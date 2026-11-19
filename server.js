"use strict";

// ======================================================
// SMART TRADE INDIA V10 PRO
// VERY STRONG OPTION SELLING SCANNER
// UPSTOX API | NODE.JS 20+
// PART 1 OF 4
// ======================================================

const http = require("http");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const BASE = "https://api.upstox.com";

const CONFIG = {
  VERSION: "SMART_TRADE_INDIA_V10_PRO",
  TIMEFRAME: 5,
  POLL_MS: 60000,
  MAX_DATA_AGE_MS: 60000,
  RSI_PERIOD: 14,
  RSI_BUY: 55,
  RSI_SELL: 45,
  VOLUME_MULTIPLIER: 1.5,
  MIN_OPTION_PREMIUM: 5,
  MAX_OPTION_PREMIUM: 1000,
  REQUIRE_ALL_SIX: true
};

// ======================================================
// INDEX SETTINGS
// ======================================================

const INDEXES = {
  NIFTY: {
    name: "NIFTY 50",
    key: "NSE_INDEX|Nifty 50"
  },

  BANKNIFTY: {
    name: "BANK NIFTY",
    key: "NSE_INDEX|Nifty Bank"
  },

  SENSEX: {
    name: "SENSEX",
    key: "BSE_INDEX|SENSEX"
  }
};

// ======================================================
// MEMORY
// ======================================================

const previousOptions = new Map();

let scanRunning = false;

let latestResults = {
  status: "WAITING",
  version: CONFIG.VERSION,
  updatedAt: null,
  indexes: [],
  signals: [],
  errors: []
};

// ======================================================
// UPSTOX REQUEST
// ======================================================

async function upstoxRequest(path) {

  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN missing");
  }

  const response = await fetch(BASE + path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + TOKEN
    },
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json();

  if (!response.ok || data.status === "error") {
    throw new Error(
      "UPSTOX ERROR " +
      response.status + " " +
      JSON.stringify(data)
    );
  }

  return data;
}

// ======================================================
// LIVE INDEX QUOTE
// ======================================================

async function getLiveQuote(instrumentKey) {

  const path =
    "/v2/market-quote/quotes?instrument_key=" +
    encodeURIComponent(instrumentKey);

  const result = await upstoxRequest(path);

  const values = Object.values(result.data || {});

  if (!values.length) {
    throw new Error("Quote unavailable: " + instrumentKey);
  }

  const quote = values[0];

  const price = Number(quote?.last_price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid live price: " + instrumentKey);
  }

  return {
    price,
    fetchedAt: Date.now(),
    raw: quote
  };
}

// ======================================================
// OPTION CONTRACTS
// ======================================================

async function getOptionContracts(index) {

  const path =
    "/v2/option/contract?instrument_key=" +
    encodeURIComponent(index.key);

  const result = await upstoxRequest(path);

  const contracts = result.data || [];

  if (!Array.isArray(contracts) || !contracts.length) {
    throw new Error("Option contracts unavailable");
  }

  const today = new Date().toLocaleDateString(
    "en-CA",
    { timeZone: "Asia/Kolkata" }
  );

  const expiries = [
    ...new Set(
      contracts
        .map(item => item.expiry)
        .filter(date => date && date >= today)
    )
  ].sort();

  if (!expiries.length) {
    throw new Error("No valid future expiry");
  }

  return {
    contracts,
    expiry: expiries[0]
  };
}

// ======================================================
// OPTION CHAIN
// ======================================================

async function getOptionChain(index, expiry) {

  const path =
    "/v2/option/chain?instrument_key=" +
    encodeURIComponent(index.key) +
    "&expiry_date=" +
    encodeURIComponent(expiry);

  const result = await upstoxRequest(path);

  const chain = result.data || [];

  if (!Array.isArray(chain) || !chain.length) {
    throw new Error("Option chain unavailable");
  }

  return chain;
}

