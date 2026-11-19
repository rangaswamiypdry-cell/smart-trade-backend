'use strict';

// ======================================================
// SMART MONEY PRO V5
// FOUR INDEX ONLY - CE / PE OPTIONS SCANNER
// Node.js 20+ | Upstox API
// PART 1 OF 2
// ======================================================

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || '';

const API = 'https://api.upstox.com';
const MASTER_URL =
  'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'smart-money-pro-v5-store.json');

const INDEXES = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY'];

const CONFIG = {
  VERSION: 'SMART_MONEY_PRO_V5_FOUR_INDEX_ONLY',
  TIMEFRAME_MINUTES: 5,
  CANDLE_MS: 300000,
  SCAN_INTERVAL_MS: 30000,
  API_TIMEOUT_MS: 20000,
  HISTORY_DAYS: 5,
  RSI_PERIOD: 14,
  RSI_BUY_MIN: 55,
  RSI_SELL_MAX: 45,
  VOLUME_MULTIPLIER: 1.5,
  MIN_OI_CHANGE_PERCENT: 0.10,
  MIN_OPTION_OI_CHANGE_PERCENT: 0.01,
  MIN_OPTION_VOLUME_CHANGE: 1,
  MAX_SPREAD_PERCENT: 2,
  MIN_DELTA: 0.40,
  MAX_DELTA: 0.70,
  MAX_STRIKES_EACH_SIDE: 30,
  MIN_MATCH_CONDITIONS: 4,
  STRONG_MATCH_CONDITIONS: 5,
  VERY_STRONG_MATCH_CONDITIONS: 6,
  MARKET_START: '09:15',
  CONFIRM_AFTER: '09:30',
  MARKET_END: '15:30',
  STOP_LOSS_PERCENT: 25,
  TARGET1_PERCENT: 30,
  TARGET2_PERCENT: 50,
  NEWS_REFRESH_MS: 120000,
  NEWS_MAX_AGE_MINUTES: 30,
  MAX_HISTORY_RECORDS: 5000,
  MAX_CONCURRENT_REQUESTS: 3
};

let instrumentMaster = [];
let indexMap = [];
let masterLoaded = false;
let scanRunning = false;
let lastScan = null;
let lastScanAt = 0;

const optionSnapshots = new Map();
const futuresSnapshots = new Map();
const activeSignals = new Map();
const signalHistory = [];
const seenSignalKeys = new Set();

let nextSignalId = 1;
let persistenceReady = false;
let lastAlertEventId = 0;

// ======================================================
// COMMON HELPERS
// ======================================================

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function istDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function istDateDaysAgo(days) {
  const d = new Date(
    Date.now() - Number(days) * 86400000
  );
  return istDate(d);
}

function istTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const result = {};
  for (const p of parts) result[p.type] = p.value;

  return {
    hour: Number(result.hour),
    minute: Number(result.minute),
    text: `${result.hour}:${result.minute}`
  };
}

function isMarketTime() {
  const t = istTimeParts();
  const value = t.hour * 60 + t.minute;
  return value >= 555 && value <= 930;
}

function istStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true
  }).format(date);
}

function norm(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeExpiry(value) {
  if (!value) return '';

  const n = Number(value);

  if (Number.isFinite(n) && n > 0) {
    return new Date(
      n < 1e12 ? n * 1000 : n
    ).toISOString().slice(0, 10);
  }

  const d = new Date(value);

  return Number.isNaN(d.getTime())
    ? ''
    : d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(data));
}

// ======================================================
// PERSISTENT STORE
// ======================================================

function ensureDataDirectory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persistStore() {
  ensureDataDirectory();

  const payload = {
    version: 5,
    savedAt: new Date().toISOString(),
    nextSignalId,
    lastAlertEventId,
    history: signalHistory.slice(-CONFIG.MAX_HISTORY_RECORDS),
    active: [...activeSignals.entries()],
    seenKeys: [...seenSignalKeys].slice(-CONFIG.MAX_HISTORY_RECORDS)
  };

  const temp = `${DB_FILE}.tmp`;

  fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
  fs.renameSync(temp, DB_FILE);
}

