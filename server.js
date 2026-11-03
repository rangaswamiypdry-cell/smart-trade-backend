// ==========================================
// SMART TRADE INDIA
// NSE F&O INTRADAY MOMENTUM SCANNER
// Node.js 20+ | Upstox API V3 | Render
// ==========================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

// ==========================================
// CONFIGURATION
// ==========================================

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const CFG = {
  timeframe: 5,
  minCandles: 30,
  volumeMultiplier: 1.5,
  bullishRSI: 60,
  bearishRSI: 40,
  minADX: 20,
  workers: 3,
  maxInstruments: 250
};

let cachedUniverse = [];
let universeLoadedAt = 0;
let scanInProgress = false;
let lastScan = null;

// ==========================================
// JSON RESPONSE
// ==========================================

function json(res, status, data) {

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });

  res.end(JSON.stringify(data));

}

// ==========================================
// HTTPS GET
// ==========================================

function get(url, headers = {}, timeout = 20000) {

  return new Promise((resolve, reject) => {

    const req = https.get(url, {
      headers,
      timeout
    }, response => {

      let body = "";

      response.setEncoding("utf8");

      response.on("data", chunk => {
        body += chunk;
      });

      response.on("end", () => {

        let result;

        try {
          result = JSON.parse(body);
        } catch {
          result = body;
        }

        if (
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {

          return reject(
            new Error(
              "HTTP " + response.statusCode +
              ": " + String(body).slice(0, 250)
            )
          );

        }

        resolve(result);

      });

    });

    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", reject);

  });

}

// ==========================================
// DOWNLOAD MASTER FILE
// ==========================================

function downloadBuffer(url, redirects = 5) {

  return new Promise((resolve, reject) => {

    const req = https.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent": "SmartTradeIndia/1.0",
        "Accept": "*/*"
      }
    }, response => {

      if (
        [301, 302, 303, 307, 308]
        .includes(response.statusCode)
      ) {

        const location = response.headers.location;

        response.resume();

        if (!location || redirects <= 0) {
          return reject(
            new Error("Too many redirects")
          );
        }

        return resolve(
          downloadBuffer(
            new URL(location, url).toString(),
            redirects - 1
          )
        );

      }

      if (response.statusCode !== 200) {

        response.resume();

        return reject(
          new Error(
            "Master download HTTP " +
            response.statusCode
          )
        );

      }

      const chunks = [];

      response.on("data", chunk => {
        chunks.push(chunk);
      });

      response.on("end", () => {
        resolve(Buffer.concat(chunks));
      });

    });

    req.on("timeout", () => {
      req.destroy(new Error("Master download timeout"));
    });

    req.on("error", reject);

  });

}

// ==========================================
// UPSTOX API REQUEST
// ==========================================

async function upstox(path) {

  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN missing");
  }

  return get(API + path, {
    "Accept": "application/json",
    "Authorization": "Bearer " + TOKEN
  });

}

// ==========================================
// INDIA DATE
// ==========================================

function istDate() {

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

}

// ==========================================
// INDIA CANDLE DATE
// ==========================================

function candleDate(value) {

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));

}

// ==========================================
// INDIA MINUTE
// ==========================================

function istMinute(value) {

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(value))
    .split(":")
    .map(Number);

  return parts[0] * 60 + parts[1];

}

// ==========================================
// COMPLETED 5 MINUTE CANDLES
// ==========================================

function getCompletedCandles(raw) {

  const now = new Date();

  const currentMinute = istMinute(now);

  const currentBucket =
    Math.floor(currentMinute / CFG.timeframe) *
    CFG.timeframe;

  const today = istDate();

  const map = new Map();

  for (const c of raw || []) {

    if (!Array.isArray(c) || c.length < 6) {
      continue;
    }

    const candle = {
      time: c[0],
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5] || 0),
      oi: Number(c[6] || 0)
    };

    if (
      ![
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume
      ].every(Number.isFinite)
    ) {
      continue;
    }

    if (
      candle.open <= 0 ||
      candle.high <= 0 ||
      candle.low <= 0 ||
      candle.close <= 0
    ) {
      continue;
    }

    if (candleDate(candle.time) === today) {

      const minute = istMinute(candle.time);

      const bucket =
        Math.floor(minute / CFG.timeframe) *
        CFG.timeframe;

      // Exclude current unfinished candle
      if (bucket >= currentBucket) {
        continue;
      }

    }

    map.set(candle.time, candle);

  }

  return Array.from(map.values())
    .sort((a, b) =>
      new Date(a.time) - new Date(b.time)
    );

}

