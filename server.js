// ==========================================
// SMART TRADE INDIA
// Node.js 20+ | Upstox API V3 | Render
// ==========================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ==========================================
// SCANNER SETTINGS
// ==========================================

const CFG = {
  interval: 5,
  volumeMultiplier: 1.5,
  bullishRsi: 65,
  bearishRsi: 35,
  minAdx: 20,
  adxPeriod: 14,
  workers: 3,
  maxInstruments: 250,
  minCandles: 30
};

let cachedUniverse = [];
let universeLoadedAt = 0;
let scanInProgress = false;
let lastScan = null;

// ==========================================
// JSON RESPONSE
// ==========================================

function json(res, status, body) {

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });

  res.end(JSON.stringify(body));

}

// ==========================================
// HTTP GET
// ==========================================

function get(url, headers = {}, timeout = 20000) {

  return new Promise((resolve, reject) => {

    const req = https.get(url, {
      headers,
      timeout
    }, response => {

      let data = "";

      response.setEncoding("utf8");

      response.on("data", chunk => {
        data += chunk;
      });

      response.on("end", () => {

        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        if (
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {

          return reject(
            new Error(
              "HTTP " + response.statusCode +
              ": " + data.slice(0, 300)
            )
          );

        }

        resolve(parsed);

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
        "User-Agent": "SmartMarketScanner/1.0",
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

        const nextUrl =
          new URL(location, url).toString();

        return resolve(
          downloadBuffer(nextUrl, redirects - 1)
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
      req.destroy(new Error("Download timeout"));
    });

    req.on("error", reject);

  });

}

// ==========================================
// UPSTOX API
// ==========================================

async function upstox(path) {

  if (!TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN missing"
    );
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
// INDIA TIME
// ==========================================

function istMinuteOfDay(value) {

  const date = new Date(value);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date).split(":").map(Number);

  return parts[0] * 60 + parts[1];

}

// ==========================================
// COMPLETED 5 MINUTE CANDLES
// ==========================================

function getCompletedCandles(raw) {

  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(now).split(":").map(Number);

  const currentMinute =
    parts[0] * 60 + parts[1];

  const currentBucket =
    Math.floor(currentMinute / CFG.interval) *
    CFG.interval;

  return (raw || []).map(c => ({

    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5] || 0),
    oi: Number(c[6] || 0)

  })).filter(c => {

    if (
      ![
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume
      ].every(Number.isFinite)
    ) {
      return false;
    }

    const minute = istMinuteOfDay(c.time);

    const candleDate = new Intl.DateTimeFormat(
      "en-CA",
      { timeZone: "Asia/Kolkata" }
    ).format(new Date(c.time));

    if (candleDate !== istDate()) {
      return true;
    }

    if (
      currentMinute >= 555 &&
      currentMinute <= 930
    ) {

      return (
        Math.floor(minute / CFG.interval) *
        CFG.interval < currentBucket
      );

    }

    return true;

  }).sort((a, b) =>
    new Date(a.time) - new Date(b.time)
  );

    }// ==========================================
// EMA INDICATOR
// ==========================================

function ema(values, period) {

  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {

    result =
      values[i] * k +
      result * (1 - k);

  }

  return result;

}


// ==========================================
// RSI INDICATOR - WILDER
// ==========================================

function rsi(values, period = 14) {

  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {

    const diff = values[i] - values[i - 1];

    gain += Math.max(diff, 0);
    loss += Math.max(-diff, 0);

  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {

    const diff = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) +
      Math.max(diff, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) +
      Math.max(-diff, 0)) / period;

  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));

}

// ==========================================
// ADX INDICATOR - WILDER
// ==========================================

