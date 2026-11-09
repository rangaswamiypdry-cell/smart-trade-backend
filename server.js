// ======================================================
// SMART TRADE INDIA - ORB + SMART VOLUME/OI SCANNER V3
// NSE EQUITY + NSE F&O | UPSTOX V3 | NODE.JS 20+
// ======================================================
"use strict";

const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const UPSTOX_BASE = "https://api.upstox.com";
const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const SCAN_LIMIT = Math.max(1, Number(process.env.ORB_SCAN_LIMIT || 2500));
const CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.SCAN_CONCURRENCY || 2)));
const CACHE_MS = Math.max(5000, Number(process.env.SCAN_CACHE_MS || 30000));
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

const VOLUME_MULTIPLIER = Number(process.env.VOLUME_MULTIPLIER || 2.5);
const RSI_BUY_MIN = Number(process.env.RSI_BUY_MIN || 60);
const RSI_STRONG_BUY = Number(process.env.RSI_STRONG_BUY || 70);
const RSI_SELL_MAX = Number(process.env.RSI_SELL_MAX || 40);
const RSI_STRONG_SELL = Number(process.env.RSI_STRONG_SELL || 30);
const BREAKOUT_BUFFER_PCT = Number(process.env.BREAKOUT_BUFFER_PCT || 0.001);
const MIN_BODY_RATIO = Number(process.env.MIN_BODY_RATIO || 0.55);
const MIN_CLOSE_POSITION = Number(process.env.MIN_CLOSE_POSITION || 0.75);

let instruments = [];
let fnoSymbols = new Set();
let lastMasterUpdate = 0;
let masterLoading = null;
const scanCache = new Map();
const scanStatus = Object.create(null);
let requestQueue = Promise.resolve();
let lastApiRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function istDate(date = new Date()) {
  const p = istParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function istTime(date = new Date()) {
  const p = istParts(date);
  return `${p.hour}:${p.minute}`;
}

function candleDate(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

async function fetchTimed(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// API RATE LIMIT PROTECTION

async function throttledFetch(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
  const task = requestQueue.then(async () => {
    const wait = Math.max(0, 250 - (Date.now() - lastApiRequestAt));
    if (wait) await sleep(wait);

    let response;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetchTimed(url, options, timeout);
      lastApiRequestAt = Date.now();

      if (response.status !== 429 && response.status !== 503) break;

      if (attempt === MAX_RETRIES) break;

      const retryAfter = Number(response.headers.get("retry-after"));

      await sleep(
        retryAfter > 0
          ? retryAfter * 1000
          : 1000 * (attempt + 1)
      );
    }

    return response;
  });

  requestQueue = task.catch(() => {});
  return task;
}

// UPSTOX API

async function upstoxRequest(path) {
  if (!UPSTOX_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing in Render Environment");
  }

  const response = await throttledFetch(UPSTOX_BASE + path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${UPSTOX_TOKEN}`
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Upstox returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const detail =
      data?.errors?.[0]?.message ||
      data?.message ||
      JSON.stringify(data);

    throw new Error(`Upstox HTTP ${response.status}: ${detail}`);
  }

  return data;
}

// LOAD NSE INSTRUMENT MASTER

async function loadInstruments(force = false) {
  if (masterLoading) return masterLoading;

  if (
    !force &&
    instruments.length &&
    Date.now() - lastMasterUpdate < 86400000
  ) return;

  masterLoading = (async () => {
    console.log("Downloading Upstox instrument master...");

    const response = await fetchTimed(
      MASTER_URL,
      {},
      60000
    );

    if (!response.ok) {
      throw new Error(`Instrument master HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    let decoded;

    try {
      decoded = zlib.gunzipSync(buffer);
    } catch {
      decoded = buffer;
    }

    const raw = JSON.parse(decoded.toString("utf8"));

    if (!Array.isArray(raw)) {
      throw new Error("Invalid instrument master: expected array");
    }

    const equity = raw.filter(x =>
      x.segment === "NSE_EQ" &&
      x.instrument_type === "EQ" &&
      x.instrument_key &&
      x.trading_symbol &&
      x.security_type !== "SM"
    );

    const fno = new Set();

    for (const x of raw) {
      if (
        x.segment === "NSE_FO" &&
        ["FUT", "CE", "PE"].includes(x.instrument_type) &&
        x.underlying_symbol
      ) {
        fno.add(String(x.underlying_symbol).toUpperCase());
      }
    }

    instruments = equity;
    fnoSymbols = fno;
    lastMasterUpdate = Date.now();

    console.log(
      `Instrument master loaded: NSE_EQ=${instruments.length}, FNO underlyings=${fnoSymbols.size}`
    );

  })();

  try {
    await masterLoading;
  } catch (err) {
    console.error("MASTER LOAD ERROR:", err.message);
    throw err;
  } finally {
    masterLoading = null;
  }
}

// GET STOCKS

async function getStocks(type = "ALL") {
  const mode = String(type).toUpperCase();

  if (!["ALL", "FNO"].includes(mode)) {
    throw new Error("type must be ALL or FNO");
  }

  await loadInstruments();

  const list = mode === "FNO"
    ? instruments.filter(x =>
        fnoSymbols.has(String(x.trading_symbol).toUpperCase())
      )
    : instruments;

  return list.slice(0, SCAN_LIMIT);
}

// GET 5 MINUTE CANDLES

async function getFiveMinuteCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const path =
    `/v3/historical-candle/intraday/${key}/minutes/5`;

  const result = await upstoxRequest(path);

  return Array.isArray(result?.data?.candles)
    ? result.data.candles
    : [];
}

