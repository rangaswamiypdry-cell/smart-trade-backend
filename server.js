
"use strict";

// ======================================================
// SMART TRADE INDIA V13 PRO
// PART 1 OF 3
// LIVE DATA + HISTORICAL CANDLES + FUTURES OI ENGINE
// NODE.JS 20+
// ======================================================

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const BASE = "https://api.upstox.com";

const CONFIG = {
  VERSION: "SMART_TRADE_INDIA_V13_PRO",

  TIMEFRAME: 5,
  SCAN_INTERVAL: 60000,

  EMA_FAST: 9,
  EMA_SLOW: 21,
  EMA_TREND: 50,

  RSI_PERIOD: 14,
  RSI_BUY: 55,
  RSI_SELL: 35,

  ADX_MIN: 20,
  VOLUME_MULTIPLIER: 1.5,
  OI_INCREASE_MIN: 2,

  MIN_CANDLES: 50,
  MAX_SIGNALS: 100,

  REQUIRE_ALL_CONDITIONS: true,
  PAPER_MODE: true,

  HISTORICAL_DAYS: 7,
  MAX_CANDLE_AGE_MINUTES: 10
};

// ======================================================
// FOUR INDEXES ONLY
// ======================================================

const INDEXES = {
  NIFTY: {
    spotKey: "NSE_INDEX|Nifty 50",
    symbol: "NIFTY",
    segment: "NSE_FO"
  },

  BANKNIFTY: {
    spotKey: "NSE_INDEX|Nifty Bank",
    symbol: "BANKNIFTY",
    segment: "NSE_FO"
  },

  FINNIFTY: {
    spotKey: "NSE_INDEX|Nifty Fin Service",
    symbol: "FINNIFTY",
    segment: "NSE_FO"
  },

  SENSEX: {
    spotKey: "BSE_INDEX|SENSEX",
    symbol: "SENSEX",
    segment: "BSE_FO"
  }
};

// ======================================================
// GLOBAL STORAGE
// ======================================================

const marketCache = new Map();
const signals = [];

const previousOI = new Map();
const oiSnapshots = new Map();

const candleCache = new Map();
const signalIds = new Set();

let instrumentMaster = [];
let instrumentMasterTime = 0;

let lastScanTime = null;
let scanRunning = false;

const serverStarted = new Date().toISOString();

// ======================================================
// TIME HELPERS
// ======================================================

function indiaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function indiaTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}

function getPreviousDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return indiaDate(d);
}

function isCompletedCandle(time) {
  const closeTime = time + CONFIG.TIMEFRAME * 60000;

  return closeTime <= Date.now();
}

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data, null, 2));
}

// ======================================================
// UPSTOX REQUEST
// ======================================================

async function upstoxRequest(path) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN missing in Render");
  }

  const response = await fetch(BASE + path, {
    method: "GET",

    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + TOKEN
    },

    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      "UPSTOX " + response.status + ": " +
      JSON.stringify(data)
    );
  }

  return data;
}

// ======================================================
// INSTRUMENT MASTER
// ======================================================

async function loadInstrumentMaster(force = false) {
  const fresh =
    instrumentMaster.length > 0 &&
    Date.now() - instrumentMasterTime < 6 * 60 * 60 * 1000;

  if (fresh && !force) {
    return instrumentMaster;
  }

  const url =
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error("Instrument master download failed");
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const decoded = zlib.gunzipSync(buffer);

  const parsed = JSON.parse(
    decoded.toString("utf8")
  );

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("Invalid instrument master");
  }

  instrumentMaster = parsed;
  instrumentMasterTime = Date.now();

  return instrumentMaster;
}

// ======================================================
// FIND NEAREST FUTURES
// ======================================================

