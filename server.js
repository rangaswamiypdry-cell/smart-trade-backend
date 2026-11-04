// ======================================================
// SMART TRADE INDIA
// NSE SHORT TERM SWING SCANNER V3
// 1 TO 5 DAYS MOMENTUM STOCK FINDER
// NODE.JS 20+ | UPSTOX V3 | RENDER
// ======================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = "https://api.upstox.com";

let instrumentCache = [];
let instrumentCacheTime = 0;

const CONFIG = {
  MIN_PRICE: 30,
  MAX_PRICE: 10000,

  MIN_RSI: 55,
  MAX_RSI: 75,

  MIN_ADX: 20,

  MIN_VOLUME_RATIO: 1.5,

  MIN_MOMENTUM: 1.0,

  MIN_SCORE: 65,

  STOP_LOSS_PERCENT: 2,

  TARGET1_PERCENT: 3,
  TARGET2_PERCENT: 5,

  MAX_STOCKS: 100,

  CONCURRENCY: 5
};

// ======================================================
// CORS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;

  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

// ======================================================
// UPSTOX REQUEST
// ======================================================

async function upstoxRequest(url) {

  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error("UPSTOX_ACCESS_TOKEN_MISSING");
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid Upstox response");
  }

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
// DATE HELPERS - INDIA
// ======================================================

function indiaDate(daysAgo = 0) {

  const date = new Date(
    Date.now() - daysAgo * 86400000
  );

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

// ======================================================
// NSE EQUITY INSTRUMENT MASTER
// ======================================================

async function getNSEStocks() {

  if (
    instrumentCache.length &&
    Date.now() - instrumentCacheTime < 86400000
  ) {
    return instrumentCache;
  }

  const instrumentUrl =
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

  const response = await fetch(instrumentUrl);

  if (!response.ok) {
    throw new Error("NSE instrument download failed");
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const json = zlib.gunzipSync(buffer).toString("utf8");

  const instruments = JSON.parse(json);

  const stocks = instruments.filter(item => {

    return (
      item.segment === "NSE_EQ" &&
      item.instrument_type === "EQ" &&
      item.instrument_key &&
      item.trading_symbol &&
      item.active !== false
    );

  });

  const unique = new Map();

  for (const stock of stocks) {

    unique.set(
      stock.instrument_key,
      {
        symbol: stock.trading_symbol,
        name: stock.name || stock.trading_symbol,
        instrument_key: stock.instrument_key
      }
    );

  }

  instrumentCache = Array.from(unique.values());

  instrumentCacheTime = Date.now();

  return instrumentCache;
}

// ======================================================
// HISTORICAL DAILY CANDLES
// ======================================================

async function getDailyCandles(instrumentKey) {

  const toDate = indiaDate(0);
  const fromDate = indiaDate(180);

  const url =
    `${UPSTOX_BASE}/v3/historical-candle/` +
    `${encodeURIComponent(instrumentKey)}` +
    `/days/1/${toDate}/${fromDate}`;

  const response = await upstoxRequest(url);

  return response?.data?.candles || [];
}

// ======================================================
// CANDLE VALIDATION
// ======================================================

function validateCandles(candles) {

  return candles
    .filter(c =>
      Array.isArray(c) &&
      c.length >= 6 &&
      Number.isFinite(new Date(c[0]).getTime()) &&
      [1, 2, 3, 4, 5].every(
        i => Number.isFinite(Number(c[i]))
      )
    )
    .sort(
      (a, b) =>
        new Date(a[0]).getTime() -
        new Date(b[0]).getTime()
    );

}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period) {

  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {

    ema =
      (values[i] - ema) * multiplier + ema;

  }

  return ema;
}

// ======================================================
// RSI 14
// ======================================================

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

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ======================================================
// MACD
// ======================================================

function calculateMACD(closes) {

  if (closes.length < 35) return null;

  const multiplier12 = 2 / 13;
  const multiplier26 = 2 / 27;

  let ema12 = closes[0];
  let ema26 = closes[0];

  const macdValues = [];

  for (const close of closes) {

    ema12 =
      (close - ema12) * multiplier12 + ema12;

    ema26 =
      (close - ema26) * multiplier26 + ema26;

    macdValues.push(ema12 - ema26);

  }

  const signal = calculateEMA(macdValues, 9);

  const macd = macdValues[macdValues.length - 1];

  return {
    macd,
    signal,
    histogram: macd - signal,
    bullish: macd > signal
  };
}

// ======================================================
// ADX 14
// ======================================================

function calculateADX(candles, period = 14) {

  if (candles.length < period * 2 + 1) {
    return null;
  }

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {

    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);

    const previousHigh = Number(candles[i - 1][2]);
    const previousLow = Number(candles[i - 1][3]);
    const previousClose = Number(candles[i - 1][4]);

    const up = high - previousHigh;
    const down = previousLow - low;

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );

    plusDM.push(
      up > down && up > 0 ? up : 0
    );

    minusDM.push(
      down > up && down > 0 ? down : 0
    );

  }

  let tr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let plus = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minus = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = period; i < trs.length; i++) {

    if (i > period) {

      tr = tr - tr / period + trs[i];

      plus =
        plus - plus / period + plusDM[i];

      minus =
        minus - minus / period + minusDM[i];

    }

    const plusDI = tr > 0 ? 100 * plus / tr : 0;
    const minusDI = tr > 0 ? 100 * minus / tr : 0;

    const sum = plusDI + minusDI;

    dx.push(
      sum > 0
        ? 100 * Math.abs(plusDI - minusDI) / sum
        : 0
    );

  }

  if (dx.length < period) return null;

  let adx =
    dx.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < dx.length; i++) {

    adx = (adx * (period - 1) + dx[i]) / period;

  }

  return adx;
}

