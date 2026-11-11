// ======================================================
// SMART TRADE INDIA V7
// ORB + VOLUME + LONG BUILDUP SCANNER
// UPSTOX V3 | NODE.JS 20+
// ======================================================

"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const TOKEN =
  process.env.UPSTOX_ACCESS_TOKEN || "";

const API =
  "https://api.upstox.com";

const MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ======================================================
// CONFIGURATION
// ======================================================

const CONFIG = {

  VERSION: "V7_ORB_LONG_BUILDUP",

  TIMEFRAME: 5,

  ORB_START: "09:15",

  ORB_END: "09:30",

  RSI_PERIOD: 14,

  RSI_BUY: 55,

  VOLUME_MULTIPLIER: 1.5,

  STRONG_VOLUME: 2,

  MIN_CANDLES: 21,

  SCAN_LIMIT: 224,

  CONCURRENCY: 3,

  CACHE_MS: 15000

};

// ======================================================
// GLOBAL VARIABLES
// ======================================================

let equityMaster = [];

let futuresMaster = [];

let fnoStocks = [];

let masterLoaded = false;

let masterLoading = false;

let scanRunning = false;

let scanCache = null;

let lastScan = {

  status: "IDLE",

  scanned: 0,

  strongBuy: 0,

  longBuildup: 0,

  shortBuildup: 0,

  waiting: 0

};

// ======================================================
// HELPERS
// ======================================================

function round(value) {

  const n = Number(value);

  return Number.isFinite(n)
    ? Number(n.toFixed(2))
    : null;

}

function sleep(ms) {

  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );

}

function istDate(date = new Date()) {

  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(date);

}

function istTime(date = new Date()) {

  return new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }
  ).format(date);

}

// ======================================================
// MARKET HOURS
// ======================================================

function isMarketOpen() {

  const day = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "Asia/Kolkata",
      weekday: "short"
    }
  ).format(new Date());

  if (day === "Sat" || day === "Sun") {
    return false;
  }

  const time = istTime();

  return time >= "09:15" && time <= "15:30";

}

// ======================================================
// UPSTOX API
// ======================================================

