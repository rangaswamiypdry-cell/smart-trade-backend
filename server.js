
"use strict";

// SMART TRADE INDIA V13 PRO
// ALL FUTURES + HEDGED OPTION SELLING
// PART 1 OF 3
// NODE.JS 20+

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const BASE = "https://api.upstox.com";

const CONFIG = {
  VERSION: "SMART_TRADE_INDIA_V13_PRO",
  TIMEFRAME: 5,
  SCAN_INTERVAL: 60000,

  CAPITAL: 120000,
  RISK_PERCENT: 1,
  DAILY_STOP_LOSS: 2400,

  VOLUME_MULTIPLIER: 1.5,
  RSI_BUY: 65,
  RSI_SELL: 35,

  TARGET_PERCENT: 0.50,
  MAX_TARGET_PERCENT: 0.60,
  SL_MULTIPLE: 1.5,

  MAX_FUTURES: 250,
  PAPER_MODE: true
};

let instruments = [];
let futures = [];
let signals = [];
let marketCache = {};
let previousOI = new Map();
let optionSnapshots = new Map();
let scanRunning = false;
let lastScanTime = null;

async function api(path) {
  if (!TOKEN) throw new Error("UPSTOX_ACCESS_TOKEN missing");

  const response = await fetch(BASE + path, {
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + TOKEN
    },
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      "Upstox " + response.status + ": " +
      JSON.stringify(data)
    );
  }

  return data;
}

// LOAD ALL FUTURES

async function loadAllFutures() {
  const url =
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Instrument master download failed");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const parsed = JSON.parse(
    zlib.gunzipSync(buffer).toString("utf8")
  );

  instruments = Array.isArray(parsed) ? parsed : [];

  const today = new Date().toISOString().slice(0, 10);

  const valid = instruments.filter(x =>
    ["NSE_FO", "BSE_FO"].includes(x.segment) &&
    x.instrument_type === "FUT" &&
    x.instrument_key &&
    x.underlying_symbol &&
    x.expiry >= today
  );

  // Nearest expiry for each underlying
  const nearest = new Map();

  for (const item of valid) {
    const old = nearest.get(item.underlying_symbol);

    if (!old || item.expiry < old.expiry) {
      nearest.set(item.underlying_symbol, item);
    }
  }

  futures = [...nearest.values()]
    .sort((a, b) =>
      a.underlying_symbol.localeCompare(b.underlying_symbol)
    )
    .slice(0, CONFIG.MAX_FUTURES);

  console.log("[V13] Futures loaded:", futures.length);

  return futures;
}

// BATCH LIVE QUOTES

async function getQuotes(keys) {
  const output = {};

  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);

    const query = encodeURIComponent(chunk.join(","));

    const result = await api(
      "/v3/market-quote/quotes?instrument_key=" + query
    );

    Object.assign(output, result.data || {});
  }

  return output;
}

// MATCH QUOTE

function findQuote(quotes, key) {
  if (quotes[key]) return quotes[key];

  const normalized = key.replace("|", ":");

  for (const [name, value] of Object.entries(quotes)) {
    if (
      name === normalized ||
      value.instrument_token === key ||
      value.instrument_key === key
    ) return value;
  }

  return null;
}

// LIVE FUTURES CANDLES

async function getFiveMinuteCandles(key) {
  const result = await api(
    "/v3/historical-candle/intraday/" +
    encodeURIComponent(key) +
    "/minutes/5"
  );

  const now = Date.now();

  return (result.data?.candles || [])
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
      c.time + 300000 <= now &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

// EMA

function EMA(values, period) {
  if (values.length < period) return null;

  let value =
    values.slice(0, period).reduce((a,b) => a+b, 0) / period;

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value =
      (values[i] - value) * multiplier + value;
  }

  return value;
}

// RSI

