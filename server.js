const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = "https://api.upstox.com";

const TIMEFRAME = 5;
const VOLUME_MULTIPLIER = 2;
const MIN_OI_CHANGE = 1;
const MIN_CANDLES = 30;
const MAX_WORKERS = 2;

let cachedStocks = [];
let masterCacheTime = 0;

const sentAlerts = new Map();

// ==========================================
// CORS
// ==========================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

// ==========================================
// UPSTOX REQUEST
// ==========================================

async function upstoxRequest(apiUrl) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error("UPSTOX_ACCESS_TOKEN_MISSING");
  }

  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `UPSTOX_ERROR_${response.status}`
    );
  }

  return data;
}

// ==========================================
// IST TIME
// ==========================================

function getISTDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getISTTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}

// ==========================================
// COMPLETED 5 MIN CANDLES
// ==========================================

function getCompletedCandles(candles) {
  const now = Date.now();

  return candles
    .filter(c => {
      const start = new Date(c[0]).getTime();

      return (
        Number.isFinite(start) &&
        start + TIMEFRAME * 60000 <= now
      );
    })
    .sort((a, b) =>
      new Date(a[0]) - new Date(b[0])
    );
}

// ==========================================
// RSI
// ==========================================

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
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

  return Number(
    (100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)
  );
}

// ==========================================
// EMA
// ==========================================

function calculateEMA(values, period) {
  if (values.length < period) return null;

  let ema =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ==========================================
// SESSION VWAP
// ==========================================

function calculateSessionVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  const today = getISTDate();

  let currentVWAP = null;
  let previousVWAP = null;

  for (const candle of candles) {
    if (getISTDate(new Date(candle[0])) !== today) {
      continue;
    }

    const high = Number(candle[2]);
    const low = Number(candle[3]);
    const close = Number(candle[4]);
    const volume = Number(candle[5]);

    const typical = (high + low + close) / 3;

    totalPV += typical * volume;
    totalVolume += volume;

    previousVWAP = currentVWAP;

    currentVWAP =
      totalVolume > 0
        ? totalPV / totalVolume
        : null;
  }

  return {
    current: currentVWAP,
    previous: previousVWAP
  };
}

// ==========================================
// ATR
// ==========================================

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);
    const previousClose = Number(candles[i - 1][4]);

    ranges.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  const last = ranges.slice(-period);

  return last.reduce((a, b) => a + b, 0) / period;
}

// ==========================================
// ADX
// ==========================================

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;

  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;

  const dxValues = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const high = Number(current[2]);
    const low = Number(current[3]);

    const previousHigh = Number(previous[2]);
    const previousLow = Number(previous[3]);
    const previousClose = Number(previous[4]);

    const upMove = high - previousHigh;
    const downMove = previousLow - low;

    const plusDM =
      upMove > downMove && upMove > 0 ? upMove : 0;

    const minusDM =
      downMove > upMove && downMove > 0 ? downMove : 0;

    const tr = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );

    trSum += tr;
    plusSum += plusDM;
    minusSum += minusDM;

    if (i >= period) {
      const plusDI = trSum > 0 ? 100 * plusSum / trSum : 0;
      const minusDI = trSum > 0 ? 100 * minusSum / trSum : 0;

      const denominator = plusDI + minusDI;

      dxValues.push(
        denominator > 0
          ? 100 * Math.abs(plusDI - minusDI) / denominator
          : 0
      );

      trSum -= rangesValue(candles, i - period + 1);
    }
  }

  if (dxValues.length < period) return null;

  const lastDX = dxValues.slice(-period);

  return Number(
    (lastDX.reduce((a, b) => a + b, 0) / period).toFixed(2)
  );
}

function rangesValue(candles, index) {
  if (index <= 0 || index >= candles.length) return 0;

  const c = candles[index];
  const p = candles[index - 1];

  return Math.max(
    Number(c[2]) - Number(c[3]),
    Math.abs(Number(c[2]) - Number(p[4])),
    Math.abs(Number(c[3]) - Number(p[4]))
  );
}

// ==========================================
// NSE F&O FUTURES MASTER
// ==========================================