// ==========================================
// LOAD NSE F&O FUTURES
// ==========================================

async function loadUniverse(force = false) {

  if (
    !force &&
    cachedUniverse.length > 0 &&
    Date.now() - universeLoadedAt < 6 * 60 * 60 * 1000
  ) {
    return cachedUniverse;
  }

  const buffer = await downloadBuffer(MASTER_URL);

  const parsed = JSON.parse(
    zlib.gunzipSync(buffer).toString("utf8")
  );

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed.data || [];

  const today = istDate();

  const seen = new Set();

  const futures = rows.filter(x => {

    return (
      x.segment === "NSE_FO" &&
      x.instrument_type === "FUT" &&
      x.instrument_key &&
      x.underlying_symbol
    );

  }).sort((a, b) => {

    return Number(a.expiry || 0) -
           Number(b.expiry || 0);

  });

  const result = [];

  for (const x of futures) {

    let expiryDate = "";

    if (x.expiry) {

      const expiryNumber = Number(x.expiry);

      expiryDate = Number.isFinite(expiryNumber)
        ? new Date(expiryNumber).toISOString().slice(0, 10)
        : String(x.expiry).slice(0, 10);

    }

    if (expiryDate && expiryDate < today) {
      continue;
    }

    const underlying = x.underlying_symbol;

    if (seen.has(underlying)) {
      continue;
    }

    seen.add(underlying);

    result.push({

      symbol: x.trading_symbol || underlying,

      underlying,

      exchange: "NSE",

      instrument_key: x.instrument_key,

      expiry: expiryDate || null

    });

  }

  cachedUniverse = result;

  universeLoadedAt = Date.now();

  return result;

}

// ==========================================
// GET CURRENT DAY 5 MINUTE CANDLES
// ==========================================

async function candlesFor(key) {

  const path =
    "/v3/historical-candle/intraday/" +
    encodeURIComponent(key) +
    "/minutes/5";

  const result = await upstox(path);

  const raw = result?.data?.candles || [];
  return getCompletedCandles(raw);
}
  // ==========================================
// PART 2: INDICATORS & INTRADAY ANALYSIS
// ==========================================

// EMA
function ema(values, period) {
  if (!values || values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

// RSI - Wilder method
function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;

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

    const currentGain = Math.max(change, 0);
    const currentLoss = Math.max(-change, 0);

    avgGain = ((avgGain * (period - 1)) + currentGain) / period;
    avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ADX - Wilder method
function adx(candles, period = 14) {
  if (!candles || candles.length < (period * 2 + 1)) {
    return null;
  }

  const trValues = [];
  const plusDMValues = [];
  const minusDMValues = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    const plusDM =
      upMove > downMove && upMove > 0 ? upMove : 0;

    const minusDM =
      downMove > upMove && downMove > 0 ? downMove : 0;

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trValues.push(tr);
    plusDMValues.push(plusDM);
    minusDMValues.push(minusDM);
  }

  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;

  for (let i = 0; i < period; i++) {
    smoothTR += trValues[i];
    smoothPlusDM += plusDMValues[i];
    smoothMinusDM += minusDMValues[i];
  }

  const dxValues = [];

  function calculateDX() {
    if (smoothTR <= 0) return 0;

    const plusDI = 100 * smoothPlusDM / smoothTR;
    const minusDI = 100 * smoothMinusDM / smoothTR;

    const denominator = plusDI + minusDI;

    if (denominator === 0) return 0;

    return 100 * Math.abs(plusDI - minusDI) / denominator;
  }

  dxValues.push(calculateDX());

  for (let i = period; i < trValues.length; i++) {
    smoothTR =
      smoothTR - (smoothTR / period) + trValues[i];

    smoothPlusDM =
      smoothPlusDM - (smoothPlusDM / period) + plusDMValues[i];

    smoothMinusDM =
      smoothMinusDM - (smoothMinusDM / period) + minusDMValues[i];

    dxValues.push(calculateDX());
  }

  if (dxValues.length < period) return null;

  let result = dxValues
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < dxValues.length; i++) {
    result = ((result * (period - 1)) + dxValues[i]) / period;
  }

  return result;
}