function loadStore() {
  if (persistenceReady) return;

  ensureDataDirectory();

  try {
    if (fs.existsSync(DB_FILE)) {
      const saved = JSON.parse(
        fs.readFileSync(DB_FILE, 'utf8')
      );

      if (Array.isArray(saved.history)) {
        signalHistory.push(...saved.history);
      }

      if (Array.isArray(saved.active)) {
        for (const [key, value] of saved.active) {
          activeSignals.set(key, value);
        }
      }

      if (Array.isArray(saved.seenKeys)) {
        for (const key of saved.seenKeys) {
          seenSignalKeys.add(key);
        }
      }

      nextSignalId = Number(saved.nextSignalId || 1);
      lastAlertEventId = Number(saved.lastAlertEventId || 0);
    }
  } catch (error) {
    console.error('[STORE LOAD ERROR]', error.message);
  }

  persistenceReady = true;
}

// ======================================================
// UPSTOX API
// ======================================================

async function upstoxGET(apiPath) {
  if (!TOKEN) {
    throw new Error('UPSTOX_ACCESS_TOKEN_MISSING');
  }

  const response = await fetch(API + apiPath, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`
    },
    signal: AbortSignal.timeout(CONFIG.API_TIMEOUT_MS)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `UPSTOX_HTTP_${response.status}`
    );
  }

  return data;
}

// ======================================================
// DOWNLOAD UPSTOX INSTRUMENT MASTER
// ======================================================

async function downloadInstrumentMaster() {
  const response = await fetch(MASTER_URL, {
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(
      `MASTER_DOWNLOAD_FAILED_${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  let rows;

  try {
    rows = JSON.parse(
      zlib.gunzipSync(buffer).toString('utf8')
    );
  } catch {
    rows = JSON.parse(buffer.toString('utf8'));
  }

  if (!Array.isArray(rows)) {
    throw new Error('INVALID_MASTER_DATA');
  }

  return rows;
}

// ======================================================
// MAP ONLY FOUR INDEXES AND THEIR FUTURES
// ======================================================

async function loadIndexMaster(force = false) {
  if (masterLoaded && !force && indexMap.length === 4) {
    return indexMap;
  }

  instrumentMaster = await downloadInstrumentMaster();

  const aliases = {
    NIFTY: ['NIFTY 50', 'NIFTY'],
    BANKNIFTY: ['NIFTY BANK', 'BANKNIFTY'],
    SENSEX: ['SENSEX'],
    FINNIFTY: [
      'NIFTY FIN SERVICE',
      'NIFTY FINANCIAL SERVICES',
      'FINNIFTY'
    ]
  };

  const today = istDate();
  const mapped = [];

  for (const symbol of INDEXES) {
    const names = aliases[symbol];

    const segment =
      symbol === 'SENSEX'
        ? 'BSE_INDEX'
        : 'NSE_INDEX';

    const foSegment =
      symbol === 'SENSEX'
        ? 'BSE_FO'
        : 'NSE_FO';

    const matches = value =>
      names.some(name => norm(name) === norm(value));

    const indexInstrument = instrumentMaster.find(item =>
      item.segment === segment &&
      item.instrument_type === 'INDEX' &&
      (
        matches(item.name) ||
        matches(item.trading_symbol)
      )
    );

    const futures = instrumentMaster
      .filter(item =>
        item.segment === foSegment &&
        item.instrument_type === 'FUT' &&
        item.instrument_key &&
        (
          matches(item.underlying_symbol) ||
          matches(item.name) ||
          matches(item.trading_symbol)
        ) &&
        normalizeExpiry(item.expiry) >= today
      )
      .sort((a, b) =>
        normalizeExpiry(a.expiry).localeCompare(
          normalizeExpiry(b.expiry)
        )
      );

    const future = futures[0];

    if (!indexInstrument || !future) {
      console.error('[INDEX NOT MAPPED]', symbol, {
        indexFound: !!indexInstrument,
        futuresFound: futures.length
      });
      continue;
    }

    mapped.push({
      symbol,
      indexKey: indexInstrument.instrument_key,
      futuresKey: future.instrument_key,
      futuresSymbol: future.trading_symbol,
      expiry: normalizeExpiry(future.expiry),
      lotSize: Number(future.lot_size || 0),
      segment: foSegment
    });

    console.log(
      '[INDEX FUTURE MAPPED]',
      symbol,
      future.trading_symbol,
      normalizeExpiry(future.expiry)
    );
  }

  indexMap = mapped;
  masterLoaded = indexMap.length === 4;

  console.log('[FOUR INDEX MASTER STATUS]', {
    expected: 4,
    mapped: indexMap.length,
    indexes: indexMap.map(x => x.symbol)
  });

  return indexMap;
}

// ======================================================
// 5-MINUTE COMPLETED CANDLES
// ======================================================

function mapCandle(c) {
  return {
    time: new Date(c[0]).getTime(),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5] || 0),
    oi: Number(c[6] || 0)
  };
}

