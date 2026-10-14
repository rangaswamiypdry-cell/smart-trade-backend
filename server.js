const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;

// ==================================================
// SMART TRADE INDIA - CONFIRMED SIGNAL BACKEND
// 5-MIN CLOSED CANDLE / NON-REPAINT RULES
// CALL BUY + PUT BUY + ENTRY + SL + TARGETS
// NIFTY + BANKNIFTY + SENSEX + NSE STOCK OPTIONS
// ==================================================

const ALERT_THRESHOLD = 75;
const STRONG_THRESHOLD = 80;
const VOLUME_MULTIPLIER = 1.5;
const ADX_MIN = 20;
const SR_LOOKBACK = 20;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(data));
}

async function upstoxRequest(apiUrl) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error("UPSTOX_ACCESS_TOKEN_MISSING");
  }

  const response = await fetch(apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `Upstox API request failed (${response.status})`
    );
  }

  return data;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, digits = 2) {
  const n = num(v);
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function candleTime(c) {
  return new Date(c[0]).getTime();
}

function getClosedCandles(candles, intervalMinutes = 5) {
  const intervalMs = intervalMinutes * 60 * 1000;

  return (candles || [])
    .filter(c => candleTime(c) + intervalMs <= Date.now())
    .sort((a, b) => candleTime(a) - candleTime(b));
}

// ==================================================
// INDICATORS
// ==================================================

function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) {
      gain += change;
    } else {
      loss += Math.abs(change);
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return round(
    100 - 100 / (1 + avgGain / avgLoss),
    2
  );
}

function calculateEMA(values, period = 20) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);

  let ema =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return round(ema, 2);
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    return null;
  }

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const high = num(candles[i][2]);
    const low = num(candles[i][3]);
    const prevClose = num(candles[i - 1][4]);

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  if (tr.length < period) {
    return null;
  }

  let atr =
    tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < tr.length; i++) {
    atr = ((atr * (period - 1)) + tr[i]) / period;
  }

  return round(atr, 2);
}

function calculateADX(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) {
    return null;
  }

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const high = num(candles[i][2]);
    const low = num(candles[i][3]);

    const prevHigh = num(candles[i - 1][2]);
    const prevLow = num(candles[i - 1][3]);
    const prevClose = num(candles[i - 1][4]);

    const up = high - prevHigh;
    const down = prevLow - low;

    plusDM.push(
      up > down && up > 0 ? up : 0
    );

    minusDM.push(
      down > up && down > 0 ? down : 0
    );

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  let atr =
    trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  let pDM =
    plusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;

  let mDM =
    minusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const dx = [];

  let lastPDI = 0;
  let lastMDI = 0;

  for (let i = period; i < trs.length; i++) {
    atr = ((atr * (period - 1)) + trs[i]) / period;

    pDM =
      ((pDM * (period - 1)) + plusDM[i]) / period;

    mDM =
      ((mDM * (period - 1)) + minusDM[i]) / period;

    lastPDI = atr > 0 ? (pDM / atr) * 100 : 0;
    lastMDI = atr > 0 ? (mDM / atr) * 100 : 0;

    const sum = lastPDI + lastMDI;

    dx.push(
      sum > 0
        ? (Math.abs(lastPDI - lastMDI) / sum) * 100
        : 0
    );
  }

  if (dx.length < period) {
    return null;
  }

  let adx =
    dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dx.length; i++) {
    adx = ((adx * (period - 1)) + dx[i]) / period;
  }

  return {
    adx: round(adx, 2),
    plusDI: round(lastPDI, 2),
    minusDI: round(lastMDI, 2)
  };
}

function calculateVWAP(candles) {
  if (!candles?.length) {
    return null;
  }

  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    const typical =
      (num(c[2]) + num(c[3]) + num(c[4])) / 3;

    const v = num(c[5]);

    pv += typical * v;
    volume += v;
  }

  return volume > 0 ? round(pv / volume, 2) : null;
}

function calculateADR(candles, period = 14) {
  if (!candles || candles.length < period) {
    return null;
  }

  const ranges = candles
    .slice(-period)
    .map(c => num(c[2]) - num(c[3]))
    .filter(v => v >= 0);

  if (!ranges.length) {
    return null;
  }

  return round(
    ranges.reduce((a, b) => a + b, 0) / ranges.length,
    2
  );
}