// ======================================================
// SWING ANALYSIS
// ======================================================

function analyseSwingStock(stock, rawCandles) {

  const candles = validateCandles(rawCandles);

  if (candles.length < 60) {

    return {
      symbol: stock.symbol,
      signal: "INSUFFICIENT_DATA"
    };

  }

  const closes = candles.map(c => Number(c[4]));
  const highs = candles.map(c => Number(c[2]));
  const lows = candles.map(c => Number(c[3]));
  const volumes = candles.map(c => Number(c[5]));

  const last = candles[candles.length - 1];

  const previous = candles[candles.length - 2];

  const close = Number(last[4]);
  const open = Number(last[1]);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);

  const rsi = calculateRSI(closes, 14);

  const adx = calculateADX(candles, 14);

  const macd = calculateMACD(closes);

  const avgVolume =
    volumes.slice(-21, -1)
      .reduce((a, b) => a + b, 0) / 20;

  const currentVolume = volumes[volumes.length - 1];

  const volumeRatio =
    avgVolume > 0
      ? currentVolume / avgVolume
      : 0;

  const previous20High = Math.max(
    ...highs.slice(-21, -1)
  );

  const previous20Low = Math.min(
    ...lows.slice(-21, -1)
  );

  const price3DaysAgo =
    closes[closes.length - 4];

  const momentum3Days =
    ((close - price3DaysAgo) / price3DaysAgo) * 100;

  const momentum1Day =
    ((close - Number(previous[4])) /
      Number(previous[4])) * 100;

  const conditions = {

    aboveEMA20:
      close > ema20,

    emaBullish:
      ema20 > ema50,

    rsiStrong:
      rsi >= CONFIG.MIN_RSI &&
      rsi <= CONFIG.MAX_RSI,

    adxStrong:
      adx >= CONFIG.MIN_ADX,

    macdBullish:
      macd && macd.bullish,

    volumeStrong:
      volumeRatio >= CONFIG.MIN_VOLUME_RATIO,

    priceMomentum:
      momentum3Days >= CONFIG.MIN_MOMENTUM,

    bullishCandle:
      close > open,

    nearBreakout:
      close >= previous20High * 0.98,

    strongBreakout:
      close > previous20High

  };

  // ====================================================
  // MOMENTUM SCORE
  // ====================================================

  let score = 0;

  if (conditions.aboveEMA20) score += 15;

  if (conditions.emaBullish) score += 15;

  if (conditions.rsiStrong) score += 10;

  if (conditions.adxStrong) score += 10;

  if (conditions.macdBullish) score += 15;

  if (conditions.volumeStrong) score += 15;

  if (conditions.priceMomentum) score += 10;

  if (conditions.bullishCandle) score += 5;

  if (conditions.strongBreakout) score += 5;

  // ====================================================
  // ENTRY / STOP LOSS / TARGET
  // ====================================================

  const entry = close;

  const atr = calculateATR(candles, 14);

  const stopLoss = Math.max(
    entry * (1 - CONFIG.STOP_LOSS_PERCENT / 100),
    entry - atr * 1.5
  );

  const target1 = entry * (
    1 + CONFIG.TARGET1_PERCENT / 100
  );

  const target2 = entry * (
    1 + CONFIG.TARGET2_PERCENT / 100
  );

  const risk = entry - stopLoss;

  const reward = target2 - entry;

  const riskReward =
    risk > 0 ? reward / risk : 0;

  // ====================================================
  // SIGNAL
  // ====================================================

  let signal = "WAIT";

  if (
    score >= 80 &&
    conditions.aboveEMA20 &&
    conditions.emaBullish &&
    conditions.rsiStrong &&
    conditions.adxStrong &&
    conditions.macdBullish &&
    conditions.volumeStrong
  ) {

    signal = "STRONG_BUY";

  } else if (
    score >= CONFIG.MIN_SCORE &&
    conditions.aboveEMA20 &&
    conditions.emaBullish &&
    conditions.rsiStrong
  ) {

    signal = "BUY";

  }

  return {

    symbol: stock.symbol,

    name: stock.name,

    instrument_key: stock.instrument_key,

    price: round(close),

    previous_close: round(Number(previous[4])),

    change_percent: round(momentum1Day),

    momentum_3day: round(momentum3Days),

    ema20: round(ema20),

    ema50: round(ema50),

    rsi14: round(rsi),

    adx14: round(adx),

    macd: round(macd.macd),

    macd_signal: round(macd.signal),

    volume: currentVolume,

    average_volume: round(avgVolume),

    volume_ratio: round(volumeRatio),

    resistance: round(previous20High),

    support: round(previous20Low),

    atr14: round(atr),

    entry_price: round(entry),

    stop_loss: round(stopLoss),

    target1: round(target1),

    target2: round(target2),

    risk_reward: round(riskReward),

    momentum_score: score,

    signal,

    holding_period: "1-5 DAYS",

    fundamental_status: "NOT_VERIFIED",

    fundamental_note:
      "Connect a verified fundamental data source to check sales, profit, ROE and debt.",

    conditions,

    candle_time: last[0],

    signal_time: new Date().toISOString()

  };

}