function isCompleted(c) {
  return (
    Number.isFinite(c.time) &&
    c.close > 0 &&
    c.time + CONFIG.CANDLE_MS <= Date.now()
  );
}

async function getFiveMinuteCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);
  const today = istDate();
  const from = istDateDaysAgo(CONFIG.HISTORY_DAYS);

  const [historical, intraday] = await Promise.all([
    upstoxGET(
      `/v3/historical-candle/${key}/minutes/5/${today}/${from}`
    ).catch(() => ({ data: { candles: [] } })),

    upstoxGET(
      `/v3/historical-candle/intraday/${key}/minutes/5`
    )
  ]);

  const combined = [
    ...(historical?.data?.candles || []),
    ...(intraday?.data?.candles || [])
  ]
    .map(mapCandle)
    .filter(isCompleted)
    .sort((a, b) => a.time - b.time);

  const unique = new Map(
    combined.map(c => [c.time, c])
  );

  return [...unique.values()].sort(
    (a, b) => a.time - b.time
  );
}

// ======================================================
// RSI - WILDER
// ======================================================

function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    avgGain =
      (avgGain * (period - 1) +
        Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) +
        Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return round(
    100 - 100 / (1 + avgGain / avgLoss)
  );
}

// ======================================================
// VOLUME RATIO
// ======================================================

function calculateVolumeRatio(candles) {
  if (candles.length < 22) return 0;

  const previous = candles.slice(-21, -1);

  const average = previous.reduce(
    (sum, c) => sum + c.volume,
    0
  ) / previous.length;

  const latest = candles[candles.length - 1].volume;

  return average > 0
    ? round(latest / average)
    : 0;
}

// ======================================================
// SESSION VWAP
// ======================================================

