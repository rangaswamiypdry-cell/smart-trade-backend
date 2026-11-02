const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = "https://api.upstox.com";

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
// UPSTOX API
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
// IST DATE
// ==========================================

function getISTDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

// ==========================================
// RSI WILDER
// ==========================================

function calculateRSI(closes, period = 14) {

  if (closes.length < period + 1) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {

    const change = closes[i] - closes[i - 1];

    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {

    const change = closes[i] - closes[i - 1];

    avgGain =
      (avgGain * 13 + Math.max(change, 0)) / 14;

    avgLoss =
      (avgLoss * 13 + Math.max(-change, 0)) / 14;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  const rs = avgGain / avgLoss;

  return Number(
    (100 - 100 / (1 + rs)).toFixed(2)
  );
}

// ==========================================
// EMA
// ==========================================

function calculateEMA(values, period = 20) {

  if (values.length < period) return null;

  let ema =
    values.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {

    ema =
      (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ==========================================
// NSE F&O FUTURES MASTER
// ==========================================

let cachedStocks = [];
let masterCacheTime = 0;

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

  const futures = instruments.filter(item => {

    return (
      item.segment === "NSE_FO" &&
      item.instrument_type === "FUT" &&
      item.underlying_type === "EQUITY" &&
      item.underlying_key &&
      item.expiry &&
      new Date(item.expiry) >= today
    );
  });

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
        underlying_key: item.underlying_key,
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
// DAILY FUTURES CANDLES
// ==========================================

async function getDailyCandles(instrumentKey) {

  const toDate = getISTDate();

  const fromDate = getISTDate(
    new Date(Date.now() - 100 * 86400000)
  );

  const apiUrl =
    `${UPSTOX_BASE}/v3/historical-candle/` +
    `${encodeURIComponent(instrumentKey)}/days/1/` +
    `${toDate}/${fromDate}`;

  const result = await upstoxRequest(apiUrl);

  return result?.data?.candles || [];
}

// ==========================================
// BTST ANALYSIS
// ==========================================

function analyseBTST(candles) {

  if (!Array.isArray(candles)) return null;

  const today = getISTDate();

   const afterMarketClose = (() => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const hour = Number(
    parts.find(x => x.type === "hour").value
  );

  const minute = Number(
    parts.find(x => x.type === "minute").value
  );

 return hour > 15 || (hour === 15 && minute >= 30); 
})();

const completed = candles
  .filter(c => {
    const candleDate = getISTDate(new Date(c[0]));

    return (
      candleDate < today ||
      (afterMarketClose && candleDate === today)
    );
  })
  .sort((a, b) =>
    new Date(a[0]) - new Date(b[0])
  );

  if (completed.length < 25) return null;

  const latest = completed[completed.length - 1];

  const previous = completed[completed.length - 2];

  const closes = completed.map(c => Number(c[4]));

  const volumes = completed.map(c => Number(c[5] || 0));

  const latestClose = Number(latest[4]);

  const latestOpen = Number(latest[1]);

  const latestHigh = Number(latest[2]);

  const latestVolume = Number(latest[5]);

  const latestOI = Number(latest[6] || 0);

  const previousClose = Number(previous[4]);

  const previousVolume = Number(previous[5]);

  const previousOI = Number(previous[6] || 0);

  const ema20 = calculateEMA(closes, 20);

  const rsi14 = calculateRSI(closes, 14);

  // Previous 20 sessions average volume

  const oldVolumes = volumes.slice(-21, -1);

  const averageVolume =
    oldVolumes.reduce((a, b) => a + b, 0) / oldVolumes.length;

  const volumeRatio =
    averageVolume > 0
      ? latestVolume / averageVolume
      : 0;

  // Volume change %

  const volumeChange =
    previousVolume > 0
      ? ((latestVolume - previousVolume) / previousVolume) * 100
      : 0;

  // Price change %

  const priceChange =
    previousClose > 0
      ? ((latestClose - previousClose) / previousClose) * 100
      : 0;

  // OI change %

  const oiChange =
    previousOI > 0
      ? ((latestOI - previousOI) / previousOI) * 100
      : 0;

  // Resistance

  const previous20 = completed.slice(-21, -1);

  const resistance = Math.max(
    ...previous20.map(c => Number(c[2]))
  );

  // Conditions

  const priceIncrease = priceChange > 0;

  const volumeIncrease = volumeChange > 0;

  const volumeSpike = volumeRatio >= 1.5;

  const oiIncrease = oiChange >= 2;

  const bullishCandle = latestClose > latestOpen;

  const emaBullish = latestClose > ema20;

  const rsiBullish = rsi14 !== null && rsi14 > 60;

  const nearHigh =
    latestClose >= latestHigh * 0.98;

  const breakout = latestClose > resistance;

  // Strong momentum confirmation

  const strong =
    priceIncrease &&
    volumeIncrease &&
    volumeSpike &&
    oiIncrease &&
    bullishCandle &&
    emaBullish &&
    rsiBullish &&
    nearHigh;

  let signal = "WAIT";

  if (strong && breakout) {

    signal = "STRONG_BUY";

  } else if (strong) {

    signal = "BUY_CANDIDATE";

  }

  return {

    signal,

    price: latestClose,

    price_change_percent:
      Number(priceChange.toFixed(2)),

    volume: latestVolume,

    volume_change_percent:
      Number(volumeChange.toFixed(2)),

    volume_ratio:
      Number(volumeRatio.toFixed(2)),

    oi: latestOI,

    previous_oi: previousOI,

    oi_change:
      Number(oiChange.toFixed(2)),

    rsi14,

    ema20:
      Number(ema20.toFixed(2)),

    resistance,

    breakout,

    candle_date: String(latest[0]),

    conditions: {

      price_increase: priceIncrease,

      volume_increase: volumeIncrease,

      volume_spike: volumeSpike,

      oi_increase: oiIncrease,

      bullish_candle: bullishCandle,

      ema_bullish: emaBullish,

      rsi_bullish: rsiBullish,

      near_day_high: nearHigh,

      breakout
    }
  };
}

// ==========================================
// CONCURRENT WORKERS
// ==========================================

async function runWorkers(items, workerCount, callback) {

  let index = 0;

  const workers = Array.from(
    { length: workerCount },
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
// MAIN BTST SCANNER
// ==========================================

async function scanBTSTStocks() {

  const stocks = await getNSEFNOStocks();

  const results = [];

  const errors = [];

  await runWorkers(
    stocks,
    3,
    async stock => {

      try {

        const candles =
          await getDailyCandles(stock.instrument_key);

        const analysis =
          analyseBTST(candles);

        if (!analysis) return;

        results.push({

          symbol: stock.symbol,

          trading_symbol: stock.trading_symbol,

          instrument_key: stock.instrument_key,

          expiry: stock.expiry,

          ...analysis

        });

      } catch (error) {

        errors.push({

          symbol: stock.symbol,

          error: error.message

        });
      }
    }
  );

  const priority = {

    STRONG_BUY: 3,

    BUY_CANDIDATE: 2,

    WAIT: 1
  };

  results.sort(
    (a, b) =>
      priority[b.signal] - priority[a.signal]
  );

  return {

    success: true,

    scanner: "SMART_TRADE_INDIA_BTST",

    market: "NSE_FNO",

    timeframe: "DAILY_COMPLETED_CANDLE",

    total_stocks: stocks.length,

    scanned: results.length,

    strong_buy_count:
      results.filter(x => x.signal === "STRONG_BUY").length,

    buy_candidate_count:
      results.filter(x => x.signal === "BUY_CANDIDATE").length,

    results,

    errors
  };
}

// ==========================================
// SERVER
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

    // HOME

    if (url.pathname === "/") {

      return sendJson(res, 200, {

        success: true,

        app: "SMART TRADE INDIA",

        scanner: "NSE FNO BTST",

        status: "RUNNING"

      });
    }

    // HEALTH

    if (url.pathname === "/health") {

      return sendJson(res, 200, {

        success: true,

        status: "RUNNING",

        upstox_token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN

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

    // BTST SCANNER

    if (url.pathname === "/api/btst/scan") {

      if (req.method !== "GET") {

        return sendJson(res, 405, {

          success: false,

          error: "GET method required"

        });
      }

      const result = await scanBTSTStocks();

      return sendJson(res, 200, result);
    }

    // STRONG MOMENTUM ONLY

    if (url.pathname === "/api/btst/strong") {

      const result = await scanBTSTStocks();

      const strongStocks = result.results.filter(
        item => item.signal === "STRONG_BUY"
     );
      return sendJson(res, 200, {

        success: true,

        count: strongStocks.length,

        data: strongStocks

      });
    }

    // BUY CANDIDATES

    if (url.pathname === "/api/btst/candidates") {

      const result = await scanBTSTStocks();

      const candidates = result.results.filter(
        item =>
          item.signal === "BUY_CANDIDATE" ||
          item.signal === "STRONG_BUY"
      );

      return sendJson(res, 200, {

        success: true,

        count: candidates.length,

        data: candidates

      });
    }

    // NOT FOUND

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
    `SMART TRADE INDIA RUNNING ON PORT ${PORT}`
  );

});