async function upstoxGET(path) {

  if (!TOKEN) {

    throw new Error(
      "UPSTOX_ACCESS_TOKEN missing"
    );

  }

  const response = await fetch(
    API + path,
    {
      method: "GET",

      headers: {

        Accept: "application/json",

        Authorization: `Bearer ${TOKEN}`

      },

      signal: AbortSignal.timeout(20000)

    }
  );

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

// ======================================================
// DOWNLOAD INSTRUMENT MASTER
// ======================================================

async function downloadMaster() {

  const response = await fetch(
    MASTER_URL,
    {
      signal: AbortSignal.timeout(60000)
    }
  );

  if (!response.ok) {

    throw new Error(
      "Instrument Master Download Failed"
    );

  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  let rows;

  try {

    rows = JSON.parse(
      zlib.gunzipSync(buffer).toString("utf8")
    );

  } catch {

    rows = JSON.parse(
      buffer.toString("utf8")
    );

  }

  if (!Array.isArray(rows)) {

    throw new Error(
      "Invalid Instrument Master"
    );

  }

  return rows;

}

// ======================================================
// BUILD NSE F&O STOCKS
// ======================================================

function buildFnoStocks(rows) {

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

  const equityMap = new Map();

  for (const item of equities) {

    equityMap.set(

      item.trading_symbol.toUpperCase(),

      item

    );

  }

  const today = istDate();

  const futureMap = new Map();

  for (const item of futures) {

    const symbol =
      String(item.underlying_symbol)
        .toUpperCase();

    const expiry =
      String(item.expiry).slice(0, 10);

    if (expiry < today) continue;

    if (!futureMap.has(symbol)) {

      futureMap.set(symbol, []);

    }

    futureMap.get(symbol).push(item);

  }

  const result = [];

  for (const [symbol, contracts] of futureMap) {

    const equity = equityMap.get(symbol);

    if (!equity) continue;

    contracts.sort((a, b) =>

      String(a.expiry).localeCompare(
        String(b.expiry)
      )

    );

    const future = contracts[0];

    result.push({

      symbol,

      equityKey: equity.instrument_key,

      futuresKey: future.instrument_key,

      futuresSymbol: future.trading_symbol,

      expiry: future.expiry

    });

  }

  return result

    .sort((a, b) =>
      a.symbol.localeCompare(b.symbol)
    )

    .slice(0, CONFIG.SCAN_LIMIT);

}

// ======================================================
// LOAD MASTER
// ======================================================

async function loadMaster(force = false) {

  if (masterLoading) {

    while (masterLoading) {
      await sleep(200);
    }

    return;

  }

  if (masterLoaded && !force) return;

  masterLoading = true;

  try {

    const rows = await downloadMaster();

    equityMaster = rows.filter(x =>

      x.segment === "NSE_EQ" &&

      x.instrument_type === "EQ"

    );

    futuresMaster = rows.filter(x =>

      x.segment === "NSE_FO" &&

      x.instrument_type === "FUT"

    );

    fnoStocks = buildFnoStocks(rows);

    masterLoaded = true;

    console.log(
      "[V7] Equity:",
      equityMaster.length
    );

    console.log(
      "[V7] Futures:",
      futuresMaster.length
    );

    console.log(
      "[V7] F&O Stocks:",
      fnoStocks.length
    );

  } finally {

    masterLoading = false;

  }

}

// ======================================================
// GET 5 MINUTE CANDLES
// ======================================================

async function getFiveMinuteCandles(instrumentKey) {

  const key = encodeURIComponent(
    instrumentKey
  );

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

      c.time + 5 * 60 * 1000 <= now

    )

    .sort((a, b) =>
      a.time - b.time
    );

}

// ======================================================
// GET FUTURES LIVE QUOTES
// ======================================================

async function getFuturesQuotes(stocks) {

  const quotes = {};

  const keys = stocks

    .map(x => x.futuresKey)

    .filter(Boolean);

  for (let i = 0; i < keys.length; i += 100) {

    const batch = keys.slice(i, i + 100);

    const query = encodeURIComponent(
      batch.join(",")
    );

    const result = await upstoxGET(

      `/v3/market-quote/quotes?instrument_key=${query}`

    );

    Object.assign(
      quotes,
      result.data || {}
    );

  }

  return quotes;

}

// ======================================================
// FIND FUTURES QUOTE
// ======================================================

function findFuturesQuote(stock, quotes) {

  const key = stock.futuresKey;

  if (quotes[key]) return quotes[key];

  return Object.values(quotes).find(q =>

    q.instrument_token === key

  ) || null;

}

// ======================================================
// LONG BUILDUP DETECTION
// ======================================================

function detectLongBuildup(quote) {

  if (!quote) {

    return {

      valid: false,

      reason: "Futures quote unavailable"

    };

  }

  const oi = Number(quote.oi || 0);

  const previousOI =
    Number(quote.previous_oi || 0);

  const price =
    Number(quote.last_price || 0);

  const previousClose =
    Number(quote.prev_close_price || 0);

  if (
    oi <= 0 ||
    previousOI <= 0 ||
    price <= 0 ||
    previousClose <= 0
  ) {

    return {

      valid: false,

      reason: "Futures OI data unavailable"

    };

  }

  const oiChange = oi - previousOI;

  const priceChange = price - previousClose;

  const oiChangePercent =
    (oiChange / previousOI) * 100;

  const longBuildup =

    oiChange > 0 &&

    priceChange > 0;

  return {

    valid: true,

    longBuildup,

    oi,

    previousOI,

    oiChange,

    oiChangePercent: round(oiChangePercent),

    futuresPrice: price,

    previousClose,

    priceChange: round(priceChange),

    classification:

      longBuildup

        ? "LONG_BUILDUP"

        : oiChange > 0 && priceChange < 0

          ? "SHORT_BUILDUP"

          : oiChange < 0 && priceChange > 0

            ? "SHORT_COVERING"

            : oiChange < 0 && priceChange < 0

              ? "LONG_UNWINDING"

              : "NEUTRAL"

  };

}

// ======================================================
// RSI 14
// ======================================================

function calculateRSI(closes, period = 14) {

  if (closes.length <= period) return null;

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
      (avgGain * (period - 1) + Math.max(change, 0))
      / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0))
      / period;

  }

  if (avgLoss === 0) return 100;

  return round(
    100 - 100 / (1 + avgGain / avgLoss)
  );

}


// ======================================================
// VWAP
// ======================================================