// Session VWAP
function sessionVWAP(candles) {
  if (!candles || candles.length === 0) return null;

  let totalPV = 0;
  let totalVolume = 0;

  for (const candle of candles) {
    const volume = Number(candle.volume) || 0;

    if (volume <= 0) continue;

    const typicalPrice =
      (candle.high + candle.low + candle.close) / 3;

    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  if (totalVolume <= 0) return null;

  return totalPV / totalVolume;
}

// Safe rounding
function roundNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return null;

  return Number(value.toFixed(digits));
}

// ==========================================
// INTRADAY ANALYSIS
// ==========================================

function analyse(candles, instrument) {

  if (!candles || candles.length < CFG.minCandles) {
    return null;
  }

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes, 14);
  const adx14 = adx(candles, 14);
  const vwap = sessionVWAP(candles);

  if (
    ema20 === null ||
    rsi14 === null ||
    adx14 === null ||
    vwap === null
  ) {
    return null;
  }

  // Average volume of previous 20 candles,
  // excluding the latest completed candle.
  const previous20 = candles.slice(-21, -1);

  if (previous20.length < 20) return null;

  const averageVolume =
    previous20.reduce(
      (sum, candle) => sum + (Number(candle.volume) || 0),
      0
    ) / 20;

  const currentVolume = Number(last.volume) || 0;

  const volumeRatio =
    averageVolume > 0
      ? currentVolume / averageVolume
      : 0;

  const volumePass =
    volumeRatio >= CFG.volumeMultiplier;

  // OI confirmation
  const currentOI = Number(last.oi) || 0;
  const previousOI = Number(previous.oi) || 0;

  const oiAvailable =
    currentOI > 0 && previousOI > 0;

  const oiIncreasing =
    oiAvailable && currentOI > previousOI;

  const oiChange =
    oiAvailable
      ? currentOI - previousOI
      : null;

  const oiChangePercent =
    oiAvailable && previousOI > 0
      ? ((currentOI - previousOI) / previousOI) * 100
      : null;

  // Candle strength
  const candleRange = last.high - last.low;

  const candleBody =
    candleRange > 0
      ? Math.abs(last.close - last.open) / candleRange
      : 0;

  const strongBullCandle =
    last.close > last.open && candleBody >= 0.55;

  const strongBearCandle =
    last.close < last.open && candleBody >= 0.55;

  // Previous 20-candle resistance and support
  // Latest candle is excluded from these levels.
  const resistance = Math.max(
    ...previous20.map(c => c.high)
  );

  const support = Math.min(
    ...previous20.map(c => c.low)
  );

  const breakout = last.close > resistance;
  const breakdown = last.close < support;

  // Trend confirmation
  const bullishTrend =
    last.close > ema20 &&
    last.close > vwap;

  const bearishTrend =
    last.close < ema20 &&
    last.close < vwap;

  const bullishRSI =
    rsi14 >= CFG.bullishRSI;

  const bearishRSI =
    rsi14 <= CFG.bearishRSI;

  const strongTrend =
    adx14 >= CFG.minADX;

  // Strong signals require all main conditions.
  // OI must be available and increasing.
  const strongBuy =
    bullishTrend &&
    bullishRSI &&
    volumePass &&
    oiIncreasing &&
    strongTrend &&
    strongBullCandle;

  const strongSell =
    bearishTrend &&
    bearishRSI &&
    volumePass &&
    oiIncreasing &&
    strongTrend &&
    strongBearCandle;

  let signal = "NO_SIGNAL";
  let confirmation = "WAIT";

  if (strongBuy) {
    signal = "STRONG_BUY";
    confirmation = breakout
      ? "BUY_CONFIRMED"
      : "WAIT_FOR_BREAKOUT";
  }

  if (strongSell) {
    signal = "STRONG_SELL";
    confirmation = breakdown
      ? "SELL_CONFIRMED"
      : "WAIT_FOR_BREAKDOWN";
  }

  const reasons = [];

  if (bullishTrend) reasons.push("PRICE_ABOVE_EMA20_VWAP");
  if (bearishTrend) reasons.push("PRICE_BELOW_EMA20_VWAP");

  if (volumePass) reasons.push("VOLUME_SPIKE");
  if (oiIncreasing) reasons.push("OI_INCREASING");

  if (strongTrend) reasons.push("ADX_STRONG");

  if (breakout) reasons.push("RESISTANCE_BREAKOUT");
  if (breakdown) reasons.push("SUPPORT_BREAKDOWN");

  if (bullishRSI) reasons.push("RSI_BULLISH");
  if (bearishRSI) reasons.push("RSI_BEARISH");

  return {
    symbol:
      instrument.trading_symbol ||
      instrument.name ||
      instrument.underlying_symbol ||
      "UNKNOWN",

    underlying:
      instrument.underlying_symbol || null,

    exchange: "NSE_FO",

    instrumentKey: instrument.instrument_key,

    signal,
    confirmation,

    price: roundNumber(last.close),
    candleTime: last.timestamp,

    volume: currentVolume,
    averageVolume: roundNumber(averageVolume),
    volumeRatio: roundNumber(volumeRatio),

    oi: currentOI || null,
    oiAvailable,
    oiIncreasing,
    oiChange: roundNumber(oiChange),
    oiChangePercent: roundNumber(oiChangePercent),

    rsi: roundNumber(rsi14),
    ema20: roundNumber(ema20),
    vwap: roundNumber(vwap),
    adx: roundNumber(adx14),

    support: roundNumber(support),
    resistance: roundNumber(resistance),

    breakout,
    breakdown,

    reasons
  };
      }
  // ==========================================
