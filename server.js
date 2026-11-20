
"use strict";

// ======================================================
// SMART TRADE INDIA V13 PRO
// FOUR INDEX VERY STRONG SELL SCANNER
// UPSTOX API | NODE.JS 20+
// PART 1 OF 2
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
  RSI_PERIOD: 14,
  RSI_BULLISH: 55,
  RSI_BEARISH: 35,
  EMA_FAST: 9,
  EMA_SLOW: 21,
  EMA_TREND: 50,
  VOLUME_MULTIPLIER: 1.5,
  OI_INCREASE_MIN: 2,
  ADX_MIN: 20,
  VERY_STRONG_SCORE: 6,
  REQUIRE_ALL_CONDITIONS: true,
  MAX_SIGNALS: 100,
  PAPER_MODE: true
};

// MIDCPNIFTY REMOVED

const INDEXES = {
  NIFTY: {
    name: "NIFTY",
    spotKey: "NSE_INDEX|Nifty 50",
    underlyingSymbol: "NIFTY",
    segment: "NSE_FO"
  },
  BANKNIFTY: {
    name: "BANKNIFTY",
    spotKey: "NSE_INDEX|Nifty Bank",
    underlyingSymbol: "BANKNIFTY",
    segment: "NSE_FO"
  },
  FINNIFTY: {
    name: "FINNIFTY",
    spotKey: "NSE_INDEX|Nifty Fin Service",
    underlyingSymbol: "FINNIFTY",
    segment: "NSE_FO"
  },
  SENSEX: {
    name: "SENSEX",
    spotKey: "BSE_INDEX|SENSEX",
    underlyingSymbol: "SENSEX",
    segment: "BSE_FO"
  }
};

const marketCache = new Map();
const signals = [];
const previousOI = new Map();
const oiSnapshots = new Map();

let instrumentMaster = [];
let instrumentMasterTime = 0;
let lastScanTime = null;
let scanRunning = false;
let serverStarted = new Date().toISOString();

// ------------------------------------------------------
// JSON RESPONSE
// ------------------------------------------------------

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

// ------------------------------------------------------
// UPSTOX REQUEST
// ------------------------------------------------------

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

// ------------------------------------------------------
// INSTRUMENT MASTER
// ------------------------------------------------------

async function loadInstrumentMaster(force = false) {
  const fresh =
    instrumentMaster.length > 0 &&
    Date.now() - instrumentMasterTime < 6 * 60 * 60 * 1000;

  if (fresh && !force) return instrumentMaster;

  const url =
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error("Instrument master download failed");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const jsonBuffer = zlib.gunzipSync(buffer);
  const parsed = JSON.parse(jsonBuffer.toString("utf8"));

  instrumentMaster = Array.isArray(parsed) ? parsed : [];
  instrumentMasterTime = Date.now();

  if (!instrumentMaster.length) {
    throw new Error("Instrument master is empty");
  }

  return instrumentMaster;
}

// ------------------------------------------------------
// NEAREST INDEX FUTURES
// ------------------------------------------------------

function findNearestFuture(indexName) {
  const config = INDEXES[indexName];

  if (!config) {
    throw new Error("Unknown index: " + indexName);
  }

  const today = Date.now();

  const candidates = instrumentMaster.filter(item => {
    return (
      item.segment === config.segment &&
      item.instrument_type === "FUT" &&
      item.underlying_symbol === config.underlyingSymbol &&
      Number(item.expiry) > today &&
      item.instrument_key
    );
  });

  candidates.sort(
    (a, b) => Number(a.expiry) - Number(b.expiry)
  );

  if (!candidates.length) {
    throw new Error(
      config.segment + " FUTURES NOT FOUND"
    );
  }

  return candidates[0];
}

// ------------------------------------------------------
// MARKET QUOTES
// ------------------------------------------------------