async function getNSEFNOStocks() {
  if (
    cachedStocks.length > 0 &&
    Date.now() - masterCacheTime < 6 * 60 * 60 * 1000
  ) {
    return cachedStocks;
  }

  const response = await fetch(
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
  );

  if (!response.ok) {
    throw new Error("INSTRUMENT_MASTER_DOWNLOAD_FAILED");
  }

  const compressed = Buffer.from(
    await response.arrayBuffer()
  );

  const instruments = JSON.parse(
    zlib.gunzipSync(compressed).toString("utf8")
  );

  const today = new Date();

  const futures = instruments.filter(item =>
    item.segment === "NSE_FO" &&
    item.instrument_type === "FUT" &&
    item.underlying_type === "EQUITY" &&
    item.underlying_key &&
    item.expiry &&
    new Date(item.expiry) >= today
  );

  const unique = new Map();

  for (const item of futures) {
    const key = item.underlying_key;
    const existing = unique.get(key);

    if (
      !existing ||
      new Date(item.expiry) < new Date(existing.expiry)
    ) {
      unique.set(key, {
        symbol: item.underlying_symbol,
        instrument_key: item.instrument_key,
        expiry: item.expiry,
        trading_symbol: item.trading_symbol
      });
    }
  }

  cachedStocks = [...unique.values()];
  masterCacheTime = Date.now();

  return cachedStocks;
}

// ==========================================
// 5 MIN INTRADAY CANDLES
// ==========================================

function getDateDaysAgo(days) {
  const today = getISTDate();
  const [y, m, d] = today.split("-").map(Number);

  return new Date(
    Date.UTC(y, m - 1, d - days)
  ).toISOString().slice(0, 10);
}

async function getIntradayCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const today = getISTDate();
  const fromDate = getDateDaysAgo(10);

  const historicalUrl =
    `${UPSTOX_BASE}/v3/historical-candle/` +
    `${key}/minutes/5/${today}/${fromDate}`;

  const intradayUrl =
    `${UPSTOX_BASE}/v3/historical-candle/intraday/` +
    `${key}/minutes/5`;

  const [historical, intraday] = await Promise.all([
    upstoxRequest(historicalUrl),
    upstoxRequest(intradayUrl)
  ]);

  const allCandles = [
    ...(historical?.data?.candles || []),
    ...(intraday?.data?.candles || [])
  ];

  const unique = new Map();

  for (const candle of allCandles) {
    unique.set(candle[0], candle);
  }

  return getCompletedCandles([...unique.values()]);
}
// ==========================================
// MOMENTUM ANALYSIS
// ==========================================