// ======================================================
// 5 MINUTE CANDLES
// ======================================================

async function getFiveMinuteCandles(index) {

  const path =
    "/v3/historical-candle/intraday/" +
    encodeURIComponent(index.key) +
    "/minutes/5";

  const result = await upstoxRequest(path);

  const candles = result.data?.candles || [];

  if (!Array.isArray(candles) || !candles.length) {
    throw new Error("5 minute candles unavailable");
  }

  const now = Date.now();

  return candles
    .filter(c => {
      if (!Array.isArray(c) || !c[0]) return false;

      const candleTime = new Date(c[0]).getTime();

      return (
        Number.isFinite(candleTime) &&
        candleTime + 300000 <= now
      );
    })
    .sort(
      (a, b) =>
        new Date(b[0]).getTime() -
        new Date(a[0]).getTime()
    );
  }
// ======================================================
// EMA CALCULATION
// ======================================================

function calculateEMA(values, period) {

  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(-period)
    .reduce((a, b) => a + b, 0) / period;

  for (
    let i = values.length - period + 1;
    i < values.length;
    i++
  ) {
    ema =
      values[i] * multiplier +
      ema * (1 - multiplier);
  }

  return Number.isFinite(ema) ? ema : null;
}

// ======================================================
// RSI CALCULATION
// ======================================================

function calculateRSI(values, period = 14) {

  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
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

  return 100 - (100 / (1 + rs));
}

// ======================================================
// VWAP CALCULATION
// ======================================================

function calculateVWAP(candles) {

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {

    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    const volume = Number(c[5] || 0);

    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      continue;
    }

    const typical = (high + low + close) / 3;

    totalPV += typical * volume;
    totalVolume += volume;
  }

  if (!totalVolume) return null;

  return totalPV / totalVolume;
}

// ======================================================
// 5 MINUTE CANDLE ANALYSIS
// ======================================================

function analyseCandles(candles) {

  if (!Array.isArray(candles) || candles.length < 21) {
    return {
      ready: false,
      direction: "WAIT",
      reason: "INSUFFICIENT CANDLES"
    };
  }

  const ordered = [...candles].reverse();

  const closes = ordered.map(c => Number(c[4]));

  const volumes = ordered.map(c => Number(c[5] || 0));

  const latest = candles[0];
  const previous = candles[1];

  const close = Number(latest[4]);
  const open = Number(latest[1]);

  if (
    !Number.isFinite(close) ||
    !Number.isFinite(open) ||
    !Number.isFinite(Number(previous[4]))
  ) {
    return {
      ready: false,
      direction: "WAIT",
      reason: "INVALID CANDLE DATA"
    };
  }

  const ema20 = calculateEMA(closes, 20);

  const rsi = calculateRSI(
    closes,
    CONFIG.RSI_PERIOD
  );

  const vwap = calculateVWAP(ordered);

  if (
    !Number.isFinite(ema20) ||
    !Number.isFinite(rsi) ||
    !Number.isFinite(vwap)
  ) {
    return {
      ready: false,
      direction: "WAIT",
      reason: "INVALID TECHNICAL DATA"
    };
  }

  const averageVolume =
    volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  const volumeSpike =
    Number(latest[5] || 0) >=
    averageVolume * CONFIG.VOLUME_MULTIPLIER;

  const bearishCandle =
    close < open &&
    close < Number(previous[4]);

  const bullishCandle =
    close > open &&
    close > Number(previous[4]);

  const bearishBreakdown =
    close < Math.min(
      ...ordered.slice(-6, -1).map(c => Number(c[3]))
    );

  const bullishBreakout =
    close > Math.max(
      ...ordered.slice(-6, -1).map(c => Number(c[2]))
    );

  return {
    ready: true,
    close,
    ema20,
    rsi,
    vwap,
    volumeSpike,
    bearishCandle,
    bullishCandle,
    bearishBreakdown,
    bullishBreakout,
    candleTime: latest[0],
    fetchedAt: Date.now()
  };
}
// ======================================================
// OPTION SNAPSHOT
// ======================================================

