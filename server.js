
'use strict';

const http = require('http');

const CONFIG = {
  VERSION: 'SMART_TRADE_INDIA_V11_EMA_ONLY',
  TIMEFRAME: 5,

  EMA_FAST: 9,
  EMA_SLOW: 15,

  VOLUME_PERIOD: 20,
  VOLUME_MULTIPLIER: 1.5,

  MIN_CONDITIONS: 5,
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

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

let apiQueue = Promise.resolve();
let nextApiTime = 0;

async function waitForApiSlot() {
  const slot = apiQueue.then(async () => {
    const wait = Math.max(
      0, nextApiTime - Date.now()
    );

    if (wait > 0) await sleep(wait);

    nextApiTime = Date.now() + 200;
  });

  apiQueue = slot.catch(() => {});
  await slot;
}

async function api(path) {
  if (!TOKEN) {
    throw new Error('UPSTOX_ACCESS_TOKEN missing');
  }

  for (let attempt = 0; attempt < 3; attempt++) {

    await waitForApiSlot();

    const response = await fetch(BASE + path, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(20000)
    });

    if (response.status === 429) {
      const retryAfter =
        response.headers.get('retry-after');

      const seconds = Number(retryAfter);

      const delay = retryAfter === null
        ? 2000 * (attempt + 1)
        : Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now();

      const wait = Math.max(
        2000,
        Number.isFinite(delay) ? delay : 2000
      );

      nextApiTime = Math.max(
        nextApiTime,
        Date.now() + wait
      );

      console.log('[API RATE LIMIT] RETRY');

      continue;
    }

    const data = await response.json();

    if (!response.ok || data.status === 'error') {
      throw new Error(JSON.stringify(data));
    }

    return data;
  }

  throw new Error('API RATE LIMIT RETRY FAILED');
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
  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

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

  // NSE F&O EQUITY FUTURES

  const futures = records.filter(x =>
    x.segment === 'NSE_FO' &&
    x.instrument_type === 'FUT' &&
    x.underlying_type === 'EQUITY' &&
    x.underlying_symbol &&
    x.instrument_key &&
    x.underlying_key &&
    x.expiry &&
    expiryOf(x.expiry) >= istDate()
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

  // ---------- INDEX SELECTION ----------

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

  // ---------- OPTION CONTRACTS ----------

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

// ---------- DAILY CANDLE DATA ----------

const dailyCandleCache = new Map();

async function getDailyCandles(instrumentKey) {

  const today = istDate();

  const cached = dailyCandleCache.get(instrumentKey);

  if (cached && cached.date === today) {
    return cached.candles;
  }

  const key = encodeURIComponent(instrumentKey);

  const from = istDate(
    new Date(Date.now() - 150 * 86400000)
  );

  const yesterday = istDate(
    new Date(Date.now() - 86400000)
  );

  const response = await api(
    `/v3/historical-candle/${key}/days/1/${yesterday}/${from}`
  );

  const candles = (response.data?.candles || [])
    .map(c => ({
      time: c[0],
      close: Number(c[4])
    }))
    .filter(c =>
      Number.isFinite(c.close) &&
      c.close > 0 &&
      istDate(new Date(c.time)) < today
    )
    .sort((a, b) =>
      new Date(a.time) - new Date(b.time)
    );

  if (candles.length >= 30) {

    dailyCandleCache.set(instrumentKey, {
      date: today,
      candles
    });

  }

  return candles;
}


// ---------- PART 2 START ----------

// ---------- INDEX FUTURE KEY ----------

function getIndexFutureKey(item) {
  const futures = state.instruments.filter(x =>
    ['NSE_FO', 'BSE_FO'].includes(x.segment) &&
    x.instrument_type === 'FUT' &&
    x.underlying_key === item.underlyingKey &&
    x.instrument_key &&
    expiryOf(x.expiry) >= istDate()
  );

  futures.sort((a, b) =>
    expiryOf(a.expiry).localeCompare(
      expiryOf(b.expiry)
    )
  );

  return futures[0]?.instrument_key || null;
}

// ---------- INDEX CANDLE DATA ----------

async function getIndexCandles(item) {
  const futureKey = getIndexFutureKey(item);

  if (!futureKey) {
    throw new Error('INDEX FUTURE NOT AVAILABLE');
  }

  const [spotCandles, futureCandles] =
    await Promise.all([
      getCandles(item.instrumentKey),
      getCandles(futureKey)
    ]);

  const futureMap = new Map(
    futureCandles.map(c => [
      new Date(c.time).getTime(),
      c
    ])
  );
  const lastSpot = spotCandles.at(-1);
  const lastFuture = futureCandles.at(-1);

  console.log('[INDEX DATA CHECK]', JSON.stringify({
    symbol: item.symbol,
    futureKey,
    spotCount: spotCandles.length,
    futureCount: futureCandles.length,
    spotTime: lastSpot?.time,
    futureTime: lastFuture?.time,
    volume: lastFuture?.volume,
    oi: lastFuture?.oi,
    matched: lastSpot
      ? futureMap.has(
          new Date(lastSpot.time).getTime()
        )
      : false
  }));
  
  return spotCandles.map(c => {
    const future = futureMap.get(
      new Date(c.time).getTime()
    );

    return {
      ...c,
      volume: future ? future.volume : null,
      oi: future ? future.oi : null
    };
  });
}

// ---------- EMA ----------

function EMA(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result =
    values.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * k + result * (1 - k);
  }

  return result;
}

// ---------- AVERAGE ----------

function average(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0)
      / values.length
    : 0;
}

