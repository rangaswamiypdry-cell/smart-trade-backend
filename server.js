
// ============================================================
// SMART TRADE INDIA PRO - LIVE 4 INDEX SELL SCANNER
// PART 1 OF 2 | NODE.JS 20+
// LIVE FUTURES PRICE + CLOSED 5M CANDLES
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
  VERSION: "SMART_TRADE_INDIA_LIVE_V2",
  TIMEFRAME: 5,
  RSI_PERIOD: 14,
  RSI_BULLISH: 55,
  RSI_BEARISH: 45,
  VOLUME_MULTIPLIER: 1.5,
  MIN_CANDLES: 21,
  DELTA_MIN: 0.15,
  DELTA_MAX: 0.35,
  TARGET_DELTA: 0.25,
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

  return istDate(date);
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
// UPSTOX API REQUEST
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
// INSTRUMENT MASTER
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
    throw new Error("Invalid instrument master");
  }

  return rows;
}

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

    console.log("[MASTER] INDEX COUNT:", indexFutures.length);

    for (const item of indexFutures) {
      console.log(
        "[INDEX]",
        item.symbol,
        item.futuresSymbol,
        item.futuresKey
      );
    }

    const missing = INDEX_NAMES.filter(
      name => !indexFutures.some(x => x.symbol === name)
    );

    if (missing.length) {
      console.warn("[MISSING INDEX]", missing);
    }
  } finally {
    masterLoading = false;
  }
}

// ============================================================
// GET CLOSED 5-MINUTE CANDLES
// ============================================================

async function getClosedCandles(instrumentKey) {
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
    .filter(c => {
      const valid =
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0 &&
        c.high >= Math.max(c.open, c.close, c.low) &&
        c.low <= Math.min(c.open, c.close, c.high);

      return valid &&
        c.time + 300000 <= now;
    })
    .sort((a, b) => a.time - b.time);
}

// ============================================================
// LIVE FUTURES QUOTES
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

    const data = result?.data || {};

    Object.assign(output, data);
  }

  return output;
}

// IMPORTANT: ROBUST QUOTE MATCHING

function findQuote(item, quotes) {
  if (!quotes || !item?.futuresKey) return null;

  if (quotes[item.futuresKey]) {
    return quotes[item.futuresKey];
  }

  for (const [key, quote] of Object.entries(quotes)) {
    if (
      key === item.futuresKey ||
      quote?.instrument_token === item.futuresKey ||
      quote?.instrument_key === item.futuresKey
    ) {
      return quote;
    }
  }

  return null;
}

function extractLivePrice(quote) {
  if (!quote) return null;

  const values = [
    quote.last_price,
    quote.ltp,
    quote.last_traded_price
  ];

  for (const value of values) {
    const price = Number(value);

    if (Number.isFinite(price) && price > 0) {
      return price;
    }
  }

  return null;
}

// ============================================================
// RSI 14
// ============================================================

function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) {
    return null;
  }

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

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

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
// CANDLE CONFIRMATION
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
// VOLUME ANALYSIS
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
// OI ANALYSIS
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
// OPTION CONTRACTS
// ============================================================