async function getMarketQuotes(keys) {
  const unique = [...new Set(
    (keys || []).filter(
      key => typeof key === "string" && key.length > 0
    )
  )];

  const output = {};

  if (unique.length === 0) return output;

  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);

    const query = encodeURIComponent(chunk.join(","));

    const result = await upstoxRequest(
      "/v3/market-quote/quotes?instrument_key=" + query
    );

    if (
      !result ||
      !result.data ||
      typeof result.data !== "object"
    ) {
      throw new Error("Invalid Upstox market quote response");
    }

    const entries = Object.entries(result.data);

    for (const requestedKey of chunk) {
      const normalizedKey = requestedKey.replace("|", ":");
      let quote = null;

      for (const [responseKey, value] of entries) {
        if (
          value &&
          (
            value.instrument_token === requestedKey ||
            value.instrument_key === requestedKey
          )
        ) {
          quote = value;
          break;
        }

        if (responseKey === normalizedKey) {
          quote = value;
          break;
        }
      }

      if (quote) {
        output[requestedKey] = quote;
      } else {
        console.log("[QUOTE NOT FOUND]", requestedKey);
      }
    }
  }

  console.log(
    "[MARKET QUOTES]",
    Object.keys(output).length,
    "/",
    unique.length
  );

  return output;
}

// ------------------------------------------------------
// EXTRACT QUOTE
// ------------------------------------------------------

function extractQuote(data) {
  const q = data || {};

  return {
    ltp: Number(q.last_price || 0),
    open: Number(q.ohlc?.open || 0),
    high: Number(q.ohlc?.high || 0),
    low: Number(q.ohlc?.low || 0),
    close: Number(
      q.prev_close_price || q.ohlc?.close || 0
    ),
    volume: Number(q.volume || q.ohlc?.volume || 0),
    oi: Number(q.oi || 0),
    previousOI: Number(q.previous_oi || 0),
    buyQuantity: Number(q.total_buy_quantity || 0),
    sellQuantity: Number(q.total_sell_quantity || 0),
    timestamp: q.last_trade_time || q.timestamp || null
  };
}

// ------------------------------------------------------
// IST DATE HELPERS
// ------------------------------------------------------

function indiaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = type =>
    parts.find(p => p.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDate(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day + days)
  );

  return date.toISOString().slice(0, 10);
}

function normalizeCandleRows(rows, now) {
  return (Array.isArray(rows) ? rows : [])
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
    );
}

// ------------------------------------------------------
// HISTORICAL + CURRENT DAY COMPLETED 5-MINUTE CANDLES
// ------------------------------------------------------

async function getCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);
  const now = Date.now();

  const today = indiaDateString(new Date(now));
  const fromDate = shiftDate(today, -10);
  const toDate = shiftDate(today, -1);

  const [historicalResult, intradayResult] =
    await Promise.allSettled([
      upstoxRequest(
        `/v3/historical-candle/${key}/minutes/5/${toDate}/${fromDate}`
      ),
      upstoxRequest(
        `/v3/historical-candle/intraday/${key}/minutes/5`
      )
    ]);

  const historicalRows =
    historicalResult.status === "fulfilled"
      ? historicalResult.value.data?.candles || []
      : [];

  const intradayRows =
    intradayResult.status === "fulfilled"
      ? intradayResult.value.data?.candles || []
      : [];

  if (historicalResult.status === "rejected") {
    console.error(
      "[HISTORICAL CANDLES ERROR]",
      instrumentKey,
      historicalResult.reason?.message
    );
  }

  if (intradayResult.status === "rejected") {
    console.error(
      "[INTRADAY CANDLES ERROR]",
      instrumentKey,
      intradayResult.reason?.message
    );
  }

  const historical = normalizeCandleRows(
    historicalRows,
    now
  );

  const intraday = normalizeCandleRows(
    intradayRows,
    now
  );

  const byTime = new Map();

  for (const candle of historical) {
    byTime.set(candle.time, candle);
  }

  for (const candle of intraday) {
    byTime.set(candle.time, candle);
  }

  const candles = [...byTime.values()]
    .sort((a, b) => a.time - b.time);

  candles.stats = {
    historicalCandles: historical.length,
    intradayCandles: intraday.length,
    totalCandles: candles.length,
    fromDate,
    toDate,
    today
  };

  if (!candles.length) {
    const errors = [];

    if (historicalResult.status === "rejected") {
      errors.push(historicalResult.reason?.message);
    }

    if (intradayResult.status === "rejected") {
      errors.push(intradayResult.reason?.message);
    }

    throw new Error(
      errors.filter(Boolean).join(" | ") ||
      "No completed 5-minute candles returned by Upstox"
    );
  }

  return candles;
}