function findNearestFuture(indexName) {
  const config = INDEXES[indexName];

  if (!config) {
    throw new Error("Unknown index " + indexName);
  }

  const today = indiaDate();

  const candidates = instrumentMaster.filter(item => {
    return (
      item.segment === config.segment &&
      item.instrument_type === "FUT" &&
      item.underlying_symbol === config.symbol &&
      item.expiry &&
      String(item.expiry) >= today &&
      item.instrument_key
    );
  });

  candidates.sort((a, b) =>
    String(a.expiry).localeCompare(String(b.expiry))
  );

  if (!candidates.length) {
    throw new Error(indexName + " FUTURES NOT FOUND");
  }

  return candidates[0];
}

// ======================================================
// MARKET QUOTES
// ======================================================

async function getMarketQuotes(keys) {
  const unique = [...new Set(keys.filter(Boolean))];

  const output = {};

  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);

    const result = await upstoxRequest(
      "/v3/market-quote/quotes?instrument_key=" +
      encodeURIComponent(chunk.join(","))
    );

    const entries = Object.entries(result.data || {});

    for (const key of chunk) {
      const normalized = key.replace("|", ":");

      const match = entries.find(([responseKey, value]) =>
        responseKey === normalized ||
        value?.instrument_token === key ||
        value?.instrument_key === key
      );

      if (match) {
        output[key] = match[1];
      }
    }
  }

  return output;
}

// ======================================================
// NORMALIZE QUOTE
// ======================================================

function extractQuote(data) {
  const q = data || {};

  return {
    ltp: Number(q.last_price || 0),

    open: Number(q.ohlc?.open || 0),
    high: Number(q.ohlc?.high || 0),
    low: Number(q.ohlc?.low || 0),

    close: Number(
      q.prev_close_price ||
      q.ohlc?.close || 0
    ),

    volume: Number(q.volume || 0),

    oi: Number(q.oi || 0),
    previousOI: Number(q.previous_oi || 0),

    buyQuantity: Number(q.total_buy_quantity || 0),
    sellQuantity: Number(q.total_sell_quantity || 0),

    timestamp: q.last_trade_time || q.timestamp || null
  };
}

// ======================================================
// CANDLE NORMALIZER
// ======================================================