// ---------- ATR ----------

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

// ---------- EXACT EMA 9/15 CROSS ----------

function detectEMACross(closes) {
  if (closes.length < 30) {
    return 'NONE';
  }

  const previousCloses = closes.slice(0, -1);

  const currentFast = EMA(
    closes,
    CONFIG.EMA_FAST
  );

  const currentSlow = EMA(
    closes,
    CONFIG.EMA_SLOW
  );

  const previousFast = EMA(
    previousCloses,
    CONFIG.EMA_FAST
  );

  const previousSlow = EMA(
    previousCloses,
    CONFIG.EMA_SLOW
  );

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

// ---------- SIGNAL ENGINE ----------


function analyseInstrument(item, candles, dailyCandles = []) {
  
  if (!candles || candles.length < 30) {
    return null;
  }

  const closes = candles.map(c => c.close);

  if (!closes.every(Number.isFinite)) {
    return null;
  }

  const last = candles.at(-1);
  const prev = candles.at(-2);

  // TODAY COMPLETED CANDLES ONLY

  if (
    istDate(new Date(last.time)) !== istDate() ||
    istDate(new Date(prev.time)) !== istDate()
  ) {
    return null;
  }

  const candleEnd =
    new Date(last.time).getTime() + 300000;

  const candleAge = Date.now() - candleEnd;

  if (candleAge < 0 || candleAge >= 300000) {
    return null;
  }

  if (
    new Date(last.time).getTime() -
    new Date(prev.time).getTime() !== 300000
  ) {
    return null;
  }

  // EXACT EMA CROSS


const isStock = item.marketType === 'STOCK';

if (isStock) {
  if (dailyCandles.length < 30) return null;

  const previousSession = candles
    .filter(c =>
      istDate(new Date(c.time)) < istDate()
    ).at(-1);

  if (
    !previousSession ||
    istDate(new Date(dailyCandles.at(-1).time)) !==
    istDate(new Date(previousSession.time))
  ) {
    return null;
  }
}

const emaCloses = isStock
  ? dailyCandles.map(c => c.close)
  : closes;

const cross = detectEMACross(emaCloses);

if (cross === 'NONE') return null;

const ema9 = EMA(
  emaCloses,
  CONFIG.EMA_FAST
);

const ema15 = EMA(
  emaCloses,
  CONFIG.EMA_SLOW
);
  

  const atr = ATR(
    candles,
    CONFIG.ATR_PERIOD
  );

  if (
    [ema9, ema15, atr].some(
      x => x === null || !Number.isFinite(x)
    ) ||
    atr <= 0
  ) {
    return null;
  }

  // VOLUME CONFIRMATION

  const volumeHistory = candles
    .slice(-(CONFIG.VOLUME_PERIOD + 1), -1)
    .map(c => c.volume);

  if (
    volumeHistory.length !== CONFIG.VOLUME_PERIOD ||
    !volumeHistory.every(
      x => Number.isFinite(x) && x >= 0
    ) ||
    !Number.isFinite(last.volume) ||
    !Number.isFinite(prev.volume) ||
    last.volume <= 0
  ) {
    return null;
  }

  const volumeAverage = average(volumeHistory);

  if (volumeAverage <= 0) return null;

  const volumeRatio =
    last.volume / volumeAverage;

  const volumeIncrease =
    last.volume > prev.volume &&
    volumeRatio >= CONFIG.VOLUME_MULTIPLIER;

  // REAL OI CHANGE

  if (
    !Number.isFinite(last.oi) ||
    !Number.isFinite(prev.oi) ||
    last.oi <= 0 ||
    prev.oi <= 0
  ) {
    return null;
  }

  const oiChangeValue =
    last.oi - prev.oi;

  const oiChange =
    (oiChangeValue / prev.oi) * 100;

  const oiIncrease =
    oiChangeValue > 0;

  // PRICE CHANGE

  const priceChange =
    last.close - prev.close;

  const priceChangePct =
    prev.close > 0
      ? (priceChange / prev.close) * 100
      : null;

  // ---------- BUY CONDITIONS ----------

  const buy = {
    emaCross:
      cross === 'UP' && ema9 > ema15,

    priceIncrease:
      priceChange > 0,

    volumeIncrease:
      volumeIncrease,

    oiIncrease:
      oiIncrease,

    bullishCandle:
      last.close > last.open
  };

  // ---------- SELL CONDITIONS ----------

  const sell = {
    emaCross:
      cross === 'DOWN' && ema9 < ema15,

    priceDecrease:
      priceChange < 0,

    volumeIncrease:
      volumeIncrease,

    oiIncrease:
      oiIncrease,

    bearishCandle:
      last.close < last.open
  };

  const buyCount =
    Object.values(buy).filter(Boolean).length;

  const sellCount =
    Object.values(sell).filter(Boolean).length;

  let signal = 'WAIT';

  if (buyCount === CONFIG.MIN_CONDITIONS) {
    signal = 'VERY_STRONG_BUY';
  } else if (
    sellCount === CONFIG.MIN_CONDITIONS
  ) {
    signal = 'VERY_STRONG_SELL';
  }

  if (signal === 'WAIT') return null;

  // ---------- ENTRY / SL / TARGET ----------

  const risk = atr * CONFIG.SL_ATR;

  const entry = last.close;

  const isBuy =
    signal === 'VERY_STRONG_BUY';

  return {
    symbol: item.symbol,
    marketType: item.marketType,
    instrumentKey: item.instrumentKey,
    underlyingKey: item.underlyingKey,

    signal,
    confirmation: '5/5',
    cross,

    conditions: isBuy ? buy : sell,

    entry,

    stopLoss: isBuy
      ? entry - risk
      : entry + risk,

    target1: isBuy
      ? entry + risk * CONFIG.TARGET1_RR
      : entry - risk * CONFIG.TARGET1_RR,

    target2: isBuy
      ? entry + risk * CONFIG.TARGET2_RR
      : entry - risk * CONFIG.TARGET2_RR,

    ema9,
    ema15,

    priceChange,
    priceChangePct,

    volume: last.volume,
    previousVolume: prev.volume,
    volumeAverage,
    volumeRatio,

    oi: last.oi,
    previousOI: prev.oi,
    oiChange,
    oiChangeValue,

    oiSource: item.marketType === 'INDEX'
      ? 'INDEX_FUTURES'
      : 'STOCK_FUTURES',

    volumeSource: item.marketType === 'INDEX'
      ? 'INDEX_FUTURES'
      : 'STOCK_FUTURES',

    candleTime: last.time,
    timeframe: isStock ? '1D' : '5min',
confirmationTimeframe: '5min',
    dataSource: 'UPSTOX',
    candleClosed: true
  };
}


// ---------- PART 3 START ----------

// ---------- OPTION STRIKE SELECTION ----------

async function selectStrike(signal) {
  const side =
    signal.signal === 'VERY_STRONG_BUY'
      ? 'CE'
      : 'PE';

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
      ![ltp, bid, ask, delta, oi, volume]
        .every(Number.isFinite) ||
      ltp <= 0 ||
      bid <= 0 ||
      ask < bid ||
      oi <= 0 ||
      volume <= 0
    ) {
      return null;
    }

    const spread =
      ((ask - bid) / bid) * 100;

    const deltaPass = side === 'CE'
      ? delta >= 0.50 && delta <= 0.80
      : delta <= -0.50 && delta >= -0.80;

    if (!deltaPass || spread > 8) {
      return null;
    }

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

  const maxVolume = Math.max(
    ...choices.map(x => x.volume),
    1
  );

  const maxOI = Math.max(
    ...choices.map(x => x.oi),
    1
  );

  choices.sort((a, b) => {
    const score = x =>
      (x.volume / maxVolume) * 40 +
      (x.oi / maxOI) * 30 +
      (1 - Math.min(
        Math.abs(Math.abs(x.delta) - 0.65)
        / 0.15,
        1
      )) * 20 +
      (1 - Math.min(
        x.spread / 8,
        1
      )) * 10;

    return score(b) - score(a);
  });

  return choices[0] || null;
}