function supportResistance(candles, lookback = SR_LOOKBACK) {
  if (!candles || candles.length < lookback + 2) {
    return null;
  }

  // Current candle is excluded from level calculation.
  const base = candles.slice(-(lookback + 1), -1);

  const resistance = Math.max(
    ...base.map(c => num(c[2]))
  );

  const support = Math.min(
    ...base.map(c => num(c[3]))
  );

  return {
    support: round(support, 2),
    resistance: round(resistance, 2)
  };
}

function candleStructure(c) {
  const open = num(c[1]);
  const high = num(c[2]);
  const low = num(c[3]);
  const close = num(c[4]);

  const range = Math.max(high - low, 0);
  const body = Math.abs(close - open);

  const closePosition =
    range > 0 ? (close - low) / range : 0.5;

  return {
    bullish:
      close > open &&
      closePosition >= 0.65 &&
      body >= range * 0.45,

    bearish:
      close < open &&
      closePosition <= 0.35 &&
      body >= range * 0.45,

    body: round(body, 2),
    range: round(range, 2),
    closePosition: round(closePosition, 2)
  };
      }
// ==================================================
// CANDLE ANALYSIS
// ==================================================

function analyseCompletedCandles(candles) {
  const completed = getClosedCandles(candles, 5);

  if (completed.length < 35) {
    return {
      ready: false,
      reason: "NEED_AT_LEAST_35_COMPLETED_5M_CANDLES"
    };
  }

  const closes = completed.map(c => num(c[4]));
  const volumes = completed.map(c => num(c[5]));

  const current = completed[completed.length - 1];
  const previous = completed[completed.length - 2];

  const averageVolume =
    volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  const volumeRatio =
    averageVolume > 0
      ? volumes[volumes.length - 1] / averageVolume
      : 0;

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi14 = calculateRSI(closes, 14);
  const atr14 = calculateATR(completed, 14);
  const adxData = calculateADX(completed, 14);
  const vwap = calculateVWAP(completed);
  const adr14 = calculateADR(completed, 14);
  const sr = supportResistance(completed, SR_LOOKBACK);
  const structure = candleStructure(current);

  const close = num(current[4]);
  const prevClose = num(previous[4]);

  const breakout =
    sr &&
    close > sr.resistance &&
    prevClose <= sr.resistance;

  const breakdown =
    sr &&
    close < sr.support &&
    prevClose >= sr.support;

  const bullishMomentum =
    close > num(current[1]) &&
    close > (ema20 || 0) &&
    close > (vwap || 0);

  const bearishMomentum =
    close < num(current[1]) &&
    close < (ema20 || Number.MAX_SAFE_INTEGER) &&
    close < (vwap || Number.MAX_SAFE_INTEGER);

  return {
    ready: true,
    candleTime: current[0],
    close,
    previousClose: prevClose,
    open: num(current[1]),
    high: num(current[2]),
    low: num(current[3]),

    rsi14,
    ema20,
    ema50,
    vwap,
    atr14,
    adr14,

    adx: adxData?.adx ?? null,
    plusDI: adxData?.plusDI ?? null,
    minusDI: adxData?.minusDI ?? null,

    currentVolume: volumes[volumes.length - 1],
    averageVolume: round(averageVolume, 2),
    volumeRatio: round(volumeRatio, 2),
    volumePass: volumeRatio >= VOLUME_MULTIPLIER,

    support: sr?.support ?? null,
    resistance: sr?.resistance ?? null,

    breakout: !!breakout,
    breakdown: !!breakdown,

    bullishMomentum,
    bearishMomentum,
    bullishCandle: structure.bullish,
    bearishCandle: structure.bearish,
    candle: structure
  };
}

// ==================================================
// CONFIDENCE ENGINE
// ==================================================