// COMPLETED CANDLES ONLY

function prepareCompletedCandles(raw) {
  const today = istDate();
  const now = Date.now();

  const out = [];

  for (const row of raw || []) {
    if (!Array.isArray(row) || row.length < 6) continue;

    const date = candleDate(row[0]);

    if (!date || istDate(date) !== today) continue;

    if (date.getTime() + 5 * 60 * 1000 > now) continue;

    const c = {
      time: row[0],
      date,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      oi: Number(row[6] || 0)
    };

    if (
      ![
        c.open, c.high, c.low,
        c.close, c.volume, c.oi
      ].every(Number.isFinite)
    ) continue;

    if (c.close <= 0 || c.high < c.low || c.volume < 0) continue;

    out.push(c);
  }

  out.sort((a, b) => a.date - b.date);

  return out.filter((c, i) =>
    i === 0 || c.time !== out[i - 1].time
  );
}

// ORB CALCULATION

function calculateORB(candles) {
  const opening = candles.filter(c => {
    const t = istTime(c.date);

    return [
      "09:15",
      "09:20",
      "09:25"
    ].includes(t);
  });

  if (opening.length !== 3) return null;

  return {
    high: Math.max(...opening.map(c => c.high)),
    low: Math.min(...opening.map(c => c.low)),
    candleCount: 3
  };
}

// EMA

function calculateEMA(values, period = 20) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

// RSI

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];

    if (d > 0) gain += d;
    else loss -= d;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(d, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return 100 - 100 / (1 + avgGain / avgLoss);
}

// VWAP

function calculateVWAP(candles) {
  let pv = 0;
  let vol = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    vol += c.volume;
  }

  return vol > 0 ? pv / vol : null;
}

// VOLUME BLAST

function calculateVolume(candles) {
  if (candles.length < 21) return null;

  const previous = candles.slice(-21, -1);
  const latest = candles[candles.length - 1];

  const average =
    previous.reduce((sum, c) => sum + c.volume, 0) /
    previous.length;

  const ratio = average > 0
    ? latest.volume / average
    : 0;

  return {
    current: latest.volume,
    average,
    ratio,
    pass: average > 0 && ratio >= VOLUME_MULTIPLIER
  };
}

// CANDLE QUALITY

function candleQuality(c) {
  const range = c.high - c.low;

  if (range <= 0) {
    return {
      bodyRatio: 0,
      closePosition: 0.5
    };
  }

  return {
    bodyRatio: Math.abs(c.close - c.open) / range,
    closePosition: (c.close - c.low) / range
  };
}

// ATR

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      )
    );
  }

  return trs.reduce((a, b) => a + b, 0) / trs.length;
          }
function calculateTrade(signal, entry, candle, orb) {
  const sl = signal === "BUY"
    ? Math.min(candle.low, orb.high)
    : Math.max(candle.high, orb.low);

  const risk = Math.abs(entry - sl);

  if (!Number.isFinite(risk) || risk <= 0) return null;

  return {
    entry: round(entry),
    stopLoss: round(sl),

    target1: round(
      signal === "BUY"
        ? entry + risk * 2
        : entry - risk * 2
    ),

    target2: round(
      signal === "BUY"
        ? entry + risk * 3
        : entry - risk * 3
    ),

    riskReward: "1:2 / 1:3"
  };
}