// ---------- OPTION ENTRY / SL / TARGET ----------

function calculateOptionRisk(option) {
  if (
    !option ||
    !Number.isFinite(option.ltp) ||
    option.ltp <= 0
  ) {
    return null;
  }

  const entry = option.ltp;

  const sl = entry * 0.80;

  const risk = entry - sl;

  return {
    optionEntry: entry,
    optionSL: sl,

    optionTarget1:
      entry + risk * CONFIG.TARGET1_RR,

    optionTarget2:
      entry + risk * CONFIG.TARGET2_RR,

    riskPerUnit: risk,

    riskPerLot:
      risk * Number(option.lotSize || 0)
  };
}

// ---------- DUPLICATE PROTECTION ----------

function getSignalTime(signal) {
  return signal.marketType === 'STOCK'
    ? istDate(new Date(signal.candleTime))
    : signal.candleTime;
}

function isNewSignal(signal) {
  const key =
    `${signal.symbol}_${signal.signal}`;

  const signalTime = getSignalTime(signal);

  const old = state.lastAlerts.get(key);

  if (old === signalTime) {
    return false;
  }

  state.lastAlerts.set(key, signalTime);

  return true;
}

// ---------- LIVE ALERT ----------

function createLiveAlert(result) {
  const option = result.option;
  const risk = result.optionRisk;

  return {
    title: 'SMART TRADE INDIA LIVE ALERT',

    symbol: result.symbol,

    marketType: result.marketType,

    signal: result.signal,

    action: option.side === 'CE'
      ? 'BUY CE'
      : 'BUY PE',

    confirmation: result.confirmation,

    ema9: result.ema9,
    ema15: result.ema15,

    cross: result.cross,

    priceChange: result.priceChange,

    volume: result.volume,
    volumeRatio: result.volumeRatio,

    oi: result.oi,
    oiChange: result.oiChange,
    oiChangeValue: result.oiChangeValue,

    strike: option.strike,

    optionSymbol: option.symbol,

    optionInstrumentKey:
      option.instrumentKey,

    expiry: option.expiry,

    lotSize: option.lotSize,

    entry: risk.optionEntry,

    stopLoss: risk.optionSL,

    target1: risk.optionTarget1,

    target2: risk.optionTarget2,

    riskPerLot: risk.riskPerLot,

    timeframe: result.timeframe,
confirmationTimeframe: '5min',

    candleTime: result.candleTime,

    alertTime: new Date().toISOString(),

    dataSource: 'UPSTOX'
  };
}

