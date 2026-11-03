// SMART MARKET SCANNER
// Node.js 20+ | Upstox API V3 | Render

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const CFG = {
  interval: 5,
  volumeMultiplier: 1.5,
  bullishRsi: 65,
  bearishRsi: 35,
  minAdx: 20,
  workers: 3,
  maxInstruments: 250
};

let cachedUniverse = [];
let universeLoadedAt = 0;
let scanInProgress = false;
let lastScan = null;


// =================================
// JSON RESPONSE
// =================================

function json(res, status, body) {

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });

  res.end(JSON.stringify(body));
}


// =================================
// HTTP GET REQUEST
// =================================

function get(url, headers = {}, timeout = 15000) {

  return new Promise((resolve, reject) => {

    const req = https.get(url, {
      headers,
      timeout
    }, r => {

      let data = "";

      r.setEncoding("utf8");

      r.on("data", chunk => {
        data += chunk;
      });

      r.on("end", () => {

        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        if (r.statusCode < 200 || r.statusCode >= 300) {
          return reject(
            new Error("HTTP " + r.statusCode)
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

// =================================
// DOWNLOAD INSTRUMENT MASTER - FIX
// =================================

function downloadBuffer(url, redirects = 5) {

  return new Promise((resolve, reject) => {

    const req = https.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent": "SmartMarketScanner/1.0",
        "Accept": "*/*"
      }
    }, res => {

      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {

        const location = res.headers.location;

        if (!location || redirects <= 0) {
          res.resume();
          return reject(new Error("Too many redirects"));
        }

        res.resume();

        const nextUrl = new URL(location, url).toString();

        return resolve(
          downloadBuffer(nextUrl, redirects - 1)
        );

      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(
          new Error("Master download HTTP " + res.statusCode)
        );
      }

      const chunks = [];

      res.on("data", chunk => chunks.push(chunk));

      res.on("end", () => {
        resolve(Buffer.concat(chunks));
      });

    });

    req.on("timeout", () => {
      req.destroy(new Error("Download timeout"));
    });

    req.on("error", reject);

  });

}



// =================================
// UPSTOX API
// =================================

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


// =================================
// INDIA DATE
// =================================

function istDate() {

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

}


// =================================
// CANDLE TIME
// =================================

function istMinuteOfDay(iso) {

  const d = new Date(iso);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(d).split(":").map(Number);

  return parts[0] * 60 + parts[1];

}


// =================================
// COMPLETED CANDLES
// =================================

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

  const currentBucketStart =
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

    const m = istMinuteOfDay(c.time);

    const candleDay = String(c.time).slice(0, 10);

    return !(
      candleDay === istDate() &&
      currentMinute >= 555 &&
      currentMinute <= 930 &&
      Math.floor(m / CFG.interval) * CFG.interval
        >= currentBucketStart
    );

  }).sort((a, b) =>
    new Date(a.time) - new Date(b.time)
  );

}
// =================================
// EMA INDICATOR
// =================================

function ema(values, period) {

  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let value = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {

    value =
      values[i] * k +
      value * (1 - k);

  }

  return value;
}


// =================================
// RSI INDICATOR - WILDER
// =================================

function rsi(values, period = 14) {

  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {

    const diff = values[i] - values[i - 1];

    if (diff > 0) gain += diff;
    else loss -= diff;

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

  return 100 - 100 / (1 + avgGain / avgLoss);

}


// =================================
// ADX INDICATOR - WILDER
// =================================

function adx(candles, period = 14) {

  if (candles.length < period * 2 + 2) {
    return null;
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {

    const previous = candles[i - 1];
    const current = candles[i];

    const up = current.high - previous.high;
    const down = previous.low - current.low;

    tr.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
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

  for (let i = period; i < tr.length; i++) {

    if (i > period) {

      smTR = smTR - smTR / period + tr[i];

      smPlus =
        smPlus - smPlus / period + plusDM[i];

      smMinus =
        smMinus - smMinus / period + minusDM[i];

    }

    const pdi = smTR ? 100 * smPlus / smTR : 0;

    const mdi = smTR ? 100 * smMinus / smTR : 0;

    const value = pdi + mdi
      ? 100 * Math.abs(pdi - mdi) / (pdi + mdi)
      : 0;

    dx.push(value);

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


// =================================
// SESSION VWAP
// =================================

function sessionVWAP(candles) {

  const today = istDate();

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {

    if (String(c.time).slice(0, 10) !== today) {
      continue;
    }

    const typical =
      (c.high + c.low + c.close) / 3;

    totalPV += typical * c.volume;

    totalVolume += c.volume;

  }

  return totalVolume
    ? totalPV / totalVolume
    : null;

}


// =================================
// MOMENTUM ANALYSIS
// =================================

function analyse(candles, instrument) {

  if (candles.length < 35) return null;

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];

  const prev = candles[candles.length - 2];

  const avgVol =
    candles.slice(-21, -1)
      .reduce((sum, c) => sum + c.volume, 0) / 20;

  const volumeRatio =
    avgVol ? last.volume / avgVol : 0;

  const r = rsi(closes, 14);

  const ema20 = ema(closes, 20);

  const ema50 = ema(closes, 50);

  const adxValue = adx(candles, 14);

  const vwap = sessionVWAP(candles);

  const oiUp =
    last.oi > 0 &&
    prev.oi > 0 &&
    last.oi > prev.oi;

  const priceUp = last.close > prev.close;

  const priceDown = last.close < prev.close;

  const volumePass =
    volumeRatio >= CFG.volumeMultiplier;

  const resistance = Math.max(
    ...candles.slice(-21, -1).map(c => c.high)
  );

  const support = Math.min(
    ...candles.slice(-21, -1).map(c => c.low)
  );

  const range = last.high - last.low;

  const body = range
    ? Math.abs(last.close - last.open) / range
    : 0;

  const strongGreen =
    last.close > last.open && body >= 0.55;

  const strongRed =
    last.close < last.open && body >= 0.55;

  const trendUp =
    ema20 !== null &&
    ema50 !== null &&
    last.close > ema20 &&
    ema20 > ema50;

  const trendDown =
    ema20 !== null &&
    ema50 !== null &&
    last.close < ema20 &&
    ema20 < ema50;

  const breakout = last.close > resistance;

  const breakdown = last.close < support;

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
      "EMA trend bullish",
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
    r <= CFG.bearishRsi &&
    r >= 15 &&
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
      "EMA trend bearish",
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

    rsi: r === null ? null : Number(r.toFixed(2)),

    ema20: ema20 === null ? null : Number(ema20.toFixed(2)),

    ema50: ema50 === null ? null : Number(ema50.toFixed(2)),

    vwap: vwap === null ? null : Number(vwap.toFixed(2)),

    adx: adxValue === null
      ? null
      : Number(adxValue.toFixed(2)),

    resistance: Number(resistance.toFixed(2)),

    support: Number(support.toFixed(2)),

    reasons

  };

      }// =================================
// LOAD NSE F&O FUTURES
// =================================

async function loadUniverse(force = false) {

  if (
    !force &&
    cachedUniverse.length &&
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

    const segment = String(x.segment || "");

    const type = String(x.instrument_type || "");

    return (
      (segment === "NSE_FO" || segment === "BSE_FO") &&
      type === "FUT" &&
      x.instrument_key &&
      x.underlying_symbol
    );

  }).filter(x => {

    const expiry = x.expiry
      ? new Date(Number(x.expiry)).toISOString().slice(0, 10)
      : "";

    return !expiry || expiry >= today;

  }).sort((a, b) =>
    Number(a.expiry || 0) - Number(b.expiry || 0)
  );

  const result = [];

  for (const x of futures) {

    const key =
      x.segment + "|" + x.underlying_symbol;

    if (seen.has(key)) continue;

    seen.add(key);

    result.push({

      symbol: x.trading_symbol || x.underlying_symbol,

      underlying: x.underlying_symbol,

      exchange: String(x.segment).startsWith("BSE")
        ? "BSE"
        : "NSE",

      instrument_key: x.instrument_key,

      expiry: x.expiry
        ? new Date(Number(x.expiry)).toISOString().slice(0, 10)
        : null

    });

  }

  cachedUniverse = result;

  universeLoadedAt = Date.now();

  return result;

}


// =================================
// GET 5 MINUTE CANDLES
// =================================

async function candlesFor(key) {

  const path =
    "/v3/historical-candle/intraday/" +
    encodeURIComponent(key) +
    "/minutes/5";

  const result = await upstox(path);

  return getCompletedCandles(
    result?.data?.candles || []
  );

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
      message: "Scanner already running",
      lastScan
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

        if (candles.length < 35) return null;

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
// SERVER
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

    // HEALTH

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


    // UPSTOX STATUS

    if (url.pathname === "/api/upstox/status") {

      if (!TOKEN) {

        return json(res, 200, {
          success: false,
          connected: false,
          message: "UPSTOX_ACCESS_TOKEN missing"
        });

      }

      try {

        const profile = await upstox("/v2/user/profile");

        return json(res, 200, {
          success: true,
          connected: true,
          profile: profile.data || profile
        });

      } catch (error) {

        return json(res, 200, {
          success: false,
          connected: false,
          error: error.message
        });

      }

    }


    // SCANNER CONFIG

    if (url.pathname === "/api/scanner/config") {

      return json(res, 200, {

        success: true,

        config: CFG,

        universeCount: cachedUniverse.length,

        scanInProgress

      });

    }


    // RELOAD INSTRUMENTS

    if (url.pathname === "/api/instruments/reload") {

      const universe = await loadUniverse(true);

      return json(res, 200, {

        success: true,

        count: universe.length,

        sample: universe.slice(0, 10)

      });

    }


    // FULL SCAN

    if (
      url.pathname === "/api/intraday/scan" ||
      url.pathname === "/api/intraday/strong"
    ) {

      const result = await runScan(
        url.searchParams.get("limit")
      );

      return json(res, 200, result);

    }


    // BULLISH SIGNALS

    if (url.pathname === "/api/intraday/bullish") {

      const result =
        lastScan || await runScan(
          url.searchParams.get("limit")
        );

      return json(res, 200, {

        success: true,

        alerts: result.bullish || []

      });

    }


    // BEARISH SIGNALS

    if (url.pathname === "/api/intraday/bearish") {

      const result =
        lastScan || await runScan(
          url.searchParams.get("limit")
        );

      return json(res, 200, {

        success: true,

        alerts: result.bearish || []

      });

    }


    // LAST SCAN

    if (url.pathname === "/api/intraday/last") {

      return json(res, 200,

        lastScan || {
          success: true,
          message: "No scan has run yet"
        }

      );

    }


    // INVALID ROUTE

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