function RSI(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i-1];

    if (change > 0) gain += change;
    else loss += Math.abs(change);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i-1];

    avgGain =
      (avgGain * (period-1) + Math.max(change,0)) / period;

    avgLoss =
      (avgLoss * (period-1) + Math.max(-change,0)) / period;
  }

  if (avgLoss === 0) return 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

// DAILY VWAP

function VWAP(candles) {
  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    const price = (c.high + c.low + c.close) / 3;
    pv += price * c.volume;
    volume += c.volume;
  }

  return volume > 0 ? pv / volume : null;
}

// OI SNAPSHOT

function getOIChange(key, current) {
  const previous = previousOI.get(key);

  previousOI.set(key, current);

  if (!previous || previous <= 0 || current <= 0) {
    return {
      change: null,
      percent: null,
      ready: false
    };
  }

  const change = current - previous;

  return {
    change,
    percent: change / previous * 100,
    ready: true
  };
}


// ============================================================
// PART 2/3 — OPTION CHAIN, OI SNAPSHOTS, SELL SIGNALS & RISK
// Requires PART 1 functions: api, getQuotes, findQuote,
// getFiveMinuteCandles, EMA, RSI, VWAP, CONFIG
// ============================================================

const optionHistory = new Map();
const futureHistory = new Map();

function number(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) ||
      !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function getExpiryDate(future) {
  let value = future.expiry;

  // Upstox instrument expiry may be Unix milliseconds.
  if (typeof value === "number" ||
      (typeof value === "string" && /^\d+$/.test(value))) {
    const n = Number(value);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }

  if (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }

  return null;
}

function getUnderlyingKey(future) {
  return future.underlying_key ||
         future.underlyingKey ||
         future.instrument_key;
}

async function getOptionChain(future) {
  const underlyingKey = getUnderlyingKey(future);
  const expiryDate = getExpiryDate(future);

  if (!underlyingKey || !expiryDate) {
    throw new Error("Missing underlying_key or valid expiry_date");
  }

  const path =
    "/v2/option/chain?instrument_key=" +
    encodeURIComponent(underlyingKey) +
    "&expiry_date=" +
    encodeURIComponent(expiryDate);

  const response = await api(path);
  return response?.data || [];
}

function getOptionMarket(option) {
  const market = option?.market_data || {};
  return {
    ltp: number(market.ltp),
    oi: number(market.oi),
    volume: number(market.volume),
    bid: number(market.bid_price),
    ask: number(market.ask_price)
  };
}

function getOptionKey(option) {
  return option?.instrument_key ||
         option?.instrumentKey ||
         option?.instrument_token ||
         null;
}

function saveOptionSnapshot(option) {
  const key = getOptionKey(option);
  if (!key) return null;

  const market = getOptionMarket(option);
  if (market.ltp === null ||
      market.oi === null ||
      market.volume === null) return null;

  const now = Date.now();
  const old = optionHistory.get(key);

  optionHistory.set(key, {
    ...market,
    time: now
  });

  if (!old) return null;

  const age = now - old.time;
  if (age < 30000 || age > 10 * 60 * 1000) return null;

  return {
    old,
    current: market,
    ageMs: age,
    oiChange: pctChange(market.oi, old.oi),
    volumeChange: pctChange(market.volume, old.volume),
    premiumChangePct: pctChange(market.ltp, old.ltp)
  };
}

function saveFutureSnapshot(future, price, oi) {
  const key = future.instrument_key;
  if (!key || price === null || oi === null) return null;

  const now = Date.now();
  const old = futureHistory.get(key);

  futureHistory.set(key, { price, oi, time: now });

  if (!old) return null;

  const age = now - old.time;
  if (age < 30000 || age > 10 * 60 * 1000) return null;

  return {
    priceChangePct: pctChange(price, old.price),
    oiChangePct: pctChange(oi, old.oi),
    ageMs: age
  };
}

function analyseFutureCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 21) {
    return { valid: false, reason: "NOT_ENOUGH_CLOSED_CANDLES" };
  }

  const closes = candles.map(c => number(c.close)).filter(v => v !== null);
  const highs = candles.map(c => number(c.high)).filter(v => v !== null);
  const lows = candles.map(c => number(c.low)).filter(v => v !== null);
  const volumes = candles.map(c => number(c.volume, 0));

  if (closes.length < 21 || highs.length < 21 ||
      lows.length < 21) {
    return { valid: false, reason: "INVALID_CANDLE_DATA" };
  }

  const lastClose = closes[closes.length - 1];
  const lastVolume = volumes[volumes.length - 1] || 0;
  const avgVolume =
    volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  const rsi = RSI(closes, 14);
  const ema20 = EMA(closes, 20);
  const vwap = VWAP(candles);

  if (![lastClose, rsi, ema20, vwap].every(Number.isFinite)) {
    return { valid: false, reason: "INDICATOR_NOT_READY" };
  }

  return {
    valid: true,
    close: lastClose,
    rsi,
    ema20,
    vwap,
    volume: lastVolume,
    averageVolume: avgVolume,
    volumePass: avgVolume > 0 &&
      lastVolume >= avgVolume * CONFIG.VOLUME_MULTIPLIER,
    bullish: lastClose > ema20 && lastClose > vwap,
    bearish: lastClose < ema20 && lastClose < vwap
  };
}

function getStrike(option) {
  return number(option?.strike_price);
}

function selectOptionPair(chain, side, spotPrice) {
  const rows = [];

  for (const item of chain) {
    const strike = getStrike(item);
    if (strike === null) continue;

    const option = side === "PE"
      ? item.put_options
      : item.call_options;

    if (!option) continue;

    const market = getOptionMarket(option);
    const key = getOptionKey(option);

    if (!key || market.ltp === null ||
        market.oi === null || market.volume === null) continue;

    rows.push({
      strike,
      option,
      key,
      market
    });
  }

  if (rows.length < 2) return null;

  // PE: short near ATM/below ATM; hedge lower strike.
  // CE: short near ATM/above ATM; hedge higher strike.
  rows.sort((a, b) =>
    Math.abs(a.strike - spotPrice) -
    Math.abs(b.strike - spotPrice)
  );

  const shortOption = rows[0];

  const hedgeCandidates = rows
    .filter(x => side === "PE"
      ? x.strike < shortOption.strike
      : x.strike > shortOption.strike)
    .sort((a, b) =>
      Math.abs(a.strike - shortOption.strike) -
      Math.abs(b.strike - shortOption.strike)
    );

  if (!hedgeCandidates.length) return null;

  return {
    short: shortOption,
    hedge: hedgeCandidates[0]
  };
}

function calculateCreditSpread(
  shortPremium,
  hedgePremium,
  strikeWidth,
  lotSize
) {
  const netCredit = shortPremium - hedgePremium;

  if (netCredit <= 0 || strikeWidth <= netCredit ||
      lotSize <= 0) return null;

  const maxProfit = netCredit * lotSize;
  const maxLoss = (strikeWidth - netCredit) * lotSize;

  const riskLimit =
    CONFIG.CAPITAL * CONFIG.RISK_PERCENT / 100;

  const lots = Math.floor(riskLimit / maxLoss);

  if (lots < 1) return null;

  const targetDebit =
    netCredit * (1 - CONFIG.TARGET_PERCENT);

  const stopDebit = Math.min(
    strikeWidth,
    netCredit * CONFIG.SL_MULTIPLE
  );

  return {
    netCredit: Number(netCredit.toFixed(2)),
    maxProfit: Number(maxProfit.toFixed(2)),
    maxLoss: Number(maxLoss.toFixed(2)),
    riskLimit: Number(riskLimit.toFixed(2)),
    lots,
    targetDebit: Number(targetDebit.toFixed(2)),
    stopDebit: Number(stopDebit.toFixed(2)),
    targetCreditPercent: CONFIG.TARGET_PERCENT * 100
  };
}