function calculateVWAP(candles) {

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {

    const typical =
      (c.high + c.low + c.close) / 3;

    totalPV += typical * c.volume;

    totalVolume += c.volume;

  }

  if (totalVolume === 0) return null;

  return round(totalPV / totalVolume);

}


// ======================================================
// GET TODAY CANDLES
// ======================================================

function getTodayCandles(candles) {

  const today = istDate();

  return candles.filter(c =>

    istDate(new Date(c.time)) === today

  );

}


// ======================================================
// ORB HIGH LOW
// 09:15 TO 09:30
// ======================================================

function calculateORB(candles) {

  const todayCandles = getTodayCandles(candles);

  const opening = todayCandles.filter(c => {

    const time = istTime(new Date(c.time));

    return (
      time >= CONFIG.ORB_START &&
      time < CONFIG.ORB_END
    );

  });

  if (opening.length < 3) {

    return {

      ready: false,

      reason: "Waiting for 3 completed ORB candles"

    };

  }

  return {

    ready: true,

    high: Math.max(
      ...opening.map(c => c.high)
    ),

    low: Math.min(
      ...opening.map(c => c.low)
    ),

    candles: opening.length

  };

}


// ======================================================
// VOLUME ANALYSIS
// ======================================================

function analyseVolume(candles) {

  if (candles.length < CONFIG.MIN_CANDLES) {

    return {

      valid: false,

      ratio: 0,

      averageVolume: 0,

      volumePass: false

    };

  }

  const previous = candles.slice(
    -(CONFIG.MIN_CANDLES),
    -1
  );

  const volumes = previous.map(c => c.volume);

  const averageVolume =

    volumes.reduce((a, b) => a + b, 0) /
    volumes.length;

  const latest =
    candles[candles.length - 1];

  const ratio = averageVolume > 0

    ? latest.volume / averageVolume

    : 0;

  return {

    valid: true,

    latestVolume: latest.volume,

    averageVolume: round(averageVolume),

    ratio: round(ratio),

    volumePass:
      ratio >= CONFIG.VOLUME_MULTIPLIER,

    strongVolume:
      ratio >= CONFIG.STRONG_VOLUME

  };

}


// ======================================================
// CANDLE DIRECTION
// ======================================================

function isBullishCandle(c) {

  const range = c.high - c.low;

  if (range <= 0) return false;

  const body = c.close - c.open;

  return (

    body > 0 &&

    body / range >= 0.45

  );

}

function isBearishCandle(c) {

  const range = c.high - c.low;

  if (range <= 0) return false;

  const body = c.open - c.close;

  return (

    body > 0 &&

    body / range >= 0.45

  );

}


// ======================================================
// ORB BREAKOUT
// ======================================================

function detectORBBreakout(candles, orb) {

  if (!orb.ready) {

    return {
      valid: false,
      reason: orb.reason
    };

  }

  const today = getTodayCandles(candles);

  const afterORB = today.filter(c =>

    istTime(new Date(c.time)) >= CONFIG.ORB_END

  );

  if (afterORB.length < 2) {

    return {
      valid: false,
      reason: "Waiting for post-ORB candles"
    };

  }

  const last = afterORB[afterORB.length - 1];

  const previous = afterORB[afterORB.length - 2];

  const breakout =

    last.close > orb.high &&

    last.close > last.open &&

    previous.close <= orb.high;

  return {

    valid: breakout,

    breakoutPrice: last.close,

    level: orb.high,

    reason: breakout
      ? "ORB HIGH BREAKOUT CONFIRMED"
      : "ORB breakout not confirmed"

  };

}


// ======================================================
// ORB BREAKDOWN
// ======================================================

function detectORBBreakdown(candles, orb) {

  if (!orb.ready) {

    return {
      valid: false,
      reason: orb.reason
    };

  }

  const today = getTodayCandles(candles);

  const afterORB = today.filter(c =>

    istTime(new Date(c.time)) >= CONFIG.ORB_END

  );

  if (afterORB.length < 2) {

    return {
      valid: false,
      reason: "Waiting for post-ORB candles"
    };

  }

  const last = afterORB[afterORB.length - 1];

  const previous = afterORB[afterORB.length - 2];

  const breakdown =

    last.close < orb.low &&

    last.close < last.open &&

    previous.close >= orb.low;

  return {

    valid: breakdown,

    breakdownPrice: last.close,

    level: orb.low,

    reason: breakdown
      ? "ORB LOW BREAKDOWN CONFIRMED"
      : "ORB breakdown not confirmed"

  };

}