function calculateSessionVWAP(candles) {
  const today = istDate();

  const session = candles.filter(c =>
    istDate(new Date(c.time)) === today
  );

  let pv = 0;
  let volume = 0;

  for (const c of session) {
    const typical =
      (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    volume += c.volume;
  }

  return volume > 0 ? pv / volume : null;
}

// ======================================================
// FUTURES OI SNAPSHOT
// ======================================================

function calculateFuturesOI(symbol, candles) {
  const latest = candles[candles.length - 1];

  if (!latest || !latest.oi) {
    return {
      available: false,
      increasing: false,
      changePercent: null
    };
  }

  const previous = futuresSnapshots.get(symbol);

  futuresSnapshots.set(symbol, {
    oi: latest.oi,
    candleTime: latest.time
  });

  if (!previous || previous.candleTime === latest.time) {
    return {
      available: false,
      increasing: false,
      changePercent: null
    };
  }

  const changePercent = previous.oi > 0
    ? ((latest.oi - previous.oi) / previous.oi) * 100
    : 0;

  return {
    available: true,
    increasing:
      changePercent >= CONFIG.MIN_OI_CHANGE_PERCENT,
    changePercent: round(changePercent)
  };
}

// ======================================================
// CANDLE STRENGTH
// ======================================================

function strongBearish(c) {
  const range = c.high - c.low;

  if (range <= 0) return false;

  return (
    c.close < c.open &&
    (c.open - c.close) / range >= 0.50
  );
}

function strongBullish(c) {
  const range = c.high - c.low;

  if (range <= 0) return false;

  return (
    c.close > c.open &&
    (c.close - c.open) / range >= 0.50
  );
}// ======================================================
// SMART MONEY PRO V5
// PART 2A
// PASTE BELOW PART 1
// ======================================================

// ======================================================
// LIVE NEWS ENGINE - RSS
// ======================================================

const NEWS_RSS_URLS = (
  process.env.NEWS_RSS_URLS ||
  'https://news.google.com/rss/search?q=Nifty+OR+Sensex+OR+Bank+Nifty+India+market&hl=en-IN&gl=IN&ceid=IN:en'
).split(',').map(x => x.trim()).filter(Boolean);

let newsState = {
  status: 'NOT_FETCHED',
  sentiment: 'NEUTRAL',
  score: 0,
  headlines: [],
  fetchedAt: null,
  error: null
};

const GOOD_WORDS = [
  'beats estimates', 'profit rises', 'record profit',
  'strong results', 'upgrade', 'buy rating',
  'growth', 'surge', 'rally', 'positive',
  'rate cut', 'inflow', 'bullish', 'outperform',
  'approval', 'order win', 'strong demand'
];

const BAD_WORDS = [
  'misses estimates', 'loss widens', 'profit falls',
  'downgrade', 'sell rating', 'fraud',
  'investigation', 'crash', 'plunge', 'decline',
  'bearish', 'outflow', 'rate hike',
  'default', 'ban', 'penalty', 'weak outlook'
];

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseRssItems(xml) {
  const items = [];
  const matches = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const item of matches) {
    const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const link = item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1];
    const pubDate = item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1];

    if (!title) continue;

    items.push({
      title: decodeXml(title.replace(/<[^>]+>/g, '')),
      link: decodeXml(link || ''),
      publishedAt: pubDate ? new Date(decodeXml(pubDate)).toISOString() : null
    });
  }

  return items;
}

function classifyNews(headlines) {
  let good = 0;
  let bad = 0;

  for (const item of headlines) {
    const title = item.title.toLowerCase();

    for (const word of GOOD_WORDS) {
      if (title.includes(word)) good++;
    }

    for (const word of BAD_WORDS) {
      if (title.includes(word)) bad++;
    }
  }

  const score = good - bad;

  return {
    score,
    sentiment:
      score >= 2 ? 'GOOD' :
      score <= -2 ? 'BAD' :
      'NEUTRAL',
    goodCount: good,
    badCount: bad
  };
}

async function fetchNews(force = false) {
  const age = newsState.fetchedAt
    ? Date.now() - new Date(newsState.fetchedAt).getTime()
    : Infinity;

  if (!force && age < CONFIG.NEWS_REFRESH_MS) {
    return newsState;
  }

  try {
    const all = [];

    for (const url of NEWS_RSS_URLS) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'SmartMoneyPro/5.0' },
          signal: AbortSignal.timeout(12000)
        });

        if (!response.ok) continue;

        const xml = await response.text();
        all.push(...parseRssItems(xml));
      } catch (error) {
        console.error('[NEWS FEED ERROR]', error.message);
      }
    }

    const unique = new Map();

    for (const item of all) {
      const key = item.title.toLowerCase();
      if (!unique.has(key)) unique.set(key, item);
    }

    const headlines = [...unique.values()]
      .filter(x => {
        if (!x.publishedAt) return true;
        const ageMs = Date.now() - new Date(x.publishedAt).getTime();
        return ageMs >= 0 &&
          ageMs <= CONFIG.NEWS_MAX_AGE_MINUTES * 60000;
      })
      .slice(0, 30);

    const result = classifyNews(headlines);

    newsState = {
      status: headlines.length ? 'LIVE' : 'NO_FRESH_NEWS',
      sentiment: result.sentiment,
      score: result.score,
      goodCount: result.goodCount,
      badCount: result.badCount,
      headlines,
      fetchedAt: new Date().toISOString(),
      error: null
    };

    console.log('[NEWS UPDATE]', {
      sentiment: newsState.sentiment,
      headlines: headlines.length,
      score: result.score
    });

    return newsState;
  } catch (error) {
    newsState = {
      ...newsState,
      status: 'ERROR',
      error: error.message
    };

    return newsState;
  }
}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period = 20) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ======================================================
// SIX CONDITION INDEX ANALYSIS
// ======================================================