function buildDirectionalSignal(a) {
  if (!a?.ready) {
    return {
      direction: "WAIT",
      confidence: 0,
      status: "WAIT",
      reasons: [],
      failed: [a?.reason || "NOT_READY"]
    };
  }

  let bull = 0;
  let bear = 0;

  const bullReasons = [];
  const bearReasons = [];
  const bullFailed = [];
  const bearFailed = [];

  // Resistance breakout
  if (a.breakout) {
    bull += 20;
    bullReasons.push("RESISTANCE_BREAKOUT");
  } else {
    bullFailed.push("NO_RESISTANCE_BREAKOUT");
  }

  // Support breakdown
  if (a.breakdown) {
    bear += 20;
    bearReasons.push("SUPPORT_BREAKDOWN");
  } else {
    bearFailed.push("NO_SUPPORT_BREAKDOWN");
  }

  // VWAP confirmation
  if (a.vwap != null && a.close > a.vwap) {
    bull += 12;
    bullReasons.push("PRICE_ABOVE_VWAP");
  } else {
    bullFailed.push("PRICE_NOT_ABOVE_VWAP");
  }

  if (a.vwap != null && a.close < a.vwap) {
    bear += 12;
    bearReasons.push("PRICE_BELOW_VWAP");
  } else {
    bearFailed.push("PRICE_NOT_BELOW_VWAP");
  }

  // EMA confirmation
  if (a.ema20 != null && a.close > a.ema20) {
    bull += 12;
    bullReasons.push("PRICE_ABOVE_EMA20");
  } else {
    bullFailed.push("PRICE_NOT_ABOVE_EMA20");
  }

  if (a.ema20 != null && a.close < a.ema20) {
    bear += 12;
    bearReasons.push("PRICE_BELOW_EMA20");
  } else {
    bearFailed.push("PRICE_NOT_BELOW_EMA20");
  }

  // RSI confirmation
  if (a.rsi14 != null && a.rsi14 >= 55) {
    bull += 10;
    bullReasons.push(`RSI_${a.rsi14}`);
  } else {
    bullFailed.push("RSI_BELOW_55");
  }

  if (a.rsi14 != null && a.rsi14 <= 45) {
    bear += 10;
    bearReasons.push(`RSI_${a.rsi14}`);
  } else {
    bearFailed.push("RSI_ABOVE_45");
  }

  // ADX and directional index
  if (
    a.adx != null &&
    a.adx >= ADX_MIN &&
    a.plusDI > a.minusDI
  ) {
    bull += 10;
    bullReasons.push(`ADX_${a.adx}_BULLISH_DI`);
  } else {
    bullFailed.push("ADX_OR_BULLISH_DI_NOT_CONFIRMED");
  }

  if (
    a.adx != null &&
    a.adx >= ADX_MIN &&
    a.minusDI > a.plusDI
  ) {
    bear += 10;
    bearReasons.push(`ADX_${a.adx}_BEARISH_DI`);
  } else {
    bearFailed.push("ADX_OR_BEARISH_DI_NOT_CONFIRMED");
  }

  // Volume confirmation
  if (a.volumePass) {
    bull += 10;
    bear += 10;

    bullReasons.push(`VOLUME_${a.volumeRatio}X`);
    bearReasons.push(`VOLUME_${a.volumeRatio}X`);
  } else {
    bullFailed.push("VOLUME_BELOW_1.5X");
    bearFailed.push("VOLUME_BELOW_1.5X");
  }

  // Closed candle confirmation
  if (a.bullishCandle) {
    bull += 10;
    bullReasons.push("BULLISH_CLOSED_5M_CANDLE");
  } else {
    bullFailed.push("BULLISH_CANDLE_NOT_CONFIRMED");
  }

  if (a.bearishCandle) {
    bear += 10;
    bearReasons.push("BEARISH_CLOSED_5M_CANDLE");
  } else {
    bearFailed.push("BEARISH_CANDLE_NOT_CONFIRMED");
  }

  // ATR support
  const volatilityOk = a.atr14 != null && a.atr14 > 0;

  if (volatilityOk && a.breakout) {
    bull += 6;
    bullReasons.push(`ATR_${a.atr14}_VOLATILITY_OK`);
  }

  if (volatilityOk && a.breakdown) {
    bear += 6;
    bearReasons.push(`ATR_${a.atr14}_VOLATILITY_OK`);
  }

  // Strict signal gates
  const bullGate =
    a.breakout &&
    a.vwap != null &&
    a.close > a.vwap &&
    a.ema20 != null &&
    a.close > a.ema20 &&
    a.rsi14 >= 55 &&
    a.adx >= ADX_MIN &&
    a.bullishCandle;

  const bearGate =
    a.breakdown &&
    a.vwap != null &&
    a.close < a.vwap &&
    a.ema20 != null &&
    a.close < a.ema20 &&
    a.rsi14 <= 45 &&
    a.adx >= ADX_MIN &&
    a.bearishCandle;

  if (bullGate && bull >= ALERT_THRESHOLD) {
    return {
      direction: "BULLISH",
      confidence: Math.min(100, bull),
      status:
        bull >= STRONG_THRESHOLD
          ? "STRONG CONFIRMED"
          : "CONFIRMED",
      reasons: bullReasons,
      failed: bullFailed
    };
  }

  if (bearGate && bear >= ALERT_THRESHOLD) {
    return {
      direction: "BEARISH",
      confidence: Math.min(100, bear),
      status:
        bear >= STRONG_THRESHOLD
          ? "STRONG CONFIRMED"
          : "CONFIRMED",
      reasons: bearReasons,
      failed: bearFailed
    };
  }

  return {
    direction:
      bull > bear
        ? "BULLISH_BUT_NOT_CONFIRMED"
        : "BEARISH_BUT_NOT_CONFIRMED",

    confidence: Math.max(bull, bear),
    status: "WAIT",

    reasons: bull > bear ? bullReasons : bearReasons,
    failed: bull > bear ? bullFailed : bearFailed
  };
}
// ==================================================
// TRADE PLAN
// ==================================================