function checkOptionConditions(option, side) {
  const snapshot = saveOptionSnapshot(option);
  if (!snapshot) {
    return {
      valid: false,
      reason: "WAITING_FOR_SECOND_OI_VOLUME_PREMIUM_SNAPSHOT"
    };
  }

  const oiPass = snapshot.oiChange > 0;
  const volumePass = snapshot.volumeChange > 0;
  const premiumDown = snapshot.premiumChangePct < 0;

  return {
    valid: true,
    oiPass,
    volumePass,
    premiumDown,
    oiChange: snapshot.oiChange,
    volumeChange: snapshot.volumeChange,
    premiumChangePct: snapshot.premiumChangePct,
    allPass: oiPass && volumePass && premiumDown
  };
}

async function scanOneFuture(future) {
  try {
    const candles = await getFiveMinuteCandles(
      future.instrument_key
    );

    const trend = analyseFutureCandles(candles);
    if (!trend.valid || !trend.volumePass) return null;

    const quoteResponse = await getQuotes([
      future.instrument_key
    ]);

    const quote = findQuote(
      quoteResponse,
      future.instrument_key
    );

    const price = number(
      quote?.last_price ?? quote?.ltp
    );

    const oi = number(
      quote?.oi ?? quote?.open_interest
    );

    if (price === null || oi === null) return null;

    const futureChange = saveFutureSnapshot(
      future, price, oi
    );

    if (!futureChange) return null;

    // Both trend and futures OI/price must confirm.
    const bullish =
      trend.bullish &&
      trend.rsi >= CONFIG.RSI_BUY &&
      futureChange.priceChangePct > 0 &&
      futureChange.oiChangePct > 0;

    const bearish =
      trend.bearish &&
      trend.rsi <= CONFIG.RSI_SELL &&
      futureChange.priceChangePct < 0 &&
      futureChange.oiChangePct > 0;

    if (!bullish && !bearish) return null;

    const chain = await getOptionChain(future);
    if (!Array.isArray(chain) || !chain.length) return null;

    const side = bullish ? "PE" : "CE";
    const pair = selectOptionPair(chain, side, price);
    if (!pair) return null;

    const optionConditions = checkOptionConditions(
      pair.short.option,
      side
    );

    if (!optionConditions.valid ||
        !optionConditions.allPass) return null;

    const lotSize = number(
      future.lot_size ?? future.lotSize
    );

    if (!lotSize) return null;

    const width = Math.abs(
      pair.short.strike - pair.hedge.strike
    );

    const risk = calculateCreditSpread(
      pair.short.market.ltp,
      pair.hedge.market.ltp,
      width,
      lotSize
    );

    if (!risk) return null;

    const now = new Date().toISOString();

    return {
      id: `${future.instrument_key}-${side}-${Date.now()}`,
      timestamp: now,
      status: "PAPER_SIGNAL",
      signal: side === "PE" ? "PE_SELL" : "CE_SELL",
      underlying: future.underlying_symbol ||
                  future.trading_symbol,
      futureInstrumentKey: future.instrument_key,
      expiry: getExpiryDate(future),

      underlyingPrice: price,
      rsi: Number(trend.rsi.toFixed(2)),
      vwap: Number(trend.vwap.toFixed(2)),
      ema20: Number(trend.ema20.toFixed(2)),

      futurePriceChangePct:
        Number(futureChange.priceChangePct.toFixed(2)),
      futureOIChangePct:
        Number(futureChange.oiChangePct.toFixed(2)),

      optionSide: side,
      shortStrike: pair.short.strike,
      shortInstrumentKey: pair.short.key,
      shortPremium: pair.short.market.ltp,
      hedgeStrike: pair.hedge.strike,
      hedgeInstrumentKey: pair.hedge.key,
      hedgePremium: pair.hedge.market.ltp,

      optionOIChangePct:
        Number(optionConditions.oiChange.toFixed(2)),
      optionVolumeChangePct:
        Number(optionConditions.volumeChange.toFixed(2)),
      premiumChangePct:
        Number(optionConditions.premiumChangePct.toFixed(2)),

      lotSize,
      risk,
      entryRule: "SELL SHORT OPTION + BUY HEDGE",
      exitRule: "BUY BACK WHEN TARGET OR STOP IS HIT",
      paperMode: CONFIG.PAPER_MODE
    };

  } catch (error) {
    return {
      error: true,
      underlying: future.underlying_symbol ||
                  future.trading_symbol,
      message: error.message
    };
  }
}