// ======================================================
// ATR 14
// ======================================================

function calculateATR(candles, period = 14) {

  if (candles.length < period + 1) return 0;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {

    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);
    const previousClose = Number(candles[i - 1][4]);

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );

  }

  let atr =
    trs.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < trs.length; i++) {

    atr = (atr * (period - 1) + trs[i]) / period;

  }

  return atr;
}

// ======================================================
// ROUND
// ======================================================

function round(value) {

  return Number(
    Number(value || 0).toFixed(2)
  );

}

// ======================================================
// CONCURRENT SCANNER
// ======================================================

async function scanWithConcurrency(stocks, limit) {

  const results = [];

  let index = 0;

  async function worker() {

    while (true) {

      const current = index++;

      if (current >= stocks.length) return;

      const stock = stocks[current];

      try {

        const candles = await getDailyCandles(
          stock.instrument_key
        );

        const analysis = analyseSwingStock(
          stock,
          candles
        );

        results.push(analysis);

      } catch (error) {

        results.push({

          symbol: stock.symbol,

          signal: "ERROR",

          error: error.message

        });

      }

    }

  }

  const workers = Array.from(
    {
      length: Math.min(limit, CONFIG.CONCURRENCY)
    },
    () => worker()
  );

  await Promise.all(workers);

  return results;

}

// ======================================================
// MAIN SWING SCANNER
// ======================================================