function analyseIndex(index, candles) {
  if (!Array.isArray(candles) || candles.length < 22) {
    return {
      success: false,
      symbol: index.symbol,
      reason: 'NOT_ENOUGH_COMPLETED_5M_CANDLES'
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const closes = candles.map(x => x.close);
  const ema20 = calculateEMA(closes, 20);
  const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const volumeRatio = calculateVolumeRatio(candles);
  const vwap = calculateSessionVWAP(candles);
  const oi = calculateFuturesOI(index.symbol, candles);

  const previousCandles = candles.slice(-11, -1);
  const previousHigh = Math.max(...previousCandles.map(x => x.high));
  const previousLow = Math.min(...previousCandles.map(x => x.low));

  const bullish = {
    priceAboveEMA20: ema20 !== null && last.close > ema20,
    rsiAbove55: rsi !== null && rsi >= CONFIG.RSI_BUY_MIN,
    volumeSpike: volumeRatio >= CONFIG.VOLUME_MULTIPLIER,
    priceAboveVWAP: vwap !== null && last.close > vwap,
    futuresOIIncreasing: oi.available && oi.increasing,
    bullishBreakout:
      last.close > previousHigh && strongBullish(last)
  };

  const bearish = {
    priceBelowEMA20: ema20 !== null && last.close < ema20,
    rsiBelow45: rsi !== null && rsi <= CONFIG.RSI_SELL_MAX,
    volumeSpike: volumeRatio >= CONFIG.VOLUME_MULTIPLIER,
    priceBelowVWAP: vwap !== null && last.close < vwap,
    futuresOIIncreasing: oi.available && oi.increasing,
    bearishBreakdown:
      last.close < previousLow && strongBearish(last)
  };

  const bullCount = Object.values(bullish).filter(Boolean).length;
  const bearCount = Object.values(bearish).filter(Boolean).length;

  let direction = 'WAIT';
  let optionSide = null;
  let matched = 0;
  let conditions = null;

  if (
    bearCount >= CONFIG.MIN_MATCH_CONDITIONS &&
    bearCount > bullCount
  ) {
    direction = 'BEARISH';
    optionSide = 'CE';
    matched = bearCount;
    conditions = bearish;
  } else if (
    bullCount >= CONFIG.MIN_MATCH_CONDITIONS &&
    bullCount > bearCount
  ) {
    direction = 'BULLISH';
    optionSide = 'PE';
    matched = bullCount;
    conditions = bullish;
  }

  const strength =
    matched >= 6 ? 'VERY STRONG' :
    matched >= 5 ? 'STRONG' :
    matched >= 4 ? 'QUALIFIED' :
    'WAIT';

  return {
    success: true,
    symbol: index.symbol,
    direction,
    optionSide,
    matched,
    totalConditions: 6,
    strength,
    conditions,
    bullishConditions: bullish,
    bearishConditions: bearish,

    price: round(last.close),
    ema20: round(ema20),
    rsi,
    volumeRatio,
    vwap: round(vwap),
    futuresOIChangePercent: oi.changePercent,
    futuresOIAvailable: oi.available,

    candleTime: new Date(last.time).toISOString(),
    candleTimeIST: istStamp(new Date(last.time)),
    dataFetchedAt: new Date().toISOString(),

    futuresInstrumentKey: index.futuresKey,
    indexInstrumentKey: index.indexKey,
    futuresSymbol: index.futuresSymbol,
    futuresExpiry: index.expiry
  };
}

// ======================================================
// OPTION CHAIN
// ======================================================

async function getOptionChain(indexKey) {
  const key = encodeURIComponent(indexKey);

  const contracts = await upstoxGET(
    `/v2/option/contract?instrument_key=${key}`
  );

  const rows = contracts?.data || [];

  const expiries = [...new Set(
    rows.map(x => normalizeExpiry(x.expiry))
      .filter(x => x >= istDate())
  )].sort();

  if (!expiries.length) {
    throw new Error('NO_OPTION_EXPIRY');
  }

  const expiry = expiries[0];

  const chain = await upstoxGET(
    `/v2/option/chain?instrument_key=${key}&expiry_date=${expiry}`
  );

  return {
    expiry,
    chain: chain?.data || []
  };
}

function getSideOption(row, side) {
  return side === 'CE'
    ? row.call_options
    : row.put_options;
}

// ======================================================
// OPTION SELL CANDIDATE ANALYSIS
// ======================================================

function analyseOption(row, side, expiry) {
  const option = getSideOption(row, side);
  if (!option?.instrument_key) return null;

  const market = option.market_data || {};
  const greeks = option.option_greeks || {};

  const ltp = Number(market.ltp || 0);
  const bid = Number(market.bid_price || 0);
  const ask = Number(market.ask_price || 0);
  const volume = Number(market.volume || 0);
  const oi = Number(market.oi || 0);
  const delta = Math.abs(Number(greeks.delta || 0));

  if (
    ltp <= 0 || bid <= 0 || ask <= 0 ||
    volume <= 0 || oi <= 0 || ask < bid ||
    delta < CONFIG.MIN_DELTA ||
    delta > CONFIG.MAX_DELTA
  ) return null;

  const spreadPercent = ((ask - bid) / ltp) * 100;

  if (spreadPercent > CONFIG.MAX_SPREAD_PERCENT) {
    return null;
  }

  const instrumentKey = option.instrument_key;
  const previous = optionSnapshots.get(instrumentKey);

  optionSnapshots.set(instrumentKey, {
    ltp, volume, oi, time: Date.now()
  });

  if (!previous || previous.oi <= 0) return null;

  // Require recent comparison data, not an old snapshot.
  if (Date.now() - previous.time > 5 * 60000) return null;

  const premiumFalling = ltp < previous.ltp;

  const volumeIncreasing =
    volume >= previous.volume + CONFIG.MIN_OPTION_VOLUME_CHANGE;

  const oiIncreasing =
    oi > previous.oi &&
    ((oi - previous.oi) / previous.oi) * 100 >=
      CONFIG.MIN_OPTION_OI_CHANGE_PERCENT;  for (const row of data.chain) {
    const candidate = analyseOption(row, side, data.expiry);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => optionScore(b) - optionScore(a));

  if (!candidates.length) {
    return {
      success: false,
      reason: `WAITING_FOR_${side}_PREMIUM_DOWN_VOLUME_UP_OI_UP`
    };
  }

  const best = candidates[0];
  const entry = best.entry;

  return {
    success: true,
    signal: `${side}_SELL`,
    optionType: side,
    strikePrice: best.strikePrice,
    instrumentKey: best.instrumentKey,
    expiry: best.expiry,
    premium: best.premium,
    entry,

    stopLoss: round(
      entry * (1 + CONFIG.STOP_LOSS_PERCENT / 100)
    ),
    target1: round(
      entry * (1 - CONFIG.TARGET1_PERCENT / 100)
    ),
    target2: round(
      entry * (1 - CONFIG.TARGET2_PERCENT / 100)
    ),

    volume: best.volume,
    oi: best.oi,
    optionOIChangePercent: best.optionOIChangePercent,
    delta: best.delta,
    spreadPercent: best.spreadPercent,
    optionConditions: best.conditions,
    selectionScore: round(optionScore(best))
  };
}

// ======================================================
// SIGNAL HISTORY
// ======================================================

function addSignal(result) {
  loadStore();

  const option = result.option;
  const key = [
    result.symbol,
    result.optionSide,
    option.strikePrice,
    option.expiry,
    result.candleTime
  ].join('|');

  if (seenSignalKeys.has(key)) return null;
  seenSignalKeys.add(key);

  const signal = {
    id: nextSignalId++,
    symbol: result.symbol,
    direction: result.direction,
    optionSide: result.optionSide,
    signal: option.signal,
    strength: result.strength,
    matchedConditions: result.matched,
    conditions: result.conditions,

    indexPrice: result.price,
    rsi: result.rsi,
    volumeRatio: result.volumeRatio,
    vwap: result.vwap,
    futuresOIChangePercent: result.futuresOIChangePercent,

    option,
    news: newsState.sentiment,
    newsStatus: newsState.status,

    candleTime: result.candleTime,
    createdAt: new Date().toISOString(),
    status: 'ACTIVE',
    events: []
  };

  signalHistory.push(signal);
  activeSignals.set(String(signal.id), signal);

  if (signalHistory.length > CONFIG.MAX_HISTORY_RECORDS) {
    signalHistory.shift();
  }

  persistStore();

  console.log('[NEW SIGNAL]', {
    id: signal.id,
    symbol: signal.symbol,
    signal: signal.signal,
    strength: signal.strength,
    matched: `${signal.matchedConditions}/6`,
    strike: option.strikePrice
  });

  return signal;
}

// ======================================================
// ONE INDEX SCAN
// ======================================================

async function scanOneIndex(index) {
  try {
    const candles = await getFiveMinuteCandles(index.futuresKey);
    const analysis = analyseIndex(index, candles);

    if (!analysis.success || !analysis.optionSide) {
      return {
        ...analysis,
        option: null
      };
    }

    const option = await selectStrongSellOption(index, analysis);

    const result = {
      ...analysis,
      option
    };

    if (option.success) {
      const saved = addSignal(result);
      result.newSignal = !!saved;
      result.signalId = saved?.id || null;
    }

    return result;
  } catch (error) {
    console.error('[INDEX SCAN ERROR]', index.symbol, error.message);

    return {
      success: false,
      symbol: index.symbol,
      reason: error.message
    };
  }
}

// ======================================================
// SCANNER
// ======================================================

async function runScanner() {
  if (scanRunning) {
    return {
      success: false,
      reason: 'SCAN_ALREADY_RUNNING'
    };
  }

  scanRunning = true;

  try {
    loadStore();

    if (!masterLoaded || indexMap.length !== 4) {
      await loadIndexMaster();
    }

    await fetchNews();

    const results = [];

    // Only the four configured indexes are scanned.
    for (const index of indexMap) {
      results.push(await scanOneIndex(index));
      await sleep(350);
    }

    lastScanAt = Date.now();

    lastScan = {
      success: true,
      version: CONFIG.VERSION,
      scanTime: new Date().toISOString(),
      scanTimeIST: istStamp(),
      indexes: INDEXES,
      news: newsState,
      results
    };

    return lastScan;
  } finally {
    scanRunning = false;
  }
}

// ======================================================
// OPTION LIVE QUOTE / SL / TARGET TRACKING
// ======================================================

async function getOptionLiveQuote(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const data = await upstoxGET(
    `/v2/market-quote/quotes?instrument_key=${key}`
  );

  const values = data?.data || {};
  const quote = values[instrumentKey] ||
    values[Object.keys(values)[0]] || {};

  return {
    ltp: Number(quote.last_price || 0),
    fetchedAt: new Date().toISOString()
  };
}

async function updateActiveSignals() {
  for (const signal of activeSignals.values()) {
    if (signal.status !== 'ACTIVE') continue;

    try {
      const quote = await getOptionLiveQuote(
        signal.option.instrumentKey
      );

      if (!quote.ltp) continue;

      signal.currentPremium = quote.ltp;
      signal.lastQuoteAt = quote.fetchedAt;

      if (quote.ltp >= signal.option.stopLoss) {
        signal.status = 'STOP_LOSS_HIT';
        signal.closedAt = new Date().toISOString();
      } else if (
        quote.ltp <= signal.option.target2
      ) {
        signal.status = 'TARGET_2_HIT';
        signal.closedAt = new Date().toISOString();
      } else if (
        quote.ltp <= signal.option.target1 &&
        !signal.target1Hit
      ) {
        signal.target1Hit = true;
        signal.events.push({
          eventId: ++lastAlertEventId,
          eventType: 'TARGET_1_HIT',
          createdAt: new Date().toISOString()
        });
      }

      persistStore();
    } catch (error) {
      console.error('[ACTIVE QUOTE ERROR]', error.message);
    }

    await sleep(250);
  }
}

// ======================================================
// SCHEDULER
// ======================================================

let schedulerStarted = false;

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.log('[SCHEDULER STARTED]', CONFIG.VERSION);

  setInterval(async () => {
    if (!isMarketTime()) return;

    try {
      await runScanner();
      await updateActiveSignals();
    } catch (error) {
      console.error('[SCHEDULER ERROR]', error.message);
    }
  }, CONFIG.SCAN_INTERVAL_MS);

  setInterval(() => {
    fetchNews(true).catch(error =>
      console.error('[NEWS REFRESH ERROR]', error.message)
    );
  }, CONFIG.NEWS_REFRESH_MS);
}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  try {
    // Dashboard route
    if (
      req.method === 'GET' &&
      (url.pathname === '/dashboard' || url.pathname === '/dashboard/')
    ) {
      const dashboardPath = path.join(__dirname, 'dashboard.html');

      if (!fs.existsSync(dashboardPath)) {
        return sendJson(res, 404, {
          success: false,
          error: 'DASHBOARD_HTML_NOT_FOUND',
          message: 'Place dashboard.html in the same folder as server.js'
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });

      return res.end(fs.readFileSync(dashboardPath, 'utf8'));
    }

    if (url.pathname === '/health') {
      return sendJson(res, 200, {
        success: true,
        version: CONFIG.VERSION,
        status: 'RUNNING',
        time: new Date().toISOString()
      });
    }

    if (url.pathname === '/api/status') {
      return sendJson(res, 200, {
        success: true,
        version: CONFIG.VERSION,
        allowedIndexes: INDEXES,
        mappedIndexes: indexMap.map(x => ({
          symbol: x.symbol,
          futuresSymbol: x.futuresSymbol,
          expiry: x.expiry
        })),
        masterLoaded,
        scanRunning,
        lastScanAt: lastScanAt
          ? new Date(lastScanAt).toISOString()
          : null,
        news: newsState,
        activeSignals: activeSignals.size,
        historyCount: signalHistory.length
      });
    }

    if (url.pathname === '/api/scan') {
      const result = await runScanner();
      return sendJson(res, 200, result);
    }

    if (url.pathname === '/api/scan/latest') {
      return sendJson(res, 200, lastScan || {
        success: false,
        reason: 'NO_SCAN_YET'
      });
    }

    if (url.pathname === '/api/news') {
      await fetchNews();
      return sendJson(res, 200, newsState);
    }

    if (url.pathname === '/api/signals/history') {
      return sendJson(res, 200, {
        success: true,
        count: signalHistory.length,
        data: signalHistory.slice().reverse()
      });
    }

    if (url.pathname === '/api/signals/active') {
      return sendJson(res, 200, {
        success: true,
        data: [...activeSignals.values()]
      });
    }

    if (url.pathname === '/api/signals/events') {
      const after = Number(url.searchParams.get('after') || 0);

      const events = signalHistory.flatMap(x => x.events || [])
        .filter(x => Number(x.eventId) > after);

      return sendJson(res, 200, {
        success: true,
        data: events
      });
    }

    return sendJson(res, 404, {
      success: false,
      error: 'NOT_FOUND'
    });
  } catch (error) {
    console.error('[SERVER ERROR]', error);

    return sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
});

// ======================================================
// START SERVER
// ======================================================

async function start() {
  loadStore();

  console.log('======================================');
  console.log(' SMART MONEY PRO V5');
  console.log(' FOUR INDEX ONLY CE / PE SCANNER');
  console.log('======================================');

  console.log('[ALLOWED INDEXES]', INDEXES.join(', '));

  if (!TOKEN) {
    console.error('[WARNING] UPSTOX_ACCESS_TOKEN is missing');
  }

  try {
    await loadIndexMaster();
  } catch (error) {
    console.error('[MASTER LOAD ERROR]', error.message);
  }

  server.listen(PORT, () => {
    console.log(`[SERVER RUNNING] PORT ${PORT}`);
  });

  startScheduler();
}

start().catch(error => {
  console.error('[FATAL START ERROR]', error);
  process.exit(1);
});
