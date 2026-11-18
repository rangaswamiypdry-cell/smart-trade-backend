
"use strict";

// ============================================================
// SMART TRADE INDIA PRO V3
// INDEX ONLY - LIVE SIGNAL + MANUAL TRADE
// Node.js 20+ | Upstox API
// 5-Minute Closed Candle Scanner
// PART 1 OF 2
// ============================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const API = "https://api.upstox.com";

const MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ============================================================
// CONFIGURATION - ONLY FIVE INDICES
// ============================================================

const CFG = {
  VERSION: "SMART_TRADE_INDIA_PRO_V3",

  TF: 5,
  MIN_CANDLES: 30,

  INDEXES: [
    "NIFTY",
    "BANKNIFTY",
    "SENSEX",
    "FINNIFTY",
    "MIDCPNIFTY"
  ],

  RSI_PERIOD: 14,
  RSI_BUY: 60,
  RSI_SELL: 40,

  EMA_PERIOD: 20,
  ADX_PERIOD: 14,
  ADX_MIN: 20,

  VOLUME_MULTIPLIER: 1.5,

  ATR_PERIOD: 14,
  SUPERTREND_PERIOD: 10,
  SUPERTREND_MULTIPLIER: 3,

  DELTA_MIN: 0.15,
  DELTA_MAX: 0.30,
  MAX_SPREAD_PCT: 2,

  CACHE_MS: 30000,
  WORKERS: 3,

  SELL_SL_MULTIPLE: 1.5,
  SELL_TARGET_DECAY: 0.50
};

// ============================================================
// GLOBAL DATA
// ============================================================

let master = [];
let universe = [];

let masterReady = false;
let masterBusy = false;
let scanBusy = false;

let scanCache = null;

const candleCache = new Map();
const dailyCache = new Map();
const optionCache = new Map();

// ============================================================
// BASIC HELPERS
// ============================================================

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  return Number(n.toFixed(digits));
}

function norm(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function istDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function expiryDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toISOString().slice(0, 10);
}

// ============================================================
// UPSTOX API REQUEST
// ============================================================

async function upstoxRequest(path, options = {}) {
  if (!TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN environment variable missing"
    );
  }

  const response = await fetch(`${API}${path}`, {
    method: options.method || "GET",

    headers: {
      "Accept": "application/json",
      "Api-Version": "2.0",
      "Authorization": `Bearer ${TOKEN}`,
      ...(options.headers || {})
    },

    body: options.body
      ? JSON.stringify(options.body)
      : undefined
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid Upstox API response");
  }

  if (!response.ok) {
    throw new Error(
      `Upstox API ${response.status}: ` +
      (data.message || text)
    );
  }

  return data;
}

// ============================================================
// DOWNLOAD UPSTOX INSTRUMENT MASTER
// ============================================================