function makeTradePlan(analysis, direction, optionLtp = null) {
  if (!analysis || !analysis.ready) {
    return null;
  }

  const entry = num(optionLtp, analysis.close);
  const atr = num(analysis.atr14);

  if (entry <= 0 || atr <= 0) {
    return null;
  }

  // Option premium risk is calculated from option premium,
  // not from the underlying index ATR.
  const risk = Math.max(entry * 0.08, 0.05);

  let stopLoss;
  let target1;
  let target2;

  if (direction === "CALL BUY") {
    stopLoss = entry - risk;
    target1 = entry + risk * 1.5;
    target2 = entry + risk * 2;
  } else if (direction === "PUT BUY") {
    stopLoss = entry - risk;
    target1 = entry + risk * 1.5;
    target2 = entry + risk * 2;
  } else {
    return null;
  }

  return {
    entry: round(entry, 2),
    stop_loss: round(Math.max(stopLoss, 0.05), 2),
    target_1: round(target1, 2),
    target_2: round(target2, 2),
    risk_per_unit: round(risk, 2),
    method: "OPTION_PREMIUM_PERCENTAGE_RISK"
  };
}

// ==================================================
// UPSTOX 5-MINUTE CANDLES
// ==================================================

async function get5mCandles(instrumentKey) {
  if (!instrumentKey) {
    throw new Error("instrument_key is required");
  }

  const encodedKey = encodeURIComponent(instrumentKey);

  const apiUrl =
    "https://api.upstox.com/v3/historical-candle/intraday/" +
    encodedKey +
    "/minutes/5";

  const result = await upstoxRequest(apiUrl);
  const candles = result?.data?.candles;

  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error("UPSTOX_CANDLES_NOT_AVAILABLE");
  }

  const closedCandles = getClosedCandles(candles, 5);

  if (closedCandles.length === 0) {
    throw new Error("NO_COMPLETED_5_MINUTE_CANDLES");
  }

  return closedCandles;
}

// ==================================================
// QUOTE
// ==================================================

async function getMarketQuote(instrumentKey) {
  if (!instrumentKey) {
    throw new Error("instrument_key is required");
  }

  const apiUrl =
    "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" +
    encodeURIComponent(instrumentKey);

  const result = await upstoxRequest(apiUrl);

  return result?.data || {};
}

// ==================================================
// ANALYSE ONE UNDERLYING
// ==================================================