function adx(candles, period = 14) {

  if (candles.length < period * 2 + 1) {
    return null;
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {

    const prev = candles[i - 1];
    const curr = candles[i];

    const up = curr.high - prev.high;
    const down = prev.low - curr.low;

    tr.push(Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    ));

    plusDM.push(
      up > down && up > 0 ? up : 0
    );

    minusDM.push(
      down > up && down > 0 ? down : 0
    );

  }

  let smTR = tr.slice(0, period)
    .reduce((a, b) => a + b, 0);

  let smPlus = plusDM.slice(0, period)
    .reduce((a, b) => a + b, 0);

  let smMinus = minusDM.slice(0, period)
    .reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = period - 1; i < tr.length; i++) {

    if (i >= period) {

      smTR = smTR - smTR / period + tr[i];

      smPlus =
        smPlus - smPlus / period + plusDM[i];

      smMinus =
        smMinus - smMinus / period + minusDM[i];

    }

    const pdi = smTR
      ? 100 * smPlus / smTR
      : 0;

    const mdi = smTR
      ? 100 * smMinus / smTR
      : 0;

    const denominator = pdi + mdi;

    dx.push(
      denominator
        ? 100 * Math.abs(pdi - mdi) / denominator
        : 0
    );

  }

  if (dx.length < period) return null;

  let result = dx.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dx.length; i++) {

    result =
      (result * (period - 1) + dx[i]) / period;

  }

  return result;

}


// ==========================================
// SESSION VWAP
// ==========================================

function sessionVWAP(candles) {

  const today = istDate();

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {

    const candleDate = new Intl.DateTimeFormat(
      "en-CA",
      { timeZone: "Asia/Kolkata" }
    ).format(new Date(c.time));

    if (candleDate !== today) continue;

    const typical =
      (c.high + c.low + c.close) / 3;

    totalPV += typical * c.volume;

    totalVolume += c.volume;

  }

  return totalVolume > 0
    ? totalPV / totalVolume
    : null;

}


// ==========================================
// MOMENTUM ANALYSIS
// ==========================================

function analyse(candles, instrument) {

  if (candles.length < CFG.minCandles) {
    return null;
  }

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];

  const prev = candles[candles.length - 2];

  // EMA20

  const ema20 = ema(closes, 20);

  // RSI14

  const r = rsi(closes, 14);

  // ADX14

  const adxValue = adx(candles, CFG.adxPeriod);

  // VWAP

  const vwap = sessionVWAP(candles);

  // AVERAGE VOLUME

  const previousCandles = candles.slice(-21, -1);

  const avgVol = previousCandles.length
    ? previousCandles.reduce(
        (sum, c) => sum + c.volume, 0
      ) / previousCandles.length
    : 0;

  const volumeRatio = avgVol > 0
    ? last.volume / avgVol
    : 0;

  const volumePass =
    volumeRatio >= CFG.volumeMultiplier;

  // PRICE AND OI

  const priceUp = last.close > prev.close;

  const priceDown = last.close < prev.close;

  const oiUp =
    last.oi > 0 &&
    prev.oi > 0 &&
    last.oi > prev.oi;

  // TREND

  const trendUp =
    ema20 !== null &&
    last.close > ema20;

  const trendDown =
    ema20 !== null &&
    last.close < ema20;

  // CANDLE STRENGTH

  const range = last.high - last.low;

  const bodyRatio = range > 0
    ? Math.abs(last.close - last.open) / range
    : 0;

  const strongGreen =
    last.close > last.open &&
    bodyRatio >= 0.55;

  const strongRed =
    last.close < last.open &&
    bodyRatio >= 0.55;

  // BREAKOUT / BREAKDOWN

  const previous20 = candles.slice(-21, -1);

  const resistance = Math.max(
    ...previous20.map(c => c.high)
  );

  const support = Math.min(
    ...previous20.map(c => c.low)
  );

  const breakout = last.close > resistance;

  const breakdown = last.close < support;

  // SIGNAL

  let signal = "NO_SIGNAL";

  let reasons = [];

  // STRONG BUY

  if (
    oiUp &&
    priceUp &&
    volumePass &&
    r !== null &&
    r >= CFG.bullishRsi &&
    r <= 85 &&
    vwap !== null &&
    last.close > vwap &&
    trendUp &&
    strongGreen &&
    adxValue !== null &&
    adxValue >= CFG.minAdx
  ) {

    signal = "STRONG_BUY";

    reasons = [
      "Price increasing",
      "OI increasing",
      "Volume spike",
      "RSI bullish",
      "Above VWAP",
      "EMA20 bullish",
      "Strong green candle",
      "ADX trend confirmed"
    ];

    if (breakout) {
      reasons.push("Resistance breakout");
    }

  }

  // STRONG SELL

  else if (
    oiUp &&
    priceDown &&
    volumePass &&
    r !== null &&
    r >= 15 &&
    r <= CFG.bearishRsi &&
    vwap !== null &&
    last.close < vwap &&
    trendDown &&
    strongRed &&
    adxValue !== null &&
    adxValue >= CFG.minAdx
  ) {

    signal = "STRONG_SELL";

    reasons = [
      "Price decreasing",
      "OI increasing",
      "Volume spike",
      "RSI bearish",
      "Below VWAP",
      "EMA20 bearish",
      "Strong red candle",
      "ADX trend confirmed"
    ];

    if (breakdown) {
      reasons.push("Support breakdown");
    }

  }

  return {

    symbol: instrument.symbol,

    underlying: instrument.underlying,

    exchange: instrument.exchange,

    instrumentKey: instrument.instrument_key,

    signal,

    ltp: last.close,

    candleTime: last.time,

    volume: last.volume,

    averageVolume: Math.round(avgVol),

    volumeRatio: Number(volumeRatio.toFixed(2)),

    oi: last.oi,

    rsi: r === null
      ? null
      : Number(r.toFixed(2)),

    ema20: ema20 === null
      ? null
      : Number(ema20.toFixed(2)),

    vwap: vwap === null
      ? null
      : Number(vwap.toFixed(2)),

    adx: adxValue === null
      ? null
      : Number(adxValue.toFixed(2)),

    resistance: Number(resistance.toFixed(2)),

    support: Number(support.toFixed(2)),

    breakout,

    breakdown,

    reasons

  };

}// =================================
// LOAD NSE F&O FUTURES
// =================================

