 
'use strict';

const http = require('http');

const CONFIG = {
  VERSION: 'SMART_TRADE_INDIA_V11',
  TIMEFRAME: 5,

  EMA_FAST: 9,
  EMA_SLOW: 15,

  RSI_PERIOD: 14,
  RSI_BUY: 65,
  RSI_SELL: 35,

  VOLUME_PERIOD: 20,
  VOLUME_MULTIPLIER: 1.5,

  MIN_CONDITIONS: 7,
  SCAN_LIMIT: 220,
  CONCURRENCY: 3,

  ATR_PERIOD: 14,
  SL_ATR: 1.5,
  TARGET1_RR: 1.5,
  TARGET2_RR: 2.5,

  PORT: process.env.PORT || 10000
};

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const BASE = 'https://api.upstox.com';

const MASTER_URL =
  'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

const state = {
  instruments: [],
  stocks: [],
  indexes: [],
  options: [],
  signals: [],
  errors: [],
  lastAlerts: new Map(),
  lastIndexOi: new Map(),
  lastScan: null,
  running: false
};

// ---------- API ----------

async function api(path) {
  if (!TOKEN) throw new Error('UPSTOX_ACCESS_TOKEN missing');

  const response = await fetch(BASE + path, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok || data.status === 'error') {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

// ---------- DATE ----------

function istDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function expiryOf(value) {
  if (typeof value === 'number') {
    return istDate(new Date(value));
  }
  return String(value || '').slice(0, 10);
}

// ---------- INSTRUMENT MASTER ----------

async function loadInstruments() {
  const response = await fetch(MASTER_URL, {
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error('Instrument master download failed');
  }

  const zlib = require('zlib');
  const buffer = Buffer.from(await response.arrayBuffer());

  const records = JSON.parse(
    zlib.gunzipSync(buffer).toString('utf8')
  );

  state.instruments = records;
console.log(
  '[NIFTY INSTRUMENT DEBUG]',
  records.filter(x =>
    /NIFTY/i.test(
      String(x.trading_symbol || '') + ' ' +
      String(x.name || '') + ' ' +
      String(x.underlying_symbol || '')
    ) &&
    String(x.segment || '').endsWith('_INDEX')
  ).map(x => ({
    name: x.trading_symbol,
    segment: x.segment,
    type: x.instrument_type,
    key: x.instrument_key
  }))
);
console.log(
  '[DEBUG] INDEX ONLY:',
  records
    .filter(x =>
      String(x.segment || '').includes('INDEX')
    )
    .map(x => ({
      name: x.trading_symbol,
      segment: x.segment,
      type: x.instrument_type,
      key: x.instrument_key
    }))
);

console.log(
  '[DEBUG] INDEX COUNT:',
  records.filter(x =>
    String(x.segment || '').includes('INDEX')
  ).length
);
  
  // NSE F&O equity futures only
  const futures = records.filter(x =>
    x.segment === 'NSE_FO' &&
    x.instrument_type === 'FUT' &&
    x.underlying_type === 'EQUITY' &&
    x.underlying_symbol &&
    x.instrument_key &&
    x.underlying_key &&
    x.expiry
  );

  const nearest = new Map();

  for (const item of futures) {
    const symbol = item.underlying_symbol;
    const old = nearest.get(symbol);

    if (
      !old ||
      expiryOf(item.expiry) < expiryOf(old.expiry)
    ) {
      nearest.set(symbol, item);
    }
  }

  state.stocks = [...nearest.values()];

  // Index spot instrument keys: verify against
  // current Upstox instrument master.
  
const normalizeIndexName = value =>
  String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const wantedIndexes = new Set([
  'NIFTY',
  'NIFTY50',
  'NIFTYBANK',
  'BANKNIFTY',
  'NIFTYFINSERVICE',
  'FINNIFTY',
  'NIFTYFINANCIALSERVICES',
  'SENSEX'
]);


state.indexes = records.filter(x => {
  const segment = String(x.segment || '');

  const name = normalizeIndexName(
    x.trading_symbol ||
    x.name ||
    x.underlying_symbol ||
    ''
  );

  return (
    segment.endsWith('_INDEX') &&
    wantedIndexes.has(name) &&
    Boolean(x.instrument_key)
  );
});


console.log(
  '[V11] SELECTED INDEXES:',
  state.indexes.map(x => ({
    name: x.trading_symbol,
    segment: x.segment,
    key: x.instrument_key
  }))
);

  // OPTIONS CONTRACTS - NSE + BSE
  state.options = records.filter(x =>
    ['NSE_FO', 'BSE_FO'].includes(x.segment) &&
    ['CE', 'PE'].includes(x.instrument_type) &&
    x.underlying_key &&
    x.instrument_key &&
    x.expiry
  );
  

  return {
    stockFutures: state.stocks.length,
    indexes: state.indexes.map(x => ({
      symbol: x.trading_symbol,
      key: x.instrument_key
    })),
    options: state.options.length
  };
}

// ---------- CANDLE DATA ----------

function normalizeCandles(rows) {
  const now = Date.now();
  const unique = new Map();

  for (const c of rows || []) {
    const time = new Date(c[0]).getTime();

    if (!Number.isFinite(time)) continue;

    // Completed 5-minute candles only
    if (time + 300000 > now) continue;

    unique.set(time, {
      time: c[0],
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
      oi: Number(c[6] || 0)
    });
  }

  return [...unique.values()]
    .sort((a, b) =>
      new Date(a.time) - new Date(b.time)
    );
}

async function getCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const from = istDate(
    new Date(Date.now() - 25 * 86400000)
  );

  const yesterday = istDate(
    new Date(Date.now() - 86400000)
  );

  const [history, intraday] = await Promise.all([
    api(
      `/v3/historical-candle/${key}/minutes/5/${yesterday}/${from}`
    ),
    api(
      `/v3/historical-candle/intraday/${key}/minutes/5`
    )
  ]);

  return normalizeCandles([
    ...(history.data?.candles || []),
    ...(intraday.data?.candles || [])
  ]).slice(-250);
}

// ---------- INDICATORS ----------

function EMA(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0)
    / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function RSI(values, period = 14) {
  if (values.length <= period) return null;

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

  if (avgLoss === 0) return 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

function VWAP(candles) {
  let pv = 0;
  let volume = 0;
  let currentDate = null;

  return candles.map(c => {
    const date = istDate(new Date(c.time));

    if (date !== currentDate) {
      currentDate = date;
      pv = 0;
      volume = 0;
    }

    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    volume += c.volume;

    return volume > 0 ? pv / volume : null;
  });
}

function average(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

function ATR(candles, period = 14) {
  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    ranges.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  return ranges.length >= period
    ? average(ranges.slice(-period))
    : null;
}

// ---------- EXACT EMA CROSS ----------

function detectEMACross(closes) {
  if (closes.length < 30) {
    return 'NONE';
  }

  const previousCloses = closes.slice(0, -1);

  const currentFast = EMA(closes, 9);
  const currentSlow = EMA(closes, 15);

  const previousFast = EMA(previousCloses, 9);
  const previousSlow = EMA(previousCloses, 15);

  if (
    previousFast <= previousSlow &&
    currentFast > currentSlow
  ) {
    return 'UP';
  }

  if (
    previousFast >= previousSlow &&
    currentFast < currentSlow
  ) {
    return 'DOWN';
  }

  return 'NONE';
      }

// ---------- 100% SIGNAL ENGINE ----------

function analyseInstrument(item, candles) {
  if (!candles || candles.length < 30) return null;

  const closes = candles.map(c => c.close);
  const last = candles.at(-1);
  const prev = candles.at(-2);

  const cross = detectEMACross(closes);

  if (cross === 'NONE') return null;

  const ema9 = EMA(closes, 9);
  const ema15 = EMA(closes, 15);
  const rsi = RSI(closes, 14);

  const vwaps = VWAP(candles);
  const vwap = vwaps.at(-1);
  const previousVWAP = vwaps.at(-2);

  const atr = ATR(candles, CONFIG.ATR_PERIOD);

  if (
    [ema9, ema15, rsi, vwap, previousVWAP, atr]
      .some(x => x === null || !Number.isFinite(x))
  ) return null;

  const volumeAverage = average(
    candles.slice(-21, -1).map(c => c.volume)
  );

  const volumeRatio = volumeAverage > 0
    ? last.volume / volumeAverage
    : 0;

  const oiChange = prev.oi > 0
    ? ((last.oi - prev.oi) / prev.oi) * 100
    : null;

  const priceChange = last.close - prev.close;

  // BUY: exact EMA cross UP
  const buy = {
    emaCross: cross === 'UP' && ema9 > ema15,
    rsi: rsi > CONFIG.RSI_BUY,
    vwapCross:
      prev.close <= previousVWAP &&
      last.close > vwap,
    priceIncrease: priceChange > 0,
    volumeIncrease:
      volumeRatio >= CONFIG.VOLUME_MULTIPLIER,
    oiIncrease:
  item.marketType === 'INDEX'
    ? true
    : oiChange !== null && oiChange > 0,
    bullishCandle: last.close > last.open
  };

  // SELL: exact EMA cross DOWN
  const sell = {
    emaCross: cross === 'DOWN' && ema9 < ema15,
    rsi: rsi < CONFIG.RSI_SELL,
    vwapCross:
      prev.close >= previousVWAP &&
      last.close < vwap,
    priceDecrease: priceChange < 0,
    volumeIncrease:
      volumeRatio >= CONFIG.VOLUME_MULTIPLIER,
    oiIncrease:
  item.marketType === 'INDEX'
    ? true
    : oiChange !== null && oiChange > 0,
    bearishCandle: last.close < last.open
  };

  const buyCount =
    Object.values(buy).filter(Boolean).length;

  const sellCount =
    Object.values(sell).filter(Boolean).length;

  let signal = 'WAIT';

  if (buyCount === 7) {
    signal = 'VERY_STRONG_BUY';
  } else if (sellCount === 7) {
    signal = 'VERY_STRONG_SELL';
  }

  if (signal === 'WAIT') return null;

  const risk = atr * CONFIG.SL_ATR;

  const entry = last.close;

  return {
    symbol: item.symbol,
    marketType: item.marketType,
    instrumentKey: item.instrumentKey,
    underlyingKey: item.underlyingKey,

    signal,
    confirmation: '7/7',
    cross,

    entry,
    stopLoss: signal === 'VERY_STRONG_BUY'
      ? entry - risk
      : entry + risk,

    target1: signal === 'VERY_STRONG_BUY'
      ? entry + risk * CONFIG.TARGET1_RR
      : entry - risk * CONFIG.TARGET1_RR,

    target2: signal === 'VERY_STRONG_BUY'
      ? entry + risk * CONFIG.TARGET2_RR
      : entry - risk * CONFIG.TARGET2_RR,

    ema9,
    ema15,
    rsi,
    vwap,

    priceChange,
    volume: last.volume,
    volumeAverage,
    volumeRatio,

    oi: last.oi,
    oiChange,

    candleTime: last.time
  };
}

// ---------- OPTION STRIKE SELECTION ----------

async function selectStrike(signal) {
  const side = signal.signal === 'VERY_STRONG_BUY'
    ? 'CE' : 'PE';

  const contracts = state.options.filter(x =>
    x.underlying_key === signal.underlyingKey &&
    x.instrument_type === side &&
    expiryOf(x.expiry) >= istDate()
  );

  if (!contracts.length) return null;

  const expiry = contracts
    .map(x => expiryOf(x.expiry))
    .sort()[0];

  const response = await api(
    `/v2/option/chain?instrument_key=${
      encodeURIComponent(signal.underlyingKey)
    }&expiry_date=${expiry}`
  );

  const rows = response.data || [];

  const choices = rows.map(row => {
    const option = side === 'CE'
      ? row.call_options
      : row.put_options;

    if (!option) return null;

    const md = option.market_data || {};
    const greeks = option.option_greeks || {};

    const contract = contracts.find(x =>
      x.instrument_key === option.instrument_key
    );

    if (!contract) return null;

    const ltp = Number(md.ltp || 0);
    const bid = Number(md.bid_price || 0);
    const ask = Number(md.ask_price || 0);
    const delta = Number(greeks.delta || 0);
    const oi = Number(md.oi || 0);
    const volume = Number(md.volume || 0);

    if (
      ltp <= 0 || bid <= 0 || ask < bid ||
      oi <= 0 || volume <= 0
    ) return null;

    const spread = ((ask - bid) / bid) * 100;

    const deltaPass = side === 'CE'
      ? delta >= 0.50 && delta <= 0.80
      : delta <= -0.50 && delta >= -0.80;

    if (!deltaPass || spread > 8) return null;

    return {
      symbol: contract.trading_symbol,
      instrumentKey: contract.instrument_key,
      strike: contract.strike_price,
      expiry,
      side,
      lotSize: contract.lot_size,
      ltp,
      bid,
      ask,
      delta,
      oi,
      volume,
      spread
    };
  }).filter(Boolean);

  choices.sort((a, b) =>
    (b.volume - a.volume) ||
    (a.spread - b.spread)
  );

  return choices[0] || null;
}

// ---------- OPTION ENTRY / SL / TARGET ----------

function calculateOptionRisk(option) {
  if (!option || option.ltp <= 0) return null;

  const entry = option.ltp;
  const sl = entry * 0.80;
  const risk = entry - sl;

  return {
    optionEntry: entry,
    optionSL: sl,
    optionTarget1: entry + risk * 1.5,
    optionTarget2: entry + risk * 2.5
  };
}

// ---------- INDEX OPTIONS OI CONFIRMATION ----------

async function getIndexOptionOIChange(item) {
  const contracts = state.options.filter(x =>
    x.underlying_key === item.underlyingKey &&
    expiryOf(x.expiry) >= istDate()
  );

  if (!contracts.length) return null;

  const expiry = [...new Set(
    contracts.map(x => expiryOf(x.expiry))
  )].sort()[0];

  const response = await api(
    `/v2/option/chain?instrument_key=${encodeURIComponent(item.underlyingKey)}&expiry_date=${expiry}`
  );

  const rows = response.data || [];

  let ceOi = 0;
  let peOi = 0;

  for (const row of rows) {
    ceOi += Number(
      row.call_options?.market_data?.oi || 0
    );

    peOi += Number(
      row.put_options?.market_data?.oi || 0
    );
  }

  if (ceOi <= 0 || peOi <= 0) return null;

  const key = `${item.underlyingKey}_${expiry}`;
  const now = Date.now();
  const previous = state.lastIndexOi.get(key);

  if (!previous) {
    state.lastIndexOi.set(key, {
      ceOi,
      peOi,
      time: now
    });
    return null;
  }

  const ceOiChangePct = previous.ceOi > 0
    ? ((ceOi - previous.ceOi) / previous.ceOi) * 100
    : null;

  const peOiChangePct = previous.peOi > 0
    ? ((peOi - previous.peOi) / previous.peOi) * 100
    : null;

  // Update baseline only after 5 minutes
  if (now - previous.time >= 300000) {
    state.lastIndexOi.set(key, {
      ceOi,
      peOi,
      time: now
    });
  }

  return {
    ceOi,
    peOi,
    ceOiChangePct,
    peOiChangePct
  };
    }

// ---------- DUPLICATE PROTECTION ----------

function isNewSignal(signal) {
  const key = `${signal.symbol}_${signal.signal}`;
  const old = state.lastAlerts.get(key);

  if (old === signal.candleTime) return false;

  state.lastAlerts.set(key, signal.candleTime);
  return true;
}

// ---------- SCANNER ----------

async function scanAll() {
  if (state.running) {
    return { status: 'SCAN_ALREADY_RUNNING' };
  }

  state.running = true;
  state.errors = [];

  try {
    if (!state.stocks.length) {
      await loadInstruments();
    }

    const universe = [
      ...state.stocks.map(x => ({
        symbol: x.underlying_symbol,
        marketType: 'STOCK',
        instrumentKey: x.instrument_key,
        underlyingKey: x.underlying_key,
        source: x
      })),

      ...state.indexes.map(x => ({
        symbol: x.trading_symbol,
        marketType: 'INDEX',
        instrumentKey: x.instrument_key,
        underlyingKey: x.instrument_key,
        source: x
      }))
    ];

    const output = [];
    let cursor = 0;

    async function worker() {
      while (cursor < universe.length) {
        const item = universe[cursor++];

        try {
          const candles = await getCandles(
            item.instrumentKey
          );

          const result = analyseInstrument(item, candles);

          if (!result) continue;
// INDEX OPTIONS OI CONFIRMATION
if (item.marketType === 'INDEX') {
    const indexOI = await getIndexOptionOIChange(item);

    if (!indexOI) continue;

    result.indexOI = indexOI;

    const bullishOI =
        indexOI.peOiChangePct > 0 &&
        indexOI.ceOiChangePct < 0;

    const bearishOI =
        indexOI.ceOiChangePct > 0 &&
        indexOI.peOiChangePct < 0;

    if (
        result.signal === 'VERY_STRONG_BUY' &&
        !bullishOI
    ) continue;

    if (
        result.signal === 'VERY_STRONG_SELL' &&
        !bearishOI
    ) continue;
      }
          const option = await selectStrike(result);

          if (!option) {
            state.errors.push({
              symbol: item.symbol,
              message: 'No liquid option contract found'
            });
            continue;
          }

          result.option = option;
          result.optionRisk = calculateOptionRisk(option);

          if (isNewSignal(result)) {
            output.push(result);
          }

        } catch (error) {
          state.errors.push({
            symbol: item.symbol,
            message: error.message
          });
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: CONFIG.CONCURRENCY },
        () => worker()
      )
    );

    state.signals = [
      ...output,
      ...state.signals
    ].slice(0, 500);

    state.lastScan = new Date().toISOString();

    return {
      status: 'SUCCESS',
      version: CONFIG.VERSION,
      scanned: universe.length,
      buy: output.filter(
        x => x.signal === 'VERY_STRONG_BUY'
      ),
      sell: output.filter(
        x => x.signal === 'VERY_STRONG_SELL'
      ),
      errors: state.errors.slice(0, 30),
      lastScan: state.lastScan
    };

  } finally {
    state.running = false;
  }
}

// ---------- INDEX LIVE SPOT PRICES ----------

async function getIndexSpotPrices() {
  const keys = state.indexes
    .map(x => x.instrument_key)
    .filter(Boolean);

  if (!keys.length) return [];

  const response = await api(
    `/v3/market-quote/ltp?instrument_key=${
      encodeURIComponent(keys.join(','))
    }`
  );

  return Object.values(response.data || {}).map(q => ({
    instrumentKey: q.instrument_token,
    lastPrice: Number(q.last_price),
    change: Number(q.last_price) - Number(q.cp || 0)
  }));
}

// ---------- DASHBOARD API ----------
const DASHBOARD_ORIGIN = (
  process.env.DASHBOARD_ORIGIN || ''
).trim().replace(/\/+$/, '');
const server = http.createServer(async (req, res) => {
 const origin = req.headers.origin;

res.setHeader('Vary', 'Origin');

if (origin) {
  if (!DASHBOARD_ORIGIN || origin !== DASHBOARD_ORIGIN) {
    res.writeHead(403, {
      'Content-Type': 'application/json'
    });
    return res.end(JSON.stringify({
      error: 'CORS blocked: Origin not allowed'
    }));
  }

  res.setHeader('Access-Control-Allow-Origin', DASHBOARD_ORIGIN);
}

res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  function send(status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(data));
  }

  try {
    if (url.pathname === '/health') {
      return send(200, {
        status: 'OK',
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        stocks: state.stocks.length,
        indexes: state.indexes.length,
        running: state.running
      });
    }

    if (url.pathname === '/api/market/instruments') {
  let spotPrices = [];

  try {
    spotPrices = await getIndexSpotPrices();
  } catch (e) {
    console.error('SPOT PRICE ERROR:', e.message);
  }

  return send(200, {
    stocks: state.stocks.length,
    indexes: state.indexes,
    options: state.options.length,
    spotPrices
  });
    }

    if (url.pathname === '/api/market/scan') {
      return send(200, await scanAll());
    }

    if (url.pathname === '/api/market/signals') {
      const type = url.searchParams.get('type');

      const signals = state.signals.filter(x =>
        type === 'BUY'
          ? x.signal === 'VERY_STRONG_BUY'
          : type === 'SELL'
            ? x.signal === 'VERY_STRONG_SELL'
            : true
      );

      return send(200, {
        count: signals.length,
        signals
      });
    }

    if (url.pathname === '/api/market/status') {
      return send(200, {
        version: CONFIG.VERSION,
        running: state.running,
        stocks: state.stocks.length,
        indexes: state.indexes.length,
        signals: state.signals.length,
        lastScan: state.lastScan,
        errors: state.errors.slice(0, 20)
      });
    }

    return send(404, { error: 'Route not found' });

  } catch (error) {
    return send(500, { error: error.message });
  }
});
let lastScheduledScanSlot = '';

function startAutoScanner() {
  setInterval(() => {
    const now = new Date();

    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now);

    const p = Object.fromEntries(
      parts.map(x => [x.type, x.value])
    );

    const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
      .includes(p.weekday);

    const hour = Number(p.hour);
    const minute = Number(p.minute);

    const marketTime =
      (hour * 60 + minute) >= 560 &&
      (hour * 60 + minute) <= 930;

    if (
      !weekday ||
      !marketTime ||
      minute % 5 !== 0 ||
      state.running
    ) return;

    const slot = `${p.weekday}_${hour}_${minute}`;

    if (slot === lastScheduledScanSlot) return;

    lastScheduledScanSlot = slot;

    scanAll().then(result => {
      console.log('[AUTO SCAN]', result.status);
    }).catch(err => {
      console.error('[AUTO SCAN ERROR]', err.message);
    });

  }, 15000);

  console.log('AUTO 5 MIN SCANNER STARTED');
}
// ---------- START ----------

async function start() {
  try {
    if (TOKEN) {
      console.log(
        'INSTRUMENTS:',
        await loadInstruments()
      );
    } else {
      console.error('UPSTOX_ACCESS_TOKEN missing');
    }
  } catch (e) {
    console.error('STARTUP ERROR:', e.message);
  }

  server.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(CONFIG.VERSION, 'STARTED');
    console.log('EMA 9/15 CROSS ONLY');
    console.log('RSI 65 / 35');
    console.log('VWAP CROSS');
    console.log('OI + VOLUME + PRICE');
    console.log('ALL 7 CONDITIONS REQUIRED');
    startAutoScanner();
  });
}

start();
               