// ======================================================
// STOCK ANALYSIS
// ======================================================

function analyseStock(stock, candles, futureQuote) {

  if (!Array.isArray(candles) ||
      candles.length < CONFIG.MIN_CANDLES) {

    return {

      symbol: stock.symbol,

      signal: "WAIT",

      reason: "Insufficient completed candles"

    };

  }

  const today = getTodayCandles(candles);

  if (today.length < 5) {

    return {

      symbol: stock.symbol,

      signal: "WAIT",

      reason: "Insufficient today's candles"

    };

  }

  const last = candles[candles.length - 1];

  const closes = candles.map(c => c.close);

  const rsi = calculateRSI(
    closes,
    CONFIG.RSI_PERIOD
  );

  const vwap = calculateVWAP(today);

  const orb = calculateORB(candles);

  const volume = analyseVolume(candles);

  const oi = detectLongBuildup(futureQuote);

  const breakout = detectORBBreakout(
    candles,
    orb
  );

  const breakdown = detectORBBreakdown(
    candles,
    orb
  );

  const longBuildup =

    oi.valid &&

    oi.classification === "LONG_BUILDUP";

  const shortBuildup =

    oi.valid &&

    oi.classification === "SHORT_BUILDUP";

  const aboveVWAP =

    vwap !== null &&

    last.close > vwap;

  const belowVWAP =

    vwap !== null &&

    last.close < vwap;

  const rsiBullish =

    rsi !== null &&

    rsi > CONFIG.RSI_BUY;

  const rsiBearish =

    rsi !== null &&

    rsi < 45;

  // STRONG BUY

  const strongBuy =

    breakout.valid &&

    volume.volumePass &&

    longBuildup &&

    aboveVWAP &&

    rsiBullish &&

    isBullishCandle(last);

  // STRONG SELL

  const strongSell =

    breakdown.valid &&

    volume.volumePass &&

    shortBuildup &&

    belowVWAP &&

    rsiBearish &&

    isBearishCandle(last);

  // LONG BUILDUP CANDIDATE

  const longCandidate =

    longBuildup &&

    volume.volumePass &&

    aboveVWAP &&

    rsiBullish;

  // SHORT BUILDUP CANDIDATE

  const shortCandidate =

    shortBuildup &&

    volume.volumePass &&

    belowVWAP &&

    rsiBearish;

  let signal = "WAIT";

  let signalType = "WAITING";

  if (strongBuy) {

    signal = "BUY";

    signalType = "STRONG_BUY";

  }

  else if (strongSell) {

    signal = "SELL";

    signalType = "STRONG_SELL";

  }

  else if (longCandidate) {

    signalType = "LONG_BUILDUP";

  }

  else if (shortCandidate) {

    signalType = "SHORT_BUILDUP";

  }

  // ENTRY AND RISK

  const entry = last.close;

  const risk = Math.max(

    entry - Math.min(last.low, orb.low),

    entry * 0.002

  );

  const stopLoss = signal === "BUY"

    ? round(entry - risk)

    : signal === "SELL"

      ? round(entry + risk)

      : null;

  const target1 = signal === "BUY"

    ? round(entry + risk * 2)

    : signal === "SELL"

      ? round(entry - risk * 2)

      : null;

  const target2 = signal === "BUY"

    ? round(entry + risk * 3)

    : signal === "SELL"

      ? round(entry - risk * 3)

      : null;

  const reasons = [];

  if (!orb.ready)
    reasons.push("ORB_NOT_READY");

  if (!breakout.valid && !breakdown.valid)
    reasons.push("ORB_NOT_BROKEN");

  if (!volume.volumePass)
    reasons.push("VOLUME_LOW");

  if (!oi.valid)
    reasons.push("OI_DATA_MISSING");

  else if (!longBuildup && !shortBuildup)
    reasons.push("OI_PRICE_CONFIRMATION_MISSING");

  if (!aboveVWAP && !belowVWAP)
    reasons.push("VWAP_NOT_CONFIRMED");

  if (!rsiBullish && !rsiBearish)
    reasons.push("RSI_NOT_CONFIRMED");

  return {

    symbol: stock.symbol,

    signal,

    signalType,

    reason: reasons.length
      ? reasons.join(", ")
      : "ALL CONDITIONS CONFIRMED",

    price: round(last.close),

    rsi,

    vwap,

    volume: last.volume,

    averageVolume: volume.averageVolume,

    volumeRatio: volume.ratio,

    volumePass: volume.volumePass,

    orbHigh: orb.high ?? null,

    orbLow: orb.low ?? null,

    breakout: breakout.valid,

    breakdown: breakdown.valid,

    futuresSymbol: stock.futuresSymbol,

    futuresPrice: oi.futuresPrice ?? null,

    futuresOI: oi.oi ?? 0,

    previousOI: oi.previousOI ?? 0,

    oiChange: oi.oiChange ?? 0,

    oiChangePercent: oi.oiChangePercent ?? 0,

    oiClassification: oi.classification,

    longBuildup,

    shortBuildup,

    entry: signal === "WAIT" ? null : entry,

    stopLoss,

    target1,

    target2,

    candleTime: istTime(new Date(last.time)),

    timeframe: "5 MINUTES"

  };

}