async function scanSwingStocks(url) {

  const stocks = await getNSEStocks();

  const requestedLimit = Number(
    url.searchParams.get("limit") || CONFIG.MAX_STOCKS
  );

  const limit = Math.min(
    300,
    Math.max(1, requestedLimit)
  );

  const minScore = Number(
    url.searchParams.get("minScore") || CONFIG.MIN_SCORE
  );

  // Rotate the universe across scans to avoid repeatedly
  // scanning only the first symbols in the instrument file.

  const offset = Number(
    url.searchParams.get("offset") || 0
  );

  const selected = stocks.slice(
    offset,
    offset + limit
  );

  const allResults = await scanWithConcurrency(
    selected,
    limit
  );

  const valid = allResults.filter(
    s => s.price > 0 && Number.isFinite(s.momentum_score)
  );

  const bullish = valid
    .filter(s =>
      ["STRONG_BUY", "BUY"].includes(s.signal) &&
      s.momentum_score >= minScore
    )
    .sort(
      (a, b) =>
        b.momentum_score - a.momentum_score
    );

  const strongBuy = bullish.filter(
    s => s.signal === "STRONG_BUY"
  );

  const buy = bullish.filter(
    s => s.signal === "BUY"
  );

  return {

    success: true,

    scanner: "NSE_SHORT_TERM_SWING_V3",

    market: "NSE CASH",

    timeframe: "DAILY",

    holding_period: "1-5 DAYS",

    total_nse_stocks: stocks.length,

    checked: allResults.length,

    strong_buy_count: strongBuy.length,

    buy_count: buy.length,

    wait_count: valid.filter(
      s => s.signal === "WAIT"
    ).length,

    fundamental_status: "NOT_VERIFIED",

    strong_buy: strongBuy,

    buy: buy,

    signals: bullish,

    all_results: valid,

    timestamp: new Date().toISOString()

  };

}

// ======================================================
// HTTP SERVER
// ======================================================

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

    // HEALTH

    if (url.pathname === "/health") {

      return sendJson(res, 200, {

        success: true,

        message: "Smart Trade India Swing Scanner V3 Running",

        timestamp: new Date().toISOString()

      });

    }

    // UPSTOX STATUS

    if (url.pathname === "/api/upstox/status") {

      return sendJson(res, 200, {

        success: true,

        token_configured:
          Boolean(process.env.UPSTOX_ACCESS_TOKEN)

      });

    }

    // NSE STOCK LIST

    if (url.pathname === "/api/stocks/nse-list") {

      const stocks = await getNSEStocks();

      return sendJson(res, 200, {

        success: true,

        count: stocks.length,

        stocks

      });

    }

    // SWING SCANNER

    if (
      url.pathname === "/api/stocks/swing-scan" &&
      req.method === "GET"
    ) {

      const result = await scanSwingStocks(url);

      return sendJson(res, 200, result);

    }

    // STRONG BUY ONLY

    if (
      url.pathname === "/api/stocks/strong-buy" &&
      req.method === "GET"
    ) {

      const result = await scanSwingStocks(url);

      return sendJson(res, 200, {

        success: true,

        scanner: "NSE_STRONG_BUY",

        count: result.strong_buy_count,

        signals: result.strong_buy,

        timestamp: result.timestamp

      });

    }

    // BUY ONLY

    if (
      url.pathname === "/api/stocks/buy" &&
      req.method === "GET"
    ) {

      const result = await scanSwingStocks(url);

      return sendJson(res, 200, {

        success: true,

        count: result.buy_count,

        signals: result.buy,

        timestamp: result.timestamp

      });

    }

    // NOT FOUND

    return sendJson(res, 404, {

      success: false,

      error: "API route not found",

      path: url.pathname

    });

  } catch (error) {

    const status =
      error.message === "UPSTOX_ACCESS_TOKEN_MISSING"
        ? 503
        : 502;

    return sendJson(res, status, {

      success: false,

      error: error.message

    });

  }

});

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

  console.log(
    `Smart Trade India Swing ScanV3 running on ${PORT}`
  );

});