async function loadUniverse(force = false) {

  if (
    !force &&
    cachedUniverse.length &&
    Date.now() - universeLoadedAt < 21600000
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
  const result = [];

  const futures = rows.filter(x => {

    const segment = String(x.segment || "");
    const type = String(x.instrument_type || "");

    return (
      segment === "NSE_FO" &&
      type === "FUT" &&
      x.instrument_key &&
      x.underlying_symbol
    );

  }).sort((a, b) =>
    Number(a.expiry || 0) - Number(b.expiry || 0)
  );

  for (const x of futures) {

    const expiry = x.expiry
      ? new Date(Number(x.expiry)).toISOString().slice(0, 10)
      : "";

    if (expiry && expiry < today) continue;

    const key = x.underlying_symbol;

    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      symbol: x.trading_symbol || key,
      underlying: key,
      exchange: "NSE",
      instrument_key: x.instrument_key
    });
  }

  cachedUniverse = result;
  universeLoadedAt = Date.now();

  return result;
}
// =================================
// GET 5 MINUTE CANDLES
// =================================
// =================================
// HISTORICAL + INTRADAY CANDLES
// =================================

async function candlesFor(key) {

  const today = istDate();

  // 10 days historical data
  const endDate = new Date(today + "T00:00:00Z");

  endDate.setUTCDate(
    endDate.getUTCDate() - 10
  );

  const fromDate = endDate
    .toISOString()
    .slice(0, 10);

  // Historical 5-minute candles
  const historicalPath =
    "/v3/historical-candle/" +
    encodeURIComponent(key) +
    "/minutes/5/" +
    today +
    "/" +
    fromDate;

  // Current day intraday candles
  const intradayPath =
    "/v3/historical-candle/intraday/" +
    encodeURIComponent(key) +
    "/minutes/5";

  const [historical, intraday] =
    await Promise.all([
      upstox(historicalPath),
      upstox(intradayPath)
    ]);

  const oldCandles =
    historical?.data?.candles || [];

  const todayCandles =
    intraday?.data?.candles || [];

  // Combine and remove duplicate timestamps
  const combined = new Map();

  for (const candle of [
    ...oldCandles,
    ...todayCandles
  ]) {
    combined.set(candle[0], candle);
  }

  const merged = Array.from(combined.values())
    .sort((a, b) =>
      new Date(a[0]) - new Date(b[0])
    );

  return getCompletedCandles(merged);
}