async function analyseUnderlying(instrumentKey, name = "") {
  const candles = await get5mCandles(instrumentKey);

  const analysis = analyseCompletedCandles(candles);

  if (!analysis.ready) {
    return {
      success: true,
      name,
      instrument_key: instrumentKey,
      signal: "WAIT",
      reason: analysis.reason
    };
  }

  const signal = buildDirectionalSignal(analysis);

  let tradeType = "WAIT";

  if (signal.direction === "BULLISH" &&
      signal.status !== "WAIT") {
    tradeType = "CALL BUY";
  } else if (signal.direction === "BEARISH" &&
             signal.status !== "WAIT") {
    tradeType = "PUT BUY";
  }

  let quote = null;

  try {
    quote = await getMarketQuote(instrumentKey);
  } catch (e) {
    // Quote is optional for the underlying analysis.
  }

  return {
    success: true,
    name,
    instrument_key: instrumentKey,
    signal: tradeType,
    direction: signal.direction,
    status: signal.status,
    confidence_score: signal.confidence,
    signal_time: analysis.candleTime,
    last_price: analysis.close,

    indicators: {
      rsi14: analysis.rsi14,
      ema20: analysis.ema20,
      ema50: analysis.ema50,
      vwap: analysis.vwap,
      adx: analysis.adx,
      atr14: analysis.atr14,
      adr14: analysis.adr14,
      volume_ratio: analysis.volumeRatio,
      support: analysis.support,
      resistance: analysis.resistance,
      breakout: analysis.breakout,
      breakdown: analysis.breakdown
    },

    reasons: signal.reasons,
    failed_conditions: signal.failed,
    quote_data: quote
  };
      }// ==================================================
// MARKET SCAN CONFIGURATION
// ==================================================

const MARKET_INSTRUMENTS = [
  {
    name: "NIFTY 50",
    instrument_key: "NSE_INDEX|Nifty 50"
  },
  {
    name: "BANK NIFTY",
    instrument_key: "NSE_INDEX|Nifty Bank"
  },
  {
    name: "SENSEX",
    instrument_key: "BSE_INDEX|SENSEX"
  }
];

// ==================================================
// SCAN ALL INDEXES
// ==================================================

async function scanAllIndexes() {
  const results = [];

  for (const item of MARKET_INSTRUMENTS) {
    try {
      const result = await analyseUnderlying(
        item.instrument_key,
        item.name
      );

      results.push(result);
    } catch (error) {
      results.push({
        success: false,
        name: item.name,
        instrument_key: item.instrument_key,
        signal: "WAIT",
        error: error.message
      });
    }
  }

  const alerts = results.filter(
    item =>
      item.success &&
      (
        item.signal === "CALL BUY" ||
        item.signal === "PUT BUY"
      )
  );

  return {
    success: true,
    timeframe: "5minute",
    candle_confirmation: "CLOSED_CANDLE_ONLY",
    scanned: results.length,
    alert_count: alerts.length,
    alerts,
    results,
    generated_at: new Date().toISOString()
  };
}

// ==================================================
// SCAN ONE INDEX
// ==================================================

async function scanOneIndex(instrumentKey) {
  const item = MARKET_INSTRUMENTS.find(
    x => x.instrument_key === instrumentKey
  );

  if (!item) {
    throw new Error("Unsupported index instrument_key");
  }

  return analyseUnderlying(
    item.instrument_key,
    item.name
  );
}

// ==================================================
// RESPONSE HELPERS
// ==================================================

function getInstrumentKey(url) {
  return (
    url.searchParams.get("instrument_key") ||
    url.searchParams.get("instrumentKey") ||
    ""
  ).trim();
}

