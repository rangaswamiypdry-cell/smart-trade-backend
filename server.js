
"use strict";

// ======================================================
// SMART TRADE INDIA V9
// THREE INDEX VERY STRONG OPTION SELLING SCANNER
// UPSTOX LIVE API | NODE JS 20+
// PART 1 OF 2
// ======================================================

const http = require("http");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const BASE = "https://api.upstox.com";

const CONFIG = {
  VERSION: "SMART_TRADE_INDIA_V9",
  TIMEFRAME: "5 MINUTE",
  POLL_MS: 60000,

  VOLUME_MULTIPLIER: 1.5,
  MIN_OI_INCREASE: 1,
  MIN_VOLUME_INCREASE: 1,

  MAX_CANDIDATES: 3,
  MIN_OPTION_PREMIUM: 5,
  MAX_OPTION_PREMIUM: 1000,

  REQUIRE_ALL_CONDITIONS: true
};

// Only three indexes
const INDEXES = {
  NIFTY: {
    name: "NIFTY 50",
    key: "NSE_INDEX|Nifty 50",
    exchange: "NSE"
  },

  BANKNIFTY: {
    name: "BANK NIFTY",
    key: "NSE_INDEX|Nifty Bank",
    exchange: "NSE"
  },

  SENSEX: {
    name: "SENSEX",
    key: "BSE_INDEX|SENSEX",
    exchange: "BSE"
  }
};

// Previous polling snapshots
const previousIndex = new Map();
const previousOptions = new Map();

// Latest scanner results
let latestResults = {
  status: "WAITING",
  version: CONFIG.VERSION,
  updatedAt: null,
  indexes: [],
  signals: [],
  errors: []
};

// API helper
async function upstoxRequest(path) {

  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN missing");
  }

  const response = await fetch(BASE + path, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": "Bearer " + TOKEN
    },
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json();

  if (!response.ok || data.status === "error") {
    throw new Error(
      "UPSTOX API ERROR " +
      response.status + ": " +
      JSON.stringify(data)
    );
  }

  return data;
}

// Full market quote
async function getLiveQuote(instrumentKey) {

  const path =
    "/v2/market-quote/quotes?instrument_key=" +
    encodeURIComponent(instrumentKey);

  const data = await upstoxRequest(path);

  const values = Object.values(data.data || {});

  if (!values.length) {
    throw new Error("Live quote unavailable: " + instrumentKey);
  }

  return values[0];
}

// Extract index price
function getPrice(quote) {

  return Number(
    quote.last_price ??
    quote.ltp ??
    0
  );
}

// Detect index direction
function analyseIndexDirection(name, price) {

  const old = previousIndex.get(name);

  previousIndex.set(name, price);

  if (!old || old.price <= 0) {
    return {
      direction: "WAIT",
      change: 0,
      confirmed: false
    };
  }

  const change = price - old.price;

  return {
    direction:
      change > 0 ? "UP" :
      change < 0 ? "DOWN" : "SIDEWAYS",

    change: Number(change.toFixed(2)),
    confirmed: change !== 0
  };
}


const contractData = await getOptionContracts(index);

const expiry = contractData.expiry;

const chain = await getOptionChain(index, expiry);


// Get live option chain
async function getOptionChain(index, expiry) {

  const path =
    "/v2/option/chain?instrument_key=" +
    encodeURIComponent(index.key) +
    "&expiry_date=" +
    encodeURIComponent(expiry);

  const result = await upstoxRequest(path);

  return Array.isArray(result.data) ?
    result.data : [];
}

// Save previous option snapshot
function getOptionChanges(optionKey, market) {

  const current = {
    price: Number(market.ltp || 0),
    oi: Number(market.oi || 0),
    volume: Number(market.volume || 0)
  };

  const old = previousOptions.get(optionKey);

  previousOptions.set(optionKey, current);

  if (!old) {
    return {
      ready: false,
      priceDown: false,
      oiIncrease: false,
      volumeIncrease: false
    };
  }

  return {
    ready: true,

    priceDown:
      current.price < old.price,

    oiIncrease:
      current.oi > old.oi,

    volumeIncrease:
      current.volume > old.volume,

    priceChange:
      Number((current.price - old.price).toFixed(2)),

    oiChange:
      current.oi - old.oi,

    volumeChange:
      current.volume - old.volume
  };
}