async function scanFuturesForSignals() {
  if (scanRunning) {
    return { status: "SCAN_ALREADY_RUNNING" };
  }

  scanRunning = true;

  try {
    const batch = futures.slice(0, CONFIG.MAX_FUTURES);
    const found = [];

    // Sequential scanning helps reduce API bursts.
    for (const future of batch) {
      const result = await scanOneFuture(future);

      if (result && !result.error) {
        found.push(result);
      }
    }

    signals = found;
    lastScanTime = new Date().toISOString();

    return {
      status: "SCAN_COMPLETE",
      scanned: batch.length,
      signalCount: found.length,
      signals: found,
      lastScanTime
    };

  } finally {
    scanRunning = false;
  }
      }
    
// ============================================================
// PART 3/3 — DASHBOARD ROUTES, DAILY RISK LOCK & SERVER START
// Add this after PART 2.
// ============================================================

let dailyRealizedPnl = 0;
let dailyTradeCount = 0;
let tradingDay = "";
let lastError = null;

function indiaTradingDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function refreshDailyRisk() {
  const today = indiaTradingDate();

  if (tradingDay !== today) {
    tradingDay = today;
    dailyRealizedPnl = 0;
    dailyTradeCount = 0;
    lastError = null;
  }

  return {
    date: tradingDay,
    realizedPnl: Number(dailyRealizedPnl.toFixed(2)),
    dailyStopLoss: CONFIG.DAILY_STOP_LOSS,
    locked: dailyRealizedPnl <= -CONFIG.DAILY_STOP_LOSS,
    remainingLossLimit: Math.max(
      0,
      CONFIG.DAILY_STOP_LOSS + dailyRealizedPnl
    )
  };
}

function sendJsonV13(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > 100000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }

      body += chunk.toString();
    });

    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function getDashboardStatus() {
  const risk = refreshDailyRisk();

  return {
    version: CONFIG.VERSION,
    serverTime: new Date().toISOString(),
    indiaDate: risk.date,
    connected: Boolean(TOKEN),
    paperMode: CONFIG.PAPER_MODE,
    scanRunning,
    lastScanTime,
    lastError,
    futuresLoaded: futures.length,
    signalsCount: signals.length,
    risk,
    config: {
      capital: CONFIG.CAPITAL,
      riskPercent: CONFIG.RISK_PERCENT,
      dailyStopLoss: CONFIG.DAILY_STOP_LOSS,
      timeframeMinutes: CONFIG.TIMEFRAME,
      volumeMultiplier: CONFIG.VOLUME_MULTIPLIER,
      rsiBuy: CONFIG.RSI_BUY,
      rsiSell: CONFIG.RSI_SELL
    }
  };
}