function getOptionChanges(key, market) {

  const current = {
    price: Number(market?.ltp || 0),
    oi: Number(market?.oi || 0),
    volume: Number(market?.volume || 0),
    time: Date.now()
  };

  const old = previousOptions.get(key);

  previousOptions.set(key, current);

  if (!old) {
    return { ready: false };
  }

  return {
    ready: true,
    premiumDown: current.price < old.price,
    oiIncrease: current.oi > old.oi,
    volumeIncrease: current.volume > old.volume,
    oiChange: current.oi - old.oi,
    volumeChange: current.volume - old.volume,
    premiumChange: current.price - old.price,
    fetchedAt: current.time
  };
}

// ======================================================
// SELECT NEAREST OTM OPTION
// ======================================================

function selectOTM(chain, direction, spot) {

  const candidates = [];

  for (const row of (chain || [])) {

    const strike = Number(row?.strike_price);

    if (
      direction === "UP" &&
      strike < spot &&
      row?.put_options
    ) {
      candidates.push({
        strike,
        type: "PE",
        option: row.put_options
      });
    }

    if (
      direction === "DOWN" &&
      strike > spot &&
      row?.call_options
    ) {
      candidates.push({
        strike,
        type: "CE",
        option: row.call_options
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) =>
    Math.abs(a.strike - spot) -
    Math.abs(b.strike - spot)
  );

  return candidates[0];
}

// ======================================================
// VERY STRONG SELL — ALL SIX CONDITIONS
// ======================================================

function analyseSignal(selected, technical, direction) {

  if (!selected?.option?.instrument_key) return null;

  const market = selected.option.market_data || {};

  const premium = Number(market.ltp || 0);

  const bid = Number(market.bid_price || 0);
  const ask = Number(market.ask_price || 0);

  const bidQty = Number(market.bid_qty || 0);
  const askQty = Number(market.ask_qty || 0);

  if (
    !Number.isFinite(premium) ||
    premium < CONFIG.MIN_OPTION_PREMIUM ||
    premium > CONFIG.MAX_OPTION_PREMIUM ||
    !bid || !ask || ask < bid ||
    !bidQty || !askQty
  ) {
    return null;
  }

  const changes = getOptionChanges(
    selected.option.instrument_key,
    market
  );

  if (!changes.ready) return null;

  const bullish = direction === "UP";
  const bearish = direction === "DOWN";

  if (!bullish && !bearish) return null;

  // ORIGINAL SIX CONDITIONS
  const conditions = bullish ? {

    priceAboveEMA20:
      technical.close > technical.ema20,

    optionOIIncreasing:
      changes.oiIncrease,

    volumeSpike:
      technical.volumeSpike,

    RSIAbove55:
      technical.rsi >= CONFIG.RSI_BUY,

    priceAboveVWAP:
      technical.close > technical.vwap,

    bullishBreakout:
      technical.bullishBreakout

  } : {

    priceBelowEMA20:
      technical.close < technical.ema20,

    optionOIIncreasing:
      changes.oiIncrease,

    volumeSpike:
      technical.volumeSpike,

    RSIBelow45:
      technical.rsi <= CONFIG.RSI_SELL,

    priceBelowVWAP:
      technical.close < technical.vwap,

    bearishBreakdown:
      technical.bearishBreakdown
  };

  const passed = Object.values(conditions)
    .every(value => value === true);

  if (!passed) return null;

  if (
    (bullish && selected.type !== "PE") ||
    (bearish && selected.type !== "CE")
  ) {
    return null;
  }

  return {

    signal: "VERY_STRONG_SELL",

    action: selected.type + " SELL",

    optionType: selected.type,

    instrumentKey: selected.option.instrument_key,

    strike: selected.strike,

    premium,

    bid,
    ask,

    bidQty,
    askQty,

    spread: Number((ask - bid).toFixed(2)),

    oi: Number(market.oi || 0),

    volume: Number(market.volume || 0),

    oiChange: changes.oiChange,

    volumeChange: changes.volumeChange,

    premiumChange: changes.premiumChange,

    direction,

    rsi: Number(technical.rsi.toFixed(2)),

    ema20: Number(technical.ema20.toFixed(2)),

    vwap: Number(technical.vwap.toFixed(2)),

    conditions,

    passedConditions: 6,

    strength: "6/6 ALL CONDITIONS PASSED",

    timestamp: new Date().toISOString(),

    dataFetchedAt: technical.fetchedAt,

    optionLtpFetchedAt: changes.fetchedAt
  };
}

// ======================================================
// SCAN ONE INDEX
// ======================================================

async function scanOneIndex(symbol, index) {

  try {

    const [quote, candles, contractData] =
      await Promise.all([
        getLiveQuote(index.key),
        getFiveMinuteCandles(index),
        getOptionContracts(index)
      ]);

    const spot = quote.price;

    if (!Number.isFinite(spot) || spot <= 0) {
      throw new Error("Invalid index price");
    }

    const technical = analyseCandles(candles);

    if (
      !technical.ready ||
      !Number.isFinite(technical.close) ||
      !Number.isFinite(technical.ema20) ||
      !Number.isFinite(technical.rsi) ||
      !Number.isFinite(technical.vwap)
    ) {
      return {
        symbol,
        name: index.name,
        status: "WAITING FOR VALID CANDLES"
      };
    }

    const direction =
      technical.close > technical.ema20 &&
      technical.rsi >= CONFIG.RSI_BUY &&
      technical.close > technical.vwap &&
      technical.bullishBreakout
        ? "UP"
        : technical.close < technical.ema20 &&
          technical.rsi <= CONFIG.RSI_SELL &&
          technical.close < technical.vwap &&
          technical.bearishBreakdown
            ? "DOWN"
            : "SIDEWAYS";

    const result = {
      symbol,
      name: index.name,
      spot,
      direction,
      rsi: Number(technical.rsi.toFixed(2)),
      ema20: Number(technical.ema20.toFixed(2)),
      vwap: Number(technical.vwap.toFixed(2)),
      volumeSpike: technical.volumeSpike,
      candleTime: technical.candleTime,
      status: "WAITING",
      conditionsPassed: 0,
      signal: null
    };

    if (direction === "SIDEWAYS") return result;

    const expiry = contractData.expiry;

    const chainData = await getOptionChain(index, expiry);

    // UPDATED: PASS chainData DIRECTLY
    const selected = selectOTM(
      chainData,
      direction,
      spot
    );

    if (!selected) {
      result.status = "NO OTM CONTRACT";
      return result;
    }

    const signal = analyseSignal(
      selected,
      technical,
      direction
    );

    if (signal) {

      result.status = "VERY_STRONG_SELL";

      result.conditionsPassed = 6;

      result.signal = {
        index: symbol,
        indexName: index.name,
        expiry,
        spot,
        ...signal
      };
    }

    return result;

  } catch (error) {

    return {
      symbol,
      name: index.name,
      status: "ERROR",
      error: error.message
    };
  }
}

// ======================================================
// RUN ALL INDEXES
// ======================================================

async function runScan() {

  if (scanRunning) {
    return latestResults;
  }

  scanRunning = true;

  try {

    const entries = Object.entries(INDEXES);

    const results = await Promise.all(
      entries.map(([symbol, index]) =>
        scanOneIndex(symbol, index)
      )
    );

    const signals = results
      .filter(item => item.signal)
      .map(item => item.signal);

    const errors = results
      .filter(item => item.status === "ERROR")
      .map(item => ({
        index: item.symbol,
        error: item.error
      }));

    latestResults = {
      status: "SUCCESS",
      version: CONFIG.VERSION,
      updatedAt: new Date().toISOString(),
      indexes: results,
      signals,
      signalCount: signals.length,
      errors
    };

    return latestResults;

  } catch (error) {

    latestResults.status = "ERROR";

    latestResults.errors = [
      { error: error.message }
    ];

    return latestResults;

  } finally {

    scanRunning = false;

  }
}
// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, statusCode, data) {

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

// ======================================================
// DASHBOARD HTML
// ======================================================

const dashboardHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>SMART TRADE INDIA V10 PRO</title>

<style>
body {
  background: #101827;
  color: white;
  font-family: Arial;
  margin: 0;
  padding: 15px;
}

h1 {
  color: #00e5a8;
  text-align: center;
}

button {
  padding: 13px;
  margin: 5px;
  border: 0;
  border-radius: 8px;
  background: #00c896;
  color: black;
  font-weight: bold;
}

.card {
  background: #1d293b;
  padding: 14px;
  margin: 12px 0;
  border-radius: 10px;
  border: 1px solid #35445c;
}

.good {
  color: #00e5a8;
}

.bad {
  color: #ff6565;
}

.small {
  color: #b8c4d6;
  font-size: 12px;
}

.signal {
  border-left: 5px solid #00e5a8;
}

#status {
  text-align: center;
  color: #ffd166;
  padding: 10px;
}
</style>
</head>

<body>

<h1>SMART TRADE INDIA V10 PRO</h1>

<div id="status">Connecting...</div>

<button onclick="scan()">SCAN NOW</button>

<button id="soundButton" onclick="enableSound()">
ENABLE SOUND
</button>

<p class="small" id="soundStatus">
Sound is OFF. Tap Enable Sound.
</p>

<h2>LIVE INDEX DATA</h2>

<div id="indexes"></div>

<h2>VERY STRONG SELL ALERTS</h2>

<div id="signals"></div>

<h2>SERVER ERRORS</h2>

<div id="errors"></div>

<script>

let soundEnabled = false;
let audioContext = null;
let lastAlertKeys = new Set();

function enableSound() {

  try {

    const AudioCtx =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioCtx) {
      throw new Error("Audio not supported");
    }

    audioContext = audioContext || new AudioCtx();

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    soundEnabled = true;

    document.getElementById("soundStatus").innerText =
      "Sound alert enabled";

    document.getElementById("soundButton").innerText =
      "SOUND ON";

  } catch (error) {

    document.getElementById("soundStatus").innerText =
      error.message;
  }
}

