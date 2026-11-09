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

const round = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
};

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

  return {
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
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

    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 1000) };
    }

    if (!response.ok) {
      const message =
        body?.errors?.[0]?.message ||
        body?.message ||
        body?.raw ||
        `HTTP ${response.status}`;

      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    return body;

  } finally {
    clearTimeout(timer);
  }
}

async function upstox(path) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing in environment variables");
  }

  let lastError;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchJson(API + path, {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        }
      });

    } catch (error) {
      lastError = error;

      const retryable = /HTTP (429|500|502|503|504)/.test(error.message);

      if (!retryable || attempt === 2) {
        throw error;
      }

      await sleep(700 * (attempt + 1));
    }
  }

  throw lastError;
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

  if (
    !force &&
    equityMaster.length &&
    Date.now() - masterUpdatedAt < 12 * 60 * 60 * 1000
  ) {
    return;
  }

  masterLoadingPromise = (async () => {
    console.log("[MASTER] Downloading Upstox complete instrument master...");

    const response = await fetch(MASTER_URL);

    if (!response.ok) {
      throw new Error(`Instrument master download failed: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const rows = decodeMaster(buffer);

    if (!Array.isArray(rows)) {
      throw new Error("Instrument master JSON is not an array");
    }

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

      if (!map.has(symbol)) {
        map.set(symbol, []);
      }

      map.get(symbol).push(future);
    }

    for (const contracts of map.values()) {
      contracts.sort((a, b) =>
        String(a.expiry).localeCompare(String(b.expiry))
      );
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

  const contracts =
    futuresBySymbol.get(String(symbol).toUpperCase()) || [];

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

    list.push({
      stock,
      future
    });
  }

  return list.slice(0, SCAN_LIMIT);
}// ============================================================
// PART 2 - INDICATORS + SCANNER + API ROUTES + SERVER
// ============================================================

// -------------------- INDICATORS --------------------
function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return round(100 - 100 / (1 + avgGain / avgLoss));
}

function calculateVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const volume = Number(c.volume || 0);

    totalPV += typical * volume;
    totalVolume += volume;
  }

  return totalVolume > 0 ? round(totalPV / totalVolume) : null;
}

function candleQuality(candle, bullish) {
  const range = candle.high - candle.low;

  if (range <= 0) return false;

  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;

  const oppositeWick = bullish
    ? candle.high - Math.max(candle.open, candle.close)
    : Math.min(candle.open, candle.close) - candle.low;

  const oppositeRatio = oppositeWick / range;

  const correctDirection = bullish
    ? candle.close > candle.open
    : candle.close < candle.open;

  return (
    correctDirection &&
    bodyRatio >= MIN_BODY_RATIO &&
    oppositeRatio <= MAX_OPPOSITE_WICK_RATIO
  );
}

function getCompletedCandles(rawCandles) {
  if (!Array.isArray(rawCandles)) return [];

  const now = Date.now();

  return rawCandles
    .map(row => {
      const time = new Date(row[0]).getTime();

      return {
        time,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5] || 0),
        oi: Number(row[6] || 0)
      };
    })
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.time + CANDLE_MINUTES * 60 * 1000 <= now
    )
    .sort((a, b) => a.time - b.time);
}

function getTodayCandles(candles) {
  const today = istDate();

  return candles.filter(c =>
    istDate(new Date(c.time)) === today
  );
}

// -------------------- ORB CALCULATION --------------------
function calculateORB(candles) {
  const todayCandles = getTodayCandles(candles);

  const openingCandles = todayCandles.filter(c => {
    const time = candleTime(new Date(c.time));
    return time >= "09:15" && time < "09:30";
  });

  if (openingCandles.length < 3) {
    return {
      ready: false,
      reason: "Waiting for 3 completed opening candles"
    };
  }

  return {
    ready: true,
    high: Math.max(...openingCandles.map(c => c.high)),
    low: Math.min(...openingCandles.map(c => c.low))
  };
}

// -------------------- BREAKOUT / RETEST --------------------
function detectBreakout(candles, orb, bullish) {
  if (!orb.ready || candles.length < 5) {
    return {
      valid: false,
      reason: "Insufficient candles"
    };
  }

  const today = getTodayCandles(candles);
  const afterORB = today.filter(c =>
    candleTime(new Date(c.time)) >= "09:30"
  );

  if (afterORB.length < 2) {
    return {
      valid: false,
      reason: "Waiting for post-ORB candles"
    };
  }

  const level = bullish ? orb.high : orb.low;
  const recent = afterORB.slice(-6);

  const breakoutIndex = recent.findIndex(c =>
    bullish ? c.close > level : c.close < level
  );

  if (breakoutIndex < 0) {
    return {
      valid: false,
      reason: "ORB breakout not confirmed"
    };
  }

  const breakoutCandle = recent[breakoutIndex];
  const later = recent.slice(breakoutIndex + 1);
  const last = recent[recent.length - 1];

  if (!REQUIRE_RETEST) {
    return {
      valid: true,
      level,
      breakoutPrice: breakoutCandle.close,
      retest: false
    };
  }

  const retestFound = later.some(c =>
    bullish
      ? c.low <= level * 1.003 && c.close >= level
      : c.high >= level * 0.997 && c.close <= level
  );

  const continuation = bullish
    ? last.close > level && last.close >= breakoutCandle.close
    : last.close < level && last.close <= breakoutCandle.close;

  return {
    valid: retestFound && continuation,
    level,
    breakoutPrice: breakoutCandle.close,
    retest: retestFound,
    continuation
  };
}

// -------------------- ANALYSIS --------------------
function analyseStock(candles, futureCandles, stock) {
  if (candles.length < 25) {
    return {
      signal: "WAIT",
      reason: "Need at least 25 completed candles"
    };
  }

  const today = getTodayCandles(candles);

  if (today.length < 5) {
    return {
      signal: "WAIT",
      reason: "Waiting for intraday candles"
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, 14);
  const vwap = calculateVWAP(today);

  const previousVolumes = candles
    .slice(-(MIN_VOLUME_CANDLES + 1), -1)
    .map(c => c.volume);

  if (previousVolumes.length < MIN_VOLUME_CANDLES) {
    return {
      signal: "WAIT",
      reason: "Not enough volume history"
    };
  }

  const averageVolume =
    previousVolumes.reduce((a, b) => a + b, 0) /
    previousVolumes.length;

  const volumeRatio =
    averageVolume > 0 ? last.volume / averageVolume : 0;

  const volumePass = volumeRatio >= VOLUME_MULTIPLIER;

  const orb = calculateORB(candles);

  const bullBreakout = detectBreakout(candles, orb, true);
  const bearBreakout = detectBreakout(candles, orb, false);

  const bullVWAP = vwap !== null &&
    (previous.close <= vwap && last.close > vwap);

  const bearVWAP = vwap !== null &&
    (previous.close >= vwap && last.close < vwap);

  const futureValid = Array.isArray(futureCandles) &&
    futureCandles.length >= 2;

  const futureLast = futureValid
    ? futureCandles[futureCandles.length - 1]
    : null;

  const futurePrevious = futureValid
    ? futureCandles[futureCandles.length - 2]
    : null;

  const oiIncreasing = futureValid &&
    futureLast.oi > futurePrevious.oi &&
    futureLast.close > futurePrevious.close;

  const oiDecreasing = futureValid &&
    futureLast.oi > futurePrevious.oi &&
    futureLast.close < futurePrevious.close;

  const bullOI = !REQUIRE_FUTURES_OI || oiIncreasing;
  const bearOI = !REQUIRE_FUTURES_OI || oiDecreasing;

  const bullVWAPPass = !REQUIRE_VWAP_CROSS || bullVWAP;
  const bearVWAPPass = !REQUIRE_VWAP_CROSS || bearVWAP;

  const bullish =
    last.close > last.open &&
    last.close > previous.close &&
    rsi !== null &&
    rsi >= RSI_BUY &&
    volumePass &&
    bullBreakout.valid &&
    bullVWAPPass &&
    bullOI &&
    candleQuality(last, true);

  const bearish =
    last.close < last.open &&
    last.close < previous.close &&
    rsi !== null &&
    rsi <= RSI_SELL &&
    volumePass &&
    bearBreakout.valid &&
    bearVWAPPass &&
    bearOI &&
    candleQuality(last, false);

  let signal = "WAIT";
  let reason = "All conditions not confirmed";

  if (bullish) {
    signal = "BUY";
    reason = "ORB breakout + retest + volume + RSI + VWAP + OI";
  } else if (bearish) {
    signal = "SELL";
    reason = "ORB breakdown + retest + volume + RSI + VWAP + OI";
  }

  const entry = last.close;

  const risk = Math.max(
    last.high - last.low,
    entry * 0.002
  );

  const stopLoss = signal === "BUY"
    ? round(entry - risk)
    : signal === "SELL"
      ? round(entry + risk)
      : null;

  const target1 = signal === "BUY"
    ? round(entry + risk * RR1)
    : signal === "SELL"
      ? round(entry - risk * RR1)
      : null;

  const target2 = signal === "BUY"
    ? round(entry + risk * RR2)
    : signal === "SELL"
      ? round(entry - risk * RR2)
      : null;

  return {
    symbol: stock.trading_symbol,
    instrumentKey: stock.instrument_key,
    signal,
    reason,
    price: round(last.close),
    volume: last.volume,
    averageVolume: round(averageVolume),
    volumeRatio: round(volumeRatio),
    rsi,
    vwap,
    orbHigh: orb.high ?? null,
    orbLow: orb.low ?? null,
    futuresOI: futureLast?.oi ?? null,
    oiIncreasing: Boolean(oiIncreasing),
    entry,
    stopLoss,
    target1,
    target2,
    riskReward: "1:2 / 1:3",
    candleTime: candleTime(new Date(last.time)),
    timeframe: "5m"
  };
}

// -------------------- MARKET DATA --------------------
async function getIntradayCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const result = await upstox(
    `/v3/historical-candle/intraday/${key}/minutes/5`
  );

  return getCompletedCandles(result?.data?.candles || []);
}

async function getFutureCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const result = await upstox(
    `/v3/historical-candle/intraday/${key}/minutes/5`
  );

  return getCompletedCandles(result?.data?.candles || []);
}

// -------------------- CONCURRENT WORKER --------------------
async function runWorkers(items, worker, concurrency) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (true) {
      const current = index++;

      if (current >= items.length) return;

      try {
        results[current] = await worker(items[current]);
      } catch (error) {
        results[current] = {
          symbol: items[current]?.stock?.trading_symbol || "UNKNOWN",
          signal: "ERROR",
          reason: error.message
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => run()
    )
  );

  return results;
}

// -------------------- MAIN SCAN --------------------
async function runScan(force = false) {
  if (!force && scanCache.data && Date.now() - scanCache.at < CACHE_MS) {
    return scanCache.data;
  }

  if (scanRunning) {
    if (scanCache.data) return scanCache.data;

    return {
      status: "SCANNING",
      message: "Scan already running",
      bullish: [],
      bearish: [],
      waiting: []
    };
  }

  scanRunning = true;
  lastScanStatus = {
    status: "SCANNING",
    startedAt: new Date().toISOString()
  };

  try {
    await loadMaster();

    const stocks = await getFnoStocks();

    const results = await runWorkers(
      stocks,
      async item => {
        const candles = await getIntradayCandles(
          item.stock.instrument_key
        );

        const futureCandles = await getFutureCandles(
          item.future.instrument_key
        );

        return analyseStock(
          candles,
          futureCandles,
          item.stock
        );
      },
      CONCURRENCY
    );

    const bullish = results.filter(x => x?.signal === "BUY");
    const bearish = results.filter(x => x?.signal === "SELL");
    const errors = results.filter(x => x?.signal === "ERROR");
    const waiting = results.filter(x => x?.signal === "WAIT");

    const data = {
      status: "SUCCESS",
      scanned: stocks.length,
      bullishCount: bullish.length,
      bearishCount: bearish.length,
      errorCount: errors.length,
      waitingCount: waiting.length,
      bullish,
      bearish,
      waiting,
      errors,
      updatedAt: new Date().toISOString()
    };

    scanCache = {
      at: Date.now(),
      data
    };

    lastScanStatus = {
      status: "SUCCESS",
      scanned: stocks.length,
      updatedAt: data.updatedAt
    };

    return data;

  } catch (error) {
    lastScanStatus = {
      status: "ERROR",
      message: error.message
    };

    throw error;

  } finally {
    scanRunning = false;
  }
}

// -------------------- HTTP HELPERS --------------------
function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

// -------------------- SERVER ROUTES --------------------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const path = url.pathname;

  try {
    if (path === "/" || path === "/health") {
      return sendJson(res, 200, {
        status: "OK",
        app: "SMART TRADE INDIA",
        version: "ORB-VOLUME-V2",
        serverTime: new Date().toISOString(),
        marketHours: isMarketHours()
      });
    }

    if (path === "/api/status") {
      return sendJson(res, 200, {
        status: "OK",
        tokenConfigured: Boolean(TOKEN),
        masterLoaded: equityMaster.length > 0,
        equityInstruments: equityMaster.length,
        futuresContracts: futuresMaster.length,
        fnoUnderlyingCount: futuresBySymbol.size,
        scanLimit: SCAN_LIMIT,
        concurrency: CONCURRENCY,
        lastScan: lastScanStatus
      });
    }

    if (path === "/api/fno-stocks" ||
        path === "/api/nse-stocks") {
      await loadMaster();

      const stocks = await getFnoStocks();

      return sendJson(res, 200, {
        status: "SUCCESS",
        count: stocks.length,
        configuredLimit: SCAN_LIMIT,
        stocks: stocks.map(x => ({
          symbol: x.stock.trading_symbol,
          instrumentKey: x.stock.instrument_key,
          futuresKey: x.future.instrument_key,
          expiry: x.future.expiry
        }))
      });
    }

    if (path === "/api/master/refresh") {
      await loadMaster(true);

      return sendJson(res, 200, {
        status: "SUCCESS",
        equityInstruments: equityMaster.length,
        futuresContracts: futuresMaster.length,
        fnoUnderlyingCount: futuresBySymbol.size
      });
    }

    if (path === "/api/scan") {
      const force = url.searchParams.get("force") === "true";
      const data = await runScan(force);

      return sendJson(res, 200, data);
    }

    if (path === "/api/bullish") {
      const data = await runScan();

      return sendJson(res, 200, {
        status: data.status,
        count: data.bullish?.length || 0,
        stocks: data.bullish || []
      });
    }

    if (path === "/api/bearish") {
      const data = await runScan();

      return sendJson(res, 200, {
        status: data.status,
        count: data.bearish?.length || 0,
        stocks: data.bearish || []
      });
    }

    if (path === "/api/strong") {
      const data = await runScan();

      const strong = [
        ...(data.bullish || []),
        ...(data.bearish || [])
      ].filter(x => x.volumeRatio >= 3);

      return sendJson(res, 200, {
        status: data.status,
        count: strong.length,
        stocks: strong
      });
    }

    return sendJson(res, 404, {
      status: "ERROR",
      message: "API route not found",
      path
    });

  } catch (error) {
    console.error("[API ERROR]", path, error.message);

    return sendJson(res, 500, {
      status: "ERROR",
      message: error.message
    });
  }
});

// -------------------- START SERVER --------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================");
  console.log(" SMART TRADE INDIA SERVER STARTED");
  console.log(` PORT: ${PORT}`);
  console.log(` SCAN LIMIT: ${SCAN_LIMIT}`);
  console.log(` VOLUME MULTIPLIER: ${VOLUME_MULTIPLIER}`);
  console.log(` RSI BUY: ${RSI_BUY}`);
  console.log(` RSI SELL: ${RSI_SELL}`);
  console.log("==========================================");

  loadMaster().catch(error => {
    console.error("[MASTER ERROR]", error.message);
  });
});