// STOCK ANALYSIS

function analyseStock(stock, raw) {
  const candles = prepareCompletedCandles(raw);

  if (candles.length < 22) return null;

  const orb = calculateORB(candles);

  if (!orb) return null;

  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const closes = candles.map(c => c.close);

  const ema20 = calculateEMA(closes, 20);
  const rsi = calculateRSI(closes, 14);

  const vwap = calculateVWAP(candles);
  const previousVWAP = calculateVWAP(candles.slice(0, -1));

  const volume = calculateVolume(candles);
  const atr = calculateATR(candles, 14);

  if (
    [ema20, rsi, vwap, previousVWAP, atr].some(x => x === null) ||
    !volume
  ) return null;

  // OI CHECK

  const oiAvailable =
    latest.oi > 0 &&
    previous.oi > 0;

  const oiChange = oiAvailable
    ? latest.oi - previous.oi
    : null;

  const oiIncrease =
    oiAvailable && oiChange > 0;

  // PRICE CHECK

  const priceIncrease =
    latest.close > previous.close;

  const priceDecrease =
    latest.close < previous.close;

  const q = candleQuality(latest);

  const buffer = Math.max(
    orb.high * BREAKOUT_BUFFER_PCT,
    atr * 0.05
  );

  // ORB BREAKOUT

  const bullishBreakout =
    latest.close > orb.high + buffer &&
    previous.close <= orb.high + buffer;

  const bearishBreakdown =
    latest.close < orb.low - buffer &&
    previous.close >= orb.low - buffer;

  // VWAP CROSS

  const aboveVWAP = latest.close > vwap;
  const belowVWAP = latest.close < vwap;

  const bullishVWAPCross =
    aboveVWAP &&
    previous.close <= previousVWAP;

  const bearishVWAPCross =
    belowVWAP &&
    previous.close >= previousVWAP;

  // SMART MONEY PROXY

  const bullishQuality =
    q.bodyRatio >= MIN_BODY_RATIO &&
    q.closePosition >= MIN_CLOSE_POSITION;

  const bearishQuality =
    q.bodyRatio >= MIN_BODY_RATIO &&
    q.closePosition <= (1 - MIN_CLOSE_POSITION);

  // FINAL BUY / SELL CONDITIONS

  const bullish =
    bullishBreakout &&
    volume.pass &&
    oiIncrease &&
    priceIncrease &&
    rsi >= RSI_BUY_MIN &&
    bullishVWAPCross &&
    bullishQuality &&
    latest.close > ema20;

  const bearish =
    bearishBreakdown &&
    volume.pass &&
    oiIncrease &&
    priceDecrease &&
    rsi <= RSI_SELL_MAX &&
    bearishVWAPCross &&
    bearishQuality &&
    latest.close < ema20;

  let signal = "WAIT";

  if (bullish) signal = "BUY";
  else if (bearish) signal = "SELL";

  const trade = signal === "WAIT"
    ? null
    : calculateTrade(signal, latest.close, latest, orb);

  const reasons = [];

  if (bullishBreakout) reasons.push("ORB_BREAKOUT");
  if (bearishBreakdown) reasons.push("ORB_BREAKDOWN");
  if (volume.pass) reasons.push("VOLUME_BLAST");
  if (oiIncrease) reasons.push("OI_INCREASE");
  if (priceIncrease) reasons.push("PRICE_INCREASE");

  if (bullishVWAPCross || bearishVWAPCross) {
    reasons.push("VWAP_CROSS");
  }

  if (bullishQuality || bearishQuality) {
    reasons.push("STRONG_CANDLE");
  }

  return {
    symbol: stock.trading_symbol,
    company: stock.name || stock.trading_symbol,
    instrumentKey: stock.instrument_key,

    signal,

    strength:
      signal === "BUY"
        ? (rsi >= RSI_STRONG_BUY ? "VERY_STRONG" : "STRONG")
        : signal === "SELL"
          ? (rsi <= RSI_STRONG_SELL ? "VERY_STRONG" : "STRONG")
          : "WAIT",

    price: round(latest.close),

    orbHigh: round(orb.high),
    orbLow: round(orb.low),

    volume: latest.volume,
    averageVolume: Math.round(volume.average),
    volumeRatio: round(volume.ratio),
    volumeBreakout: volume.pass,

    oi: latest.oi,
    previousOI: previous.oi,
    oiChange,
    oiIncrease,

    priceIncrease,

    rsi: round(rsi),
    ema20: round(ema20),
    vwap: round(vwap),

    aboveVWAP,
    vwapCross: bullishVWAPCross || bearishVWAPCross,

    breakout: bullishBreakout,
    breakdown: bearishBreakdown,

    candleBodyRatio: round(q.bodyRatio, 3),
    candleClosePosition: round(q.closePosition, 3),

    smartMoneyProxy:
      oiIncrease &&
      volume.pass &&
      (bullishQuality || bearishQuality),

    reasons,

    candleTime: latest.time,

    entry: trade?.entry ?? null,
    stopLoss: trade?.stopLoss ?? null,
    target1: trade?.target1 ?? null,
    target2: trade?.target2 ?? null,
    riskReward: trade?.riskReward ?? null
  };
}

