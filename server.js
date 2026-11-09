// ============================================================
// SMART TRADE INDIA - ORB + VOLUME BREAKOUT SCANNER
// NSE F&O STOCKS | UPSTOX V3 | NODE.JS 20+
// Closed 5-minute candles | Futures OI | Volume blast | VWAP
// ============================================================

"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const API = "https://api.upstox.com";
const MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// -------------------- SETTINGS --------------------
const SCAN_LIMIT = Math.max(1, Number(process.env.SCAN_LIMIT || 224));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
const CACHE_MS = Number(process.env.SCAN_CACHE_MS || 20000);
const CANDLE_MINUTES = 5;
const VOLUME_MULTIPLIER = Number(process.env.VOLUME_MULTIPLIER || 2.5);
const RSI_BUY = Number(process.env.RSI_BUY || 65);
const RSI_SELL = Number(process.env.RSI_SELL || 35);
const MIN_VOLUME_CANDLES = 20;
const REQUIRE_FUTURES_OI = String(process.env.REQUIRE_FUTURES_OI || "true") === "true";
const REQUIRE_VWAP_CROSS = String(process.env.REQUIRE_VWAP_CROSS || "true") === "true";
const REQUIRE_RETEST = String(process.env.REQUIRE_RETEST || "true") === "true";
const MIN_BODY_RATIO = Number(process.env.MIN_BODY_RATIO || 0.40);
const MAX_OPPOSITE_WICK_RATIO = Number(process.env.MAX_OPPOSITE_WICK_RATIO || 0.35);
const RR1 = 2;
const RR2 = 3;

// -------------------- STATE --------------------
let equityMaster = [];
let futuresMaster = [];
let futuresBySymbol = new Map();
let masterUpdatedAt = null;
let masterLoadingPromise = null;
let scanRunning = false;
let scanCache = { at: 0, data: null };
let lastScanStatus = { status: "IDLE" };

// -------------------- HELPERS --------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value =>
  Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null;

function istDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function istParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = type => parts.find(x => x.type === type)?.value || "00";
  return { hour: Number(get("hour")), minute: Number(get("minute")) };
}

function candleTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function isMarketHours() {
  const p = istParts(new Date());
  const minutes = p.hour * 60 + p.minute;
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

async function fetchJson(url, options = {}, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { raw: text.slice(0, 1000) }; }

    if (!response.ok) {
      const message = body?.errors?.[0]?.message || body?.message ||
        body?.raw || `HTTP ${response.status}`;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function upstox(path) {
  if (!TOKEN) throw new Error("UPSTOX_ACCESS_TOKEN is missing in environment variables");
  return fetchJson(API + path, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
}

function decodeMaster(buffer) {
  try {
    return JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
  } catch {
    return JSON.parse(buffer.toString("utf8"));
  }
}

// -------------------- INSTRUMENT MASTER --------------------
async function loadMaster(force = false) {
  if (masterLoadingPromise) return masterLoadingPromise;
  if (!force && equityMaster.length && Date.now() - masterUpdatedAt < 12 * 60 * 60 * 1000) {
    return;
  }

  masterLoadingPromise = (async () => {
    console.log("[MASTER] Downloading Upstox complete instrument master...");
    const response = await fetch(MASTER_URL);
    if (!response.ok) throw new Error(`Instrument master download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const rows = decodeMaster(buffer);
    if (!Array.isArray(rows)) throw new Error("Instrument master JSON is not an array");

    const equities = rows.filter(x =>
      x.segment === "NSE_EQ" &&
      x.instrument_type === "EQ" &&
      x.instrument_key &&
      x.trading_symbol
    );

    const futures = rows.filter(x =>
      x.segment === "NSE_FO" &&
      x.instrument_type === "FUT" &&
      x.instrument_key &&
      x.underlying_symbol &&
      x.expiry
    );

    const map = new Map();
    for (const future of futures) {
      const symbol = String(future.underlying_symbol).toUpperCase();
      if (!map.has(symbol)) map.set(symbol, []);
      map.get(symbol).push(future);
    }

    for (const contracts of map.values()) {
      contracts.sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));
    }

    equityMaster = equities;
    futuresMaster = futures;
    futuresBySymbol = map;
    masterUpdatedAt = Date.now();

    console.log(`[MASTER] Equity instruments: ${equityMaster.length}`);
    console.log(`[MASTER] Stock futures contracts: ${futuresMaster.length}`);
    console.log(`[MASTER] F&O underlying symbols: ${futuresBySymbol.size}`);
  })();

  try {
    await masterLoadingPromise;
  } finally {
    masterLoadingPromise = null;
  }
}

function nearestFuture(symbol) {
  const today = istDate();
  const contracts = futuresBySymbol.get(String(symbol).toUpperCase()) || [];
  return contracts.find(x => String(x.expiry) >= today) || null;
}

async function getFnoStocks() {
  await loadMaster();
  const list = [];
  const seen = new Set();

  for (const stock of equityMaster) {
    const symbol = String(stock.trading_symbol).toUpperCase();
    if (seen.has(symbol)) continue;
    const future = nearestFuture(symbol);
    if (!future) continue;
    seen.add(symbol);
    list.push({ stock, future });
  }

  // Keep all available NSE F&O underlyings up to configured cap.
  return list.slice(0, SCAN_LIMIT);
}

// -------------------- MARKET DATA --------------------
async function getFiveMinuteCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);
  const result = await upstox(`/v3/historical-candle/intraday/${key}/minutes/5`);
  return result?.data?.candles || [];
}

function parseCandles(raw) {
  const today = istDate();
  const now = Date.now();

  return raw.map(row => {
    const date = new Date(row[0]);
    return {
      time: row[0],
      date,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] || 0),
      oi: Number(row[6] || 0)
    };
  }).filter(c =>
    Number.isFinite(c.date.getTime()) &&
    istDate(c.date) === today &&
    [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
    // Candle timestamp is its start time. Do not use an unfinished 5-min candle.
    c.date.getTime() + CANDLE_MINUTES * 60 * 1000 <= now
  ).sort((a, b) => a.date - b.date);
}

// -------------------- INDICATORS --------------------
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function vwapAt(candles, endIndex) {
  let pv = 0;
  let volume = 0;
  for (let i = 0; i <= endIndex; i++) {
    const c = candles[i];
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    volume += c.volume;
  }
  return volume > 0 ? pv / volume : null;
}

function volumeStats(candles) {
  if (candles.length < MIN_VOLUME_CANDLES + 1) return null;
  const last = candles[candles.length - 1];
  const previous = candles.slice(-(MIN_VOLUME_CANDLES + 1), -1);
  const average = previous.reduce((sum, c) => sum + c.volume, 0) / previous.length;
  const ratio = average > 0 ? last.volume / average : 0;
  return { average, current: last.volume, ratio, pass: ratio >= VOLUME_MULTIPLIER };
}

function futuresOiStats(candles) {
  const valid = candles.filter(c => c.oi > 0);
  if (valid.length < 2) {
    return { available: false, increasing: false, change: null, changePercent: null };
  }
  const current = valid[valid.length - 1].oi;
  const previous = valid[valid.length - 2].oi;
  const change = current - previous;
  return {
    available: true,
    increasing: change > 0,
    change,
    changePercent: previous > 0 ? (change / previous) * 100 : null,
    current,
    previous
  };
}

// -------------------- ORB / CONFIRMATIONS --------------------
function calculateOrb(candles) {
  const opening = candles.filter(c =>
    ["09:15", "09:20", "09:25"].includes(candleTime(c.date))
  );
  if (opening.length !== 3) return null;
  return {
    high: Math.max(...opening.map(c => c.high)),
    low: Math.min(...opening.map(c => c.low))
  };
}

function candleQuality(candle, direction) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;

  if (bodyRatio < MIN_BODY_RATIO) return false;
  if (direction === "UP") {
    return candle.close > candle.open &&
      (candle.high - candle.close) / range <= MAX_OPPOSITE_WICK_RATIO;
  }
  return candle.close < candle.open &&
    (candle.close - candle.low) / range <= MAX_OPPOSITE_WICK_RATIO;
}

// Find a breakout candle before the latest candle, then a later retest,
// and require the latest completed candle to close back in breakout direction.
function breakoutRetest(candles, level, direction) {
  const lastIndex = candles.length - 1;
  if (lastIndex < 4) return { breakout: false, retest: false, confirmed: false };

  let breakoutIndex = -1;
  for (let i = 3; i < lastIndex; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const crossed = direction === "UP"
      ? c.close > level && p.close <= level
      : c.close < level && p.close >= level;
    if (crossed) breakoutIndex = i;
  }

  if (breakoutIndex < 0) return { breakout: false, retest: false, confirmed: false };

  let retest = false;
  for (let i = breakoutIndex + 1; i < lastIndex; i++) {
    const c = candles[i];
    const touched = direction === "UP"
      ? c.low <= level * 1.002 && c.close >= level
      : c.high >= level * 0.998 && c.close <= level;
    if (touched) retest = true;
  }

  const last = candles[lastIndex];
  const confirmed = direction === "UP"
    ? last.close > level && last.close > last.open
    : last.close < level && last.close < last.open;

  return {
    breakout: true,
    retest,
    confirmed: REQUIRE_RETEST ? retest && confirmed : confirmed,
    breakoutTime: candles[breakoutIndex].time
  };
}

function vwapCrossRecent(candles, direction, lookback = 4) {
  const start = Math.max(1, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const previousVwap = vwapAt(candles, i - 1);
    const currentVwap = vwapAt(candles, i);
    if (previousVwap === null || currentVwap === null) continue;

    const previous = candles[i - 1];
    const current = candles[i];

    if (direction === "UP" &&
        previous.close <= previousVwap &&
        current.close > currentVwap) return true;

    if (direction === "DOWN" &&
        previous.close >= previousVwap &&
        current.close < currentVwap) return true;
  }
  return false;
}

function makeRisk(signal, price, candle, orb) {
  const stop = signal === "BUY"
    ? Math.min(candle.low, orb.high) - (price * 0.001)
    : Math.max(candle.high, orb.low) + (price * 0.001);

  const risk = Math.abs(price - stop);
  if (!Number.isFinite(risk) || risk <= 0 || risk / price > 0.08) return null;

  return {
    entry: round(price),
    stopLoss: round(stop),
    target1: round(signal === "BUY" ? price + risk * RR1 : price - risk * RR1),
    target2: round(signal === "BUY" ? price + risk * RR2 : price - risk * RR2),
    riskReward: "1:2 / 1:3"
  };
}

// -------------------- STOCK ANALYSIS --------------------
async function analyseOne(item) {
  const { stock, future } = item;
  let equityRaw, futureRaw;

  try {
    [equityRaw, futureRaw] = await Promise.all([
      getFiveMinuteCandles(stock.instrument_key),
      getFiveMinuteCandles(future.instrument_key)
    ]);
  } catch (error) {
    return {
      symbol: stock.trading_symbol,
      signal: "DATA_ERROR",
      error: error.message
    };
  }

  const candles = parseCandles(equityRaw);
  const futureCandles = parseCandles(futureRaw);

  // 20 previous volume candles + current closed candle; RSI(14) needs 15 closes.
  if (candles.length < MIN_VOLUME_CANDLES + 1) return null;
  if (REQUIRE_FUTURES_OI && futureCandles.length < 2) return null;

  const orb = calculateOrb(candles);
  if (!orb) return null;

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const closes = candles.map(c => c.close);
  const currentRsi = rsi(closes, 14);
  const currentEma = ema(closes, 20);
  const currentVwap = vwapAt(candles, candles.length - 1);
  const volume = volumeStats(candles);
  const oi = futuresOiStats(futureCandles);

  if (currentRsi === null || currentEma === null || currentVwap === null || !volume) return null;

  const up = breakoutRetest(candles, orb.high, "UP");
  const down = breakoutRetest(candles, orb.low, "DOWN");

  const priceUp = last.close > last.open && last.close > previous.close;
  const priceDown = last.close < last.open && last.close < previous.close;

  const vwapUp = last.close > currentVwap &&
    (!REQUIRE_VWAP_CROSS || vwapCrossRecent(candles, "UP"));
  const vwapDown = last.close < currentVwap &&
    (!REQUIRE_VWAP_CROSS || vwapCrossRecent(candles, "DOWN"));

  const oiBuy = !REQUIRE_FUTURES_OI || (oi.available && oi.increasing && priceUp);
  const oiSell = !REQUIRE_FUTURES_OI || (oi.available && oi.increasing && priceDown);

  const buyChecks = {
    orbBreakout: up.breakout,
    retestContinuation: up.confirmed,
    volumeBlast: volume.pass,
    candleQuality: candleQuality(last, "UP"),
    futuresOiIncrease: oiBuy,
    rsi65: currentRsi >= RSI_BUY,
    aboveEma20: last.close > currentEma,
    vwapCross: vwapUp
  };

  const sellChecks = {
    orbBreakdown: down.breakout,
    retestContinuation: down.confirmed,
    volumeBlast: volume.pass,
    candleQuality: candleQuality(last, "DOWN"),
    futuresOiIncrease: oiSell,
    rsi35: currentRsi <= RSI_SELL,
    belowEma20: last.close < currentEma,
    vwapCross: vwapDown
  };

  const buy = Object.values(buyChecks).every(Boolean);
  const sell = Object.values(sellChecks).every(Boolean);
  const signal = buy ? "BUY" : sell ? "SELL" : "WAIT";
  const risk = signal === "WAIT" ? null : makeRisk(signal, last.close, last, orb);

  return {
    symbol: stock.trading_symbol,
    company: stock.name || stock.trading_symbol,
    signal: risk ? signal : "WAIT",
    price: round(last.close),
    candleTime: last.time,
    timeframe: "5m CLOSED",
    futuresSymbol: future.trading_symbol,
    futuresExpiry: future.expiry,
    futuresOIAvailable: oi.available,
    futuresOIChange: oi.change,
    futuresOIChangePercent: round(oi.changePercent),
    futuresOIIncreasing: oi.increasing,
    volume: last.volume,
    averageVolume20: Math.round(volume.average),
    volumeRatio: round(volume.ratio),
    volumeBlast: volume.pass,
    rsi14: round(currentRsi),
    ema20: round(currentEma),
    vwap: round(currentVwap),
    orbHigh: round(orb.high),
    orbLow: round(orb.low),
    breakoutTime: buy ? up.breakoutTime : sell ? down.breakoutTime : null,
    buyChecks,
    sellChecks,
    smartMoneyProxy: "PRICE + VOLUME + FUTURES OI (not exchange order-flow data)",
    ...(risk || { entry: null, stopLoss: null, target1: null, target2: null, riskReward: null })
  };
}

// -------------------- CONCURRENCY / SCAN --------------------
async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;

  async function runWorker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        output[index] = await worker(items[index]);
      } catch (error) {
        output[index] = {
          symbol: items[index]?.stock?.trading_symbol || "UNKNOWN",
          signal: "DATA_ERROR",
          error: error.message
        };
      }
      // Gentle spacing reduces burst pressure on the API.
      await sleep(100);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker()
  ));
  return output.filter(Boolean);
}

async function runScan(force = false) {
  if (scanRunning) {
    if (scanCache.data) return scanCache.data;
    throw new Error("A scan is already running. Retry shortly.");
  }

  if (!force && scanCache.data && Date.now() - scanCache.at < CACHE_MS) {
    return scanCache.data;
  }

  scanRunning = true;
  const startedAt = new Date().toISOString();
  lastScanStatus = { status: "SCANNING", startedAt };

  try {
    if (!TOKEN) throw new Error("UPSTOX_ACCESS_TOKEN is missing");
    const items = await getFnoStocks();
    console.log(`[SCAN] Starting scan for ${items.length} NSE F&O stocks`);

    const all = await mapLimit(items, CONCURRENCY, analyseOne);
    const valid = all.filter(x => x.signal !== "DATA_ERROR");
    const errors = all.filter(x => x.signal === "DATA_ERROR");
    const buy = valid.filter(x => x.signal === "BUY");
    const sell = valid.filter(x => x.signal === "SELL");
    const wait = valid.filter(x => x.signal === "WAIT");

    valid.sort((a, b) => (b.volumeRatio || 0) - (a.volumeRatio || 0));

    const result = {
      success: true,
      scanner: "SMART_TRADE_INDIA_ORB_VOLUME_V1",
      market: "NSE F&O STOCKS",
      timeframe: "5-minute completed candles only",
      orbWindow: "09:15-09:30 IST",
      configuredScanLimit: SCAN_LIMIT,
      fnoStocksFound: items.length,
      analysedStocks: valid.length,
      dataErrors: errors.length,
      buyCount: buy.length,
      sellCount: sell.length,
      waitCount: wait.length,
      settings: {
        volumeMultiplier: VOLUME_MULTIPLIER,
        rsiBuy: RSI_BUY,
        rsiSell: RSI_SELL,
        requireFuturesOI: REQUIRE_FUTURES_OI,
        requireVwapCross: REQUIRE_VWAP_CROSS,
        requireRetest: REQUIRE_RETEST
      },
      buy,
      sell,
      data: valid,
      errors,
      startedAt,
      completedAt: new Date().toISOString()
    };

    scanCache = { at: Date.now(), data: result };
    lastScanStatus = {
      status: "COMPLETED",
      fnoStocksFound: items.length,
      analysedStocks: valid.length,
      dataErrors: errors.length,
      buyCount: buy.length,
      sellCount: sell.length,
      completedAt: result.completedAt
    };

    console.log(`[SCAN] Done. BUY=${buy.length}, SELL=${sell.length}, WAIT=${wait.length}, ERRORS=${errors.length}`);
    return result;
  } catch (error) {
    lastScanStatus = { status: "ERROR", error: error.message, at: new Date().toISOString() };
    throw error;
  } finally {
    scanRunning = false;
  }
}

// -------------------- HTTP SERVER --------------------
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { success: false, error: "GET only" });
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/" || path === "/health") {
      return sendJson(res, 200, {
        success: true,
        status: "ONLINE",
        scanner: "SMART TRADE INDIA ORB VOLUME V1",
        tokenConfigured: Boolean(TOKEN),
        marketHours: isMarketHours()
      });
    }

    if (path === "/api/status") {
      return sendJson(res, 200, {
        success: true,
        tokenConfigured: Boolean(TOKEN),
        masterLoaded: equityMaster.length > 0,
        equityInstruments: equityMaster.length,
        futuresContracts: futuresMaster.length,
        fnoUnderlyingCount: futuresBySymbol.size,
        masterUpdatedAt,
        scanRunning,
        lastScanStatus,
        settings: {
          scanLimit: SCAN_LIMIT,
          concurrency: CONCURRENCY,
          volumeMultiplier: VOLUME_MULTIPLIER,
          rsiBuy: RSI_BUY,
          rsiSell: RSI_SELL,
          requireFuturesOI: REQUIRE_FUTURES_OI,
          requireVwapCross: REQUIRE_VWAP_CROSS,
          requireRetest: REQUIRE_RETEST
        }
      });
    }

    if (path === "/api/master/refresh") {
      await loadMaster(true);
      scanCache = { at: 0, data: null };
      return sendJson(res, 200, {
        success: true,
        equityInstruments: equityMaster.length,
        futuresContracts: futuresMaster.length,
        fnoUnderlyingCount: futuresBySymbol.size
      });
    }

    if (path === "/api/fno-stocks") {
      const stocks = await getFnoStocks();
      return sendJson(res, 200, {
        success: true,
        count: stocks.length,
        configuredLimit: SCAN_LIMIT,
        data: stocks.map(x => ({
          symbol: x.stock.trading_symbol,
          company: x.stock.name || x.stock.trading_symbol,
          equityInstrumentKey: x.stock.instrument_key,
          futuresSymbol: x.future.trading_symbol,
          futuresInstrumentKey: x.future.instrument_key,
          expiry: x.future.expiry
        }))
      });
    }

    if (path === "/api/scan" || path === "/api/orb/scan") {
      const refresh = url.searchParams.get("refresh") === "true";
      return sendJson(res, 200, await runScan(refresh));
    }

    if (path === "/api/bullish" || path === "/api/orb/bullish") {
      const result = await runScan();
      return sendJson(res, 200, { success: true, total: result.buyCount, data: result.buy });
    }

    if (path === "/api/bearish" || path === "/api/orb/bearish") {
      const result = await runScan();
      return sendJson(res, 200, { success: true, total: result.sellCount, data: result.sell });
    }

    if (path === "/api/strong") {
      const result = await runScan();
      const data = result.data.filter(x =>
        (x.signal === "BUY" || x.signal === "SELL") &&
        Number(x.volumeRatio) >= VOLUME_MULTIPLIER
      );
      return sendJson(res, 200, { success: true, total: data.length, data });
    }

    return sendJson(res, 404, { success: false, error: "ROUTE NOT FOUND", path });
  } catch (error) {
    console.error("[SERVER ERROR]", error.stack || error.message);
    return sendJson(res, 500, { success: false, error: error.message });
  }
});

server.listen(PORT, () => {
  console.log("SMART TRADE INDIA ORB + VOLUME SCANNER STARTED");
  console.log("PORT:", PORT);
  console.log("UPSTOX TOKEN:", TOKEN ? "CONFIGURED" : "MISSING");
  console.log("SCAN LIMIT:", SCAN_LIMIT);
  console.log("VOLUME:", `${VOLUME_MULTIPLIER}x`, "RSI:", `${RSI_BUY}/${RSI_SELL}`);
});
        // ==================================================
// SERVER START - LAST ENDPOINT
// ==================================================

server.listen(PORT, "0.0.0.0", () => {

    console.log("==================================");
    console.log("SMART TRADE INDIA V2 STARTED");
    console.log("==================================");

    console.log("PORT:", PORT);

    console.log(
        "UPSTOX TOKEN:",
        TOKEN ? "CONNECTED" : "MISSING"
    );

    console.log("SCAN LIMIT:", SCAN_LIMIT);
    console.log("VOLUME BLAST:", VOLUME_MULTIPLIER);
    console.log("RSI BUY:", RSI_BUY);
    console.log("RSI SELL:", RSI_SELL);

    console.log("SERVER STATUS: ONLINE");

    console.log("==================================");

});      