// PART 3: SCANNER ENGINE
// ==========================================

// Worker pool
async function runWorkers(items, workerCount, callback) {
  let index = 0;

  const workers = Array.from(
    { length: Math.min(workerCount, items.length) },
    async () => {
      while (true) {
        const currentIndex = index++;

        if (currentIndex >= items.length) break;

        await callback(items[currentIndex]);
      }
    }
  );

  await Promise.all(workers);
}

// ==========================================
// RUN INTRADAY SCAN
// ==========================================

async function runScan(limit) {

  if (scanInProgress) {
    return {
      success: false,
      busy: true,
      message: "Scanner already running"
    };
  }

  scanInProgress = true;

  const startedAt = new Date().toISOString();

  const result = {
    success: true,
    busy: false,
    timeframe: "5m",
    startedAt,
    completedAt: null,
    scanned: 0,
    analysed: 0,
    bullish: 0,
    bearish: 0,
    noSignal: 0,
    errors: 0,
    oiAvailableCount: 0,
    alerts: [],
    errorDetails: []
  };

  try {

    const universe = await loadUniverse();

    const requested = Number(limit);

    const effectiveLimit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, CFG.maxInstruments)
        : CFG.maxInstruments;

    const instruments = universe.slice(0, effectiveLimit);

    result.scanned = instruments.length;

    await runWorkers(
      instruments,
      CFG.workers,
      async instrument => {

        try {

          const candles = await candlesFor(
            instrument.instrument_key
          );

          const analysis = analyse(candles, instrument);

          if (!analysis) {
            result.errors += 0;
            return;
          }

          result.analysed++;

          if (analysis.oiAvailable) {
            result.oiAvailableCount++;
          }

          if (analysis.signal === "STRONG_BUY") {
            result.bullish++;
            result.alerts.push(analysis);
          } else if (analysis.signal === "STRONG_SELL") {
            result.bearish++;
            result.alerts.push(analysis);
          } else {
            result.noSignal++;
          }

        } catch (error) {

          result.errors++;

          if (result.errorDetails.length < 10) {
            result.errorDetails.push({
              symbol:
                instrument.trading_symbol ||
                instrument.name ||
                "UNKNOWN",
              error: error.message
            });
          }
        }
      }
    );

    // Sort strongest signals first
    result.alerts.sort((a, b) => {

      const scoreA =
        (a.volumeRatio || 0) +
        (a.adx || 0) / 100;

      const scoreB =
        (b.volumeRatio || 0) +
        (b.adx || 0) / 100;

      return scoreB - scoreA;
    });

    result.completedAt = new Date().toISOString();

    result.durationSeconds = roundNumber(
      (new Date(result.completedAt) -
        new Date(startedAt)) / 1000
    );

    result.oiDataStatus =
      result.oiAvailableCount > 0
        ? "OI_DATA_AVAILABLE"
        : "OI_DATA_NOT_AVAILABLE";

    lastScan = result;

    return result;

  } catch (error) {

    result.success = false;
    result.message = error.message;
    result.completedAt = new Date().toISOString();

    lastScan = result;

    return result;

  } finally {

    scanInProgress = false;
  }
}