function analyseMomentum(candles) {
  if (!Array.isArray(candles) ||
      candles.length < MIN_CANDLES) {
    return null;
  }

  const closes = candles.map(c => Number(c[4]));
  const volumes = candles.map(c => Number(c[5] || 0));

  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const close = Number(latest[4]);
  const open = Number(latest[1]);
  const high = Number(latest[2]);
  const low = Number(latest[3]);

  const previousClose = Number(previous[4]);

  const latestVolume = Number(latest[5] || 0);
  const previousVolume = Number(previous[5] || 0);

  const latestOI = Number(latest[6] || 0);
  const previousOI = Number(previous[6] || 0);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes, 14);

  const atr = calculateATR(candles, 14);
  const adx = calculateADX(candles, 14);

  if (
    ema20 === null ||
    ema50 === null ||
    rsi === null ||
    atr === null
  ) {
    return null;
  }

  // Volume average excluding current candle
  const oldVolumes = volumes.slice(-21, -1);

  const averageVolume =
    oldVolumes.reduce((a, b) => a + b, 0) /
    oldVolumes.length;

  const volumeRatio =
    averageVolume > 0
      ? latestVolume / averageVolume
      : 0;

  const volumeIncrease =
    latestVolume > previousVolume;

  // OI
  const oiAvailable =
    latestOI > 0 && previousOI > 0;

  const oiChange =
    oiAvailable
      ? ((latestOI - previousOI) / previousOI) * 100
      : null;

  const oiIncrease =
    oiAvailable && oiChange >= MIN_OI_CHANGE;

  // Price
  const priceChange =
    previousClose > 0
      ? ((close - previousClose) / previousClose) * 100
      : 0;

  // VWAP
  const vwapData = calculateSessionVWAP(candles);

  const vwap = vwapData.current;

  const previousVWAP = vwapData.previous;

  if (vwap === null) return null;

  const vwapCrossUp =
    previousClose <= previousVWAP &&
    close > vwap;

  const vwapCrossDown =
    previousClose >= previousVWAP &&
    close < vwap;

  // Breakout / breakdown
  const previous20 = candles.slice(-21, -1);

  const resistance = Math.max(
    ...previous20.map(c => Number(c[2]))
  );

  const support = Math.min(
    ...previous20.map(c => Number(c[3]))
  );

  const breakout = close > resistance;
  const breakdown = close < support;

  // Candle confirmation
  const bullishCandle = close > open;
  const bearishCandle = close < open;

  const strongBullishCandle =
    close > open &&
    high > low &&
    (close - open) / (high - low) >= 0.65;

  const strongBearishCandle =
    close < open &&
    high > low &&
    (open - close) / (high - low) >= 0.65;

  // Directional OI confirmation
  const longBuildUp =
    oiIncrease && priceChange > 0;

  const shortBuildUp =
    oiIncrease && priceChange < 0;

  // Trend
  const bullishTrend =
    close > ema20 && ema20 > ema50;

  const bearishTrend =
    close < ema20 && ema20 < ema50;

  const adxStrong = adx !== null && adx >= 20;

  // Strong signals
  const bullish =
    longBuildUp &&
    volumeRatio >= VOLUME_MULTIPLIER &&
    volumeIncrease &&
    rsi >= 60 &&
    rsi <= 80 &&
    close > vwap &&
    bullishTrend &&
    strongBullishCandle &&
    breakout &&
    adxStrong;

  const bearish =
    shortBuildUp &&
    volumeRatio >= VOLUME_MULTIPLIER &&
    volumeIncrease &&
    rsi >= 20 &&
    rsi <= 40 &&
    close < vwap &&
    bearishTrend &&
    strongBearishCandle &&
    breakdown &&
    adxStrong;

  let signal = "WAIT";

  if (bullish) {
    signal = "STRONG_BUY";
  } else if (bearish) {
    signal = "STRONG_SELL";
  }

  // Entry / SL / Targets
  const entry = close;

  let stopLoss = null;
  let target1 = null;
  let target2 = null;
  let target3 = null;

  if (signal === "STRONG_BUY") {
    stopLoss = entry - atr * 1.2;
    target1 = entry + atr * 1.5;
    target2 = entry + atr * 2;
    target3 = entry + atr * 3;
  }

  if (signal === "STRONG_SELL") {
    stopLoss = entry + atr * 1.2;
    target1 = entry - atr * 1.5;
    target2 = entry - atr * 2;
    target3 = entry - atr * 3;
  }

  return {
    signal,

    entry: Number(entry.toFixed(2)),

    stop_loss:
      stopLoss === null ? null : Number(stopLoss.toFixed(2)),

    target_1:
      target1 === null ? null : Number(target1.toFixed(2)),

    target_2:
      target2 === null ? null : Number(target2.toFixed(2)),

    target_3:
      target3 === null ? null : Number(target3.toFixed(2)),

    price_change_percent: Number(priceChange.toFixed(2)),

    volume: latestVolume,

    average_volume: Math.round(averageVolume),

    volume_ratio: Number(volumeRatio.toFixed(2)),

    oi: latestOI,

    oi_change_percent:
      oiChange === null ? null : Number(oiChange.toFixed(2)),

    rsi,

    ema20: Number(ema20.toFixed(2)),

    ema50: Number(ema50.toFixed(2)),

    vwap: Number(vwap.toFixed(2)),

    adx,

    atr: Number(atr.toFixed(2)),

    resistance: Number(resistance.toFixed(2)),

    support: Number(support.toFixed(2)),

    breakout,

    breakdown,

    candle_time: latest[0],

    conditions: {
      oi_increase: oiIncrease,
      long_build_up: longBuildUp,
      short_build_up: shortBuildUp,
      volume_blast: volumeRatio >= VOLUME_MULTIPLIER,
      volume_increase: volumeIncrease,
      rsi_bullish: rsi >= 60 && rsi <= 80,
      rsi_bearish: rsi >= 20 && rsi <= 40,
      vwap_above: close > vwap,
      vwap_below: close < vwap,
      vwap_cross_up: vwapCrossUp,
      vwap_cross_down: vwapCrossDown,
      ema_bullish: bullishTrend,
      ema_bearish: bearishTrend,
      adx_strong: adxStrong,
      bullish_candle: bullishCandle,
      bearish_candle: bearishCandle,
      breakout,
      breakdown
    }
  };
}

// ==========================================
// CONCURRENT WORKERS
// ==========================================

async function runWorkers(items, count, callback) {
  let index = 0;

  const workers = Array.from(
    { length: count },
    async () => {
      while (index < items.length) {
        const current = items[index++];

        await callback(current);
      }
    }
  );

  await Promise.all(workers);
}

// ==========================================
// TELEGRAM ALERT
// ==========================================