async function recordClosedTrade(pnl) {
  refreshDailyRisk();

  if (!Number.isFinite(pnl)) {
    throw new Error("P&L must be a valid number");
  }

  dailyRealizedPnl += pnl;
  dailyTradeCount += 1;

  return {
    recorded: true,
    tradePnl: pnl,
    tradeCount: dailyTradeCount,
    risk: refreshDailyRisk()
  };
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {
    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJsonV13(res, 200, {
        ok: true,
        ...getDashboardStatus()
      });
    }

    // Dashboard status
    if (req.method === "GET" &&
        url.pathname === "/api/status") {
      return sendJsonV13(res, 200, getDashboardStatus());
    }

    // Loaded futures list
    if (req.method === "GET" &&
        url.pathname === "/api/futures") {
      return sendJsonV13(res, 200, {
        count: futures.length,
        futures: futures.map(f => ({
          symbol: f.underlying_symbol || f.trading_symbol,
          instrumentKey: f.instrument_key,
          expiry: getExpiryDate(f),
          lotSize: f.lot_size
        }))
      });
    }

    // Dashboard signals
    if (req.method === "GET" &&
        url.pathname === "/api/signals") {
      return sendJsonV13(res, 200, {
        count: signals.length,
        signals,
        lastScanTime,
        risk: refreshDailyRisk()
      });
    }

    // Manually start a scan
    if (req.method === "GET" &&
        url.pathname === "/api/scan") {
      const risk = refreshDailyRisk();

      if (!TOKEN) {
        return sendJsonV13(res, 503, {
          error: "UPSTOX_ACCESS_TOKEN_MISSING"
        });
      }

      if (risk.locked) {
        return sendJsonV13(res, 423, {
          status: "DAILY_LOSS_LIMIT_REACHED",
          risk
        });
      }

      if (scanRunning) {
        return sendJsonV13(res, 202, {
          status: "SCAN_ALREADY_RUNNING",
          lastScanTime
        });
      }

      const result = await scanFuturesForSignals();
      return sendJsonV13(res, 200, {
        ...result,
        risk: refreshDailyRisk()
      });
    }

    // Record a closed paper trade's P&L.
    // Example body: {"pnl":-500}
    if (req.method === "POST" &&
        url.pathname === "/api/risk/close-trade") {
      const body = await readRequestBody(req);
      const pnl = number(body.pnl);

      if (pnl === null) {
        return sendJsonV13(res, 400, {
          error: "VALID_PNL_REQUIRED"
        });
      }

      const result = await recordClosedTrade(pnl);
      return sendJsonV13(res, 200, result);
    }

    // Unknown endpoint
    return sendJsonV13(res, 404, {
      error: "ENDPOINT_NOT_FOUND",
      path: url.pathname
    });

  } catch (error) {
    lastError = error.message;

    return sendJsonV13(res, 500, {
      error: "SERVER_ERROR",
      message: error.message
    });
  }
}

const server = http.createServer(handleRequest);

async function startV13Server() {
  if (!TOKEN) {
    console.error(
      "[V13] UPSTOX_ACCESS_TOKEN is missing in Render Environment"
    );
  }

  try {
    console.log("[V13] Loading futures instrument master...");
    await loadAllFutures();
    console.log("[V13] Futures loaded:", futures.length);
  } catch (error) {
    lastError = error.message;
    console.error("[V13] Futures load failed:", error.message);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[V13] Server running on port ${PORT}`);
    console.log(`[V13] Paper mode: ${CONFIG.PAPER_MODE}`);
  });

  // Periodically refresh the instrument master.
  setInterval(async () => {
    try {
      await loadAllFutures();
      console.log("[V13] Futures master refreshed:", futures.length);
    } catch (error) {
      lastError = error.message;
      console.error("[V13] Master refresh error:", error.message);
    }
  }, 6 * 60 * 60 * 1000);

  // Automatic scan. The API route also checks the daily risk lock.
  setInterval(async () => {
    const risk = refreshDailyRisk();

    if (!TOKEN || risk.locked || scanRunning || !futures.length) {
      return;
    }

    try {
      await scanFuturesForSignals();
    } catch (error) {
      lastError = error.message;
      console.error("[V13] Scheduled scan error:", error.message);
    }
  }, CONFIG.SCAN_INTERVAL);
}

startV13Server().catch(error => {
  console.error("[V13] Startup error:", error);
  process.exitCode = 1;
});
    
