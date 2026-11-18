// ============================================================
// SMART TRADE INDIA PRO - OPTION SELLING ALERT SCANNER
// Node.js 20+ | Upstox API | 5-minute CLOSED candles
// Alerts only. Does NOT place live orders.
// PART 1 OF 2
// ============================================================
"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const API = "https://api.upstox.com";
const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const CFG = {
  VERSION: "SMART_TRADE_INDIA_OPTION_SELL_PRO_V1",
  TF: 5,
  MIN_CANDLES: 30,
  VOLUME_MULTIPLIER: 1.5,
  RSI_PERIOD: 14,
  BEAR_RSI_MAX: 40,
  BULL_RSI_MIN: 60,
  ADX_MIN: 20,
  DELTA_MIN: 0.15,
  DELTA_MAX: 0.30,
  MAX_SPREAD_PCT: 2.0,
  MAX_OPTION_ALERTS: 12,
  WORKERS: 3,
  CACHE_MS: 60000,
  CANDLE_CACHE_MS: 60000,
  DAILY_CACHE_MS: 21600000,
  SELL_SL_MULTIPLE: 1.5,
  SELL_TARGET_DECAY: 0.50,
  INDEXES: [
    "NIFTY",
    "BANKNIFTY",
    "SENSEX",
    "FINNIFTY",
    "MIDCPNIFTY"
  ]
};

let master = [];
let universe = [];
let masterReady = false;
let masterBusy = false;
let scanBusy = false;
let scanCache = null;

const optionCache = new Map();
const candleCache = new Map();
const dailyCache = new Map();

const round = n =>
  Number.isFinite(Number(n))
    ? Number(Number(n).toFixed(2))
    : null;

const enc = s => encodeURIComponent(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function istDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function istTime(d = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(d);
}

function marketOpen() {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short"
  }).format(new Date());

  const t = istTime();

  return day !== "Sat" &&
    day !== "Sun" &&
    t >= "09:15" &&
    t <= "15:30";
}