// ---------- MAIN LIVE SCANNER ----------

async function scanAll() {
  if (state.running) {
    return {
      status: 'SCAN_ALREADY_RUNNING'
    };
  }

  state.running = true;
  state.errors = [];

  try {
    if (
      !state.stocks.length ||
      !state.indexes.length
    ) {
      await loadInstruments();
    }

    // ---------- ALL INDEX + NSE F&O ----------

    const universe = [

      ...state.indexes.map(x => ({
        symbol: x.trading_symbol,
        marketType: 'INDEX',
        instrumentKey: x.instrument_key,
        underlyingKey: x.instrument_key,
        source: x
      })),

      ...state.stocks.map(x => ({
        symbol: x.underlying_symbol,
        marketType: 'STOCK',
        instrumentKey: x.instrument_key,
        underlyingKey: x.underlying_key,
        source: x
      }))

    ];

    const output = [];

    let cursor = 0;

    async function worker() {
      while (cursor < universe.length) {

        const item = universe[cursor++];

        try {

          // INDEX SPOT + FUTURES DATA

          const candles =
            item.marketType === 'INDEX'
              ? await getIndexCandles(item)
              : await getCandles(
                  item.instrumentKey
                );

          // EMA + OI + VOLUME + PRICE

          const dailyCandles =
  item.marketType === 'STOCK'
    ? await getDailyCandles(item.underlyingKey)
    : [];

const result = analyseInstrument(
  item,
  candles,
  dailyCandles
);

         
if (!result) {
  if (item.marketType === 'INDEX') {
    const last = candles.at(-1);
    const prev = candles.at(-2);

    console.log('[INDEX DEBUG]', JSON.stringify({
      symbol: item.symbol,
      futureKey: getIndexFutureKey(item),
      candleCount: candles.length,
      emaCross: detectEMACross(
        candles.map(c => c.close)
      ),
      price: last?.close,
      previousPrice: prev?.close,
      volume: last?.volume,
      previousVolume: prev?.volume,
      volumeRatio: last?.volume /
        average(candles.slice(-21, -1)
          .map(c => c.volume)),
      oi: last?.oi,
      previousOI: prev?.oi,
      candleTime: last?.time
    }));
  }
  continue;
}
          

          // DUPLICATE CHECK

          const alertKey =
            `${result.symbol}_${result.signal}`;

          if (
  state.lastAlerts.get(alertKey) ===
  getSignalTime(result)
) {
  continue;
            }

          // AUTOMATIC CE / PE STRIKE

          const option = await selectStrike(
            result
          );

          if (!option) {
            state.errors.push({
              symbol: item.symbol,
              message:
                'No liquid option contract found'
            });

            continue;
          }

          result.option = option;

          result.optionRisk =
            calculateOptionRisk(option);

          if (!result.optionRisk) {
            continue;
          }

          // RECHECK SIGNAL FRESHNESS

          const candleEnd =
            new Date(result.candleTime)
              .getTime() + 300000;

          const age = Date.now() - candleEnd;

          if (age < 0 || age >= 300000) {
            continue;
          }

          // LIVE ALERT

          if (isNewSignal(result)) {

            result.alert =
              createLiveAlert(result);

            output.push(result);

            console.log(
              '[LIVE SIGNAL]',
              JSON.stringify(result.alert)
            );
          }

        } catch (error) {

          state.errors.push({
            symbol: item.symbol,
            message: error.message
          });

          console.error(
            '[SCAN ERROR]',
            item.symbol,
            error.message
          );
        }
      }
    }

    // ---------- PARALLEL SCANNER ----------

    await Promise.all(
      Array.from(
        { length: CONFIG.CONCURRENCY },
        () => worker()
      )
    );

    // ---------- SAVE SIGNAL HISTORY ----------

    state.signals = [
      ...output,
      ...state.signals
    ].slice(0, 500);

    state.lastScan =
      new Date().toISOString();

    const buy = output.filter(
      x => x.signal === 'VERY_STRONG_BUY'
    );

    const sell = output.filter(
      x => x.signal === 'VERY_STRONG_SELL'
    );

    console.log(
      '[SCAN COMPLETE]',
      'Scanned:', universe.length,
      'BUY:', buy.length,
      'SELL:', sell.length,
      'Errors:', state.errors.length
    );

    return {
      status: 'SUCCESS',

      version: CONFIG.VERSION,

      scanned: universe.length,

      buy,
      sell,

      alerts: output.map(x => x.alert),

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

  return Object.entries(
    response.data || {}
  ).map(([key, q]) => ({

    instrumentKey:
      q.instrument_token || key,

    lastPrice: Number(q.last_price),

    change: q.cp != null
      ? Number(q.last_price) - Number(q.cp)
      : null

  }));
}


// ---------- PART 4 START ----------

// ---------- DASHBOARD SECURITY ----------

const DASHBOARD_ORIGIN = (
  process.env.DASHBOARD_ORIGIN || ''
).trim().replace(/\/+$/, '');

// ---------- HTTP SERVER ----------

const server = http.createServer(
  async (req, res) => {

    const origin = req.headers.origin;

    res.setHeader('Vary', 'Origin');

    if (origin) {

      if (
        !DASHBOARD_ORIGIN ||
        origin !== DASHBOARD_ORIGIN
      ) {

        res.writeHead(403, {
          'Content-Type': 'application/json'
        });

        return res.end(JSON.stringify({
          error: 'CORS blocked: Origin not allowed'
        }));
      }

      res.setHeader(
        'Access-Control-Allow-Origin',
        DASHBOARD_ORIGIN
      );
    }

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept'
    );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(
      req.url,
      'http://localhost'
    );

    function send(status, data) {
      res.writeHead(status, {
        'Content-Type': 'application/json'
      });

      res.end(JSON.stringify(data));
    }

    try {

      // ---------- HOME ----------

      if (url.pathname === '/') {

        return send(200, {
          status: 'ONLINE',
          version: CONFIG.VERSION,
          dataSource: 'UPSTOX',
          timeframe: '5min',

          strategy:
            'EMA 9/15 + OI + VOLUME + PRICE',

          confirmation: '5/5',

          endpoints: [
            '/health',
            '/api/market/instruments',
            '/api/market/scan',
            '/api/market/signals',
            '/api/market/alerts',
            '/api/market/status'
          ]
        });
      }

      // ---------- HEALTH ----------

      if (url.pathname === '/health') {

        return send(200, {

          status: 'OK',

          version: CONFIG.VERSION,

          tokenConfigured: Boolean(TOKEN),

          stocks: state.stocks.length,

          indexes: state.indexes.length,

          options: state.options.length,

          running: state.running,

          lastScan: state.lastScan,

          strategy: {
            emaFast: CONFIG.EMA_FAST,
            emaSlow: CONFIG.EMA_SLOW,
            volumeMultiplier:
              CONFIG.VOLUME_MULTIPLIER,
            confirmation: '5/5',
            timeframe: '5min'
          }
        });
      }

      // ---------- MARKET INSTRUMENTS ----------

      if (
        url.pathname ===
        '/api/market/instruments'
      ) {

        let spotPrices = [];

        try {

          spotPrices =
            await getIndexSpotPrices();

        } catch (error) {

          console.error(
            'SPOT PRICE ERROR:',
            error.message
          );
        }

        return send(200, {

          stocks: state.stocks.length,

          indexes: state.indexes,

          options: state.options.length,

          spotPrices

        });
      }

      // ---------- MANUAL LIVE SCAN ----------

      if (
        url.pathname === '/api/market/scan'
      ) {

        return send(
          200,
          await scanAll()
        );
      }

      // ---------- LIVE SIGNALS ----------

      if (
        url.pathname === '/api/market/signals'
      ) {

        const type = url.searchParams
          .get('type')?.toUpperCase();

        const signals = state.signals.filter(x =>
          type === 'BUY'
            ? x.signal === 'VERY_STRONG_BUY'
            : type === 'SELL'
              ? x.signal === 'VERY_STRONG_SELL'
              : true
        );

        return send(200, {

          status: 'SUCCESS',

          count: signals.length,

          lastScan: state.lastScan,

          signals

        });
      }

      // ---------- LIVE ALERTS ----------

      if (
        url.pathname === '/api/market/alerts'
      ) {

        const alerts = state.signals
          .map(x => x.alert)
          .filter(Boolean);

        return send(200, {

          status: 'SUCCESS',

          count: alerts.length,

          alerts

        });
      }

      // ---------- SCANNER STATUS ----------

      if (
        url.pathname === '/api/market/status'
      ) {

        return send(200, {

          status: 'SUCCESS',

          version: CONFIG.VERSION,

          running: state.running,

          stocks: state.stocks.length,

          indexes: state.indexes.length,

          options: state.options.length,

          signals: state.signals.length,

          lastScan: state.lastScan,

          errors: state.errors.slice(0, 30),

          settings: {

            emaFast: 9,

            emaSlow: 15,

            oiIncrease: true,

            volumeIncrease: true,

            priceConfirmation: true,

            volumeMultiplier:
              CONFIG.VOLUME_MULTIPLIER,

            confirmation: '5/5',

           indexTimeframe: '5min',
stockTimeframe: '1D',
confirmationTimeframe: '5min',

            rsiEnabled: false,

            vwapEnabled: false,

            autoScanner: true,

            dataSource: 'UPSTOX'

          }
        });
      }

      return send(404, {
        error: 'Route not found'
      });

    } catch (error) {

      console.error(
        '[SERVER ERROR]',
        error.message
      );

      return send(500, {
        error: error.message
      });
    }
  }
);

// ---------- AUTO 5 MINUTE SCANNER ----------

let lastScheduledScanSlot = '';

function startAutoScanner() {

  setInterval(() => {

    const now = new Date();

    const parts = new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }
    ).formatToParts(now);

    const p = Object.fromEntries(
      parts.map(x => [
        x.type,
        x.value
      ])
    );

    const weekday = [
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri'
    ].includes(p.weekday);

    const hour = Number(p.hour);
    const minute = Number(p.minute);
    const second = Number(p.second);

    const totalMinutes =
      hour * 60 + minute;

    // FIRST SCAN 09:20
    // LAST SCAN 15:30

    const marketTime =
      totalMinutes >= 560 &&
      totalMinutes <= 930;

    if (
      !TOKEN ||
      !weekday ||
      !marketTime ||
      minute % 5 !== 0 ||
      second < 10 ||
      state.running
    ) {
      return;
    }

    const slot =
      `${istDate(now)}_${hour}_${minute}`;

    if (
      slot === lastScheduledScanSlot
    ) {
      return;
    }

    lastScheduledScanSlot = slot;

    console.log(
      '[AUTO SCAN START]',
      slot
    );

    scanAll().then(result => {

      console.log(
        '[AUTO SCAN]',
        result.status
      );

      console.log(
        '[AUTO SCAN RESULT]',
        JSON.stringify({
          scanned: result.scanned,
          buy: result.buy?.length || 0,
          sell: result.sell?.length || 0,
          alerts: result.alerts?.length || 0
        })
      );

    }).catch(error => {

      console.error(
        '[AUTO SCAN ERROR]',
        error.message
      );

    });

  }, 10000);

  console.log(
    'AUTO 5 MIN SCANNER STARTED'
  );
}