function normalizeCandles(rows) {
  const now = Date.now();

  return (rows || [])
    .map(c => ({
      time: new Date(c[0]).getTime(),

      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),

      volume: Number(c[5] || 0),
      oi: Number(c[6] || 0)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      c.close > 0 &&
      isCompletedCandle(c.time) &&
      c.time >= now - 32 * 24 * 60 * 60 * 1000
    );
}

// ======================================================
// HISTORICAL + INTRADAY 5 MINUTE CANDLES
// ======================================================

async function getCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const toDate = indiaDate();
  const fromDate = getPreviousDate(CONFIG.HISTORICAL_DAYS);

  const historicalPath =
    `/v3/historical-candle/${key}/minutes/5/${toDate}/${fromDate}`;

  const intradayPath =
    `/v3/historical-candle/intraday/${key}/minutes/5`;

  const [historical, intraday] = await Promise.all([
    upstoxRequest(historicalPath),
    upstoxRequest(intradayPath)
  ]);

  const combined = [
    ...(historical.data?.candles || []),
    ...(intraday.data?.candles || [])
  ];

  const normalized = normalizeCandles(combined);

  const unique = new Map();

  for (const candle of normalized) {
    unique.set(candle.time, candle);
  }

  const candles = [...unique.values()]
    .sort((a, b) => a.time - b.time);

  if (candles.length < CONFIG.MIN_CANDLES) {
    throw new Error(
      `Need ${CONFIG.MIN_CANDLES} completed candles; received ${candles.length}`
    );
  }

  candleCache.set(instrumentKey, candles);

  return candles;
}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period) {
  if (!values || values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ======================================================
// WILDER RSI
// ======================================================

function calculateRSI(values, period = 14) {
  if (!values || values.length <= period) return null;

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

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// ======================================================
// SESSION VWAP
// ======================================================

function calculateSessionVWAP(candles) {
  if (!candles?.length) return null;

  const today = indiaDate();

  const session = candles.filter(c =>
    indiaDate(new Date(c.time)) === today
  );

  let pv = 0;
  let volume = 0;

  for (const c of session) {
    const typical = (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    volume += c.volume;
  }

  return volume > 0 ? pv / volume : null;
}

// ======================================================
// OI TRACKING BY COMPLETED CANDLE
// ======================================================

function calculateOIChange(key, currentOI, candleTime) {
  if (!currentOI || currentOI <= 0) {
    return {
      ready: false,
      change: null,
      percent: null,
      increasing: false
    };
  }

  const previous = previousOI.get(key);

  // Same candle: do not overwrite baseline.
  if (previous && previous.candleTime === candleTime) {
    return previous.result;
  }

  const result = previous
    ? {
        ready: true,
        change: currentOI - previous.oi,

        percent:
          previous.oi > 0
            ? ((currentOI - previous.oi) / previous.oi) * 100
            : 0,

        increasing: currentOI > previous.oi
      }
    : {
        ready: false,
        change: 0,
        percent: 0,
        increasing: false
      };

  previousOI.set(key, {
    oi: currentOI,
    candleTime,
    result
  });

  oiSnapshots.set(key, {
    currentOI,
    candleTime,
    updatedAt: new Date().toISOString()
  });

  return result;
}


// ======================================================
// SMART TRADE INDIA V13 PRO
// PART 2 OF 3
// TREND + SIX CONDITIONS + SELL SIGNAL ENGINE
// ======================================================

// ------------------------------------------------------
// ADX CALCULATION
// ------------------------------------------------------

function calculateADX(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) {
    return null;
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];

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

    const t = tr.slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    const p = plusDM.slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    const m = minusDM.slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    if (!t) continue;

    const pdi = 100 * p / t;
    const mdi = 100 * m / t;

    dx.push(
      100 * Math.abs(pdi - mdi) /
      Math.max(pdi + mdi, 0.000001)
    );
  }

  if (dx.length < period) return null;

  return dx.slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

// ------------------------------------------------------
// MACD
// ------------------------------------------------------

function calculateMACD(values) {
  if (!values || values.length < 35) return null;

  const fast = calculateEMA(values, 12);
  const slow = calculateEMA(values, 26);

  if (fast === null || slow === null) return null;

  return {
    macd: fast - slow
  };
}

// ------------------------------------------------------
// AVERAGE DAILY RANGE PROXY
// ------------------------------------------------------

function calculateADR(candles, period = 14) {
  if (!candles || candles.length < period) return null;

  const recent = candles.slice(-period);

  return recent.reduce(
    (sum, c) => sum + (c.high - c.low),
    0
  ) / period;
}

// ------------------------------------------------------
// ORDER FLOW PROXY
// ------------------------------------------------------

function calculateOrderFlow(quote) {
  const buy = Number(quote.buyQuantity || 0);
  const sell = Number(quote.sellQuantity || 0);

  const total = buy + sell;

  return {
    buyQuantity: buy,
    sellQuantity: sell,

    imbalance: buy - sell,

    imbalancePercent: total
      ? ((buy - sell) / total) * 100
      : null,

    buyPressure: buy > sell,
    sellPressure: sell > buy
  };
}

// ------------------------------------------------------
// MARKET TREND DETECTION
// ------------------------------------------------------

function detectMarketTrend(candles, quote) {
  const closes = candles.map(c => c.close);

  const ema9 = calculateEMA(closes, CONFIG.EMA_FAST);
  const ema21 = calculateEMA(closes, CONFIG.EMA_SLOW);
  const ema50 = calculateEMA(closes, CONFIG.EMA_TREND);

  const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const vwap = calculateSessionVWAP(candles);
  const adx = calculateADX(candles, 14);

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const bullish =
    ema9 !== null &&
    ema21 !== null &&
    ema50 !== null &&
    adx !== null &&
    ema9 > ema21 &&
    ema21 > ema50 &&
    last.close > ema50 &&
    adx >= CONFIG.ADX_MIN;

  const bearish =
    ema9 !== null &&
    ema21 !== null &&
    ema50 !== null &&
    adx !== null &&
    ema9 < ema21 &&
    ema21 < ema50 &&
    last.close < ema50 &&
    adx >= CONFIG.ADX_MIN;

  let trend = "SIDEWAYS";

  if (bullish) trend = "UPTREND";
  if (bearish) trend = "DOWNTREND";

  return {
    trend,

    bullish,
    bearish,

    ema9,
    ema21,
    ema50,

    rsi,
    vwap,
    adx,

    priceIncreasing: last.close > previous.close,
    priceDecreasing: last.close < previous.close,

    priceAboveVWAP: vwap !== null && last.close > vwap,
    priceBelowVWAP: vwap !== null && last.close < vwap,

    futuresPrice: quote.ltp
  };
}

// ------------------------------------------------------
// VOLUME CONFIRMATION
// ------------------------------------------------------

function checkVolume(candles) {
  if (candles.length < 21) {
    return {
      pass: false,
      current: 0,
      average: 0,
      multiplier: 0
    };
  }

  const last = candles[candles.length - 1];

  const previous20 = candles.slice(-21, -1);

  const average = previous20.reduce(
    (sum, c) => sum + c.volume,
    0
  ) / 20;

  const multiplier = average > 0
    ? last.volume / average
    : 0;

  return {
    pass:
      average > 0 &&
      last.volume >= average * CONFIG.VOLUME_MULTIPLIER,

    current: last.volume,
    average: Math.round(average),
    multiplier: Number(multiplier.toFixed(2))
  };
}

// ------------------------------------------------------
// OI + PRICE CONFIRMATION
// ------------------------------------------------------

function checkOIPattern(oiData, priceUp, priceDown) {
  const valid =
    oiData &&
    oiData.ready &&
    Number.isFinite(oiData.percent);

  const oiIncreasing =
    valid &&
    oiData.percent >= CONFIG.OI_INCREASE_MIN;

  return {
    valid: !!valid,
    oiIncreasing: !!oiIncreasing,

    longBuildUp:
      !!oiIncreasing && priceUp,

    shortBuildUp:
      !!oiIncreasing && priceDown,

    oiChange: oiData?.change ?? null,
    oiChangePercent: oiData?.percent ?? null
  };
}

// ------------------------------------------------------
// SIX CONDITION SELL ANALYSIS
// ------------------------------------------------------

function analyseIndex(
  indexName,
  candles,
  spotQuote,
  futureQuote,
  oiData
) {
  if (!candles || candles.length < CONFIG.MIN_CANDLES) {
    return {
      index: indexName,
      status: "WAIT",
      reason: "Insufficient completed candles"
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const trend = detectMarketTrend(candles, futureQuote);

  const volume = checkVolume(candles);

  const priceUp = last.close > previous.close;
  const priceDown = last.close < previous.close;

  const oi = checkOIPattern(
    oiData,
    priceUp,
    priceDown
  );

  const macd = calculateMACD(
    candles.map(c => c.close)
  );

  const macdUp = macd !== null && macd.macd > 0;
  const macdDown = macd !== null && macd.macd < 0;

  // BULLISH MARKET = PE SELL

  const peChecks = {
    trend: trend.bullish,

    vwap:
      trend.priceAboveVWAP,

    rsi:
      trend.rsi !== null &&
      trend.rsi >= CONFIG.RSI_BUY,

    macd:
      macdUp,

    volume:
      volume.pass,

    oiPrice:
      oi.longBuildUp
  };

  // BEARISH MARKET = CE SELL

  const ceChecks = {
    trend: trend.bearish,

    vwap:
      trend.priceBelowVWAP,

    rsi:
      trend.rsi !== null &&
      trend.rsi <= CONFIG.RSI_SELL,

    macd:
      macdDown,

    volume:
      volume.pass,

    oiPrice:
      oi.shortBuildUp
  };

  const peScore = Object.values(peChecks)
    .filter(Boolean).length;

  const ceScore = Object.values(ceChecks)
    .filter(Boolean).length;

  let direction = null;

  if (
    CONFIG.REQUIRE_ALL_CONDITIONS &&
    peScore === 6 &&
    trend.trend === "UPTREND"
  ) {
    direction = "PE";
  }

  if (
    CONFIG.REQUIRE_ALL_CONDITIONS &&
    ceScore === 6 &&
    trend.trend === "DOWNTREND"
  ) {
    direction = "CE";
  }

  const allValid =
    trend.rsi !== null &&
    trend.vwap !== null &&
    trend.adx !== null &&
    macd !== null &&
    oi.valid;

  const adr = calculateADR(candles, 14);

  return {
    index: indexName,

    status: direction
      ? "VERY_STRONG_SELL"
      : "WAIT",

    direction,

    trend: trend.trend,

    underlyingPrice: spotQuote.ltp,
    futuresPrice: futureQuote.ltp,

    candleClose: last.close,
    candleTime: new Date(last.time).toISOString(),

    rsi: trend.rsi,
    vwap: trend.vwap,

    ema9: trend.ema9,
    ema21: trend.ema21,
    ema50: trend.ema50,

    adx: trend.adx,
    adr,

    macd: macd?.macd ?? null,

    volume: volume.current,
    averageVolume: volume.average,
    volumeMultiplier: volume.multiplier,

    oi: oiData.currentOI,
    oiChange: oi.change,
    oiChangePercent: oi.oiChangePercent,
    oiReady: oi.valid,

    peScore,
    ceScore,

    peChecks,
    ceChecks,

    dataValid: allValid,

    orderFlow: calculateOrderFlow(futureQuote),

    reason: direction
      ? "ALL SIX CONDITIONS CONFIRMED"
      : "Waiting for all six conditions",

    timestamp: new Date().toISOString()
  };
}

// ------------------------------------------------------
// DUPLICATE CANDLE PROTECTION
// ------------------------------------------------------

function isNewSignal(index, direction, candleTime) {
  const id = `${index}_${direction}_${candleTime}`;

  if (signalIds.has(id)) return false;

  signalIds.add(id);

  return true;
}


// ======================================================
// SMART TRADE INDIA V13 PRO
// PART 3 OF 3
// OPTION SELECTOR + SCANNER + DASHBOARD + API ROUTES
// ======================================================

const scanResults = {};
let lastScanTime = null;

// ------------------------------------------------------
// COMMON HELPERS
// ------------------------------------------------------

function getNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getExpiryDate(value) {
  if (value === undefined || value === null) return "";

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const n = Number(value);
    const d = new Date(n > 100000000000 ? n : n * 1000);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }

  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

function getTodayIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getNextExpiry(contracts) {
  const today = getTodayIndia();

  return contracts
    .map(x => ({
      ...x,
      expiryDate: getExpiryDate(x.expiry)
    }))
    .filter(x => x.expiryDate && x.expiryDate >= today)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))[0];
}

// ------------------------------------------------------
// OPTION CONTRACTS
// ------------------------------------------------------

async function getOptionContracts(indexKey) {
  const url =
    `${BASE}/v2/option/contract?instrument_key=${encodeURIComponent(indexKey)}`;

  const response = await upstoxRequest(url);
  const list = response?.data || [];

  if (!Array.isArray(list)) return [];

  return list;
}

async function getOptionChain(indexKey, expiryDate) {
  if (!expiryDate) return [];

  const url =
    `${BASE}/v2/option/chain?instrument_key=${encodeURIComponent(indexKey)}` +
    `&expiry_date=${encodeURIComponent(expiryDate)}`;

  const response = await upstoxRequest(url);
  return Array.isArray(response?.data) ? response.data : [];
}

// ------------------------------------------------------
// OPTION SELL CANDIDATE SELECTOR
// ------------------------------------------------------

function selectOptionToSell(chain, optionType) {
  if (!Array.isArray(chain) || !chain.length) return null;

  const candidates = [];

  for (const row of chain) {
    const option =
      optionType === "PE"
        ? row.put_options
        : row.call_options;

    if (!option) continue;

    const market = option.market_data || {};
    const greeks = option.option_greeks || {};

    const ltp = getNumber(market.ltp);
    const oi = getNumber(market.oi);
    const volume = getNumber(market.volume);
    const delta = Math.abs(getNumber(greeks.delta));

    if (ltp <= 0 || oi <= 0 || volume <= 0) continue;

    // Avoid extremely low-liquidity contracts.
    if (volume < 1 || oi < 1) continue;

    // Prefer liquid, reasonably priced contracts.
    candidates.push({
      instrumentKey: option.instrument_key || "",
      strike: getNumber(row.strike_price),
      optionType,
      ltp,
      oi,
      volume,
      delta
    });
  }

  if (!candidates.length) return null;

  // Prefer liquidity first, then a moderate absolute delta.
  candidates.sort((a, b) => {
    const scoreA =
      Math.log10(a.oi + 1) +
      Math.log10(a.volume + 1) -
      Math.abs(a.delta - 0.25);

    const scoreB =
      Math.log10(b.oi + 1) +
      Math.log10(b.volume + 1) -
      Math.abs(b.delta - 0.25);

    return scoreB - scoreA;
  });

  return candidates[0];
}

// ------------------------------------------------------
// INDEX SCANNER
// ------------------------------------------------------

async function scanOneIndex(index) {
  try {
    const future = await findNearestFuture(index);

    if (!future || !future.instrument_key) {
      return {
        index: index.name,
        status: "WAIT",
        reason: "Nearest future contract not found"
      };
    }

    const quoteResponse = await getMarketQuotes([
      future.instrument_key
    ]);

    const quote = extractQuote(
      quoteResponse,
      future.instrument_key
    );

    if (!quote) {
      return {
        index: index.name,
        status: "WAIT",
        reason: "Live futures quote unavailable"
      };
    }

    const candles = await getCandles(future.instrument_key);

    if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) {
      return {
        index: index.name,
        status: "WAIT",
        reason: "Not enough completed 5-minute candles",
        candleCount: candles?.length || 0
      };
    }

    // PART 2 analysis: all six conditions are mandatory.
    const analysis = analyseIndex(
      index.name,
      candles,
      quote
    );

    if (!analysis || analysis.signal === "WAIT") {
      return {
        index: index.name,
        status: "WAIT",
        reason: analysis?.reason || "Six conditions not satisfied",
        analysis
      };
    }

    const optionType =
      analysis.signal === "PE_SELL" ? "PE" : "CE";

    // Get nearest valid expiry from actual contracts.
    const contracts = await getOptionContracts(index.instrument_key);
    const expiry = getNextExpiry(contracts);

    if (!expiry) {
      return {
        index: index.name,
        status: "WAIT",
        reason: "Valid option expiry not found",
        analysis
      };
    }

    const chain = await getOptionChain(
      index.instrument_key,
      expiry.expiryDate
    );

    const selectedOption = selectOptionToSell(
      chain,
      optionType
    );

    if (!selectedOption || !selectedOption.instrumentKey) {
      return {
        index: index.name,
        status: "WAIT",
        reason: "Liquid option contract not found",
        analysis
      };
    }

    const candleTime =
      candles[candles.length - 1].time ||
      candles[candles.length - 1].timestamp ||
      "";

    const signalId =
      `${index.name}_${optionType}_${candleTime}`;

    if (!isNewSignal(signalId)) {
      return {
        index: index.name,
        status: "WAIT",
        reason: "Duplicate completed-candle signal",
        analysis
      };
    }

    const signal = {
      id: signalId,
      index: index.name,
      direction: analysis.signal,
      action: `SELL ${optionType}`,
      optionType,
      expiry: expiry.expiryDate,
      strike: selectedOption.strike,
      optionInstrumentKey: selectedOption.instrumentKey,
      optionLtp: selectedOption.ltp,
      optionOI: selectedOption.oi,
      optionVolume: selectedOption.volume,
      futurePrice: getNumber(quote.last_price),
      candleTime,
      timeframe: "5 minute",
      conditionsPassed: 6,
      totalConditions: 6,
      paperMode: CONFIG.PAPER_MODE,
      status: "VERY_STRONG",
      createdAt: new Date().toISOString(),
      analysis
    };

    signals.unshift(signal);

    if (signals.length > CONFIG.MAX_SIGNALS) {
      signals.length = CONFIG.MAX_SIGNALS;
    }

    return {
      index: index.name,
      status: "VERY_STRONG",
      signal
    };

  } catch (error) {
    return {
      index: index.name,
      status: "ERROR",
      reason: error.message
    };
  }
}

// ------------------------------------------------------
// SCAN ALL FOUR INDEXES
// ------------------------------------------------------

async function scanAllIndexes() {
  if (scanRunning) {
    return {
      status: "BUSY",
      message: "Previous scan is still running"
    };
  }

  scanRunning = true;

  try {
    const results = [];

    for (const index of INDEXES) {
      const result = await scanOneIndex(index);
      results.push(result);
      scanResults[index.name] = result;
    }

    lastScanTime = new Date().toISOString();

    return {
      status: "OK",
      lastScanTime,
      results,
      signals: signals.slice(0, 50)
    };

  } finally {
    scanRunning = false;
  }
}

// ------------------------------------------------------
// DASHBOARD HTML
// ------------------------------------------------------

function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMART TRADE INDIA V13 PRO</title>
<style>
body {
  margin: 0;
  padding: 16px;
  background: #101827;
  color: #e8eef8;
  font-family: Arial, sans-serif;
}
h2 { color: #35d0a0; }
button {
  background: #159b75;
  color: white;
  border: 0;
  padding: 12px 18px;
  border-radius: 7px;
  font-size: 15px;
}
.card {
  background: #1b293c;
  padding: 14px;
  margin: 12px 0;
  border-radius: 9px;
  overflow-wrap: anywhere;
}
.good { color: #39dfa2; }
.wait { color: #ffc857; }
.bad { color: #ff7777; }
.small { color: #aab8ca; font-size: 12px; }
</style>
</head>
<body>
<h2>SMART TRADE INDIA V13 PRO</h2>
<p>Live NSE / BSE Index Options Scanner</p>
<p id="status">Connecting...</p>
<button onclick="runScan()">SCAN NOW</button>
<h3>INDEX STATUS</h3>
<div id="indexes"></div>
<h3>VERY STRONG SELL SIGNALS</h3>
<div id="signals"></div>
<script>
async function loadData() {
  try {
    const r = await fetch('/api/scan');
    const d = await r.json();

    document.getElementById('status').innerText =
      'Last scan: ' + (d.lastScanTime || 'Waiting');

    const results = d.results || [];

    document.getElementById('indexes').innerHTML =
      results.map(x => {
        const cls = x.status === 'VERY_STRONG' ? 'good' :
                    x.status === 'ERROR' ? 'bad' : 'wait';

        return '<div class="card"><b>' + x.index +
          '</b><p class="' + cls + '">' + x.status +
          '</p><p class="small">' +
          (x.reason || x.signal?.action || '') +
          '</p></div>';
      }).join('');

    document.getElementById('signals').innerHTML =
      (d.signals || []).map(s =>
        '<div class="card">' +
        '<b class="good">' + s.index + ' — ' + s.action +
        '</b><p>Strike: ' + s.strike +
        '</p><p>Expiry: ' + s.expiry +
        '</p><p>Option LTP: ' + s.optionLtp +
        '</p><p>Future price: ' + s.futurePrice +
        '</p><p>Conditions: ' + s.conditionsPassed +
        '/' + s.totalConditions +
        '</p><p class="small">Paper mode: ' + s.paperMode +
        '</p></div>'
      ).join('') || '<div class="card">No confirmed signals</div>';

  } catch(e) {
    document.getElementById('status').innerText =
      'Dashboard error: ' + e.message;
  }
}

async function runScan() {
  document.getElementById('status').innerText = 'Scanning...';
  try {
    await fetch('/api/scan?run=1');
    await loadData();
  } catch(e) {
    document.getElementById('status').innerText = e.message;
  }
}

loadData();
setInterval(loadData, 15000);
</script>
</body>
</html>`;
}

// ------------------------------------------------------
// HTTP ROUTES
// ------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      });
      return res.end();
    }

    if (path === "/" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });
      return res.end(dashboardHTML());
    }

    if (path === "/health") {
      return sendJson(res, 200, {
        status: "OK",
        version: "SMART_TRADE_INDIA_V13_PRO",
        serverTime: new Date().toISOString(),
        tokenConfigured: Boolean(TOKEN),
        paperMode: CONFIG.PAPER_MODE
      });
    }

    if (path === "/api/status") {
      return sendJson(res, 200, {
        status: "OK",
        version: "V13 PRO",
        tokenConfigured: Boolean(TOKEN),
        scanRunning,
        lastScanTime,
        indexes: INDEXES.map(x => x.name)
      });
    }

    if (path === "/api/indexes") {
      return sendJson(res, 200, {
        indexes: INDEXES.map(x => x.name)
      });
    }

    if (path === "/api/scan") {
      if (url.searchParams.get("run") === "1") {
        const result = await scanAllIndexes();
        return sendJson(res, 200, result);
      }

      return sendJson(res, 200, {
        status: "OK",
        lastScanTime,
        results: Object.values(scanResults),
        signals: signals.slice(0, 50)
      });
    }

    if (path === "/api/signals") {
      return sendJson(res, 200, {
        count: signals.length,
        signals
      });
    }

    if (path === "/api/market") {
      return sendJson(res, 200, {
        indexes: Object.values(scanResults),
        lastScanTime
      });
    }

    if (path === "/api/futures") {
      const data = [];

      for (const index of INDEXES) {
        const future = await findNearestFuture(index);
        data.push({
          index: index.name,
          future: future || null
        });
      }

      return sendJson(res, 200, { data });
    }

    return sendJson(res, 404, {
      status: "NOT_FOUND",
      path
    });

  } catch (error) {
    return sendJson(res, 500, {
      status: "ERROR",
      message: error.message
    });
  }
});

// ------------------------------------------------------
// START SERVER + AUTOMATIC SCAN
// ------------------------------------------------------

async function startServer() {
  if (!TOKEN) {
    console.error("[V13] UPSTOX_ACCESS_TOKEN missing");
  }

  try {
    await loadInstrumentMaster();
    console.log("[V13] Instrument master loaded");
  } catch (error) {
    console.error("[V13] Instrument master error:", error.message);
  }

  server.listen(PORT, () => {
    console.log("====================================");
    console.log("SMART TRADE INDIA V13 PRO RUNNING");
    console.log("PORT:", PORT);
    console.log("PAPER MODE:", CONFIG.PAPER_MODE);
    console.log("INDEXES:", INDEXES.map(x => x.name).join(", "));
    console.log("DASHBOARD: /");
    console.log("HEALTH: /health");
    console.log("SCAN: /api/scan");
    console.log("====================================");
  });

  // Scan immediately, then every configured interval.
  setTimeout(() => {
    scanAllIndexes().catch(err =>
      console.error("[V13] Initial scan error:", err.message)
    );
  }, 3000);

  setInterval(() => {
    scanAllIndexes().catch(err =>
      console.error("[V13] Auto scan error:", err.message)
    );
  }, CONFIG.SCAN_INTERVAL);
}

startServer();


                 