async function getOptionContracts(underlyingKey) {
  const cached = optionContractsCache.get(underlyingKey);

  if (cached && Date.now() - cached.time < 60000) {
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
// NEAREST EXPIRY
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
// OPTION CHAIN
// ============================================================

async function getOptionChain(underlyingKey, expiry) {
  const cacheKey = `${underlyingKey}_${expiry}`;
  const cached = optionChainCache.get(cacheKey);

  if (cached && Date.now() - cached.time < CONFIG.OPTION_CACHE_MS) {
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
// OTM OPTION SELL SELECTOR
// BULLISH = PE SELL
// BEARISH = CE SELL
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

    if (optionType === "PE" && strike >= spot) continue;
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
    selectionMethod: "OTM + DELTA + VOLUME + OI + SPREAD",
    updatedAt: new Date().toISOString()
  };
}


// ============================================================
// SMART TRADE INDIA PRO - LIVE 4 INDEX SELL SCANNER
// PART 2 OF 2 | NODE.JS 20+
// ANALYSE INDEX + SIX CONDITIONS + LIVE API
// ============================================================

// ============================================================
// ANALYSE INDEX
// ALL SIX CONDITIONS ARE MANDATORY
// ============================================================

async function analyseIndex(index, quotes) {
  const base = {
    symbol: index.symbol,
    indexName: index.symbol,
    futuresSymbol: index.futuresSymbol,
    expiry: index.expiry,
    futuresKey: index.futuresKey,
    livePrice: null,
    price: null,
    rsi: null,
    vwap: null,
    volumeRatio: null,
    oiChange: null,
    option: null,
    signal: "WAIT",
    action: "NO SIGNAL",
    strength: "NONE",
    conditions: {},
    reason: "WAITING FOR DATA",
    updatedAt: new Date().toISOString()
  };

  try {
    // 1. LIVE FUTURES PRICE

    const quote = findQuote(index, quotes);
    const livePrice = extractLivePrice(quote);

    if (!livePrice) {
      return {
        ...base,
        reason: "LIVE FUTURES PRICE NOT AVAILABLE"
      };
    }

    base.livePrice = round(livePrice);
    base.price = round(livePrice);

    // 2. CLOSED 5-MINUTE CANDLES

    const candles = await getClosedCandles(index.futuresKey);

    if (candles.length < CONFIG.MIN_CANDLES) {
      return {
        ...base,
        reason: "NOT ENOUGH CLOSED 5-MINUTE CANDLES"
      };
    }

    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    // 3. RSI

    const closes = candles.map(c => c.close);

    const rsi = calculateRSI(
      closes,
      CONFIG.RSI_PERIOD
    );

    // 4. VWAP

    const todayCandles = getTodayCandles(candles);
    const vwap = calculateVWAP(todayCandles);

    // 5. VOLUME

    const volume = analyseVolume(candles);

    // 6. OI

    const oi = analyseOI(candles);

    base.rsi = rsi;
    base.vwap = vwap;
    base.volumeRatio = volume.ratio;
    base.oiChange = oi.valid ? oi.change : null;

    base.futuresVolume = volume.latestVolume || null;
    base.averageVolume = volume.averageVolume || null;
    base.currentOI = oi.currentOI || null;

    // ========================================================
    // SIX MANDATORY CONDITIONS
    // ========================================================

    const bullishConditions = {
      priceIncrease:
        last.close > previous.close &&
        last.close > last.open,

      volumeIncrease:
        volume.valid && volume.pass,

      oiIncrease:
        oi.valid && oi.increase,

      rsiConfirmation:
        rsi !== null && rsi > CONFIG.RSI_BULLISH,

      vwapConfirmation:
        vwap !== null && last.close > vwap,

      candleConfirmation:
        bullishCandle(last)
    };

    const bearishConditions = {
      priceDecrease:
        last.close < previous.close &&
        last.close < last.open,

      volumeIncrease:
        volume.valid && volume.pass,

      oiIncrease:
        oi.valid && oi.increase,

      rsiConfirmation:
        rsi !== null && rsi < CONFIG.RSI_BEARISH,

      vwapConfirmation:
        vwap !== null && last.close < vwap,

      candleConfirmation:
        bearishCandle(last)
    };

    const bullishCount = Object.values(
      bullishConditions
    ).filter(Boolean).length;

    const bearishCount = Object.values(
      bearishConditions
    ).filter(Boolean).length;

    base.conditions = {
      bullish: bullishConditions,
      bearish: bearishConditions,
      bullishCount,
      bearishCount,
      required: 6
    };

    base.candleTime = new Date(last.time).toISOString();

    // ========================================================
    // SIGNAL SELECTION
    // ========================================================

    let direction = null;

    if (bullishCount === 6) {
      direction = "BULLISH";
    } else if (bearishCount === 6) {
      direction = "BEARISH";
    }

    if (!direction) {
      return {
        ...base,
        signal: "WAIT",
        action: "NO SIGNAL",
        strength: "NONE",
        reason: `BULLISH ${bullishCount}/6 | BEARISH ${bearishCount}/6`
      };
    }

    // ========================================================
    // OPTION SELECTION
    // BULLISH = OTM PE SELL
    // BEARISH = OTM CE SELL
    // ========================================================

    let option;

    try {
      option = await selectOTMSellOption(
        index,
        direction
      );
    } catch (error) {
      return {
        ...base,
        signal: "WAIT",
        action: "NO OPTION",
        reason: `OPTION API ERROR: ${error.message}`,
        conditions: {
          ...base.conditions,
          confirmedDirection: direction
        }
      };
    }

    if (!option.success) {
      return {
        ...base,
        signal: "WAIT",
        action: "NO OPTION",
        reason: option.reason,
        conditions: {
          ...base.conditions,
          confirmedDirection: direction
        }
      };
    }

    // ========================================================
    // FINAL VERY STRONG ALERT
    // ========================================================

    const signal = {
      ...base,

      signal: direction,
      action: direction === "BULLISH"
        ? "OTM PE SELL"
        : "OTM CE SELL",

      strength: "VERY STRONG",
      reason: "ALL SIX CONDITIONS CONFIRMED",

      option,

      alertTime: new Date().toISOString(),

      conditions: {
        ...base.conditions,
        confirmedDirection: direction
      }
    };

    const alertKey =
      `${index.symbol}_${direction}_${option.strikePrice}_${option.expiry}`;

    alertHistory.set(alertKey, signal);

    return signal;

  } catch (error) {
    console.error(
      `[ANALYSE ERROR] ${index.symbol}:`,
      error.message
    );

    return {
      ...base,
      signal: "ERROR",
      reason: error.message
    };
  }
}

// ============================================================
// RUN COMPLETE FOUR INDEX SCAN
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

    return {
      status: "SCANNING",
      message: "Scan already running",
      indexes: []
    };
  }

  scanRunning = true;

  try {
    await loadMaster();

    if (!indexFutures.length) {
      throw new Error("No index futures found in master");
    }

    // LIVE QUOTES FOR ALL FOUR INDEXES

    const quotes = await getLiveQuotes(indexFutures);

    // ANALYSE ALL INDEXES

    const results = await Promise.all(
      indexFutures.map(index =>
        analyseIndex(index, quotes)
      )
    );

    // Ensure missing indexes still appear on dashboard

    const finalIndexes = INDEX_NAMES.map(name => {
      const found = results.find(x => x.symbol === name);

      return found || {
        symbol: name,
        indexName: name,
        livePrice: null,
        price: null,
        rsi: null,
        vwap: null,
        volumeRatio: null,
        oiChange: null,
        signal: "WAIT",
        action: "NO SIGNAL",
        strength: "NONE",
        reason: "INDEX FUTURES NOT FOUND",
        option: null
      };
    });

    const bullish = finalIndexes.filter(
      x => x.signal === "BULLISH" &&
        x.strength === "VERY STRONG"
    );

    const bearish = finalIndexes.filter(
      x => x.signal === "BEARISH" &&
        x.strength === "VERY STRONG"
    );

    const data = {
      status: "SUCCESS",
      version: CONFIG.VERSION,

      market: marketOpen() ? "OPEN" : "CLOSED",

      marketTime: istTime(),

      updatedAt: new Date().toISOString(),

      totalIndexes: 4,

      scanned: finalIndexes.filter(
        x => x.signal !== "ERROR"
      ).length,

      bullishCount: bullish.length,
      bearishCount: bearish.length,

      veryStrongCount: bullish.length + bearish.length,

      bullish,
      bearish,

      indexes: finalIndexes,

      settings: {
        timeframe: "5 MINUTES",
        rsiPeriod: CONFIG.RSI_PERIOD,
        volumeMultiplier: CONFIG.VOLUME_MULTIPLIER,
        mandatoryConditions: 6,
        bullishAction: "OTM PE SELL",
        bearishAction: "OTM CE SELL"
      }
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

  } catch (error) {
    console.error("[SCAN ERROR]", error.message);

    const errorData = {
      status: "ERROR",
      message: error.message,
      market: marketOpen() ? "OPEN" : "CLOSED",
      updatedAt: new Date().toISOString(),
      indexes: INDEX_NAMES.map(name => ({
        symbol: name,
        indexName: name,
        livePrice: null,
        price: null,
        signal: "ERROR",
        reason: error.message
      }))
    };

    lastScan = {
      ...lastScan,
      status: "ERROR",
      error: error.message
    };

    return errorData;

  } finally {
    scanRunning = false;
  }
}

// ============================================================
// HTTP JSON RESPONSE
// ============================================================

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
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

    if (path === "/health" || path === "/api/health") {
      return sendJson(res, 200, {
        status: "OK",
        version: CONFIG.VERSION,
        server: "RUNNING",
        tokenConfigured: Boolean(TOKEN),
        masterLoaded,
        indexesLoaded: indexFutures.length,
        market: marketOpen() ? "OPEN" : "CLOSED",
        time: istTime()
      });
    }

    // SERVER STATUS

    if (path === "/api/status") {
      return sendJson(res, 200, {
        status: "OK",
        lastScan,
        masterLoaded,
        indexes: indexFutures.map(x => ({
          symbol: x.symbol,
          futuresSymbol: x.futuresSymbol,
          expiry: x.expiry,
          futuresKey: x.futuresKey
        }))
      });
    }

    // INDEX LIST

    if (path === "/api/indexes") {
      return sendJson(res, 200, {
        status: "SUCCESS",
        indexes: INDEX_NAMES,
        futures: indexFutures
      });
    }

    // MAIN LIVE SCAN

    if (
      path === "/api/scan" ||
      path === "/api/options/auto-scan"
    ) {
      const force = url.searchParams.get("refresh") === "true";

      const data = await runScan(force);

      return sendJson(res, 200, data);
    }

    // BULLISH PE SELL

    if (
      path === "/api/strong-buy" ||
      path === "/api/strong-bullish"
    ) {
      const data = await runScan();

      return sendJson(res, 200, {
        status: data.status,
        count: data.bullishCount || 0,
        stocks: data.bullish || []
      });
    }

    // BEARISH CE SELL

    if (
      path === "/api/strong-sell" ||
      path === "/api/strong-bearish"
    ) {
      const data = await runScan();

      return sendJson(res, 200, {
        status: data.status,
        count: data.bearishCount || 0,
        stocks: data.bearish || []
      });
    }

    // RECENT ALERTS

    if (path === "/api/alerts") {
      const alerts = Array.from(
        alertHistory.values()
      ).sort((a, b) =>
        new Date(b.alertTime) - new Date(a.alertTime)
      );

      return sendJson(res, 200, {
        status: "SUCCESS",
        count: alerts.length,
        alerts: alerts.slice(0, 50)
      });
    }

    // CONFIGURATION

    if (path === "/api/config") {
      return sendJson(res, 200, {
        status: "SUCCESS",
        version: CONFIG.VERSION,
        config: CONFIG,
        indexes: INDEX_NAMES,
        signalRules: {
          bullish: "ALL 6 CONDITIONS + OTM PE SELL",
          bearish: "ALL 6 CONDITIONS + OTM CE SELL",
          partialSignals: false
        }
      });
    }

    // UNKNOWN ROUTE

    return sendJson(res, 404, {
      status: "ERROR",
      message: "API route not found",
      path
    });

  } catch (error) {
    console.error("[SERVER ERROR]", error.message);

    return sendJson(res, 500, {
      status: "ERROR",
      message: error.message
    });
  }
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, async () => {
  console.log("======================================");
  console.log("SMART TRADE INDIA PRO");
  console.log("VERSION:", CONFIG.VERSION);
  console.log("PORT:", PORT);
  console.log("INDEXES:", INDEX_NAMES.join(", "));
  console.log("TIMEFRAME: 5 MINUTES");
  console.log("BULLISH: OTM PE SELL");
  console.log("BEARISH: OTM CE SELL");
  console.log("CONDITIONS: ALL SIX MANDATORY");
  console.log("======================================");

  try {
    await loadMaster();
    console.log("[SERVER] Instrument master loaded");
  } catch (error) {
    console.error("[MASTER ERROR]", error.message);
  }
});

  