// ======================================================
// PART 2 OF 2
// VERY STRONG OPTION SELL SIGNAL ENGINE
// ======================================================

// Fetch completed 5-minute candles
async function getFiveMinuteCandles(index) {

  const path =
    "/v3/historical-candle/intraday/" +
    encodeURIComponent(index.key) +
    "/minutes/5";

  const result = await upstoxRequest(path);

  const candles = result.data?.candles || [];

  const now = Date.now();

  // Remove running candle
  return candles
    .filter(c => {
      const start = new Date(c[0]).getTime();
      return Number.isFinite(start) &&
        now >= start + 5 * 60 * 1000;
    })
    .sort((a, b) =>
      new Date(b[0]).getTime() -
      new Date(a[0]).getTime()
    );
}

// Confirm index direction
function confirmFiveMinuteDirection(candles) {

  if (!candles || candles.length < 2) {
    return "WAIT";
  }

  const latest = candles[0];
  const previous = candles[1];

  const open = Number(latest[1]);
  const close = Number(latest[4]);
  const previousClose = Number(previous[4]);

  if (
    close > open &&
    close > previousClose
  ) {
    return "UP";
  }

  if (
    close < open &&
    close < previousClose
  ) {
    return "DOWN";
  }

  return "SIDEWAYS";
}