function getRequestedInstrumentKeys(url) {
  const raw =
    url.searchParams.get("instrument_keys") ||
    url.searchParams.get("instrumentKeys") ||
    "";

  return raw
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

// ==================================================
// SAFE API ERROR RESPONSE
// ==================================================

function apiErrorMessage(error) {
  const message = String(error?.message || "Unknown error");

  if (message.includes("UPSTOX_ACCESS_TOKEN_MISSING")) {
    return "Upstox access token is not configured";
  }

  return message;
}// ==================================================
// HTTP SERVER AND API ROUTES
// ==================================================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {
    // ----------------------------------------------
    // HOME
    // ----------------------------------------------

    if (url.pathname === "/" && req.method === "GET") {
      return sendJson(res, 200, {
        success: true,
        app: "Smart Trade India Backend",
        status: "running",
        version: "2.0",
        endpoints: [
          "/health",
          "/api/signals/scan",
          "/api/signals/underlying",
          "/api/market/quotes",
          "/api/market/candles"
        ]
      });
    }

    // ----------------------------------------------
    // HEALTH
    // ----------------------------------------------

    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, {
        success: true,
        app: "Smart Trade India Backend",
        status: "running",
        upstox_token_configured:
          Boolean(process.env.UPSTOX_ACCESS_TOKEN),
        timestamp: new Date().toISOString()
      });
    }

    // ----------------------------------------------
    // SCAN ALL INDEXES
    // ----------------------------------------------

       // SCAN ALL INDEXES
    if (
      url.pathname === "/api/signals/scan" &&
      req.method === "GET"
    ) {
      const result = await scanAllIndexes();
      return sendJson(res, 200, result);
    }

    // ----------------------------------------------
    // SCAN ONE UNDERLYING
    // ---------------------------------------------- 

    if (
      url.pathname === "/api/signals/underlying" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const result = await analyseUnderlying(
        instrumentKey,
        instrumentKey
      );

      return sendJson(res, 200, result);
    }

    // ----------------------------------------------
    // MARKET QUOTES
    // ----------------------------------------------

    if (
      url.pathname === "/api/market/quotes" &&
      req.method === "GET"
    ) {
      const keys = getRequestedInstrumentKeys(url);

      if (!keys.length) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_keys is required"
        });
      }

      const apiUrl =
        "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" +
        encodeURIComponent(keys.join(","));

      const result = await upstoxRequest(apiUrl);

      return sendJson(res, 200, {
        success: true,
        data: result.data || {}
      });
    }

    // ----------------------------------------------
    // 5-MINUTE CANDLES
    // ----------------------------------------------

    if (
      url.pathname === "/api/market/candles" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const interval =
        url.searchParams.get("interval") || "5minute";

      if (
        interval !== "5minute" &&
        interval !== "1minute"
      ) {
        return sendJson(res, 400, {
          success: false,
          error: "interval must be 1minute or 5minute"
        });
      }

      let candles;

      if (interval === "5minute") {
        candles = await get5mCandles(instrumentKey);
      } else {
        const apiUrl =
          "https://api.upstox.com/v3/historical-candle/" +
          encodeURIComponent(instrumentKey) +
          "/minutes/1";

        const result = await upstoxRequest(apiUrl);

        candles = getClosedCandles(
          result?.data?.candles || [],
          1
        );
      }

      return sendJson(res, 200, {
        success: true,
        instrument_key: instrumentKey,
        interval,
        candle_count: candles.length,
        candles
      });
    }

    // ----------------------------------------------
    // OPTION ALERTS — SAFE PLACEHOLDER
    // ----------------------------------------------

    if (
      url.pathname === "/api/options/scan" &&
      req.method === "GET"
    ) {
      return sendJson(res, 200, {
        success: true,
        expiry:
          url.searchParams.get("expiry") || "current_week",
        alert_count: 0,
        alerts: [],
        message:
          "Underlying index scan is available at /api/signals/scan. Option-chain confirmation is not implemented in this section."
      });
    }

    // ----------------------------------------------
    // UNKNOWN ROUTE
    // ----------------------------------------------

    return sendJson(res, 404, {
      success: false,
      error: "Endpoint not found",
      path: url.pathname
    });

  } catch (error) {
    console.error(
      "API error:",
      url.pathname,
      error.message
    );

    return sendJson(res, 500, {
      success: false,
      error: apiErrorMessage(error),
      path: url.pathname
    });
  }
});

// ==================================================
// START SERVER
// ==================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Smart Trade India backend listening on port ${PORT}`
  );
});

server.on("error", error => {
  console.error("Server startup error:", error);
  process.exit(1);
});
