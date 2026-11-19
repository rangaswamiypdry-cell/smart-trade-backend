// ============================================================
// SMART TRADE INDIA - 4 INDEX OPTIONS SELL SCANNER
// PART 1 OF 2 | NODE.JS 20+
// NIFTY / BANKNIFTY / SENSEX / FINNIFTY
// Upstox API | 5-minute completed candles
// ============================================================

"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const API = "https://api.upstox.com";
const MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const CONFIG = {
  VERSION: "SMART_TRADE_INDIA_4_INDEX_SELL_V1",

  TIMEFRAME: 5,
  RSI_PERIOD: 14,
  RSI_BULLISH: 55,
  RSI_BEARISH: 45,

  VOLUME_MULTIPLIER: 1.5,
  MIN_CANDLES: 21,

  // OTM option delta filter
  DELTA_MIN: 0.15,
  DELTA_MAX: 0.35,
  TARGET_DELTA: 0.25,

  // Maximum acceptable bid/ask spread
  MAX_SPREAD_PERCENT: 3,

  SCAN_CACHE_MS: 5000,
  OPTION_CACHE_MS: 10000,

  CONCURRENCY: 4
};

const INDEX_NAMES = [
  "NIFTY",
  "BANKNIFTY",
  "SENSEX",
  "FINNIFTY"
];

let indexFutures = [];
let masterLoaded = false;
let masterLoading = false;
let scanRunning = false;
let scanCache = null;

const optionContractsCache = new Map();
const optionChainCache = new Map();
const alertHistory = new Map();

let lastScan = {
  status: "STARTING",
  scanned: 0,
  bullishCount: 0,
  bearishCount: 0,
  updatedAt: null
};

// ============================================================
// BASIC HELPERS
// ============================================================

function round(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
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

function istTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function marketOpen() {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short"
  }).format(new Date());

  if (day === "Sat" || day === "Sun") return false;

  const time = istTime();
  return time >= "09:15" && time <= "15:30";
}