// =================================
// WORKER POOL
// =================================

async function workerPool(items, worker, concurrency) {

  const output = [];
  let next = 0;

  async function run() {

    while (next < items.length) {

      const index = next++;

      try {
        output[index] = await worker(items[index]);
      } catch (error) {
        output[index] = {
          _error: error.message,
          instrument: items[index].symbol
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      run
    )
  );

  return output;
}


// =================================
// RUN SCANNER
// =================================

async function runScan(limit = CFG.maxInstruments) {

  if (scanInProgress) {
    return {
      success: false,
      busy: true,
      message: "Scanner already running"
    };
  }

  scanInProgress = true;

  try {

    const universe = await loadUniverse();

    const selected = universe.slice(
      0,
      Math.max(
        1,
        Math.min(
          Number(limit) || CFG.maxInstruments,
          CFG.maxInstruments
        )
      )
    );

    const results = await workerPool(
      selected,
      async instrument => {

        const candles = await candlesFor(
          instrument.instrument_key
        );

        if (candles.length < 50) return null;

        return analyse(candles, instrument);
      },
      CFG.workers
    );

    const valid = results.filter(Boolean);

    const alerts = valid.filter(
      x => x.signal !== "NO_SIGNAL"
    );

    lastScan = {
      success: true,
      scanned: selected.length,
      analysed: valid.length,

      errors: results
        .filter(x => x && x._error)
        .slice(0, 20),

      bullish: alerts.filter(
        x => x.signal === "STRONG_BUY"
      ),

      bearish: alerts.filter(
        x => x.signal === "STRONG_SELL"
      ),

      alerts,
      timestamp: new Date().toISOString(),
      timeframe: "5-minute completed candles"
    };

    return lastScan;

  } finally {
    scanInProgress = false;
  }
}


// =================================
// SERVER ROUTES
// =================================

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {

    if (
      url.pathname === "/" ||
      url.pathname === "/health"
    ) {
      return json(res, 200, {
        success: true,
        service: "Smart Market Scanner",
        status: "running",
        tokenConfigured: Boolean(TOKEN),
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/upstox/status") {

      if (!TOKEN) {
        return json(res, 200, {
          success: false,
          connected: false,
          message: "UPSTOX_ACCESS_TOKEN missing"
        });
      }

      try {
        await upstox("/v2/user/profile");

        return json(res, 200, {
          success: true,
          connected: true
        });

      } catch (error) {
        return json(res, 200, {
          success: false,
          connected: false,
          error: error.message
        });
      }
    }

    if (url.pathname === "/api/scanner/config") {
      return json(res, 200, {
        success: true,
        config: CFG,
        universeCount: cachedUniverse.length,
        scanInProgress
      });
    }

    if (url.pathname === "/api/instruments/reload") {
      const universe = await loadUniverse(true);

      return json(res, 200, {
        success: true,
        count: universe.length,
        sample: universe.slice(0, 10)
      });
    }

    if (
      url.pathname === "/api/intraday/scan" ||
      url.pathname === "/api/intraday/strong"
    ) {
      const result = await runScan(
        url.searchParams.get("limit")
      );

      return json(res, 200, result);
    }

    if (url.pathname === "/api/intraday/bullish") {

      const result = lastScan ||
        await runScan(url.searchParams.get("limit"));

      return json(res, 200, {
        success: true,
        alerts: result.bullish || []
      });
    }

    if (url.pathname === "/api/intraday/bearish") {

      const result = lastScan ||
        await runScan(url.searchParams.get("limit"));

      return json(res, 200, {
        success: true,
        alerts: result.bearish || []
      });
    }

    if (url.pathname === "/api/intraday/last") {
      return json(res, 200,
        lastScan || {
          success: true,
          message: "No scan has run yet"
        }
      );
    }

    return json(res, 404, {
      success: false,
      error: "Route not found",
      path: url.pathname
    });

  } catch (error) {

    console.error("API Error:", error);

    return json(res, 500, {
      success: false,
      error: error.message
    });
  }
});


// =================================
// START SERVER
// =================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Smart Market Scanner running on port " + PORT
  );
});