// CONCURRENT SCANNER

async function runPool(items, limit, worker) {
  const results = new Array(items.length);

  let next = 0;

  async function runner() {
    while (true) {
      const i = next++;

      if (i >= items.length) return;

      try {
        results[i] = await worker(items[i]);
      } catch (err) {
        console.error(
          "STOCK SCAN ERROR:",
          items[i]?.trading_symbol,
          err.message
        );

        results[i] = null;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      runner
    )
  );

  return results.filter(Boolean);
}

// MAIN SCANNER

async function scanStocks(type = "ALL", force = false) {
  const mode = String(type).toUpperCase();

  if (!["ALL", "FNO"].includes(mode)) {
    throw new Error("type must be ALL or FNO");
  }

  const key = mode;
  const cached = scanCache.get(key);

  if (
    !force &&
    cached &&
    Date.now() - cached.time < CACHE_MS
  ) {
    return cached.data;
  }

  const stocks = await getStocks(mode);

  scanStatus[mode] = {
    status: "SCANNING",
    totalStocks: stocks.length,
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  console.log(
    `ORB scan started: ${mode}, ${stocks.length} stocks`
  );

  const results = await runPool(
    stocks,
    CONCURRENCY,
    async stock => {
      const raw = await getFiveMinuteCandles(
        stock.instrument_key
      );

      return analyseStock(stock, raw);
    }
  );

  results.sort(
    (a, b) => b.volumeRatio - a.volumeRatio
  );

  const buys = results.filter(x => x.signal === "BUY");
  const sells = results.filter(x => x.signal === "SELL");

  const output = {
    success: true,

    scanner: "SMART_TRADE_INDIA_ORB_V3",

    type: mode,

    timeframe: "5 MINUTES - COMPLETED CANDLES",

    orbPeriod: "09:15 TO 09:30 IST",

    rules: {
      volumeMultiplier: VOLUME_MULTIPLIER,
      rsiBuyMinimum: RSI_BUY_MIN,
      rsiVeryStrongBuy: RSI_STRONG_BUY,
      rsiSellMaximum: RSI_SELL_MAX,
      rsiVeryStrongSell: RSI_STRONG_SELL,
      oiIncreaseRequired: true,
      vwapPositionRequired: true,

      fakeBreakoutFilters: [
        "ORB close confirmation",
        "breakout buffer",
        "candle body strength",
        "close near candle extreme"
      ]
    },

    totalStocks: stocks.length,
    analysedStocks: results.length,

    signals: buys.length + sells.length,
    bullish: buys.length,
    bearish: sells.length,

    wait: results.length - buys.length - sells.length,

    data: results,

    scanTime: new Date().toISOString()
  };

  scanCache.set(key, {
    time: Date.now(),
    data: output
  });

  scanStatus[mode] = {
    status: "COMPLETED",
    totalStocks: stocks.length,
    analysedStocks: results.length,
    signals: output.signals,
    bullish: buys.length,
    bearish: sells.length,
    completedAt: new Date().toISOString()
  };

  return output;
}

// FILTER DATA

function filterData(output, kind) {
  const rows = output?.data || [];

  if (kind === "bullish") {
    return rows.filter(x => x.signal === "BUY");
  }

  if (kind === "bearish") {
    return rows.filter(x => x.signal === "SELL");
  }

  if (kind === "strong") {
    return rows.filter(x => x.strength === "VERY_STRONG");
  }

  if (kind === "volume") {
    return rows.filter(x => x.volumeBreakout);
  }

  if (kind === "oi") {
    return rows.filter(x => x.oiIncrease);
  }

  return rows;
}

// HTTP SERVER

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    return res.end();
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, {
      success: false,
      error: "GET only"
    });
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const path = url.pathname;

  try {

    // HEALTH CHECK

    if (path === "/health") {
      return sendJson(res, 200, {
        success: true,
        status: "ONLINE",
        app: "SMART TRADE INDIA",
        scanner: "ORB V3",
        node: process.version,
        upstoxTokenConfigured: Boolean(UPSTOX_TOKEN)
      });
    }

    // SCANNER STATUS

    if (path === "/api/orb/status") {
      return sendJson(res, 200, {
        success: true,
        scanner: "ORB V3",
        apiConnected: Boolean(UPSTOX_TOKEN),
        instrumentsLoaded: instruments.length,
        fnoStocks: fnoSymbols.size,

        lastMasterUpdate:
          lastMasterUpdate
            ? new Date(lastMasterUpdate).toISOString()
            : null,

        scanStatus,
        timeframe: "5 MINUTES"
      });
    }

    // REFRESH MASTER

    if (path === "/api/orb/refresh-master") {
      scanCache.clear();

      await loadInstruments(true);

      return sendJson(res, 200, {
        success: true,
        nseStocks: instruments.length,
        fnoStocks: fnoSymbols.size
      });
    }

    // STOCK LIST

    if (path === "/api/orb/stocks") {
      const type = url.searchParams.get("type") || "ALL";

      const stocks = await getStocks(type);

      return sendJson(res, 200, {
        success: true,
        type: type.toUpperCase(),
        total: stocks.length,

        data: stocks.map(x => ({
          symbol: x.trading_symbol,
          company: x.name || x.trading_symbol,
          instrumentKey: x.instrument_key
        }))
      });
    }

    // SCANNER ROUTES

    if (
      path === "/api/orb/scan" ||
      path === "/api/orb/bullish" ||
      path === "/api/orb/bearish" ||
      path === "/api/orb/strong" ||
      path === "/api/orb/volume" ||
      path === "/api/orb/oi"
    ) {

      const type =
        url.searchParams.get("type") || "ALL";

      const force =
        url.searchParams.get("refresh") === "1";

      const output = await scanStocks(type, force);

      if (path === "/api/orb/scan") {
        return sendJson(res, 200, output);
      }

      const kind = path.split("/").pop();

      const data = filterData(output, kind);

      return sendJson(res, 200, {
        success: true,
        type: kind.toUpperCase(),
        total: data.length,
        data,
        scanTime: output.scanTime
      });
    }

    // ROUTE NOT FOUND

    return sendJson(res, 404, {
      success: false,
      message: "API route not found",

      availableRoutes: [
        "/health",
        "/api/orb/status",
        "/api/orb/stocks?type=ALL",
        "/api/orb/stocks?type=FNO",
        "/api/orb/scan?type=ALL",
        "/api/orb/scan?type=FNO",
        "/api/orb/bullish",
        "/api/orb/bearish",
        "/api/orb/strong",
        "/api/orb/volume",
        "/api/orb/oi",
        "/api/orb/refresh-master"
      ]
    });

  } catch (err) {

    console.error(
      "SERVER ERROR:",
      err.stack || err.message
    );

    const status =
      /missing in Render Environment/.test(err.message)
        ? 503
        : 500;

    return sendJson(res, status, {
      success: false,
      error: err.message
    });
  }
});

// START SERVER

server.listen(PORT, () => {

  console.log(
    "SMART TRADE INDIA ORB V3 STARTED"
  );

  console.log("PORT:", PORT);

  console.log(
    "UPSTOX TOKEN:",
    UPSTOX_TOKEN ? "CONFIGURED" : "MISSING"
  );

  console.log(
    `CONFIG: volume=${VOLUME_MULTIPLIER}x, RSI buy>=${RSI_BUY_MIN}, strong>=${RSI_STRONG_BUY}, concurrency=${CONCURRENCY}`
  );

});

process.on(
  "unhandledRejection",
  err => console.error("UNHANDLED REJECTION:", err)
);

process.on("uncaughtException", err => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});
