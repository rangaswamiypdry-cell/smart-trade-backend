'use strict';

const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = 'https://api.upstox.com';

const optionSnapshots = new Map();
const stockSnapshots = new Map();
const lastSignals = new Map();

const INDEXES = [
  { name: 'NIFTY', key: 'NSE_INDEX|Nifty 50' },
  { name: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank' },
  { name: 'SENSEX', key: 'BSE_INDEX|SENSEX' },
  { name: 'FINNIFTY', key: 'NSE_INDEX|Nifty Fin Service' },
  { name: 'MIDCPNIFTY', key: 'NSE_INDEX|Nifty Midcap 50' }
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;

  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8'
  });

  res.end(JSON.stringify(data));
}

async function upstoxRequest(apiUrl) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error('UPSTOX_ACCESS_TOKEN_MISSING');
  }

  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Upstox non-JSON response HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `Upstox HTTP ${response.status}`
    );
  }

  return data;
}

function number(value, fallback = 0) {
  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : fallback;
}

function extractPrice(quote) {
  return number(
    quote?.last_price ??
    quote?.ltp ??
    quote?.last_traded_price
  );
}

function extractVolume(quote) {
  return number(
    quote?.volume ??
    quote?.volume_traded ??
    quote?.volumeTraded ??
    quote?.total_traded_quantity ??
    quote?.total_volume
  );
}

function extractOI(quote) {
  return number(
    quote?.oi ??
    quote?.open_interest
  );
}

function extractQuote(response, instrumentKey) {
  const data = response?.data || {};

  return data[instrumentKey] ||
    data[Object.keys(data)[0]] ||
    null;
}

function extractCandles(response) {
  return response?.data?.candles || [];
}

function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) ||
      closes.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    averageGain =
      (averageGain * (period - 1) +
       Math.max(change, 0)) / period;

    averageLoss =
      (averageLoss * (period - 1) +
       Math.max(-change, 0)) / period;
  }

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  return Number(
    (100 - 100 / (1 + averageGain / averageLoss))
      .toFixed(2)
  );
}

function getCompletedCandles(candles) {
  const now = Date.now();
  const interval = 5 * 60 * 1000;

  return (Array.isArray(candles) ? candles : [])
    .filter(c =>
      Array.isArray(c) &&
      Number.isFinite(new Date(c[0]).getTime()) &&
      [1, 2, 3, 4, 5].every(
        i => Number.isFinite(Number(c[i]))
      ) &&
      new Date(c[0]).getTime() + interval <= now
    )
    .sort(
      (a, b) =>
        new Date(a[0]).getTime() -
        new Date(b[0]).getTime()
    );
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}function analyseCandles(candles) {
  const rows = getCompletedCandles(candles);

  if (rows.length < 21) {
    return {
      ready: false,
      direction: 'WAIT',
      reason: 'NEED_21_COMPLETED_CANDLES',
      completedCandles: rows.length
    };
  }

  const closes = rows.map(c => Number(c[4]));
  const volumes = rows.map(c => Number(c[5]));

  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];

  const open = Number(latest[1]);
  const high = Number(latest[2]);
  const low = Number(latest[3]);
  const close = Number(latest[4]);
  const currentVolume = Number(latest[5]);

  const previousClose = Number(previous[4]);

  const averageVolume =
    volumes.slice(-21, -1)
      .reduce((sum, value) => sum + value, 0) / 20;

  const ema20 = calculateEMA(closes, 20);
  const rsi14 = calculateRSI(closes, 14);

  let totalPV = 0;
  let totalVolume = 0;

  // Intraday VWAP: reset at the date boundary.
  const latestDate = new Date(latest[0]).toDateString();

  const todayRows = rows.filter(
    c => new Date(c[0]).toDateString() === latestDate
  );

  for (const c of todayRows) {
    const v = Number(c[5]);

    const typicalPrice =
      (Number(c[2]) + Number(c[3]) + Number(c[4])) / 3;

    totalPV += typicalPrice * v;
    totalVolume += v;
  }

  const vwap = totalVolume > 0
    ? totalPV / totalVolume
    : null;

  const previousRows = rows.slice(-21, -1);

  const resistance = Math.max(
    ...previousRows.map(c => Number(c[2]))
  );

  const support = Math.min(
    ...previousRows.map(c => Number(c[3]))
  );

  const volumePass =
    averageVolume > 0 &&
    currentVolume >= averageVolume * 1.5;

  const validIndicators =
    vwap !== null &&
    ema20 !== null &&
    rsi14 !== null &&
    currentVolume > 0 &&
    averageVolume > 0;

  if (!validIndicators) {
    return {
      ready: false,
      direction: 'WAIT',
      reason: 'VWAP_OR_VOLUME_DATA_UNAVAILABLE',
      close,
      rsi14,
      vwap,
      currentVolume,
      averageVolume
    };
  }

  const bullish =
    close > open &&
    close > previousClose &&
    close > ema20 &&
    close > vwap &&
    close > resistance &&
    rsi14 >= 65 &&
    volumePass;

  const bearish =
    close < open &&
    close < previousClose &&
    close < ema20 &&
    close < vwap &&
    close < support &&
    rsi14 <= 35 &&
    volumePass;

  const direction = bullish
    ? 'CALL'
    : bearish
      ? 'PUT'
      : 'WAIT';

  return {
    ready: true,
    close,
    open,
    previousClose,
    rsi14,
    ema20: Number(ema20.toFixed(2)),
    vwap: Number(vwap.toFixed(2)),
    currentVolume,
    averageVolume: Number(averageVolume.toFixed(2)),
    volumePass,
    resistance,
    support,
    bullish,
    bearish,
    direction,
    candleTime: latest[0]
  };
}