async function downloadInstrumentMaster() {
  const response = await fetch(MASTER_URL);

  if (!response.ok) {
    throw new Error(
      `Instrument master download failed: ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const output = zlib.gunzipSync(buffer);

  const rows = JSON.parse(output.toString("utf8"));

  if (!Array.isArray(rows)) {
    throw new Error("Invalid instrument master format");
  }

  return rows;
}

// ============================================================
// INDEX FUTURES UNIVERSE
// ONLY NIFTY, BANKNIFTY, SENSEX,
// FINNIFTY, MIDCPNIFTY
// ============================================================

function buildUniverse(rows) {
  const today = istDate();

  const selected = new Map();

  const futures = rows.filter(f =>
    ["NSE_FO", "BSE_FO"].includes(f.segment) &&
    f.instrument_type === "FUT" &&
    f.instrument_key &&
    f.underlying_key &&
    String(f.underlying_type || "")
      .toUpperCase() === "INDEX" &&
    expiryDate(f.expiry) >= today
  );

  for (const f of futures) {
    const underlying = norm(
      f.underlying_symbol ||
      f.name ||
      f.trading_symbol
    );

    const indexName = CFG.INDEXES
      .slice()
      .sort(
        (a, b) =>
          norm(b).length - norm(a).length
      )
      .find(i =>
        underlying.includes(norm(i))
      );

    if (!indexName) continue;

    const key = `INDEX:${indexName}`;

    const item = {
      symbol: indexName,
      kind: "INDEX",

      futuresKey: f.instrument_key,
      underlyingKey: f.underlying_key,

      futuresSymbol: f.trading_symbol,

      expiry: expiryDate(f.expiry),

      lotSize: Number(f.lot_size || 0)
    };

    const old = selected.get(key);

    if (!old || item.expiry < old.expiry) {
      selected.set(key, item);
    }
  }

  return [...selected.values()].sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol)
  );
}

// ============================================================
// REFRESH MASTER AND INDEX UNIVERSE
// ============================================================

async function refreshMaster() {
  if (masterBusy) return universe;

  masterBusy = true;

  try {
    const rows = await downloadInstrumentMaster();

    master = rows;

    universe = buildUniverse(master);

    masterReady = true;

    console.log(
      "[MASTER] Index Futures:",
      universe.map(x => x.symbol).join(", ")
    );

    console.log(
      "[MASTER] Total Indexes:",
      universe.length
    );

    return universe;

  } finally {
    masterBusy = false;
  }
}

// ============================================================
// PRICE DATA HELPERS
// ============================================================

function extractCandles(data) {
  const candles =
    data?.data?.candles ||
    data?.candles ||
    [];

  if (!Array.isArray(candles)) {
    return [];
  }

  return candles.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5] || 0),
    oi: Number(c[6] || 0)
  })).filter(c =>
    Number.isFinite(c.close) &&
    c.close > 0
  );
}


// ============================================================
// EMA
// ============================================================

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * multiplier +
      ema * (1 - multiplier);
  }

  return ema;
}

// ============================================================
// RSI - WILDER
// ============================================================

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gain += change;
    else loss += Math.abs(change);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// ============================================================
// ATR 14
// ============================================================

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  return trs.slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

// ============================================================
// ADX 14
// ============================================================

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;

  const plusDM = [];
  const minusDM = [];
  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const up = c.high - p.high;
    const down = p.low - c.low;

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);

    tr.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  const dx = [];

  for (let i = period - 1; i < tr.length; i++) {
    const start = i - period + 1;

    const atr = tr.slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    if (!atr) continue;

    const p = plusDM.slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    const m = minusDM.slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    const plusDI = 100 * p / atr;
    const minusDI = 100 * m / atr;

    const denominator = plusDI + minusDI;

    dx.push(
      denominator
        ? 100 * Math.abs(plusDI - minusDI) / denominator
        : 0
    );
  }

  if (dx.length < period) return null;

  return dx.slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

// ============================================================
// VWAP
// ============================================================

function calculateVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;

    totalPV += typical * c.volume;
    totalVolume += c.volume;
  }

  return totalVolume > 0
    ? totalPV / totalVolume
    : null;
}

// ============================================================
// MACD
// ============================================================

function calculateMACD(values) {
  if (values.length < 35) return null;

  const fast = [];
  const slow = [];

  for (let i = 0; i < values.length; i++) {
    const part = values.slice(0, i + 1);

    fast.push(calculateEMA(part, 12));
    slow.push(calculateEMA(part, 26));
  }

  const macd = fast.map((v, i) =>
    v !== null && slow[i] !== null
      ? v - slow[i]
      : null
  ).filter(v => v !== null);

  const signal = calculateEMA(macd, 9);

  if (signal === null || !macd.length) return null;

  return {
    value: macd[macd.length - 1],
    signal,
    histogram: macd[macd.length - 1] - signal
  };
}

// ============================================================
// SUPERTREND
// ============================================================

function calculateSupertrend(
  candles,
  period = 10,
  multiplier = 3
) {
  if (candles.length < period + 2) return null;

  const atr = calculateATR(candles, period);

  if (!atr) return null;

  const last = candles[candles.length - 1];

  const middle = (last.high + last.low) / 2;

  const upper = middle + multiplier * atr;
  const lower = middle - multiplier * atr;

  return {
    upper: round(upper),
    lower: round(lower),
    trend: last.close >= middle ? "UP" : "DOWN"
  };
}

// ============================================================
// ADR 14 - DAILY RANGE
// ============================================================

function calculateADR(dailyCandles, period = 14) {
  if (dailyCandles.length < period) return null;

  const ranges = dailyCandles
    .slice(-period)
    .map(c => c.high - c.low);

  return ranges.reduce((a, b) => a + b, 0) / period;
}

// ============================================================
// CLOSED 5-MINUTE CANDLES
// ============================================================

function isClosedCandle(time) {
  const candleTime = new Date(time).getTime();

  if (!Number.isFinite(candleTime)) return false;

  const now = Date.now();

  const currentBucket =
    Math.floor(now / 300000) * 300000;

  return candleTime < currentBucket;
}

async function getClosedCandles(instrumentKey) {
  const cached = candleCache.get(instrumentKey);

  if (
    cached &&
    Date.now() - cached.time < CFG.CANDLE_CACHE_MS
  ) {
    return cached.data;
  }

  const path =
    `/v3/historical-candle/intraday/${enc(instrumentKey)}/minutes/5`;

  const response = await upstoxRequest(path);

  const candles = extractCandles(response)
    .filter(c => isClosedCandle(c.time))
    .sort((a, b) =>
      new Date(a.time) - new Date(b.time)
    );

  candleCache.set(instrumentKey, {
    time: Date.now(),
    data: candles
  });

  return candles;
}

// ============================================================
// DAILY CANDLES
// ============================================================

async function getDailyCandles(instrumentKey) {
  const cached = dailyCache.get(instrumentKey);

  if (
    cached &&
    Date.now() - cached.time < CFG.DAILY_CACHE_MS
  ) {
    return cached.data;
  }

  const to = istDate();

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 35);

  const from = istDate(fromDate);

  const path =
    `/v3/historical-candle/${enc(instrumentKey)}/day/1/${to}/${from}`;

  const response = await upstoxRequest(path);

  const candles = extractCandles(response)
    .sort((a, b) =>
      new Date(a.time) - new Date(b.time)
    );

  dailyCache.set(instrumentKey, {
    time: Date.now(),
    data: candles
  });

  return candles;
}

// ============================================================
// MARKET QUOTE
// ============================================================

async function getMarketQuote(instrumentKey) {
  const path =
    `/v2/market-quote/quotes?instrument_key=${enc(instrumentKey)}`;

  const response = await upstoxRequest(path);

  const data = response.data || {};

  const key = Object.keys(data)[0];

  return key ? data[key] : null;
}

// ============================================================
// 8/8 MANDATORY SIGNAL ANALYSIS
// ============================================================

function analyseCandles(candles, quote, dailyCandles) {
  if (candles.length < CFG.MIN_CANDLES) {
    return {
      signal: "WAIT",
      reason: "Not enough completed candles"
    };
  }

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema20 = calculateEMA(closes, 20);
  const rsi = calculateRSI(closes, 14);
  const adx = calculateADX(candles, 14);
  const vwap = calculateVWAP(candles);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles, 14);

  const supertrend = calculateSupertrend(
    candles,
    CFG.SUPERTREND_PERIOD,
    CFG.SUPERTREND_MULTIPLIER
  );

  const adr14 = calculateADR(dailyCandles, 14);

  const avgVolume = candles
    .slice(-21, -1)
    .reduce((sum, c) => sum + c.volume, 0) / 20;

  const volumePass =
    avgVolume > 0 &&
    last.volume >= avgVolume * CFG.VOLUME_MULTIPLIER;

  const currentOI = Number(
    quote?.oi || quote?.open_interest || 0
  );

  const previousOI = Number(previous.oi || 0);

  const oiPass =
    currentOI > 0 &&
    previousOI > 0 &&
    currentOI > previousOI;

  const priceUp = last.close > previous.close;
  const priceDown = last.close < previous.close;

  const indicatorsReady = [
    ema20, rsi, adx, vwap, macd, atr,
    supertrend, adr14
  ].every(v => v !== null && v !== undefined);

  if (!indicatorsReady) {
    return {
      signal: "WAIT",
      reason: "Indicators not ready"
    };
  }

  const bullish = [
    oiPass,
    priceUp,
    volumePass,
    rsi >= CFG.RSI_BUY,
    adx >= CFG.ADX_MIN,
    last.close > ema20,
    last.close > vwap,
    macd.histogram > 0
  ];

  const bearish = [
    oiPass,
    priceDown,
    volumePass,
    rsi <= CFG.RSI_SELL,
    adx >= CFG.ADX_MIN,
    last.close < ema20,
    last.close < vwap,
    macd.histogram < 0
  ];

  const bullCount = bullish.filter(Boolean).length;
  const bearCount = bearish.filter(Boolean).length;

  let signal = "WAIT";
  let optionAction = "NONE";

  if (bullCount === 8) {
    signal = "VERY_STRONG_BULLISH";
    optionAction = "SELL_PE";
  } else if (bearCount === 8) {
    signal = "VERY_STRONG_BEARISH";
    optionAction = "SELL_CE";
  }

  return {
    signal,
    optionAction,

    bullishCount: `${bullCount}/8`,
    bearishCount: `${bearCount}/8`,

    price: round(last.close),

    rsi: round(rsi),
    ema20: round(ema20),
    adx: round(adx),
    vwap: round(vwap),

    macd: round(macd.value),
    macdSignal: round(macd.signal),

    atr14: round(atr),
    adr14: round(adr14),

    supertrend: supertrend.trend,
    supertrendUpper: supertrend.upper,
    supertrendLower: supertrend.lower,

    volume: last.volume,
    averageVolume: round(avgVolume),

    oi: currentOI,
    previousOI,

    conditions: {
      oiIncrease: oiPass,
      priceUp,
      priceDown,
      volumeIncrease: volumePass,
      rsiBullish: rsi >= CFG.RSI_BUY,
      rsiBearish: rsi <= CFG.RSI_SELL,
      adxStrong: adx >= CFG.ADX_MIN,
      aboveEMA: last.close > ema20,
      belowEMA: last.close < ema20,
      aboveVWAP: last.close > vwap,
      belowVWAP: last.close < vwap,
      macdBullish: macd.histogram > 0,
      macdBearish: macd.histogram < 0
    },

    candleTime: last.time
  };
}

// ============================================================
// OPTION CHAIN
// ============================================================

async function getOptionChain(underlyingKey, expiry) {
  const cacheKey = `${underlyingKey}:${expiry}`;

  const cached = optionCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < CFG.CACHE_MS
  ) {
    return cached.data;
  }

  const path =
    `/v2/option/chain?instrument_key=${enc(underlyingKey)}` +
    `&expiry_date=${enc(expiry)}`;

  const response = await upstoxRequest(path);

  const rows = response.data || [];

  optionCache.set(cacheKey, {
    time: Date.now(),
    data: rows
  });

  return rows;
}

// ============================================================
// SELECT OTM OPTION USING DELTA
// ============================================================

function selectSellingOption(chain, optionAction) {
  const side =
    optionAction === "SELL_CE"
      ? "call_options"
      : "put_options";

  const candidates = [];

  for (const row of chain) {
    const option = row[side];

    if (!option) continue;

    const market = option.market_data || {};
    const greeks = option.option_greeks || {};

    const delta = Math.abs(Number(greeks.delta));

    const bid = Number(market.bid_price || 0);
    const ask = Number(market.ask_price || 0);

    const volume = Number(market.volume || 0);
    const oi = Number(market.oi || 0);

    const key = option.instrument_key;

    if (!key || !bid || !ask || !delta) continue;
    if (delta < CFG.DELTA_MIN || delta > CFG.DELTA_MAX) continue;
    if (volume <= 0 || oi <= 0) continue;

    const spreadPct =
      ((ask - bid) / ((ask + bid) / 2)) * 100;

    if (spreadPct > CFG.MAX_SPREAD_PCT) continue;

    candidates.push({
      instrumentKey: key,
      tradingSymbol: option.trading_symbol || "",
      strikePrice: Number(row.strike_price),
      delta: round(delta, 3),

      bid: round(bid),
      ask: round(ask),

      spreadPct: round(spreadPct),
      volume,
      oi,

      entryReference: round(bid)
    });
  }

  candidates.sort((a, b) =>
    Math.abs(a.delta - 0.22) -
    Math.abs(b.delta - 0.22)
  );

  return candidates[0] || null;
}

// ============================================================
// INDEX SCANNER
// ============================================================

async function scanOneIndex(item) {
  try {
    const [candles, dailyCandles, quote] =
      await Promise.all([
        getClosedCandles(item.futuresKey),
        getDailyCandles(item.futuresKey),
        getMarketQuote(item.futuresKey)
      ]);

    const analysis = analyseCandles(
      candles,
      quote,
      dailyCandles
    );

    const result = {
      symbol: item.symbol,
      kind: "INDEX",

      futuresSymbol: item.futuresSymbol,
      expiry: item.expiry,
      lotSize: item.lotSize,

      ...analysis,

      option: null,
      status: "OK"
    };

    if (
      analysis.optionAction === "SELL_CE" ||
      analysis.optionAction === "SELL_PE"
    ) {
      try {
        const chain = await getOptionChain(
          item.underlyingKey,
          item.expiry
        );

        result.option = selectSellingOption(
          chain,
          analysis.optionAction
        );

        if (!result.option) {
          result.optionStatus =
            "No option matched delta and spread filters";
        }
      } catch (error) {
        result.optionStatus = error.message;
      }
    }

    return result;

  } catch (error) {
    return {
      symbol: item.symbol,
      kind: "INDEX",
      signal: "ERROR",
      status: "ERROR",
      error: error.message
    };
  }
}

// ============================================================
// SCAN ALL FIVE INDICES
// ============================================================

async function runScan() {
  if (scanBusy) {
    return scanCache || [];
  }

  scanBusy = true;

  try {
    if (!masterReady) {
      await refreshMaster();
    }

    const results = [];

    for (
      let i = 0;
      i < universe.length;
      i += CFG.WORKERS
    ) {
      const batch = universe.slice(
        i,
        i + CFG.WORKERS
      );

      const data = await Promise.all(
        batch.map(scanOneIndex)
      );

      results.push(...data);
    }

    scanCache = results;

    return results;

  } finally {
    scanBusy = false;
  }
}

// ============================================================
// HTTP RESPONSE
// ============================================================

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

// ============================================================
// API ROUTES
// ============================================================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        success: true,
        version: CFG.VERSION,
        mode: "LIVE_SIGNAL_MANUAL_TRADE",
        orderPlacement: false,
        marketData: "UPSTOX",
        timeframe: "5 MINUTE CLOSED CANDLES"
      });
    }

    if (url.pathname === "/api/status") {
      return sendJson(res, 200, {
        success: true,
        version: CFG.VERSION,
        masterReady,
        masterBusy,
        scanBusy,
        tokenConfigured: Boolean(TOKEN),
        universeCount: universe.length,
        indexes: universe.map(x => x.symbol),
        expectedIndexes: CFG.INDEXES
      });
    }

    if (url.pathname === "/api/master/refresh") {
      const data = await refreshMaster();

      return sendJson(res, 200, {
        success: true,
        count: data.length,
        indexes: data
      });
    }

    if (
      url.pathname === "/api/scan" ||
      url.pathname === "/api/option-selling/scan"
    ) {
      const results = await runScan();

      return sendJson(res, 200, {
        success: true,
        version: CFG.VERSION,
        mode: "LIVE_SIGNAL_MANUAL_TRADE",
        orderPlacement: false,
        count: results.length,
        results
      });
    }

    if (url.pathname === "/api/strong-sell") {
      const results = await runScan();

      return sendJson(res, 200, {
        success: true,
        results: results.filter(x =>
          x.signal === "VERY_STRONG_BEARISH" &&
          x.optionAction === "SELL_CE"
        )
      });
    }

    if (url.pathname === "/api/call-sell") {
      const results = await runScan();

      return sendJson(res, 200, {
        success: true,
        results: results.filter(x =>
          x.optionAction === "SELL_CE"
        )
      });
    }

    if (url.pathname === "/api/put-sell") {
      const results = await runScan();

      return sendJson(res, 200, {
        success: true,
        results: results.filter(x =>
          x.optionAction === "SELL_PE"
        )
      });
    }

    return sendJson(res, 404, {
      success: false,
      error: "Route not found"
    });

  } catch (error) {
    console.error("[SERVER ERROR]", error);

    return sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, () => {
  console.log("======================================");
  console.log("SMART TRADE INDIA PRO V3");
  console.log("MODE: LIVE SIGNAL + MANUAL TRADE");
  console.log("INDEX ONLY");
  console.log("TIMEFRAME: 5 MIN CLOSED CANDLES");
  console.log("AUTO ORDER: DISABLED");
  console.log("PORT:", PORT);
  console.log("======================================");

  refreshMaster().catch(error => {
    console.error("[MASTER ERROR]", error.message);
  });
});