async function sendTelegramAlert(stock, analysis) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) return;

  const message =
    `🚨 ${analysis.signal}\n\n` +
    `Stock: ${stock.symbol}\n` +
    `Entry: ${analysis.entry}\n` +
    `SL: ${analysis.stop_loss}\n` +
    `Target 1: ${analysis.target_1}\n` +
    `Target 2: ${analysis.target_2}\n` +
    `Target 3: ${analysis.target_3}\n\n` +
    `RSI: ${analysis.rsi}\n` +
    `Volume: ${analysis.volume_ratio}x\n` +
    `OI Change: ${analysis.oi_change_percent}%\n` +
    `ADX: ${analysis.adx}\n` +
    `Time: ${analysis.candle_time}`;

  const url =
    `https://api.telegram.org/bot${botToken}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message
    })
  });
}

// ==========================================
// MAIN SCANNER
// ==========================================

async function scanIntraday() {
  const stocks = await getNSEFNOStocks();

  const results = [];
  const errors = [];

  await runWorkers(
    stocks,
    MAX_WORKERS,
    async stock => {
      try {
        const candles =
          await getIntradayCandles(stock.instrument_key);

        const analysis =
          analyseMomentum(candles);

        if (!analysis) return;

        const item = {
          symbol: stock.symbol,
          trading_symbol: stock.trading_symbol,
          instrument_key: stock.instrument_key,
          expiry: stock.expiry,
          ...analysis
        };

        results.push(item);

        if (
          analysis.signal === "STRONG_BUY" ||
          analysis.signal === "STRONG_SELL"
        ) {
          const alertKey =
            `${stock.instrument_key}_${analysis.candle_time}_${analysis.signal}`;

          if (!sentAlerts.has(alertKey)) {
            sentAlerts.set(alertKey, Date.now());

            try {
              await sendTelegramAlert(stock, analysis);
            } catch (e) {
              console.error("TELEGRAM ERROR:", e.message);
            }
          }
        }
      } catch (error) {
        errors.push({
          symbol: stock.symbol,
          error: error.message
        });
      }
    }
  );

  // Keep recent alert keys only
  for (const [key, time] of sentAlerts) {
    if (Date.now() - time > 24 * 60 * 60 * 1000) {
      sentAlerts.delete(key);
    }
  }

  const priority = {
    STRONG_BUY: 3,
    STRONG_SELL: 3,
    WAIT: 1
  };

  results.sort(
    (a, b) =>
      priority[b.signal] - priority[a.signal]
  );

  return {
    success: true,

    scanner: "SMART_TRADE_INDIA_INTRADAY",

    market: "NSE_FNO",

    timeframe: "5_MIN_COMPLETED_CANDLE",

    scan_time: getISTTime(),

    total_stocks: stocks.length,

    scanned: results.length,

    strong_buy_count:
      results.filter(x => x.signal === "STRONG_BUY").length,

    strong_sell_count:
      results.filter(x => x.signal === "STRONG_SELL").length,

    results,

    errors
  };
}

// ==========================================
// SERVER ROUTES
// ==========================================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    if (req.method !== "GET") {
      return sendJson(res, 405, {
        success: false,
        error: "GET_METHOD_REQUIRED"
      });
    }

    // HOME
    if (url.pathname === "/") {
      return sendJson(res, 200, {
        success: true,
        app: "SMART TRADE INDIA",
        scanner: "NSE FNO INTRADAY MOMENTUM",
        timeframe: "5 MINUTES",
        status: "RUNNING"
      });
    }

    // HEALTH
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        success: true,
        status: "RUNNING",
        upstox_token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN,
        telegram_configured:
          !!process.env.TELEGRAM_BOT_TOKEN &&
          !!process.env.TELEGRAM_CHAT_ID
      });
    }

    // UPSTOX STATUS
    if (url.pathname === "/api/upstox/status") {
      return sendJson(res, 200, {
        success: true,
        token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN
      });
    }

    // ALL SCAN RESULTS
    if (url.pathname === "/api/intraday/scan") {
      const result = await scanIntraday();
      return sendJson(res, 200, result);
    }

    // STRONG BUY ONLY
    if (url.pathname === "/api/intraday/bullish") {
      const result = await scanIntraday();
const data = result.results.filter(
        x => x.signal === "STRONG_SELL"
      );

      return sendJson(res, 200, {
        success: true,
        count: data.length,
        data
      });
    }

    // STRONG BOTH
    if (url.pathname === "/api/intraday/strong") {
      const result = await scanIntraday();

      const data = result.results.filter(
        x =>
          x.signal === "STRONG_BUY" ||
          x.signal === "STRONG_SELL"
      );

      return sendJson(res, 200, {
        success: true,
        count: data.length,
        data
      });
    }

    return sendJson(res, 404, {
      success: false,
      error: "API_ROUTE_NOT_FOUND"
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
});

// ==========================================
// START
// ==========================================

server.listen(PORT, () => {
  console.log(
    `SMART TRADE INDIA INTRADAY RUNNING ON PORT ${PORT}`
  );
});