// Find nearest OTM option
function selectOTM(chain, direction, spot) {

  const candidates = [];

  for (const row of chain) {

    const strike = Number(row.strike_price);

    if (!Number.isFinite(strike)) continue;

    if (
      direction === "UP" &&
      strike < spot &&
      row.put_options
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
      row.call_options
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

// Analyse option selling conditions
function analyseSellingOption(selected, direction) {

  if (!selected?.option?.instrument_key) {
    return null;
  }

  const market =
    selected.option.market_data || {};

  const premium = Number(market.ltp || 0);
  const oi = Number(market.oi || 0);
  const volume = Number(market.volume || 0);

  if (
    premium < CONFIG.MIN_OPTION_PREMIUM ||
    premium > CONFIG.MAX_OPTION_PREMIUM ||
    oi <= 0 ||
    volume <= 0
  ) {
    return null;
  }

  const changes = getOptionChanges(
    selected.option.instrument_key,
    market
  );

  // First snapshot is only a baseline
  if (!changes.ready) return null;

  const allConditions = {

    correctDirection:
      direction === "UP" ?
        selected.type === "PE" :
        direction === "DOWN" &&
        selected.type === "CE",

    premiumDecrease:
      changes.priceDown,

    oiIncrease:
      changes.oiIncrease,

    volumeIncrease:
      changes.volumeIncrease
  };

  const passed = Object.values(allConditions)
    .every(Boolean);

  if (!passed) return null;

  return {
    signal: "VERY_STRONG_SELL",

    action: selected.type + " SELL",

    optionType: selected.type,

    instrumentKey:
      selected.option.instrument_key,

    strike: selected.strike,

    premium,

    oi,

    volume,

    oiChange: changes.oiChange,

    volumeChange: changes.volumeChange,

    premiumChange: changes.priceChange,

    conditions: allConditions,

    strength: "ALL CONDITIONS PASSED",

    timestamp: new Date().toISOString()
  };
}

// Scan one index
async function scanOneIndex(symbol, index) {

  const errors = [];

  try {

    const [quote, candles, contracts] =
      await Promise.all([
        getLiveQuote(index.key),
        getFiveMinuteCandles(index),
        getOptionContracts(index)
      ]);

    const spot = getPrice(quote);

    if (!spot) {
      throw new Error("Index live price missing");
    }

    const direction =
      confirmFiveMinuteDirection(candles);

    const oldIndex =
      previousIndex.get(symbol);

    const indexChange =
      oldIndex ?
      Number((spot - oldIndex.price).toFixed(2)) :
      0;

    previousIndex.set(symbol, {
      price: spot,
      time: Date.now()
    });

    const indexResult = {
      symbol,
      name: index.name,
      instrumentKey: index.key,
      spot,
      indexChange,
      direction,
      candleTime: candles[0]?.[0] || null,
      status: "WAITING",
      signal: null
    };

    if (direction === "WAIT" ||
        direction === "SIDEWAYS") {
      return indexResult;
    }

    // Only current week contracts
    const expiries = [...new Set(
      contracts
        .map(c => c.expiry)
        .filter(Boolean)
    )].sort();

    if (!expiries.length) {
      throw new Error("No current expiry contracts");
    }

    const expiry = expiries[0];

    const chain =
      await getOptionChain(index, expiry);

    const selected =
      selectOTM(chain, direction, spot);

    if (!selected) {
      indexResult.status = "NO OTM CONTRACT";
      return indexResult;
    }

    const sellingSignal =
      analyseSellingOption(selected, direction);

    if (sellingSignal) {

      indexResult.status = "VERY_STRONG_SELL";

      indexResult.signal = {
        index: symbol,
        indexName: index.name,
        expiry,
        spot,
        direction,
        ...sellingSignal
      };
    }

    return indexResult;

  } catch (error) {

    return {
      symbol,
      name: index.name,
      status: "ERROR",
      error: error.message
    };
  }
}

// Scan all three indexes
let scanRunning = false;

async function runScan() {

  if (scanRunning) return latestResults;

  scanRunning = true;

  try {

    const results = await Promise.all(
      Object.entries(INDEXES).map(
        ([symbol, index]) =>
          scanOneIndex(symbol, index)
      )
    );

    const signals = results
      .filter(r => r.signal)
      .map(r => r.signal);

    latestResults = {
      status: "SUCCESS",
      version: CONFIG.VERSION,
      updatedAt: new Date().toISOString(),
      indexes: results,
      signals,
      errors: results
        .filter(r => r.error)
        .map(r => ({
          index: r.symbol,
          error: r.error
        }))
    };

    return latestResults;

  } finally {

    scanRunning = false;
  }
}

// HTTP response helper
function sendJson(res, status, data) {

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

// Dashboard API server
const server = http.createServer(
  async (req, res) => {

    const path = new URL(
      req.url,
      "http://localhost"
    ).pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      return res.end();
    }

    if (path === "/health") {

      return sendJson(res, 200, {
        status: "OK",
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        indexes: Object.keys(INDEXES),
        time: new Date().toISOString()
      });
    }

    if (path === "/api/indexes") {

      return sendJson(res, 200, {
        indexes: INDEXES,
        timeframe: CONFIG.TIMEFRAME
      });
    }

    if (path === "/api/scan") {

      const data = await runScan();

      return sendJson(res, 200, data);
    }

    if (path === "/api/signals") {

      return sendJson(res, 200, {
        count: latestResults.signals.length,
        signals: latestResults.signals,
        updatedAt: latestResults.updatedAt
      });
    }

    if (path === "/api/status") {

      return sendJson(res, 200, {
        status: latestResults.status,
        version: CONFIG.VERSION,
        lastUpdate: latestResults.updatedAt,
        indexes: latestResults.indexes
      });
    }

    return sendJson(res, 404, {
      status: "ERROR",
      message: "Route not found"
    });
  }
);

// Start server
server.listen(PORT, () => {

  console.log(
    "SMART TRADE INDIA V9 RUNNING ON " + PORT
  );

  console.log(
    "SCANNING: NIFTY + BANKNIFTY + SENSEX"
  );

  console.log(
    "OPTION SELLING: PE SELL / CE SELL"
  );

  if (!TOKEN) {
    console.log("WARNING: UPSTOX TOKEN MISSING");
  }
});

// Poll live data every 60 seconds
setInterval(() => {

  runScan().catch(error => {
    console.error("SCAN ERROR:", error.message);
  });

}, CONFIG.POLL_MS);

// Initial scan
runScan().catch(error => {
  console.error("INITIAL SCAN ERROR:", error.message);
});