async function getMarketQuote(instrumentKey) {
  const url = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  url.searchParams.set(
    'instrument_key',
    instrumentKey
  );

  return upstoxRequest(url.toString());
}

async function getIntradayCandles(instrumentKey) {
  const url =
    `${UPSTOX_BASE}/v3/historical-candle/intraday/` +
    `${encodeURIComponent(instrumentKey)}/minutes/5`;

  return upstoxRequest(url);
}

async function getOptionContracts(instrumentKey) {
  const url = new URL(
    `${UPSTOX_BASE}/v2/option/contract`
  );

  url.searchParams.set(
    'instrument_key',
    instrumentKey
  );

  return upstoxRequest(url.toString());
}

function getNearestExpiry(contracts) {
  const today = new Date().toISOString().slice(0, 10);

  return contracts
    .map(c => c.expiry)
    .filter(Boolean)
    .sort()
    .find(date => date >= today) || null;
}

function getOptionType(contract) {
  const type = String(
    contract.instrument_type || ''
  ).toUpperCase();

  if (type === 'CE' || type === 'CALL') return 'CALL';
  if (type === 'PE' || type === 'PUT') return 'PUT';

  return '';
}

function calculateOptionMomentum(
  contract,
  quote,
  previous,
  direction
) {
  const p = extractPrice(quote);
  const v = extractVolume(quote);
  const oi = extractOI(quote);

  const valid = p > 0 && v > 0 && oi > 0;

  const conditions = {
    priceUp: !!previous && p > previous.price,
    volumeUp: !!previous && v > previous.volume,
    oiUp: !!previous && oi > previous.oi
  };

  const score =
    Object.values(conditions).filter(Boolean).length * 100 / 3;

  const confirmed =
    valid &&
    direction !== 'WAIT' &&
    getOptionType(contract) === direction &&
    Object.values(conditions).every(Boolean);

  return {
    symbol: contract.trading_symbol,
    instrument_key: contract.instrument_key,
    strike: number(contract.strike_price),
    expiry: contract.expiry,
    optionType: getOptionType(contract),
    price: p,
    volume: v,
    oi,
    conditions,
    score: Math.round(score),
    signal: confirmed ? direction : 'WAIT',
    gammaBlast: false,
    gammaNote:
      'Actual Gamma is not confirmed without valid Gamma Greeks'
  };
    }async function scanIndexOptions(url) {
  const requested = (
    url.searchParams.get('indexes') ||
    INDEXES.map(x => x.name).join(',')
  )
    .split(',')
    .map(x => x.trim().toUpperCase());

  const results = [];

  for (const index of INDEXES.filter(
    x => requested.includes(x.name)
  )) {
    try {
      const quoteResponse =
        await getMarketQuote(index.key);

      const spotQuote = extractQuote(
        quoteResponse,
        index.key
      );

      const spot = extractPrice(spotQuote);

      const candleResponse =
        await getIntradayCandles(index.key);

      const trend = analyseCandles(
        extractCandles(candleResponse)
      );

      if (!trend.ready || trend.direction === 'WAIT') {
        results.push({
          index: index.name,
          spot,
          trend,
          signal: 'WAIT',
          reason: trend.reason ||
            'Market direction not confirmed'
        });

        continue;
      }

      const contractsResponse =
        await getOptionContracts(index.key);

      const contracts = contractsResponse?.data || [];

      const expiry =
        url.searchParams.get('expiry') ||
        getNearestExpiry(contracts);

      const filtered = contracts
        .filter(c => !expiry || c.expiry === expiry)
        .filter(c => getOptionType(c) === trend.direction)
        .filter(c => c.instrument_key)
        .sort(
          (a, b) =>
            Math.abs(number(a.strike_price) - spot) -
            Math.abs(number(b.strike_price) - spot)
        )
        .slice(0, 10);

      const candidates = [];

      for (const contract of filtered) {
        try {
          const response =
            await getMarketQuote(contract.instrument_key);

          const quote = extractQuote(
            response,
            contract.instrument_key
          );

          if (!quote) continue;

          const key = contract.instrument_key;
          const previous = optionSnapshots.get(key);

          const signal = calculateOptionMomentum(
            contract,
            quote,
            previous,
            trend.direction
          );

          candidates.push(signal);

          optionSnapshots.set(key, {
            price: extractPrice(quote),
            volume: extractVolume(quote),
            oi: extractOI(quote),
            time: Date.now()
          });
        } catch (error) {
          candidates.push({
            symbol: contract.trading_symbol,
            signal: 'WAIT',
            error: error.message
          });
        }
      }

      candidates.sort(
        (a, b) => b.score - a.score
      );

      const bestStrike = candidates.find(
        c => c.signal === trend.direction &&
             c.score >= 75
      ) || null;

      const dedupeKey = `${index.name}:${trend.direction}`;

      const previousSignal = lastSignals.get(dedupeKey);

      const alert = bestStrike
        ? `${trend.direction}_STRONG`
        : 'WAIT';

      lastSignals.set(dedupeKey, {
        signal: alert,
        strike: bestStrike?.strike || null,
        time: Date.now()
      });

      results.push({
        index: index.name,
        spot,
        expiry,
        trend,
        marketDirection: trend.direction,
        optionsScanned: candidates.length,
        bestStrike,
        candidates,
        alert
      });
    } catch (error) {
      results.push({
        index: index.name,
        signal: 'WAIT',
        error: error.message
      });
    }
  }

  return {
    success: true,
    scanner: 'STRONG_CALL_PUT_SCANNER',
    threshold: 75,
    timestamp: new Date().toISOString(),
    results
  };
}