// ==========================================
// HTTP SERVER
// ==========================================

const server = http.createServer(async (req, res) => {

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const path = url.pathname;

  // Health
  if (path === "/health") {
    return json(res, 200, {
      success: true,
      status: "ONLINE",
      scanner: "INTRADAY_FNO_SCANNER",
      timeframe: "5m",
      timestamp: new Date().toISOString()
    });
  }

  // Home
  if (path === "/") {
    return json(res, 200, {
      success: true,
      name: "Smart Intraday F&O Scanner",
      version: "1.0.0",
      timeframe: "5m",
      endpoints: [
        "/health",
        "/api/upstox/status",
        "/api/scanner/config",
        "/api/instruments/reload",
        "/api/intraday/scan",
        "/api/intraday/last",
        "/api/intraday/strong",
        "/api/intraday/bullish",
        "/api/intraday/bearish"
      ]
    });
  }

  // Upstox connection status
  if (path === "/api/upstox/status") {

    if (!TOKEN) {
      return json(res, 401, {
        success: false,
        connected: false,
        message: "UPSTOX_ACCESS_TOKEN missing in Render"
      });
    }

    try {

      const profile = await upstox(
        "/v2/user/profile"
      );

      return json(res, 200, {
        success: true,
        connected: true,
        user: profile
      });

    } catch (error) {

      return json(res, 401, {
        success: false,
        connected: false,
        message: error.message
      });
    }
  }

  // Scanner configuration
  if (path === "/api/scanner/config") {

    return json(res, 200, {
      success: true,
      config: CFG,
      scanInProgress,
      universeLoaded: cachedUniverse.length,
      lastScanTime: lastScan
        ? lastScan.completedAt
        : null
    });
  }

  // Reload instrument master
  if (path === "/api/instruments/reload") {

    try {

      cachedUniverse = [];
      universeLoadedAt = 0;

      const universe = await loadUniverse();

      return json(res, 200, {
        success: true,
        instruments: universe.length,
        message: "NSE F&O instrument master loaded"
      });

    } catch (error) {

      return json(res, 500, {
        success: false,
        message: error.message
      });
    }
  }

  // Start scanner
  if (path === "/api/intraday/scan") {

    if (scanInProgress) {
      return json(res, 202, {
        success: true,
        busy: true,
        message: "Scanner already running",
        lastScan
      });
    }

    const limit = url.searchParams.get("limit");

    // Respond immediately; scanner runs in background.
    runScan(limit).catch(error => {
      console.error("Background scan error:", error);
    });

    return json(res, 202, {
      success: true,
      busy: true,
      message: "Intraday scan started",
      timeframe: "5m"
    });
  }

  // Latest scan result
  if (path === "/api/intraday/last") {

    return json(res, 200, {
      success: true,
      scanInProgress,
      data: lastScan
    });
  }

  // Strong signals
  if (path === "/api/intraday/strong") {

    if (!lastScan) {
      return json(res, 200, {
        success: true,
        message: "No scan has run yet",
        alerts: []
      });
    }

    return json(res, 200, {
      success: true,
      alerts: lastScan.alerts || []
    });
  }

  // Bullish signals
  if (path === "/api/intraday/bullish") {

    const alerts = lastScan
      ? (lastScan.alerts || []).filter(
          item => item.signal === "STRONG_BUY"
        )
      : [];

    return json(res, 200, {
      success: true,
      count: alerts.length,
      alerts
    });
  }

  // Bearish signals
  if (path === "/api/intraday/bearish") {

    const alerts = lastScan
      ? (lastScan.alerts || []).filter(
          item => item.signal === "STRONG_SELL"
        )
      : [];

    return json(res, 200, {
      success: true,
      count: alerts.length,
      alerts
    });
  }

  return json(res, 404, {
    success: false,
    message: "Route not found",
    path
  });
});

// ==========================================
// START SERVER
// ==========================================

server.listen(PORT, () => {
  console.log(
    `Smart Intraday F&O Scanner running on port ${PORT}`
  );
});