// ======================================================
// CONCURRENT WORKERS
// ======================================================

async function runWorkers(items, worker, limit) {

  const results = new Array(items.length);

  let index = 0;

  async function run() {

    while (true) {

      const current = index++;

      if (current >= items.length) return;

      try {

        results[current] =
          await worker(items[current]);

      } catch (error) {

        results[current] = {

          symbol: items[current].symbol,

          signal: "ERROR",

          reason: error.message

        };

      }

    }

  }

  await Promise.all(

    Array.from(

      {
        length: Math.min(limit, items.length)
      },

      () => run()

    )

  );

  return results;

}


// ======================================================
// MAIN SCANNER
// ======================================================

async function runScan(force = false) {

  if (

    !force &&

    scanCache &&

    Date.now() - scanCache.time < CONFIG.CACHE_MS

  ) {

    return scanCache.data;

  }

  if (scanRunning) {

    if (scanCache) return scanCache.data;

    throw new Error("Scanner already running");

  }

  scanRunning = true;

  try {

    await loadMaster();

    // Get all Futures OI quotes

    const futureQuotes =
      await getFuturesQuotes(fnoStocks);

    // Scan all stocks

    const results = await runWorkers(

      fnoStocks,

      async stock => {

        const candles =
          await getFiveMinuteCandles(stock.equityKey);

        const quote =
          findFuturesQuote(stock, futureQuotes);

        return analyseStock(
          stock,
          candles,
          quote
        );

      },

      CONFIG.CONCURRENCY

    );

    const strongBuy = results.filter(x =>
      x.signalType === "STRONG_BUY"
    );

    const strongSell = results.filter(x =>
      x.signalType === "STRONG_SELL"
    );

    const longBuildup = results.filter(x =>
      x.signalType === "LONG_BUILDUP"
    );

    const shortBuildup = results.filter(x =>
      x.signalType === "SHORT_BUILDUP"
    );

    const waiting = results.filter(x =>
      x.signal === "WAIT" &&
      x.signalType === "WAITING"
    );

    const errors = results.filter(x =>
      x.signal === "ERROR"
    );

    const data = {

      status: "SUCCESS",

      scanner: CONFIG.VERSION,

      timeframe: "5 MINUTES",

      scanned: fnoStocks.length,

      strongBuyCount: strongBuy.length,

      strongSellCount: strongSell.length,

      longBuildupCount: longBuildup.length,

      shortBuildupCount: shortBuildup.length,

      waitingCount: waiting.length,

      errorCount: errors.length,

      bullish: strongBuy,

      bearish: strongSell,

      strongBuy,

      strongSell,

      longBuildup,

      shortBuildup,

      waiting,

      errors,

      updatedAt: new Date().toISOString()

    };

    lastScan = {

      status: "SUCCESS",

      scanned: data.scanned,

      strongBuy: data.strongBuyCount,

      strongSell: data.strongSellCount,

      longBuildup: data.longBuildupCount,

      shortBuildup: data.shortBuildupCount,

      waiting: data.waitingCount

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


// ======================================================
// GENERIC LIVE QUOTES
// ======================================================

async function getLiveQuotes(keys) {

  if (!keys.length) {

    throw new Error("Instrument keys required");

  }

  if (keys.length > 500) {

    throw new Error("Maximum 500 instrument keys");

  }

  const query = encodeURIComponent(
    keys.join(",")
  );

  return await upstoxGET(

    `/v3/market-quote/quotes?instrument_key=${query}`

  );

}


// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {

  res.writeHead(status, {

    "Content-Type":
      "application/json; charset=utf-8",

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",

    "Cache-Control": "no-store"

  });

  res.end(JSON.stringify(data));

}


// ======================================================
// API SERVER
// ======================================================

const server = http.createServer(
  async (req, res) => {

    if (req.method === "OPTIONS") {

      res.writeHead(204, {

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods":
          "GET, OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type, Authorization"

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

      if (
        path === "/" ||
        path === "/health"
      ) {

        return sendJson(res, 200, {

          status: "OK",

          app: "SMART TRADE INDIA",

          version: CONFIG.VERSION,

          tokenConfigured: Boolean(TOKEN),

          marketOpen: isMarketOpen()

        });

      }


      // STATUS

      if (path === "/api/status") {

        return sendJson(res, 200, {

          status: "OK",

          version: CONFIG.VERSION,

          tokenConfigured: Boolean(TOKEN),

          masterLoaded,

          equityInstruments: equityMaster.length,

          futuresContracts: futuresMaster.length,

          fnoStockCount: fnoStocks.length,

          fnoUnderlyingCount: fnoStocks.length,

          lastScan

        });

      }


      // FNO STOCKS

      if (
        path === "/api/fno-stocks" ||
        path === "/api/nse-stocks"
      ) {

        await loadMaster();

        return sendJson(res, 200, {

          status: "SUCCESS",

          count: fnoStocks.length,

          stocks: fnoStocks.map(x => ({

            symbol: x.symbol,

            equityKey: x.equityKey,

            instrumentKey: x.equityKey,

            futuresKey: x.futuresKey,

            futuresSymbol: x.futuresSymbol,

            expiry: x.expiry

          }))

        });

      }


      // LIVE QUOTES

      if (path === "/api/market/live-quotes") {

        const keys = (
          url.searchParams.get("instrument_keys") || ""
        )

          .split(",")

          .filter(Boolean);

        if (!keys.length) {

          return sendJson(res, 400, {

            success: false,

            message: "instrument_keys required"

          });

        }

        const result =
          await getLiveQuotes(keys);

        return sendJson(res, 200, {

          success: true,

          source: "UPSTOX V3",

          timestamp: new Date().toISOString(),

          data: result.data || {}

        });

      }


      // SCANNER

      if (path === "/api/scan") {

        const force =
          url.searchParams.get("force") === "true";

        const data = await runScan(force);

        return sendJson(res, 200, data);

      }


      // LONG BUILDUP

      if (path === "/api/long-buildup") {

        const data = await runScan();

        return sendJson(res, 200, {

          status: data.status,

          count: data.longBuildupCount,

          stocks: data.longBuildup

        });

      }


      // STRONG BUY

      if (path === "/api/strong-buy") {

        const data = await runScan();

        return sendJson(res, 200, {

          status: data.status,

          count: data.strongBuyCount,

          stocks: data.strongBuy

        });

      }


      // STRONG SELL

      if (path === "/api/strong-sell") {

        const data = await runScan();

        return sendJson(res, 200, {

          status: data.status,

          count: data.strongSellCount,

          stocks: data.strongSell

        });

      }


      // MASTER REFRESH

      if (path === "/api/master/refresh") {

        await loadMaster(true);

        scanCache = null;

        return sendJson(res, 200, {

          status: "SUCCESS",

          fnoStockCount: fnoStocks.length

        });

      }


      // 404

      return sendJson(res, 404, {

        status: "ERROR",

        message: "Route not found",

        path

      });

    } catch (error) {

      console.error(
        "[V7 API ERROR]",
        path,
        error.message
      );

      return sendJson(res, 500, {

        status: "ERROR",

        message: error.message

      });

    }

  }

);


// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, "0.0.0.0", () => {

  console.log("====================================");

  console.log(" SMART TRADE INDIA V7 STARTED");

  console.log(" ORB + VOLUME + LONG BUILDUP");

  console.log(" PORT:", PORT);

  console.log(" SCAN LIMIT:", CONFIG.SCAN_LIMIT);

  console.log("====================================");

  loadMaster().catch(error => {

    console.error(
      "[MASTER LOAD ERROR]",
      error.message
    );

  });

});