async function upstox(path) {
  if (!TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing in Render environment"
    );
  }

  const r = await fetch(API + path, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`
    },
    signal: AbortSignal.timeout(25000)
  });

  const j = await r.json();

  if (!r.ok) {
    throw new Error(
      j?.errors?.[0]?.message ||
      j?.message ||
      `Upstox HTTP ${r.status}`
    );
  }

  return j;
}

async function downloadMaster() {
  const r = await fetch(MASTER_URL, {
    signal: AbortSignal.timeout(60000)
  });

  if (!r.ok) {
    throw new Error(
      `Instrument master download failed: ${r.status}`
    );
  }

  const b = Buffer.from(await r.arrayBuffer());

  let rows;

  try {
    rows = JSON.parse(
      zlib.gunzipSync(b).toString("utf8")
    );
  } catch {
    rows = JSON.parse(b.toString("utf8"));
  }

  if (!Array.isArray(rows)) {
    throw new Error(
      "Invalid Upstox instrument master format"
    );
  }

  return rows;
}

function expiryDate(v) {
  if (!v) return null;

  const d = new Date(v);

  return Number.isNaN(d.getTime())
    ? null
    : istDate(d);
}

function norm(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function buildUniverse(rows) {
  const today = istDate();

  const futures = rows.filter(x =>
    ["NSE_FO", "BSE_FO"].includes(x.segment) &&
    x.instrument_type === "FUT" &&
    x.instrument_key &&
    x.underlying_key &&
    ["EQUITY", "INDEX"].includes(
      String(x.underlying_type || "").toUpperCase()
    ) &&
    expiryDate(x.expiry) >= today
  );

  const selected = new Map();

  for (const f of futures) {
    const underlying = norm(
      f.underlying_symbol ||
      f.name ||
      f.trading_symbol
    );

    const isIndex = CFG.INDEXES.some(
      i => underlying.includes(norm(i))
    );

    const isEquity =
      String(f.underlying_type).toUpperCase() === "EQUITY";

    if (!isIndex && !isEquity) continue;

    const key = isIndex
      ? `INDEX:${CFG.INDEXES.find(
          i => underlying.includes(norm(i))
        )}`
      : `STOCK:${underlying}`;

    const item = {
      symbol: isIndex
        ? CFG.INDEXES.find(
            i => underlying.includes(norm(i))
          )
        : (f.underlying_symbol || f.name),

      kind: isIndex ? "INDEX" : "STOCK",
      futuresKey: f.instrument_key,
      underlyingKey: f.underlying_key,
      futuresSymbol: f.trading_symbol,
      expiry: expiryDate(f.expiry),
      lotSize: Number(f.lot_size || 0)
    };

    const old = selected.get(key);

    if (!old || item.expiry < old.expiry) {
      selected.set(key, item);
    }
  }

  return [...selected.values()].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.symbol.localeCompare(b.symbol)
  );
}

async function loadMaster(force = false) {
  if (masterBusy) {
    while (masterBusy) await sleep(150);
    return;
  }

  if (masterReady && !force) return;

  masterBusy = true;

  try {
    master = await downloadMaster();
    universe = buildUniverse(master);
    masterReady = true;

    console.log(
      `[MASTER] Loaded ${master.length} instruments; scanner universe ${universe.length}`
    );
  } finally {
    masterBusy = false;
  }
}

async function getCandles(key) {
  const cached = candleCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < CFG.CANDLE_CACHE_MS
  ) {
    return cached.data;
  }

  const j = await upstox(
    `/v3/historical-candle/intraday/${enc(key)}/minutes/5`
  );

  const now = Date.now();

  const data = (j?.data?.candles || [])
    .map(c => ({
      time: new Date(c[0]).getTime(),
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +(c[5] || 0),
      oi: +(c[6] || 0)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      c.time + 300000 <= now
    )
    .sort((a, b) => a.time - b.time);

  candleCache.set(key, {
    time: Date.now(),
    data
  });

  return data;
}

async function getDailyCandles(key) {
  const cached = dailyCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < CFG.DAILY_CACHE_MS
  ) {
    return cached.data;
  }

  const j = await upstox(
    `/v3/historical-candle/${enc(key)}/days/1/${istDate()}`
  );

  const data = (j?.data?.candles || [])
    .map(c => ({
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +(c[5] || 0)
    }))
    .filter(c => c.close > 0)
    .reverse();

  dailyCache.set(key, {
    time: Date.now(),
    data
  });

  return data;
}

async function getQuotes(items) {
  const out = {};

  const keys = items
    .map(x => x.futuresKey)
    .filter(Boolean);

  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);

    const j = await upstox(
      `/v3/market-quote/quotes?instrument_key=${enc(batch.join(","))}`
    );

    Object.assign(out, j?.data || {});
  }

  return out;
}

function findQuote(item, quotes) {
  return quotes[item.futuresKey] ||
    Object.values(quotes).find(
      q => q.instrument_token === item.futuresKey
    ) ||
    null;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let v = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    v = values[i] * k + v * (1 - k);
  }

  return v;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];

    if (d > 0) gain += d;
    else loss -= d;
  }

  let ag = gain / period;
  let al = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (al === 0) return 100;

  return 100 - 100 / (1 + ag / al);
}

function macd(values) {
  if (values.length < 35) return null;

  const fast = ema(values.slice(-60), 12);
  const slow = ema(values.slice(-60), 26);

  if (fast === null || slow === null) return null;

  const series = [];

  for (let i = 26; i <= values.length; i++) {
    const f = ema(values.slice(0, i), 12);
    const s = ema(values.slice(0, i), 26);

    if (f !== null && s !== null) {
      series.push(f - s);
    }
  }

  const line = fast - slow;
  const signal = ema(series, 9);

  return signal === null
    ? null
    : {
        line,
        signal,
        hist: line - signal
      };
}

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) {
    return null;
  }

  const tr = [];
  const pdm = [];
  const mdm = [];

  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1];
    const b = candles[i];

    tr.push(
      Math.max(
        b.high - b.low,
        Math.abs(b.high - a.close),
        Math.abs(b.low - a.close)
      )
    );

    const up = b.high - a.high;
    const down = a.low - b.low;

    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
  }

  // ============================================================
// SMART TRADE INDIA PRO - OPTION SELLING ALERT SCANNER
// PART 2 OF 2
// ============================================================

// Continue ADX function from PART 1

  let trSum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let pSum = pdm.slice(0, period).reduce((a, b) => a + b, 0);
  let mSum = mdm.slice(0, period).reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = period; i < tr.length; i++) {
    if (i > period) {
      trSum = trSum - trSum / period + tr[i];
      pSum = pSum - pSum / period + pdm[i];
      mSum = mSum - mSum / period + mdm[i];
    }

    if (trSum <= 0) continue;

    const pdi = 100 * pSum / trSum;
    const mdi = 100 * mSum / trSum;
    const total = pdi + mdi;

    dx.push(
      total === 0
        ? 0
        : 100 * Math.abs(pdi - mdi) / total
    );
  }

  if (dx.length < period) return null;

  let result =
    dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dx.length; i++) {
    result = (result * (period - 1) + dx[i]) / period;
  }

  return result;
}

function calculateVWAP(candles) {
  let pv = 0;
  let vol = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }

  return vol > 0 ? pv / vol : null;
}

function calculateADR(daily) {
  if (!daily || daily.length < 14) return null;

  const last = daily.slice(-14);

  const total = last.reduce(
    (sum, c) => sum + (c.high - c.low),
    0
  );

  const avg = total / last.length;
  const price = last[last.length - 1].close;

  return {
    points: round(avg),
    percent: round(price > 0 ? avg / price * 100 : 0)
  };
}

function analyseCandles(candles, quote, daily) {
  if (candles.length < CFG.MIN_CANDLES) {
    return {
      ready: false,
      reason: "Not enough completed 5-minute candles"
    };
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const rsiValue = rsi(closes, CFG.RSI_PERIOD);
  const ema20 = ema(closes, 20);
  const macdValue = macd(closes);
  const adxValue = adx(candles, 14);
  const vwap = calculateVWAP(candles);

  const avgVolume =
    candles.slice(-21, -1).reduce(
      (s, c) => s + c.volume, 0
    ) / 20;

  const volumeRatio =
    avgVolume > 0 ? last.volume / avgVolume : 0;

  const oiIncreasing =
    last.oi > 0 &&
    prev.oi > 0 &&
    last.oi > prev.oi;

  const priceUp =
    last.close > prev.close;

  const priceDown =
    last.close < prev.close;

  const quotePrice =
    Number(
      quote?.last_price ||
      quote?.ltp ||
      quote?.last_traded_price ||
      0
    );

  const quoteChange =
    Number(
      quote?.net_change ||
      quote?.change ||
      0
    );

  const quoteUp =
    quotePrice > 0
      ? quoteChange > 0
      : priceUp;

  const quoteDown =
    quotePrice > 0
      ? quoteChange < 0
      : priceDown;

  const volumePass =
    volumeRatio >= CFG.VOLUME_MULTIPLIER;

  const trendPass =
    adxValue !== null &&
    adxValue >= CFG.ADX_MIN;

  const macdBull =
    macdValue !== null &&
    macdValue.line > macdValue.signal &&
    macdValue.hist > 0;

  const macdBear =
    macdValue !== null &&
    macdValue.line < macdValue.signal &&
    macdValue.hist < 0;

  const bullishConditions = {
    OI_INCREASE: oiIncreasing,
    PRICE_INCREASE: priceUp && quoteUp,
    VOLUME_INCREASE: volumePass,
    RSI_STRONG: rsiValue !== null &&
      rsiValue >= CFG.BULL_RSI_MIN,
    ADX_STRONG: trendPass,
    ABOVE_EMA20: ema20 !== null &&
      last.close > ema20,
    ABOVE_VWAP: vwap !== null &&
      last.close > vwap,
    MACD_BULLISH: macdBull
  };

  const bearishConditions = {
    OI_INCREASE: oiIncreasing,
    PRICE_DECREASE: priceDown && quoteDown,
    VOLUME_INCREASE: volumePass,
    RSI_STRONG: rsiValue !== null &&
      rsiValue <= CFG.BEAR_RSI_MAX,
    ADX_STRONG: trendPass,
    BELOW_EMA20: ema20 !== null &&
      last.close < ema20,
    BELOW_VWAP: vwap !== null &&
      last.close < vwap,
    MACD_BEARISH: macdBear
  };

  const bullCount = Object.values(
    bullishConditions
  ).filter(Boolean).length;

  const bearCount = Object.values(
    bearishConditions
  ).filter(Boolean).length;

  // ALL 8 CONDITIONS ARE MANDATORY
  const bullish = bullCount === 8;
  const bearish = bearCount === 8;

  const adr = calculateADR(daily);

  return {
    ready: true,
    signal: bullish
      ? "SELL_PE"
      : bearish
        ? "SELL_CE"
        : "WAIT",

    direction: bullish
      ? "BULLISH"
      : bearish
        ? "BEARISH"
        : "SIDEWAYS",

    bullish,
    bearish,

    conditions: {
      bullish: bullishConditions,
      bearish: bearishConditions
    },

    bullishCount: bullCount,
    bearishCount: bearCount,

    price: round(quotePrice || last.close),
    candleClose: round(last.close),
    rsi: round(rsiValue),
    ema20: round(ema20),
    vwap: round(vwap),
    adx: round(adxValue),
    macd: macdValue
      ? {
          line: round(macdValue.line),
          signal: round(macdValue.signal),
          histogram: round(macdValue.hist)
        }
      : null,

    volume: last.volume,
    averageVolume: round(avgVolume),
    volumeRatio: round(volumeRatio),
    oi: last.oi,
    previousOI: prev.oi,
    oiChange: last.oi - prev.oi,
    adr14: adr,

    candleTime: new Date(last.time).toISOString()
  };
}

async function getOptionChain(underlyingKey, expiry) {
  const cacheKey = `${underlyingKey}:${expiry}`;
  const cached = optionCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < CFG.CACHE_MS
  ) {
    return cached.data;
  }

  const j = await upstox(
    `/v2/option/chain?instrument_key=${enc(underlyingKey)}&expiry_date=${enc(expiry)}`
  );

  const data = j?.data || [];

  optionCache.set(cacheKey, {
    time: Date.now(),
    data
  });

  return data;
}

function getOptionLegs(chain, type) {
  const result = [];

  for (const row of chain) {
    const strike = Number(row.strike_price);

    const leg = type === "CE"
      ? row.call_options
      : row.put_options;

    if (!leg || !leg.instrument_key) continue;

    const greeks = leg.option_greeks || {};
    const market = leg.market_data || {};

    const delta = Number(greeks.delta);
    const gamma = Number(greeks.gamma);
    const theta = Number(greeks.theta);
    const vega = Number(greeks.vega);
    const iv = Number(greeks.iv);

    const bid = Number(market.bid_price || 0);
    const ask = Number(market.ask_price || 0);
    const ltp = Number(market.ltp || 0);

    const bidQty = Number(market.bid_qty || 0);
    const askQty = Number(market.ask_qty || 0);
    const volume = Number(market.volume || 0);
    const oi = Number(market.oi || 0);

    if (
      !Number.isFinite(delta) ||
      !Number.isFinite(gamma) ||
      !Number.isFinite(theta) ||
      !Number.isFinite(vega)
    ) continue;

    if (
      Math.abs(delta) < CFG.DELTA_MIN ||
      Math.abs(delta) > CFG.DELTA_MAX
    ) continue;

    if (bid <= 0 || ask <= 0 || ask < bid) continue;

    const mid = (bid + ask) / 2;
    const spreadPct =
      mid > 0 ? ((ask - bid) / mid) * 100 : 100;

    if (spreadPct > CFG.MAX_SPREAD_PCT) continue;

    if (bidQty <= 0 || volume <= 0 || oi <= 0) continue;

    result.push({
      type,
      strike,
      expiry: null,
      instrumentKey: leg.instrument_key,
      tradingSymbol: leg.trading_symbol || null,

      bid: round(bid),
      ask: round(ask),
      ltp: round(ltp),

      bidQty,
      askQty,
      volume,
      oi,

      delta: round(delta),
      gamma: round(gamma),
      theta: round(theta),
      vega: round(vega),
      iv: round(iv),
      spreadPct: round(spreadPct),

      // Indicative short-option references
      entryReference: round(bid),
      stopReference: round(bid * CFG.SELL_SL_MULTIPLE),
      targetPremium: round(bid * CFG.SELL_TARGET_DECAY)
    });
  }

  return result;
}

function selectOption(chain, type) {
  const legs = getOptionLegs(chain, type);

  if (!legs.length) return null;

  legs.sort((a, b) => {
    const aScore =
      Math.abs(Math.abs(a.delta) - 0.22) * 100 +
      a.spreadPct * 3 -
      Math.log10(a.volume + 1) -
      Math.log10(a.oi + 1);

    const bScore =
      Math.abs(Math.abs(b.delta) - 0.22) * 100 +
      b.spreadPct * 3 -
      Math.log10(b.volume + 1) -
      Math.log10(b.oi + 1);

    return aScore - bScore;
  });

  return legs[0];
}

async function getOptionSignal(item, analysis) {
  if (!analysis.ready || analysis.signal === "WAIT") {
    return null;
  }

  const expiry = item.expiry;

  const chain = await getOptionChain(
    item.underlyingKey,
    expiry
  );

  const type = analysis.signal === "SELL_PE"
    ? "PE"
    : "CE";

  const selected = selectOption(chain, type);

  if (!selected) return null;

  selected.expiry = expiry;

  return {
    action: analysis.signal,
    optionType: type,
    strike: selected.strike,
    expiry,
    contract: selected,

    underlying: item.symbol,
    underlyingPrice: analysis.price,

    direction: analysis.direction,
    conditionsPassed: 8,
    conditionsRequired: 8,

    status: "VERY_STRONG_SELL",
    signalTime: new Date().toISOString()
  };
}

async function worker(items, fn) {
  const results = [];
  let index = 0;

  async function run() {
    while (index < items.length) {
      const current = items[index++];

      try {
        results.push(await fn(current));
      } catch (e) {
        results.push({
          symbol: current.symbol,
          error: e.message
        });
      }
    }
  }

  const count = Math.min(
    CFG.WORKERS,
    items.length
  );

  await Promise.all(
    Array.from({ length: count }, run)
  );

  return results;
}

async function scanOne(item, quotes) {
  const quote = findQuote(item, quotes);

  const candles = await getCandles(item.futuresKey);

  const daily = await getDailyCandles(item.futuresKey);

  const analysis = analyseCandles(
    candles,
    quote,
    daily
  );

  const result = {
    symbol: item.symbol,
    kind: item.kind,
    futuresSymbol: item.futuresSymbol,
    expiry: item.expiry,
    analysis
  };

  if (
    analysis.ready &&
    analysis.signal !== "WAIT"
  ) {
    result.optionSignal = await getOptionSignal(
      item,
      analysis
    );
  }

  return result;
}

async function runScan() {
  if (scanBusy) {
    return scanCache || {
      status: "SCAN_RUNNING",
      signals: []
    };
  }

  if (
    scanCache &&
    Date.now() - scanCache.time < CFG.CACHE_MS
  ) {
    return scanCache.data;
  }

  scanBusy = true;

  try {
    await loadMaster();

    const quotes = await getQuotes(universe);

    const results = await worker(
      universe,
      item => scanOne(item, quotes)
    );

    const signals = results
      .filter(x =>
        x.optionSignal &&
        x.optionSignal.status === "VERY_STRONG_SELL"
      )
      .sort((a, b) =>
        (b.analysis.adx || 0) -
        (a.analysis.adx || 0)
      );

    const data = {
      success: true,
      version: CFG.VERSION,
      time: new Date().toISOString(),
      marketOpen: marketOpen(),
      universeCount: universe.length,
      scannedCount: results.length,
      signalCount: signals.length,
      rules: {
        conditionsRequired: 8,
        volumeMultiplier: CFG.VOLUME_MULTIPLIER,
        bullishRsiMinimum: CFG.BULL_RSI_MIN,
        bearishRsiMaximum: CFG.BEAR_RSI_MAX,
        adxMinimum: CFG.ADX_MIN
      },
      signals,
      results
    };

    scanCache = {
      time: Date.now(),
      data
    };

    return data;
  } finally {
    scanBusy = false;
  }
}

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 200, { success: true });
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {
    if (url.pathname === "/health") {
      return send(res, 200, {
        success: true,
        status: "SERVER_RUNNING",
        version: CFG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        masterReady,
        universeCount: universe.length,
        marketOpen: marketOpen(),
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/status") {
      return send(res, 200, {
        success: true,
        version: CFG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        masterReady,
        totalInstruments: master.length,
        universeCount: universe.length,
        indexes: CFG.INDEXES,
        marketOpen: marketOpen(),
        scanRunning: scanBusy
      });
    }

    if (url.pathname === "/api/instruments") {
      await loadMaster();

      return send(res, 200, {
        success: true,
        count: universe.length,
        instruments: universe
      });
    }

    if (url.pathname === "/api/master/refresh") {
      await loadMaster(true);

      scanCache = null;

      return send(res, 200, {
        success: true,
        message: "Instrument master refreshed",
        count: universe.length
      });
    }

    if (url.pathname === "/api/scan") {
      const data = await runScan();

      return send(res, 200, data);
    }

    if (
      url.pathname === "/api/option-selling/scan" ||
      url.pathname === "/api/strong-sell"
    ) {
      const data = await runScan();

      return send(res, 200, {
        success: data.success,
        time: data.time,
        count: data.signalCount,
        signals: data.signals
      });
    }

    if (url.pathname === "/api/put-sell") {
      const data = await runScan();

      const signals = data.signals.filter(
        x => x.optionSignal.optionType === "PE"
      );

      return send(res, 200, {
        success: true,
        count: signals.length,
        signals
      });
    }

    if (url.pathname === "/api/call-sell") {
      const data = await runScan();

      const signals = data.signals.filter(
        x => x.optionSignal.optionType === "CE"
      );

      return send(res, 200, {
        success: true,
        count: signals.length,
        signals
      });
    }

    return send(res, 404, {
      success: false,
      error: "API route not found",
      route: url.pathname
    });

  } catch (e) {
    console.error("[API ERROR]", e);

    return send(res, 500, {
      success: false,
      error: e.message
    });
  }
});

server.listen(PORT, () => {
  console.log("====================================");
  console.log("SMART TRADE INDIA OPTION SELL PRO");
  console.log("VERSION:", CFG.VERSION);
  console.log("PORT:", PORT);
  console.log("UPSTOX TOKEN:", TOKEN ? "CONFIGURED" : "MISSING");
  console.log("====================================");

  loadMaster().catch(e => {
    console.error("[MASTER ERROR]", e.message);
  });
});