// TODAY SESSION CANDLES FOR VWAP

function getTodaySessionCandles(candles) {
  const today = indiaDateString();

  return candles.filter(c =>
    indiaDateString(new Date(c.time)) === today
  );
}

// ------------------------------------------------------
// EMA
// ------------------------------------------------------

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

// ------------------------------------------------------
// RSI WILDER
// ------------------------------------------------------

function calculateRSI(values, period = 14) {
  if (!values || values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) +
      Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) +
      Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// ------------------------------------------------------
// FUTURES VWAP
// ------------------------------------------------------

function calculateVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const typical =
      (c.high + c.low + c.close) / 3;

    totalPV += typical * c.volume;
    totalVolume += c.volume;
  }

  if (!totalVolume) return null;

  return totalPV / totalVolume;
}

// ------------------------------------------------------
// ADR
// ------------------------------------------------------

function calculateADR(candles, period = 14) {
  if (!candles || candles.length < period) return null;

  const recent = candles.slice(-period);

  const total = recent.reduce(
    (sum, c) => sum + c.high - c.low,
    0
  );

  return total / period;
}

// ------------------------------------------------------
// ADX
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

    plusDM.push(
      up > down && up > 0 ? up : 0
    );

    minusDM.push(
      down > up && down > 0 ? down : 0
    );

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

  return dx.slice(-period).reduce(
    (a, b) => a + b, 0
  ) / period;
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
// OI SNAPSHOT
// ------------------------------------------------------

function calculateOIChange(key, currentOI) {
  if (!Number.isFinite(currentOI) || currentOI <= 0) {
    return {
      change: null,
      percent: null,
      increasing: false,
      ready: false
    };
  }

  const previous = previousOI.get(key);

  previousOI.set(key, currentOI);

  if (!previous || previous <= 0) {
    return {
      change: 0,
      percent: 0,
      increasing: false,
      ready: false
    };
  }

  const change = currentOI - previous;

  return {
    change,
    percent: change / previous * 100,
    increasing: change > 0,
    ready: true
  };
}

// ------------------------------------------------------
// ORDER FLOW PROXY
// ------------------------------------------------------

function calculateOrderFlow(quote) {
  const buy = quote.buyQuantity || 0;
  const sell = quote.sellQuantity || 0;
  const total = buy + sell;

  return {
    buyQuantity: buy,
    sellQuantity: sell,
    imbalance: buy - sell,
    imbalancePercent: total
      ? ((buy - sell) / total) * 100
      : null,
    sellPressure: sell > buy,
    buyPressure: buy > sell
  };
}


// ======================================================
// SMART TRADE INDIA V13 PRO
// PART 2 OF 2
// ======================================================

// ------------------------------------------------------
// OPTION CHAIN
// ------------------------------------------------------

async function getOptionChain(spotKey) {
  const result = await upstoxRequest(
    "/v2/option/chain?instrument_key=" +
    encodeURIComponent(spotKey) +
    "&expiry_date=current_week"
  );

  return result.data || [];
}

// ------------------------------------------------------
// OPTION SELL STRIKE SELECTOR
// ------------------------------------------------------