function normalizeExpiry(value) {
  if (!value) return null;

  let date;

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    let timestamp = Number(value);
    if (timestamp < 1000000000000) timestamp *= 1000;
    date = new Date(timestamp);
  } else {
    date = new Date(value);
  }

  if (!Number.isFinite(date.getTime())) return null;

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function normalizeSymbol(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getIndexName(row) {
  const values = [
    row.underlying_symbol,
    row.trading_symbol,
    row.name,
    row.underlying_name
  ].map(normalizeSymbol);

  for (const symbol of values) {
    if (
      symbol === "NIFTY" ||
      symbol === "NIFTY50" ||
      symbol.includes("NIFTY50")
    ) return "NIFTY";

    if (symbol.includes("BANKNIFTY")) return "BANKNIFTY";
    if (symbol.includes("FINNIFTY")) return "FINNIFTY";
    if (symbol.includes("SENSEX")) return "SENSEX";
  }

  return null;
}

// ============================================================
// UPSTOX REQUEST
// ============================================================

async function upstoxGET(path) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN missing in Render");
  }

  const response = await fetch(API + path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`
    },
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `Upstox HTTP ${response.status}`
    );
  }

  return data;
}

// ============================================================
// DOWNLOAD UPSTOX INSTRUMENT MASTER
// ============================================================

async function downloadMaster() {
  const response = await fetch(MASTER_URL, {
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error("Instrument master download failed");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  let rows;

  try {
    rows = JSON.parse(
      zlib.gunzipSync(buffer).toString("utf8")
    );
  } catch {
    rows = JSON.parse(buffer.toString("utf8"));
  }

  if (!Array.isArray(rows)) {
    throw new Error("Invalid instrument master data");
  }

  return rows;
}

// ============================================================
// BUILD ONLY FOUR INDEX FUTURES
// ============================================================

function buildIndexFutures(rows) {
  const today = istDate();
  const selected = new Map();

  for (const row of rows) {
    const segment = String(row.segment || "").toUpperCase();
    const type = String(row.instrument_type || "").toUpperCase();
    const underlyingType =
      String(row.underlying_type || "").toUpperCase();

    if (!["NSE_FO", "BSE_FO"].includes(segment)) continue;
    if (type !== "FUT") continue;
    if (underlyingType !== "INDEX") continue;
    if (!row.instrument_key || !row.underlying_key) continue;

    const symbol = getIndexName(row);
    if (!symbol || !INDEX_NAMES.includes(symbol)) continue;

    const expiry = normalizeExpiry(row.expiry);
    if (!expiry || expiry < today) continue;

    const item = {
      symbol,
      segment,
      futuresKey: row.instrument_key,
      underlyingKey: row.underlying_key,
      futuresSymbol: row.trading_symbol || row.name || symbol,
      expiry,
      lotSize: Number(row.lot_size || 0)
    };

    const old = selected.get(symbol);

    if (!old || expiry < old.expiry) {
      selected.set(symbol, item);
    }
  }

  return INDEX_NAMES
    .filter(name => selected.has(name))
    .map(name => selected.get(name));
}

// ============================================================
// LOAD MASTER
// ============================================================

async function loadMaster(force = false) {
  if (masterLoading) {
    while (masterLoading) await sleep(200);
    return;
  }

  if (masterLoaded && !force) return;

  masterLoading = true;

  try {
    const rows = await downloadMaster();
    indexFutures = buildIndexFutures(rows);
    masterLoaded = true;

    console.log("[MASTER] Four index futures:", indexFutures.length);

    for (const item of indexFutures) {
      console.log(
        "[INDEX]",
        item.symbol,
        item.futuresSymbol,
        item.expiry,
        item.futuresKey
      );
    }

    const missing = INDEX_NAMES.filter(
      name => !indexFutures.some(x => x.symbol === name)
    );

    if (missing.length) {
      console.warn("[MASTER] Index futures not found:", missing);
    }
  } finally {
    masterLoading = false;
  }
}

// ============================================================
// GET COMPLETED 5-MINUTE FUTURES CANDLES
// ============================================================

async function getFiveMinuteCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const result = await upstoxGET(
    `/v3/historical-candle/intraday/${key}/minutes/5`
  );

  const raw = result?.data?.candles || [];
  const now = Date.now();

  return raw
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
      Number.isFinite(c.close) &&
      c.close > 0 &&
      c.time + 5 * 60 * 1000 <= now
    )
    .sort((a, b) => a.time - b.time);
}

// ============================================================
// GET LIVE FUTURES QUOTES
// ============================================================

async function getLiveQuotes(items) {
  const keys = items.map(x => x.futuresKey).filter(Boolean);
  const output = {};

  if (!keys.length) return output;

  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const query = encodeURIComponent(batch.join(","));

    const result = await upstoxGET(
      `/v3/market-quote/quotes?instrument_key=${query}`
    );

    Object.assign(output, result?.data || {});
  }

  return output;
}

function findQuote(item, quotes) {
  if (quotes[item.futuresKey]) return quotes[item.futuresKey];

  return Object.values(quotes).find(
    q => q.instrument_token === item.futuresKey
  ) || null;
}

// ============================================================
// RSI 14
// ============================================================

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

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return round(100 - 100 / (1 + avgGain / avgLoss));
}

// ============================================================
// TODAY CANDLES AND VWAP
// ============================================================

function getTodayCandles(candles) {
  const today = istDate();

  return candles.filter(c =>
    istDate(new Date(c.time)) === today
  );
}

function calculateVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    totalPV += typical * c.volume;
    totalVolume += c.volume;
  }

  if (totalVolume <= 0) return null;

  return round(totalPV / totalVolume);
}

// ============================================================
// CANDLE BODY CONFIRMATION
// ============================================================

function bullishCandle(c) {
  const range = c.high - c.low;
  if (range <= 0) return false;

  const body = c.close - c.open;

  return body > 0 && body / range >= 0.45;
}

function bearishCandle(c) {
  const range = c.high - c.low;
  if (range <= 0) return false;

  const body = c.open - c.close;

  return body > 0 && body / range >= 0.45;
}

// ============================================================
// VOLUME CONFIRMATION
// Latest completed candle vs previous 20 candles
// ============================================================

function analyseVolume(candles) {
  if (candles.length < CONFIG.MIN_CANDLES) {
    return {
      valid: false,
      pass: false,
      ratio: 0,
      averageVolume: 0
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles.slice(-21, -1);

  const averageVolume =
    previous.reduce((sum, c) => sum + c.volume, 0) /
    previous.length;

  const ratio = averageVolume > 0
    ? last.volume / averageVolume
    : 0;

  return {
    valid: true,
    pass: ratio >= CONFIG.VOLUME_MULTIPLIER,
    latestVolume: last.volume,
    averageVolume: round(averageVolume),
    ratio: round(ratio)
  };
}

// ============================================================
// INTRADAY OI CHANGE
// Latest completed candle vs previous completed candle
// ============================================================

function analyseOI(candles) {
  if (candles.length < 2) {
    return {
      valid: false,
      increase: false,
      change: 0
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  if (last.oi <= 0 || previous.oi <= 0) {
    return {
      valid: false,
      increase: false,
      change: 0
    };
  }

  const change = last.oi - previous.oi;

  return {
    valid: true,
    increase: change > 0,
    currentOI: last.oi,
    previousOI: previous.oi,
    change,
    changePercent: round(change / previous.oi * 100)
  };
}

// ============================================================
// OPTION CONTRACT CACHE
// ============================================================

async function getOptionContracts(underlyingKey) {
  const cached = optionContractsCache.get(underlyingKey);

  if (
    cached &&
    Date.now() - cached.time < 60000
  ) {
    return cached.data;
  }

  const key = encodeURIComponent(underlyingKey);

  const result = await upstoxGET(
    `/v2/option/contract?instrument_key=${key}`
  );

  const contracts = result?.data || [];

  if (!Array.isArray(contracts)) {
    throw new Error("Invalid option contracts response");
  }

  optionContractsCache.set(underlyingKey, {
    time: Date.now(),
    data: contracts
  });

  return contracts;
}

// ============================================================
// NEAREST OPTION EXPIRY
// ============================================================

function nearestExpiry(contracts) {
  const today = istDate();

  const expiries = [
    ...new Set(
      contracts
        .map(x => normalizeExpiry(x.expiry))
        .filter(x => x && x >= today)
    )
  ].sort();

  return expiries[0] || null;
}

// ============================================================
// OPTION CHAIN CACHE
// ============================================================

async function getOptionChain(underlyingKey, expiry) {
  const cacheKey = `${underlyingKey}_${expiry}`;
  const cached = optionChainCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < CONFIG.OPTION_CACHE_MS
  ) {
    return cached.data;
  }

  const key = encodeURIComponent(underlyingKey);
  const exp = encodeURIComponent(expiry);

  const result = await upstoxGET(
    `/v2/option/chain?instrument_key=${key}&expiry_date=${exp}`
  );

  const chain = result?.data || [];

  if (!Array.isArray(chain)) {
    throw new Error("Invalid option chain response");
  }

  optionChainCache.set(cacheKey, {
    time: Date.now(),
    data: chain
  });

  return chain;
}

// ============================================================
// OPTION MARKET DATA
// ============================================================

function optionData(option) {
  const market = option?.market_data || {};
  const greeks = option?.option_greeks || {};

  return {
    instrumentKey: option?.instrument_key || null,
    ltp: Number(market.ltp || 0),
    volume: Number(market.volume || 0),
    oi: Number(market.oi || 0),
    bid: Number(market.bid_price || 0),
    ask: Number(market.ask_price || 0),
    bidQty: Number(market.bid_qty || 0),
    askQty: Number(market.ask_qty || 0),
    delta: Number(greeks.delta || 0)
  };
}

// ============================================================
// OTM OPTION SELL STRIKE SELECTOR
// Bullish = OTM PE SELL
// Bearish = OTM CE SELL
// ============================================================

async function selectOTMSellOption(index, direction) {
  const contracts = await getOptionContracts(index.underlyingKey);

  if (!contracts.length) {
    return {
      success: false,
      reason: "NO_OPTION_CONTRACTS"
    };
  }

  const expiry = nearestExpiry(contracts);

  if (!expiry) {
    return {
      success: false,
      reason: "NO_VALID_EXPIRY"
    };
  }

  const chain = await getOptionChain(
    index.underlyingKey,
    expiry
  );

  if (!chain.length) {
    return {
      success: false,
      reason: "OPTION_CHAIN_EMPTY"
    };
  }

  const optionType = direction === "BULLISH" ? "PE" : "CE";
  const candidates = [];

  for (const row of chain) {
    const strike = Number(row.strike_price || 0);
    const spot = Number(row.underlying_spot_price || 0);

    if (strike <= 0 || spot <= 0) continue;

    // OTM PE must be below spot.
    if (optionType === "PE" && strike >= spot) continue;

    // OTM CE must be above spot.
    if (optionType === "CE" && strike <= spot) continue;

    const option = optionType === "PE"
      ? row.put_options
      : row.call_options;

    if (!option) continue;

    const data = optionData(option);
    const absDelta = Math.abs(data.delta);

    if (!data.instrumentKey || data.ltp <= 0) continue;
    if (data.volume <= 0 || data.oi <= 0) continue;
    if (data.bid <= 0 || data.ask <= 0) continue;
    if (data.ask < data.bid) continue;

    if (
      absDelta < CONFIG.DELTA_MIN ||
      absDelta > CONFIG.DELTA_MAX
    ) continue;

    const spreadPercent =
      ((data.ask - data.bid) / data.ltp) * 100;

    if (spreadPercent > CONFIG.MAX_SPREAD_PERCENT) continue;

    const contract = contracts.find(
      c => c.instrument_key === data.instrumentKey
    );

    // Prefer a liquid strike with delta near 0.25.
    const score =
      Math.abs(absDelta - CONFIG.TARGET_DELTA) * 100 +
      spreadPercent * 2 -
      Math.min(data.volume / 100000, 2) -
      Math.min(data.oi / 1000000, 2);

    candidates.push({
      symbol: index.symbol,
      direction,
      action: `SELL_${optionType}`,
      optionType,
      strikePrice: strike,
      expiry,
      underlyingSpot: spot,
      instrumentKey: data.instrumentKey,
      tradingSymbol: contract?.trading_symbol || null,
      lotSize: Number(contract?.lot_size || 0),
      ltp: round(data.ltp),
      bidPrice: round(data.bid),
      askPrice: round(data.ask),
      volume: data.volume,
      oi: data.oi,
      delta: round(data.delta),
      spreadPercent: round(spreadPercent),
      score: round(score)
    });
  }

  if (!candidates.length) {
    return {
      success: false,
      reason: "NO_LIQUID_OTM_OPTION_MATCHED"
    };
  }

  candidates.sort((a, b) => a.score - b.score);

  return {
    success: true,
    ...candidates[0],
    selectionMethod:
      "OTM + DELTA + VOLUME + OI + BID_ASK_SPREAD",
    updatedAt: new Date().toISOString()
  };
}

// ============================================================
// SMART TRADE INDIA - 4 INDEX OPTIONS SELL SCANNER
// PART 2 OF 2
// SIGNAL ENGINE + SCANNER + API SERVER
// ============================================================

// ============================================================
// ANALYSE ONE INDEX
// All six conditions are mandatory.
// ============================================================

async function analyseIndex(index, candles, liveQuote) {
  const base = {
    symbol: index.symbol,
    futuresSymbol: index.futuresSymbol,
    futuresKey: index.futuresKey,
    expiry: index.expiry,
    underlyingKey: index.underlyingKey
  };

  if (!Array.isArray(candles) ||
      candles.length < CONFIG.MIN_CANDLES) {
    return {
      ...base,
      signal: "WAIT",
      signalType: "WAITING",
      reason: "INSUFFICIENT_COMPLETED_CANDLES"
    };
  }

  const todayCandles = getTodayCandles(candles);

  if (todayCandles.length < 3) {
    return {
      ...base,
      signal: "WAIT",
      signalType: "WAITING",
      reason: "INSUFFICIENT_TODAY_CANDLES"
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const vwap = calculateVWAP(todayCandles);

  const volume = analyseVolume(candles);
  const oi = analyseOI(candles);

  // 1. OI must increase.
  const oiIncrease = oi.valid && oi.increase;

  // 2. Latest completed candle volume must be 1.5x average.
  const volumeIncrease = volume.valid && volume.pass;

  // 3. Price direction.
  const priceUp = last.close > previous.close;
  const priceDown = last.close < previous.close;

  // 4. VWAP direction.
  const aboveVWAP = vwap !== null && last.close > vwap;
  const belowVWAP = vwap !== null && last.close < vwap;

  // 5. RSI direction.
  const rsiBullish =
    rsi !== null && rsi > CONFIG.RSI_BULLISH;

  const rsiBearish =
    rsi !== null && rsi < CONFIG.RSI_BEARISH;

  // 6. Completed candle confirmation.
  const bullishConfirmation = bullishCandle(last);
  const bearishConfirmation = bearishCandle(last);

  // ALL SIX CONDITIONS MUST PASS.
  const bullishChecks = {
    oiIncrease,
    volumeIncrease,
    priceUp,
    aboveVWAP,
    rsiBullish,
    bullishCandle: bullishConfirmation
  };

  const bearishChecks = {
    oiIncrease,
    volumeIncrease,
    priceDown,
    belowVWAP,
    rsiBearish,
    bearishCandle: bearishConfirmation
  };

  const bullishStrong =
    Object.values(bullishChecks).every(Boolean);

  const bearishStrong =
    Object.values(bearishChecks).every(Boolean);

  let signal = "WAIT";
  let signalType = "WAITING";
  let option = null;
  let optionError = null;

  // Bullish index => SELL OTM PE.
  if (bullishStrong) {
    signal = "SELL_PE";
    signalType = "VERY_STRONG_BULLISH";
  }

  // Bearish index => SELL OTM CE.
  else if (bearishStrong) {
    signal = "SELL_CE";
    signalType = "VERY_STRONG_BEARISH";
  }

  // Option strike selection only after full confirmation.
  if (bullishStrong || bearishStrong) {
    const direction = bullishStrong ? "BULLISH" : "BEARISH";

    try {
      option = await selectOTMSellOption(index, direction);
    } catch (error) {
      optionError = error.message;
    }
  }

  const livePrice = Number(liveQuote?.last_price || 0);
  const liveVolume = Number(liveQuote?.volume || 0);
  const liveOI = Number(liveQuote?.oi || 0);

  return {
    ...base,

    signal,
    signalType,

    alert:
      bullishStrong || bearishStrong
        ? "VERY_STRONG_SELL"
        : "NO_CONFIRMED_SIGNAL",

    optionAction:
      bullishStrong
        ? "OTM PE SELL"
        : bearishStrong
          ? "OTM CE SELL"
          : null,

    conditions: {
      bullish: bullishChecks,
      bearish: bearishChecks
    },

    confirmedConditions:
      bullishStrong
        ? Object.values(bullishChecks).filter(Boolean).length
        : bearishStrong
          ? Object.values(bearishChecks).filter(Boolean).length
          : 0,

    requiredConditions: 6,

    candle: {
      time: new Date(last.time).toISOString(),
      open: round(last.open),
      high: round(last.high),
      low: round(last.low),
      close: round(last.close),
      volume: last.volume,
      oi: last.oi
    },

    live: {
      price: round(livePrice),
      dayVolume: liveVolume,
      currentOI: liveOI,
      previousDayClose: round(liveQuote?.prev_close_price),
      previousDayOI: Number(liveQuote?.previous_oi || 0),
      quoteTimestamp: liveQuote?.timestamp || null
    },

    indicators: {
      rsi,
      vwap,
      volumeRatio: volume.ratio,
      averageVolume: volume.averageVolume,
      candleVolume: volume.latestVolume,
      oi: oi.currentOI || 0,
      previousCandleOI: oi.previousOI || 0,
      oiChange: oi.change || 0,
      oiChangePercent: oi.changePercent || 0
    },

    option,
    optionError,

    timeframe: "5 MINUTES",
    updatedAt: new Date().toISOString()
  };
}

// ============================================================
// ALERT HISTORY
// ============================================================

function saveAlert(result) {
  if (
    result.signal !== "SELL_PE" &&
    result.signal !== "SELL_CE"
  ) {
    return;
  }

  const candleTime = result.candle?.time || "";
  const key = `${result.symbol}_${result.signal}_${candleTime}`;

  // Do not create duplicate alert for the same candle.
  if (alertHistory.has(key)) return;

  const alert = {
    id: key,
    symbol: result.symbol,
    signal: result.signal,
    signalType: result.signalType,
    optionAction: result.optionAction,
    option: result.option,
    futuresPrice: result.candle?.close || null,
    rsi: result.indicators?.rsi || null,
    vwap: result.indicators?.vwap || null,
    oiChange: result.indicators?.oiChange || 0,
    volumeRatio: result.indicators?.volumeRatio || 0,
    candleTime,
    createdAt: new Date().toISOString()
  };

  alertHistory.set(key, alert);

  // Keep the latest 100 alerts.
  while (alertHistory.size > 100) {
    const oldest = alertHistory.keys().next().value;
    alertHistory.delete(oldest);
  }

  console.log(
    "[VERY STRONG ALERT]",
    alert.symbol,
    alert.optionAction,
    alert.option?.strikePrice || "STRIKE NOT SELECTED"
  );
}

// ============================================================
// WORKER POOL
// ============================================================

async function runWorkers(items, worker, limit) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (true) {
      const current = nextIndex++;

      if (current >= items.length) return;

      try {
        results[current] = await worker(items[current]);
      } catch (error) {
        results[current] = {
          symbol: items[current].symbol,
          signal: "ERROR",
          signalType: "ERROR",
          reason: error.message
        };
      }
    }
  }

  const count = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: count }, () => runOne())
  );

  return results;
}

// ============================================================
// MAIN SCANNER
// ============================================================

async function runScan(force = false) {
  if (
    !force &&
    scanCache &&
    Date.now() - scanCache.time < CONFIG.SCAN_CACHE_MS
  ) {
    return scanCache.data;
  }

  if (scanRunning) {
    if (scanCache) return scanCache.data;
    throw new Error("SCAN_ALREADY_RUNNING");
  }

  scanRunning = true;

  try {
    await loadMaster();

    if (!indexFutures.length) {
      throw new Error(
        "NO_INDEX_FUTURES_FOUND_CHECK_INSTRUMENT_MASTER"
      );
    }

    // Live quote request for four futures only.
    const quotes = await getLiveQuotes(indexFutures);

    // Fetch completed 5-minute futures candles.
    const results = await runWorkers(
      indexFutures,

      async index => {
        const candles = await getFiveMinuteCandles(
          index.futuresKey
        );

        const quote = findQuote(index, quotes);

        return analyseIndex(index, candles, quote);
      },

      CONFIG.CONCURRENCY
    );

    const bullish = results.filter(
      x => x.signalType === "VERY_STRONG_BULLISH"
    );

    const bearish = results.filter(
      x => x.signalType === "VERY_STRONG_BEARISH"
    );

    const waiting = results.filter(
      x => x.signalType === "WAITING"
    );

    const errors = results.filter(
      x => x.signalType === "ERROR"
    );

    const signals = [...bullish, ...bearish];

    for (const item of signals) {
      saveAlert(item);
    }

    const data = {
      status: "SUCCESS",
      scanner: CONFIG.VERSION,

      market: "INDIA INDEX FUTURES",
      timeframe: "5 MINUTES",

      marketOpen: marketOpen(),
      marketTime: istTime(),

      scanned: results.length,

      bullishCount: bullish.length,
      bearishCount: bearish.length,
      veryStrongSellCount: signals.length,

      waitingCount: waiting.length,
      errorCount: errors.length,

      // Bullish => OTM PE SELL.
      bullishPeSell: bullish,

      // Bearish => OTM CE SELL.
      bearishCeSell: bearish,

      // Combined alerts.
      alerts: signals,

      // All four index statuses.
      indices: results,

      updatedAt: new Date().toISOString()
    };

    lastScan = {
      status: "SUCCESS",
      scanned: data.scanned,
      bullishCount: data.bullishCount,
      bearishCount: data.bearishCount,
      updatedAt: data.updatedAt
    };

    scanCache = {
      time: Date.now(),
      data
    };

    return data;

  } finally {
    scanRunning = false;
  }
}

// ============================================================
// JSON RESPONSE
// ============================================================

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    // HEALTH
    if (path === "/" || path === "/health") {
      return sendJson(res, 200, {
        status: "OK",
        app: "SMART TRADE INDIA",
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        marketOpen: marketOpen(),
        marketTime: istTime()
      });
    }

    // STATUS
    if (path === "/api/status") {
      return sendJson(res, 200, {
        status: "OK",
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        masterLoaded,
        indexCount: indexFutures.length,
        indices: indexFutures,
        lastScan
      });
    }

    // ONLY FOUR INDEX FUTURES
    if (path === "/api/index-futures") {
      await loadMaster();

      return sendJson(res, 200, {
        status: "SUCCESS",
        count: indexFutures.length,
        indices: indexFutures
      });
    }

    // MAIN SCAN
    if (path === "/api/scan") {
      const force =
        url.searchParams.get("force") === "true";

      const data = await runScan(force);

      return sendJson(res, 200, data);
    }

    // BULLISH => PE SELL
    if (path === "/api/bullish-pe-sell") {
      const data = await runScan();

      return sendJson(res, 200, {
        status: data.status,
        count: data.bullishCount,
        signals: data.bullishPeSell
      });
    }

    // BEARISH => CE SELL
    if (path === "/api/bearish-ce-sell") {
      const data = await runScan();

      return sendJson(res, 200, {
        status: data.status,
        count: data.bearishCount,
        signals: data.bearishCeSell
      });
    }

    // ALL VERY STRONG SELL ALERTS
    if (path === "/api/strong-sell") {
      const data = await runScan();

      return sendJson(res, 200, {
        status: data.status,
        count: data.veryStrongSellCount,
        bullishPeSell: data.bullishPeSell,
        bearishCeSell: data.bearishCeSell,
        alerts: data.alerts
      });
    }

    // ALERT HISTORY
    if (path === "/api/alerts") {
      return sendJson(res, 200, {
        status: "SUCCESS",
        count: alertHistory.size,
        alerts: [...alertHistory.values()].reverse()
      });
    }

    // MASTER REFRESH
    if (path === "/api/master/refresh") {
      await loadMaster(true);
      scanCache = null;

      return sendJson(res, 200, {
        status: "SUCCESS",
        count: indexFutures.length,
        indices: indexFutures
      });
    }

    // FORCE NEW SCAN
    if (path === "/api/scan/refresh") {
      const data = await runScan(true);
      return sendJson(res, 200, data);
    }

    // NOT FOUND
    return sendJson(res, 404, {
      status: "ERROR",
      message: "ROUTE_NOT_FOUND",
      path
    });

  } catch (error) {
    console.error("[API ERROR]", path, error.message);

    return sendJson(res, 500, {
      status: "ERROR",
      message: error.message,
      marketTime: istTime()
    });
  }
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log(" SMART TRADE INDIA - 4 INDEX SCANNER");
  console.log(" NIFTY | BANKNIFTY | SENSEX | FINNIFTY");
  console.log(" BULLISH  : OTM PE SELL");
  console.log(" BEARISH  : OTM CE SELL");
  console.log(" 6 CONDITIONS - ALL MANDATORY");
  console.log(" LIVE UPSTOX QUOTES + 5M CANDLES");
  console.log(" ALERT ONLY - NO LIVE ORDERS");
  console.log(" PORT:", PORT);
  console.log("========================================");

  loadMaster().catch(error => {
    console.error("[MASTER LOAD ERROR]", error.message);
  });
});