// ---------- SERVER START ----------

async function start() {

  try {

    if (TOKEN) {

      const instruments =
        await loadInstruments();

      console.log(
        'INSTRUMENTS:',
        instruments
      );

    } else {

      console.error(
        'UPSTOX_ACCESS_TOKEN missing'
      );
    }

  } catch (error) {

    console.error(
      'STARTUP ERROR:',
      error.message
    );
  }

  server.listen(
    CONFIG.PORT,
    '0.0.0.0',
    () => {

      console.log(
        CONFIG.VERSION,
        'STARTED'
      );

      console.log(
        'PORT:', CONFIG.PORT
      );

      console.log(
        'EMA 9/15 EXACT CROSS ONLY'
      );

      console.log(
        'OI INCREASE REQUIRED'
      );

      console.log(
        'VOLUME INCREASE 1.5X'
      );

      console.log(
        'PRICE INCREASE / DECREASE'
      );

      console.log(
        'ALL 5 CONDITIONS REQUIRED'
      );

      console.log('RSI DISABLED');

      console.log('VWAP DISABLED');

      console.log(
        'NIFTY BANKNIFTY FINNIFTY SENSEX'
      );

      console.log(
        'ALL NSE F&O STOCKS'
      );

      console.log(
        'LIVE UPSTOX DATA ONLY'
      );

      console.log(
        'LIVE ALERTS ENABLED'
      );

      startAutoScanner();
    }
  );
}

start();

             