async function getNseStockFutures() {
  const response = await fetch(
    'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
  );

  if (!response.ok) {
    throw new Error(
      `NSE instruments HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const instruments = JSON.parse(
    zlib.gunzipSync(buffer).toString('utf8')
  );

  const today = new Date().toISOString().slice(0, 10);

  const valid = instruments.filter(c =>
    c.segment === 'NSE_FO' &&
    c.instrument_type === 'FUT' &&
    c.underlying_type === 'EQUITY' &&
    c.underlying_key &&
    c.instrument_key &&
    c.expiry >= today
  );

  const map = new Map();

  for (const contract of valid) {
    const symbol = contract.underlying_symbol;
    const old = map.get(symbol);

    if (!old || contract.expiry < old.expiry) {
      map.set(symbol, contract);
    }
  }

  return [...map.values()];
}

async function scanLongBuildUp() {
  const contracts = await getNseStockFutures();
  const results = [];

  for (const contract of contracts) {
    try {
      const response =
        await getMarketQuote(contract.instrument_key);

      const quote = extractQuote(
        response,
        contract.instrument_key
      );

      if (!quote) continue;

      const p = extractPrice(quote);
      const v = extractVolume(quote);
      const oi = extractOI(quote);

      const key = contract.instrument_key;
      const previous = stockSnapshots.get(key);

      const conditions = {
        priceUp: !!previous && p > previous.price,
        volumeUp: !!previous && v > previous.volume,
        oiUp: !!previous && oi > previous.oi
      };

      const confirmed =
        p > 0 &&
        v > 0 &&
        oi > 0 &&
        Object.values(conditions).every(Boolean);

      results.push({
        symbol: contract.underlying_symbol,
        instrument_key: key,
        price: p,
        volume: v,
        oi,
        conditions,
        longBuildUp: confirmed,
        signal: confirmed ? 'LONG_BUILD_UP' : 'WAIT'
      });

      stockSnapshots.set(key, {
        price: p,
        volume: v,
        oi,
        time: Date.now()
      });
    } catch (error) {
      results.push({
        symbol: contract.underlying_symbol,
        signal: 'WAIT',
        error: error.message
      });
    }
  }

  const signals = results.filter(
    x => x.longBuildUp
  );

  return {
    success: true,
    scanner: 'NSE_FNO_LONG_BUILD_UP',
    checked: results.length,
    count: signals.length,
    signals,
    all_results: results,
    timestamp: new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  try {
    if (url.pathname === '/health') {
      return sendJson(res, 200, {
        success: true,
        message: 'Smart Trade India Backend running',
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname === '/api/upstox/status') {
      return sendJson(res, 200, {
        success: true,
        token_configured:
          Boolean(process.env.UPSTOX_ACCESS_TOKEN)
      });
    }

    if (
      url.pathname === '/api/options/strong-gamma-scan' ||
      url.pathname === '/api/options/auto-scan'
    ) {
      return sendJson(
        res,
        200,
        await scanIndexOptions(url)
      );
    }

    if (
      url.pathname === '/api/stocks/long-build-up' ||
      url.pathname === '/api/options/nse-stocks/scan'
    ) {
      return sendJson(
        res,
        200,
        await scanLongBuildUp()
      );
    }

    if (url.pathname === '/api/market/quote') {
      const key = url.searchParams.get('instrument_key');

      if (!key) {
        return sendJson(res, 400, {
          success: false,
          error: 'instrument_key is required'
        });
      }

      return sendJson(res, 200, {
        success: true,
        data: await getMarketQuote(key)
      });
    }

    return sendJson(res, 404, {
      success: false,
      error: 'API route not found',
      path: url.pathname
    });
  } catch (error) {
    const status =
      error.message === 'UPSTOX_ACCESS_TOKEN_MISSING'
        ? 503
        : 502;

    return sendJson(res, status, {
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

server.listen(PORT, () => {
  console.log(
    `Smart Trade India backend running on port ${PORT}`
  );
});