function selectSellStrike(chain, direction) {
  const candidates = [];

  for (const item of chain || []) {
    const spot = Number(item.underlying_spot_price || 0);
    const strike = Number(item.strike_price || 0);

    if (!spot || !strike) continue;

    const option = direction === "PE"
      ? item.put_options
      : item.call_options;

    if (!option?.instrument_key) continue;

    const md = option.market_data || {};
    const greeks = option.option_greeks || {};

    const ltp = Number(md.ltp || 0);
    const oi = Number(md.oi || 0);
    const volume = Number(md.volume || 0);
    const bid = Number(md.bid_price || 0);
    const ask = Number(md.ask_price || 0);
    const delta = Math.abs(Number(greeks.delta || 0));

    const isOTM = direction === "PE"
      ? strike < spot
      : strike > spot;

    if (!isOTM) continue;

    if (
      ltp <= 0 ||
      oi <= 0 ||
      volume <= 0 ||
      bid <= 0 ||
      ask <= 0
    ) continue;

    const spread = ((ask - bid) / ask) * 100;

    if (spread > 3) continue;

    if (delta > 0 && (delta < 0.10 || delta > 0.40)) {
      continue;
    }

    const distance = Math.abs(strike - spot) / spot;

    const score =
      Math.log10(oi + 1) * 2 +
      Math.log10(volume + 1) * 2 -
      spread -
      distance * 100;

    candidates.push({
      direction,
      strike,
      spot,
      instrumentKey: option.instrument_key,
      expiry: item.expiry || null,
      ltp,
      oi,
      volume,
      bid,
      ask,
      spreadPercent: Number(spread.toFixed(2)),
      delta,
      theta: Number(greeks.theta || 0),
      gamma: Number(greeks.gamma || 0),
      vega: Number(greeks.vega || 0),
      iv: Number(greeks.iv || 0),
      score: Number(score.toFixed(2))
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

// ------------------------------------------------------
// SIX CONDITIONS - VERY STRONG SELL
// ------------------------------------------------------

function analyseIndex(
  indexName,
  candles,
  spotQuote,
  futureQuote,
  oiData
) {
  const stats = candles.stats || {};

  if (!candles || candles.length < 55) {
    return {
      index: indexName,
      status: "WAIT",
      reason: "Historical candles insufficient",
      dataStatus: "INSUFFICIENT_CANDLES",
      candleCount: candles?.length || 0,
      requiredCandles: 55,
      historicalCandles: stats.historicalCandles || 0,
      intradayCandles: stats.intradayCandles || 0,
      peScore: 0,
      ceScore: 0
    };
  }

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);

  const rsi = calculateRSI(closes, 14);

  // VWAP uses today's session only.
  const todayCandles = getTodaySessionCandles(candles);
  const vwap = calculateVWAP(todayCandles);

  const adx = calculateADX(candles, 14);
  const adr = calculateADR(candles, 14);
  const macd = calculateMACD(closes);

  const avgVolumeCandles = candles.slice(-21, -1);

  const avgVolume = avgVolumeCandles.length
    ? avgVolumeCandles.reduce(
        (sum, c) => sum + c.volume, 0
      ) / avgVolumeCandles.length
    : 0;

  const volumePass =
    avgVolume > 0 &&
    last.volume >= avgVolume * CONFIG.VOLUME_MULTIPLIER;

  const oiPass =
    oiData.ready &&
    oiData.percent >= CONFIG.OI_INCREASE_MIN;

  const priceUp = last.close > previous.close;
  const priceDown = last.close < previous.close;

  const trendUp =
    ema9 !== null &&
    ema21 !== null &&
    ema50 !== null &&
    adx !== null &&
    ema9 > ema21 &&
    ema21 > ema50 &&
    adx >= CONFIG.ADX_MIN;

  const trendDown =
    ema9 !== null &&
    ema21 !== null &&
    ema50 !== null &&
    adx !== null &&
    ema9 < ema21 &&
    ema21 < ema50 &&
    adx >= CONFIG.ADX_MIN;

  const macdUp = macd && macd.macd > 0;
  const macdDown = macd && macd.macd < 0;

  // PE SELL: Underlying bullish.
  const peChecks = {
    trend: trendUp,
    vwap: vwap !== null && last.close > vwap,
    rsi: rsi !== null && rsi > CONFIG.RSI_BULLISH,
    macd: !!macdUp,
    volume: volumePass,
    oiPrice: oiPass && priceUp
  };

  // CE SELL: Underlying bearish.
  const ceChecks = {
    trend: trendDown,
    vwap: vwap !== null && last.close < vwap,
    rsi: rsi !== null && rsi < CONFIG.RSI_BEARISH,
    macd: !!macdDown,
    volume: volumePass,
    oiPrice: oiPass && priceDown
  };

  const peScore =
    Object.values(peChecks).filter(Boolean).length;

  const ceScore =
    Object.values(ceChecks).filter(Boolean).length;

  let direction = null;

  if (
    CONFIG.REQUIRE_ALL_CONDITIONS &&
    peScore === CONFIG.VERY_STRONG_SCORE
  ) {
    direction = "PE";
  }

  if (
    CONFIG.REQUIRE_ALL_CONDITIONS &&
    ceScore === CONFIG.VERY_STRONG_SCORE
  ) {
    direction = "CE";
  }

  const orderFlow = calculateOrderFlow(futureQuote);

  return {
    index: indexName,

    status: direction
      ? "VERY_STRONG_SELL"
      : "WAIT",

    direction,

    dataStatus: "READY",

    underlyingPrice: spotQuote.ltp,
    futuresPrice: futureQuote.ltp,

    candleClose: last.close,
    candleTime: new Date(last.time).toISOString(),

    candleCount: candles.length,
    requiredCandles: 55,

    historicalCandles: stats.historicalCandles || 0,
    intradayCandles: stats.intradayCandles || 0,

    rsi: rsi !== null
      ? Number(rsi.toFixed(2))
      : null,

    vwap: vwap !== null
      ? Number(vwap.toFixed(2))
      : null,

    ema9: ema9 !== null
      ? Number(ema9.toFixed(2))
      : null,

    ema21: ema21 !== null
      ? Number(ema21.toFixed(2))
      : null,

    ema50: ema50 !== null
      ? Number(ema50.toFixed(2))
      : null,

    adx: adx !== null
      ? Number(adx.toFixed(2))
      : null,

    adr: adr !== null
      ? Number(adr.toFixed(2))
      : null,

    macd: macd
      ? Number(macd.macd.toFixed(4))
      : null,

    volume: last.volume,
    averageVolume: Math.round(avgVolume),

    volumeMultiplier: Number(
      (avgVolume > 0
        ? last.volume / avgVolume
        : 0).toFixed(2)
    ),

    oi: oiData.currentOI,
    oiChange: oiData.change,
    oiChangePercent: oiData.percent,
    oiReady: oiData.ready,

    footprintProxy: orderFlow,

    peScore,
    ceScore,

    peChecks,
    ceChecks,

    timestamp: new Date().toISOString()
  };
}

// ------------------------------------------------------
// SCAN ONE INDEX
// ------------------------------------------------------

async function scanOneIndex(name) {
  try {
    const config = INDEXES[name];

    if (!config) {
      throw new Error("Index configuration missing");
    }

    const future = findNearestFuture(name);

    const [quotes, candles, chain] = await Promise.all([
      getMarketQuotes([
        config.spotKey,
        future.instrument_key
      ]),
      getCandles(future.instrument_key),
      getOptionChain(config.spotKey)
    ]);

    const spotRaw = quotes[config.spotKey];
    const futureRaw = quotes[future.instrument_key];

    if (!spotRaw || !futureRaw) {
      throw new Error("Spot/Futures quote unavailable");
    }

    const spotQuote = extractQuote(spotRaw);
    const futureQuote = extractQuote(futureRaw);

    if (!spotQuote.ltp || !futureQuote.ltp) {
      throw new Error("Invalid live price");
    }

    if (!candles.length) {
      throw new Error("Futures candles unavailable");
    }

    const lastCandle = candles[candles.length - 1];

    const currentOI =
      lastCandle.oi > 0
        ? lastCandle.oi
        : futureQuote.oi;

    const oiData = calculateOIChange(
      future.instrument_key,
      currentOI
    );

    oiData.currentOI = currentOI;

    const analysis = analyseIndex(
      name,
      candles,
      spotQuote,
      futureQuote,
      oiData
    );

    analysis.futuresInstrumentKey =
      future.instrument_key;

    analysis.futuresSymbol =
      future.trading_symbol;

    analysis.futuresExpiry =
      future.expiry;

    if (analysis.direction) {
      analysis.selectedStrike = selectSellStrike(
        chain,
        analysis.direction
      );

      if (!analysis.selectedStrike) {
        analysis.status = "WAIT";
        analysis.reason = "No liquid OTM option contract";
      }
    }

    // Only all-six-confirmed signals are saved.
    if (
      analysis.status === "VERY_STRONG_SELL" &&
      analysis.selectedStrike
    ) {
      const signalId =
        name + "_" +
        analysis.direction + "_" +
        analysis.candleTime;

      if (!signals.some(s => s.id === signalId)) {
        signals.unshift({
          id: signalId,
          ...analysis
        });

        if (signals.length > CONFIG.MAX_SIGNALS) {
          signals.pop();
        }
      }
    }

    marketCache.set(name, analysis);

    return analysis;

  } catch (error) {
    const result = {
      index: name,
      status: "ERROR",
      error: error.message,
      timestamp: new Date().toISOString()
    };

    marketCache.set(name, result);

    return result;
  }
}

// ------------------------------------------------------
// FULL FOUR-INDEX SCAN
// ------------------------------------------------------

async function runFullScan() {
  if (scanRunning) {
    return {
      status: "SCAN_ALREADY_RUNNING",
      results: Object.fromEntries(marketCache)
    };
  }

  scanRunning = true;

  try {
    await loadInstrumentMaster();

    const results = {};

    for (const name of Object.keys(INDEXES)) {
      results[name] = await scanOneIndex(name);
    }

    lastScanTime = new Date().toISOString();

    return {
      status: "SUCCESS",
      version: CONFIG.VERSION,
      lastScanTime,
      indexes: Object.keys(INDEXES),
      results
    };

  } finally {
    scanRunning = false;
  }
}

// ------------------------------------------------------
// INDIA MARKET TIME
// ------------------------------------------------------

function getIndiaTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(p => p.type === type)?.value;

  const weekday = get("weekday");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));

  return {
    weekday,
    hour,
    minute,
    minutes: hour * 60 + minute
  };
}