function playAlert() {

  if (!soundEnabled || !audioContext) return;

  try {

    const oscillator = audioContext.createOscillator();

    const gain = audioContext.createGain();

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.frequency.value = 880;
    gain.gain.value = 0.12;

    oscillator.start();

    oscillator.stop(audioContext.currentTime + 0.35);

  } catch (error) {

    console.log(error);
  }
}

// ======================================================
// SCAN API
// ======================================================

async function scan() {

  document.getElementById("status").innerText =
    "Scanning live market...";

  try {

    const response = await fetch("/api/scan", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const data = await response.json();

    render(data);

  } catch (error) {

    document.getElementById("status").innerText =
      "ERROR: " + error.message;
  }
}

// ======================================================
// RENDER DASHBOARD
// ======================================================

function render(data) {

  document.getElementById("status").innerText =
    (data.status || "UNKNOWN") +
    " | " +
    (data.version || "");

  const indexes = data.indexes || [];
  const signals = data.signals || [];
  const errors = data.errors || [];

  let indexHTML = "";

  indexes.forEach(item => {

    indexHTML +=
      '<div class="card">' +
      '<h3>' + (item.name || item.symbol || "-") + '</h3>' +
      '<p>Spot: ' + (item.spot ?? "-") + '</p>' +
      '<p>Direction: ' + (item.direction || "-") + '</p>' +
      '<p>RSI: ' + (item.rsi ?? "-") + '</p>' +
      '<p>Status: ' + (item.status || "-") + '</p>' +
      '</div>';
  });

  document.getElementById("indexes").innerHTML =
    indexHTML || "No index data";

  // NEW SIGNAL SOUND
  const currentKeys = new Set(
    signals.map(s =>
      [
        s.index,
        s.optionType,
        s.strike,
        s.expiry,
        s.instrumentKey
      ].join("|")
    )
  );

  let newSignal = false;

  currentKeys.forEach(key => {
    if (!lastAlertKeys.has(key)) {
      newSignal = true;
    }
  });

  if (newSignal) playAlert();

  lastAlertKeys = currentKeys;

  let signalHTML = "";

  signals.forEach(s => {

    signalHTML +=
      '<div class="card signal">' +
      '<h3 class="good">VERY STRONG SELL</h3>' +
      '<h2>' + (s.indexName || s.index || "-") + '</h2>' +
      '<h2>' + (s.action || "-") + '</h2>' +
      '<p>Strike: ' + (s.strike ?? "-") + '</p>' +
      '<p>Premium: ' + (s.premium ?? "-") + '</p>' +
      '<p>OI Change: ' + (s.oiChange ?? "-") + '</p>' +
      '<p>RSI: ' + (s.rsi ?? "-") + '</p>' +
      '<p class="good">6/6 ALL CONDITIONS PASSED</p>' +
      '</div>';
  });

  document.getElementById("signals").innerHTML =
    signalHTML || '<div class="card">NO CONFIRMED SIGNAL</div>';

  document.getElementById("errors").innerHTML =
    errors.map(e =>
      '<div class="card bad">' +
      (e.index || "") + " " + (e.error || "") +
      '</div>'
    ).join("") || "No errors";

}

// ======================================================
// AUTOMATIC REFRESH
// ======================================================

scan();

setInterval(scan, 60000);

</script>

</body>
</html>`;

// ======================================================
// HTTP SERVER
// ======================================================

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
    "http://" + (req.headers.host || "localhost")
  );

  const path = url.pathname;

  try {

    if (path === "/" && req.method === "GET") {

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      return res.end(dashboardHTML);
    }

    if (path === "/health") {

      return sendJson(res, 200, {
        status: "OK",
        version: CONFIG.VERSION,
        serverTime: new Date().toISOString(),
        upstoxTokenConfigured: Boolean(TOKEN)
      });
    }

    if (path === "/api/indexes") {

      return sendJson(res, 200, {
        indexes: INDEXES,
        version: CONFIG.VERSION
      });
    }

    if (path === "/api/scan") {

      const data = await runScan();

      return sendJson(res, 200, data);
    }

    if (path === "/api/signals") {

      return sendJson(res, 200, {
        status: latestResults.status,
        signals: latestResults.signals || [],
        count: (latestResults.signals || []).length,
        updatedAt: latestResults.updatedAt
      });
    }

    if (path === "/api/status") {

      return sendJson(res, 200, latestResults);
    }

    return sendJson(res, 404, {
      status: "ERROR",
      message: "Route not found",
      path
    });

  } catch (error) {

    return sendJson(res, 500, {
      status: "ERROR",
      message: error.message
    });
  }
});

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

  console.log("----------------------------------");
  console.log(CONFIG.VERSION);
  console.log("SERVER RUNNING ON PORT " + PORT);
  console.log("NIFTY 50 ENABLED");
  console.log("BANKNIFTY ENABLED");
  console.log("SENSEX ENABLED");
  console.log("VERY STRONG SELL 6/6 ONLY");
  console.log("----------------------------------");

  runScan().catch(error => {
    console.error("Initial scan error:", error.message);
  });

  setInterval(() => {

    runScan().catch(error => {
      console.error("Auto scan error:", error.message);
    });

  }, CONFIG.POLL_MS);

});