function isMarketTime() {
  const t = getIndiaTime();

  return (
    t.weekday !== "Sat" &&
    t.weekday !== "Sun" &&
    t.minutes >= 555 &&
    t.minutes <= 930
  );
}

// ------------------------------------------------------
// DASHBOARD HTML
// ------------------------------------------------------

const DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMART TRADE INDIA V13 PRO</title>

<style>
*{box-sizing:border-box}
body{
  margin:0;padding:16px;
  background:#09111f;color:#eaf0ff;
  font-family:Arial,sans-serif
}
h1{font-size:22px;color:#56c5ff}
.sub{color:#a5b4ca;font-size:12px}
.cards{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
  gap:12px;margin-top:18px
}
.card{
  background:#142238;
  border:1px solid #2a405e;
  border-radius:12px;padding:15px
}
.name{font-size:18px;font-weight:bold}
.price{font-size:25px;margin:12px 0}
.green{color:#30e49a}
.red{color:#ff697d}
.yellow{color:#ffcf70}
button{
  background:#147bc1;color:white;border:0;
  border-radius:8px;padding:12px;margin:5px;
  font-weight:bold
}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{
  padding:9px;border-bottom:1px solid #30415a;
  text-align:left
}
.panel{
  overflow:auto;background:#142238;
  padding:12px;border-radius:12px;margin-top:15px
}
.small{font-size:12px;color:#aabbd1}
</style>
</head>

<body>

<h1>SMART TRADE INDIA V13 PRO</h1>

<div class="sub">
FOUR INDEX LIVE FUTURES DATA | HISTORICAL 5M CANDLES | ALL SIX CONDITIONS
</div>

<button onclick="refresh()">REFRESH SCAN</button>
<button onclick="soundOn()">ENABLE SOUND</button>

<div id="status" class="sub">Connecting...</div>

<div class="cards" id="cards"></div>

<div class="panel">
<h3>VERY STRONG SELL ALERTS</h3>
<table>
<thead>
<tr>
<th>Index</th>
<th>Signal</th>
<th>Strike</th>
<th>LTP</th>
<th>OI</th>
<th>Time</th>
</tr>
</thead>
<tbody id="alerts"></tbody>
</table>
</div>

<div class="panel">
<h3>ALL SIX CONDITIONS</h3>
<div id="details" class="small">Waiting...</div>
</div>

<script>
let soundEnabled=false;
let seen=new Set();

function soundOn(){
  soundEnabled=true;

  try{
    const ctx=new (
      window.AudioContext||window.webkitAudioContext
    )();

    const osc=ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime+0.1);
  }catch(e){}
}

function beep(){
  if(!soundEnabled)return;

  try{
    const ctx=new (
      window.AudioContext||window.webkitAudioContext
    )();

    const osc=ctx.createOscillator();
    const gain=ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value=880;
    gain.gain.value=0.15;

    osc.start();
    osc.stop(ctx.currentTime+0.35);
  }catch(e){}
}

function fmt(v){
  if(v===null||v===undefined||
     !Number.isFinite(Number(v))){
    return "N/A";
  }

  return Number(v).toLocaleString("en-IN");
}

function checksText(checks){
  if(!checks)return "DATA UNAVAILABLE";

  return Object.entries(checks).map(([k,v])=>
    k+": "+(v?"PASS":"FAIL")
  ).join(" | ");
}

async function refresh(){
  try{
    const [marketResponse,signalResponse]=await Promise.all([
      fetch("/api/market"),
      fetch("/api/signals")
    ]);

    if(!marketResponse.ok||!signalResponse.ok){
      throw new Error("Dashboard API error");
    }

    const market=await marketResponse.json();
    const alerts=await signalResponse.json();

    document.getElementById("status").textContent=
      "Last scan: "+(market.lastScanTime||"Waiting")+
      " | Mode: "+market.mode+
      " | Version: "+market.version;

    const results=market.results||{};

    document.getElementById("cards").innerHTML=
      Object.values(results).map(x=>{
        const signal=x.direction||"WAIT";

        const color=signal==="CE"?"red":
          signal==="PE"?"green":"yellow";

        const strike=x.selectedStrike;

        return \`
        <div class="card">
          <div class="name">\${x.index}</div>

          <div class="price">
            \${fmt(x.underlyingPrice)}
          </div>

          <div class="\${color}">
            \${x.status==="VERY_STRONG_SELL"
              ?"VERY STRONG "+signal+" SELL"
              :x.status}
          </div>

          <p class="small">
            Futures: \${fmt(x.futuresPrice)}<br>
            Candles: \${fmt(x.candleCount)} / 55<br>
            Historical: \${fmt(x.historicalCandles)}<br>
            Intraday: \${fmt(x.intradayCandles)}<br>
            RSI: \${fmt(x.rsi)} |
            ADX: \${fmt(x.adx)}<br>
            VWAP: \${fmt(x.vwap)}<br>
            EMA 50: \${fmt(x.ema50)}<br>
            MACD: \${fmt(x.macd)}<br>
            Volume: \${fmt(x.volume)}<br>
            OI: \${fmt(x.oi)}<br>
            OI Change: \${fmt(x.oiChangePercent)}%
          </p>

          <b>
            \${strike
              ?strike.strike+" "+signal+" SELL"
              :"No confirmed strike"}
          </b>

          <p class="small">
            \${x.reason||x.error||""}
          </p>
        </div>
        \`;
      }).join("");

    const rows=alerts.signals||[];

    for(const s of rows){
      if(!seen.has(s.id)){
        seen.add(s.id);
        beep();
      }
    }

    document.getElementById("alerts").innerHTML=
      rows.map(s=>\`
        <tr>
          <td>\${s.index}</td>
          <td class="red">\${s.direction} SELL</td>
          <td>\${s.selectedStrike?.strike??"-"}</td>
          <td>\${s.selectedStrike?.ltp??"-"}</td>
          <td>\${fmt(s.selectedStrike?.oi)}</td>
          <td>\${new Date(s.timestamp).toLocaleTimeString()}</td>
        </tr>
      \`).join("");

    document.getElementById("details").innerHTML=
      Object.values(results).map(x=>
        "<p><b>"+x.index+"</b>"+
        "<br>PE: "+checksText(x.peChecks)+
        "<br>CE: "+checksText(x.ceChecks)+
        "<br>Candles: "+fmt(x.candleCount)+
        "<br>Status: "+x.status+"</p>"
      ).join("");

  }catch(e){
    document.getElementById("status").textContent=
      "ERROR: "+e.message;
  }
}

refresh();
setInterval(refresh,5000);
</script>

</body>
</html>`;

// ------------------------------------------------------
// HTTP SERVER
// ------------------------------------------------------

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
    "http://localhost:" + PORT
  );

  try {

    if (req.method !== "GET") {
      return sendJson(res, 405, {
        error: "GET requests only"
      });
    }

    // DASHBOARD
    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      return res.end(DASHBOARD);
    }

    // HEALTH
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        status: "OK",
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        instrumentMasterLoaded: instrumentMaster.length > 0,
        started: serverStarted,
        lastScanTime
      });
    }

    // STATUS
    if (url.pathname === "/api/status") {
      return sendJson(res, 200, {
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        scanRunning,
        lastScanTime,
        paperMode: CONFIG.PAPER_MODE,
        indexes: Object.keys(INDEXES)
      });
    }

    // MANUAL SCAN
    if (url.pathname === "/api/scan") {

      if (!TOKEN) {
        return sendJson(res, 401, {
          status: "ERROR",
          error: "UPSTOX_ACCESS_TOKEN missing"
        });
      }

      const result = await runFullScan();

      return sendJson(res, 200, result);
    }

    // MARKET DATA
    if (url.pathname === "/api/market") {
      return sendJson(res, 200, {
        version: CONFIG.VERSION,
        mode: TOKEN ? "LIVE_API_POLLING" : "NO_TOKEN",
        lastScanTime,
        scanRunning,
        indexes: Object.keys(INDEXES),
        results: Object.fromEntries(marketCache)
      });
    }

    // SIGNALS
    if (url.pathname === "/api/signals") {
      return sendJson(res, 200, {
        count: signals.length,
        signals
      });
    }

    // INDEX LIST
    if (url.pathname === "/api/indexes") {
      return sendJson(res, 200, {
        indexes: INDEXES
      });
    }

    
    // FUTURES DATA STATUS
    if (url.pathname === "/api/futures") {
      return sendJson(res, 200, {
        indexes: Object.keys(INDEXES).map(name => {
          try {
            const future = findNearestFuture(name);

            return {
              index: name,
              status: "FOUND",
              tradingSymbol: future.trading_symbol,
              instrumentKey: future.instrument_key,
              expiry: future.expiry
            };

          } catch (error) {
            return {
              index: name,
              status: "ERROR",
              error: error.message
            };
          }
        })
      });
    }

    // CANDLE DIAGNOSTICS
    if (url.pathname === "/api/candles") {
      return sendJson(res, 200, {
        version: CONFIG.VERSION,
        indexes: Object.fromEntries(
          [...marketCache.entries()].map(([name, data]) => [
            name,
            {
              candleCount: data.candleCount || 0,
              requiredCandles: 55,
              historicalCandles: data.historicalCandles || 0,
              intradayCandles: data.intradayCandles || 0,
              dataStatus: data.dataStatus || "READY",
              status: data.status
            }
          ])
        )
      });
    }

    return sendJson(res, 404, {
      error: "Route not found",
      routes: [
        "/",
        "/health",
        "/api/status",
        "/api/scan",
        "/api/market",
        "/api/signals",
        "/api/indexes",
        "/api/futures",
        "/api/candles"
      ]
    });

  } catch (error) {
    return sendJson(res, 500, {
      status: "ERROR",
      error: error.message
    });
  }
});

// ------------------------------------------------------
// AUTOMATIC SCANNER
// ------------------------------------------------------

setInterval(() => {

  if (
    TOKEN &&
    isMarketTime() &&
    !scanRunning
  ) {
    runFullScan().catch(error => {
      console.error(
        "[V13 SCAN ERROR]",
        error.message
      );
    });
  }

}, CONFIG.SCAN_INTERVAL);

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------

server.listen(PORT, "0.0.0.0", async () => {

  console.log("====================================");
  console.log("SMART TRADE INDIA V13 PRO");
  console.log("PORT:", PORT);
  console.log("TOKEN:", TOKEN ? "CONFIGURED" : "MISSING");
  console.log("INDEXES:", Object.keys(INDEXES).join(", "));
  console.log("HISTORICAL + INTRADAY 5M CANDLES");
  console.log("MODE: PAPER");
  console.log("ALL SIX CONDITIONS REQUIRED");
  console.log("====================================");

  if (TOKEN) {
    try {
      await loadInstrumentMaster();

      console.log(
        "[V13] Instrument Master Loaded:",
        instrumentMaster.length
      );

      console.log("[V13] Four Index Scanner Ready");

    } catch (error) {
      console.error(
        "[V13 MASTER ERROR]",
        error.message
      );
    }
  }
});
  
