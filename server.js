'use strict';
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 10000);
const UPSTOX_BASE = 'https://api.upstox.com';
const snapshots = new Map();
const stockSnapshots = new Map();

const INDEXES = [
  { name: 'NIFTY', key: 'NSE_INDEX|Nifty 50' },
  { name: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank' },
  { name: 'SENSEX', key: 'BSE_INDEX|SENSEX' },
  { name: 'FINNIFTY', key: 'NSE_INDEX|Nifty Fin Service' },
  { name: 'MIDCPNIFTY', key: 'NSE_INDEX|Nifty Midcap 50' }
];

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}

function send(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    ...cors(),
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
}

async function upstox(url) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error('UPSTOX_ACCESS_TOKEN_MISSING');
  }

  const r = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    }
  });

  const txt = await r.text();
  let data;

  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    throw new Error(
      `Upstox returned non-JSON (HTTP ${r.status})`
    );
  }

  if (!r.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `Upstox HTTP ${r.status}`
    );
  }

  return data;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function price(q) {
  return num(
    q?.last_price ??
    q?.ltp ??
    q?.last_traded_price
  );
}

function volume(q) {
  return num(
    q?.volume ??
    q?.volume_traded ??
    q?.volumeTraded ??
    q?.total_traded_quantity ??
    q?.total_volume
  );
}

function oi(q) {
  return num(q?.oi ?? q?.open_interest);
}

function quoteFrom(d, key) {
  const obj = d?.data || {};
  return obj[key] || obj[Object.keys(obj)[0]] || null;
}

function candlesFrom(d) {
  return d?.data?.candles || [];
}

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= p; i++) {
    const x = closes[i] - closes[i - 1];
    gain += Math.max(x, 0);
    loss += Math.max(-x, 0);
  }

  let ag = gain / p;
  let al = loss / p;

  for (let i = p + 1; i < closes.length; i++) {
    const x = closes[i] - closes[i - 1];

    ag = (ag * (p - 1) + Math.max(x, 0)) / p;
    al = (al * (p - 1) + Math.max(-x, 0)) / p;
  }

  return al === 0
    ? (ag === 0 ? 50 : 100)
    : Number((100 - 100 / (1 + ag / al)).toFixed(2));
}

function analyse(candles) {
  const now = Date.now();

  const rows = (
    Array.isArray(candles) ? candles : []
  )
    .filter(c =>
      Array.isArray(c) &&
      Number.isFinite(new Date(c[0]).getTime()) &&
      new Date(c[0]).getTime() + 300000 <= now &&
      [1, 2, 3, 4, 5].every(
        i => Number.isFinite(Number(c[i]))
      )
    )
    .sort(
      (a, b) => new Date(a[0]) - new Date(b[0])
    );

  if (rows.length < 21) {
    return {
      ready: false,
      reason: 'NEED_21_COMPLETED_5M_CANDLES',
      count: rows.length
    };
  }

  const close = rows.map(c => num(c[4]));
  const latest = rows[rows.length - 1];
  const vol = rows.map(c => num(c[5]));

  const avgVol =
    vol.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  let pv = 0;
  let vv = 0;

  for (const c of rows) {
    const v = num(c[5]);
    pv += (
      (num(c[2]) + num(c[3]) + num(c[4])) / 3
    ) * v;
    vv += v;
  }

  const vwap = vv ? pv / vv : null;
  const rr = rsi(close);

  const highs = rows.slice(-21, -1).map(c => num(c[2]));
  const lows = rows.slice(-21, -1).map(c => num(c[3]));

  const c = num(latest[4]);
  const o = num(latest[1]);

  const bullish =
    c > o &&
    c > close[close.length - 2] &&
    vwap !== null &&
    c > vwap &&
    c > Math.max(...highs) &&
    rr !== null &&
    rr >= 65 &&
    avgVol > 0 &&
    num(latest[5]) >= avgVol * 1.5;

  const bearish =
    c < o &&
    c < close[close.length - 2] &&
    vwap !== null &&
    c < vwap &&
    c < Math.min(...lows) &&
    rr !== null &&
    rr <= 35 &&
    avgVol > 0 &&
    num(latest[5]) >= avgVol * 1.5;

  return {
    ready: true,
    close: c,
    open: o,
    rsi14: rr,
    vwap: Number(vwap?.toFixed(2)),
    volume: num(latest[5]),
    averageVolume20: Number(avgVol.toFixed(2)),
    volumePass:
      avgVol > 0 && num(latest[5]) >= avgVol * 1.5,
    bullish,
    bearish,
    direction: bullish ? 'CALL' : bearish ? 'PUT' : 'WAIT',
    candleTime: latest[0]
  };
}async function getQuote(key) {
  return quoteFrom(
    await upstox(
      `${UPSTOX_BASE}/v2/market-quote/quotes?instrument_key=${encodeURIComponent(key)}`
    ),
    key
  );
}

async function getIndexAnalysis(key) {
  const url =
    `${UPSTOX_BASE}/v3/historical-candle/intraday/` +
    `${encodeURIComponent(key)}/minutes/5`;

  const d = await upstox(url);
  return analyse(candlesFrom(d));
}

async function getContracts(key) {
  const d = await upstox(
    `${UPSTOX_BASE}/v2/option/contract?instrument_key=${encodeURIComponent(key)}`
  );

  return Array.isArray(d?.data) ? d.data : [];
}

function expiryNearest(contracts) {
  const today = new Date().toISOString().slice(0, 10);

  return contracts
    .map(c => c.expiry)
    .filter(Boolean)
    .sort()
    .find(x => x >= today) || null;
}

function contractType(c) {
  const t = String(
    c?.instrument_type || c?.option_type || ''
  ).toUpperCase();

  const s = String(
    c?.trading_symbol || ''
  ).toUpperCase();

  if (t.includes('CE') || t === 'CALL' || s.endsWith('CE')) {
    return 'CALL';
  }

  if (t.includes('PE') || t === 'PUT' || s.endsWith('PE')) {
    return 'PUT';
  }

  return '';
}

function scoreOption(q, prev, direction, greeks = {}) {
  const p = price(q);
  const v = volume(q);
  const oiNow = oi(q);

  const prevP = prev?.price;
  const prevV = prev?.volume;
  const prevOI = prev?.oi;

  const checks = {
    optionPriceUp: Number.isFinite(prevP) && p > prevP,
    volumeIncreasing: Number.isFinite(prevV) && v > prevV,
    oiIncreasing: Number.isFinite(prevOI) && oiNow > prevOI,
    gammaAvailable:
      Number.isFinite(Number(greeks.gamma)) &&
      Number(greeks.gamma) > 0
  };

  const positive = [
    checks.optionPriceUp,
    checks.volumeIncreasing,
    checks.oiIncreasing
  ].filter(Boolean).length;

  const score = Math.round((positive / 3) * 100);

  const signal =
    direction !== 'WAIT' && positive === 3
      ? direction
      : 'WAIT';

  return {
    price: p,
    volume: v,
    oi: oiNow,
    previousPrice: prevP ?? null,
    previousVolume: prevV ?? null,
    previousOI: prevOI ?? null,
    checks,
    score,
    signal,
    gamma: Number.isFinite(Number(greeks.gamma))
      ? Number(greeks.gamma)
      : null,
    gammaBlast:
      signal !== 'WAIT' && checks.gammaAvailable
  };
}

async function strongGammaScan(url) {
  const requested = (
    url.searchParams.get('indexes') ||
    INDEXES.map(x => x.name).join(',')
  )
    .split(',')
    .map(s => s.trim().toUpperCase());

  const indexes = INDEXES.filter(
    x => requested.includes(x.name)
  );

  const results = [];

  for (const idx of indexes) {
    try {
      const [market, trend, allContracts] =
        await Promise.all([
          getQuote(idx.key),
          getIndexAnalysis(idx.key),
          getContracts(idx.key)
        ]);

      const spot = price(market);

      if (
        !trend.ready ||
        trend.direction === 'WAIT' ||
        !spot
      ) {
        results.push({
          index: idx.name,
          spot,
          trend,
          signal: 'WAIT',
          reason: 'Index trend is not strongly confirmed'
        });

        continue;
      }

      const expiry =
        url.searchParams.get('expiry') ||
        expiryNearest(allContracts);

      const sameExpiry = allContracts
        .filter(c => !expiry || c.expiry === expiry)
        .filter(c =>
          contractType(c) === trend.direction &&
          c.instrument_key &&
          Number.isFinite(Number(c.strike_price))
        );

      sameExpiry.sort(
        (a, b) =>
          Math.abs(Number(a.strike_price) - spot) -
          Math.abs(Number(b.strike_price) - spot)
      );

      const selected = sameExpiry.slice(0, 8);
      const candidates = [];

      for (const c of selected) {
        try {
          const q = await getQuote(c.instrument_key);
          if (!q) continue;

          const key = c.instrument_key;
          const previous = snapshots.get(key);

          const s = scoreOption(
            q,
            previous,
            trend.direction,
            c.greeks || {}
          );

          snapshots.set(key, {
            price: price(q),
            volume: volume(q),
            oi: oi(q),
            time: Date.now()
          });

          candidates.push({
            symbol: c.trading_symbol,
            instrument_key: key,
            expiry: c.expiry,
            strike: num(c.strike_price),
            optionType: trend.direction,
            lotSize: num(c.lot_size),
            ...s,
            signalTime: new Date().toISOString()
          });
        } catch (e) {
          candidates.push({
            symbol: c.trading_symbol,
            error: e.message,
            signal: 'WAIT'
          });
        }
      }

      candidates.sort(
        (a, b) => (b.score || 0) - (a.score || 0)
      );

      const best = candidates.find(
        c =>
          c.signal === trend.direction &&
          c.score >= 75
      ) || null;

      results.push({
        index: idx.name,
        spot,
        expiry,
        marketDirection: trend.direction,
        trend,
        bestStrike: best,
        candidates,
        alert: best ? `${trend.direction}_STRONG` : 'WAIT',
        note:
          'First scan stores baseline; later scans compare ' +
          'price/volume/OI. Gamma Blast is confirmed only ' +
          'if Gamma data is supplied.'
      });
    } catch (e) {
      results.push({
        index: idx.name,
        signal: 'WAIT',
        error: e.message
      });
    }
  }

  return {
    success: true,
    scanner: 'STRONG_GAMMA_MOMENTUM',
    threshold: 75,
    timestamp: new Date().toISOString(),
    results
  };
}

async function getNseStockFutures() {
  const r = await fetch(
    'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
  );

  if (!r.ok) {
    throw new Error(
      `Instrument download failed HTTP ${r.status}`
    );
  }

  const raw = Buffer.from(await r.arrayBuffer());

  const txt = zlib.gunzipSync(raw).toString('utf8');
  const items = JSON.parse(txt).filter(
    x =>
      x.segment === 'NSE_FO' &&
      x.instrument_type === 'FUT' &&
      x.underlying_type === 'EQUITY' &&
      x.underlying_key &&
      x.instrument_key
  );

  const map = new Map();

  for (const x of items) {
    if (!x.expiry) continue;

    const old = map.get(x.underlying_symbol);

    if (
      !old ||
      new Date(x.expiry).getTime() <
        new Date(old.expiry).getTime()
    ) {
      map.set(x.underlying_symbol, x);
    }
  }

  return [...map.values()];
    }async function scanLongBuildUp() {
  const contracts = await getNseStockFutures();
  const out = [];

  for (const c of contracts) {
    try {
      const q = await getQuote(c.instrument_key);
      if (!q) continue;

      const p = price(q);
      const v = volume(q);
      const oiNow = oi(q);

      const old = stockSnapshots.get(c.instrument_key);
      const valid = p > 0 && v > 0 && oiNow > 0;

      const conditions = {
        priceUp: !!old && p > old.price,
        volumeUp: !!old && v > old.volume,
        oiUp: !!old && oiNow > old.oi
      };

      const confirmed =
        valid &&
        Object.values(conditions).every(Boolean);

      out.push({
        symbol: c.underlying_symbol || c.trading_symbol,
        instrument_key: c.instrument_key,
        price: p,
        volume: v,
        oi: oiNow,
        conditions,
        longBuildUp: confirmed,
        signal: confirmed ? 'LONG_BUILD_UP' : 'WAIT'
      });

      stockSnapshots.set(c.instrument_key, {
        price: p,
        volume: v,
        oi: oiNow,
        time: Date.now()
      });
    } catch (e) {
      out.push({
        symbol: c.underlying_symbol || c.trading_symbol,
        signal: 'WAIT',
        error: e.message
      });
    }
  }

  const hits = out.filter(x => x.longBuildUp);

  return {
    success: true,
    scanner: 'NSE_FNO_LONG_BUILD_UP',
    checked: out.length,
    count: hits.length,
    signals: hits,
    all_results: out,
    timestamp: new Date().toISOString(),
    note:
      'First scan stores baseline; later scans compare ' +
      'cumulative values.'
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors());
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  try {
    if (url.pathname === '/health') {
      return send(res, 200, {
        success: true,
        message: 'Smart Trade India backend running',
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname === '/api/upstox/status') {
      return send(res, 200, {
        success: true,
        token_configured:
          Boolean(process.env.UPSTOX_ACCESS_TOKEN)
      });
    }

    if (
      url.pathname === '/api/options/strong-gamma-scan' ||
      url.pathname === '/api/options/auto-scan'
    ) {
      return send(res, 200, await strongGammaScan(url));
    }

    if (
      url.pathname === '/api/stocks/long-build-up' ||
      url.pathname === '/api/options/nse-stocks/scan'
    ) {
      return send(res, 200, await scanLongBuildUp());
    }

    if (url.pathname === '/api/market/quote') {
      const key = url.searchParams.get('instrument_key');

      if (!key) {
        return send(res, 400, {
          success: false,
          error: 'instrument_key is required'
        });
      }

      return send(res, 200, {
        success: true,
        data: await getQuote(key)
      });
    }

    return send(res, 404, {
      success: false,
      error: 'API route not found',
      path: url.pathname
    });
  } catch (e) {
    const status =
      e.message === 'UPSTOX_ACCESS_TOKEN_MISSING'
        ? 503
        : 502;

    return send(res, status, {
      success: false,
      error: e.message || 'Internal server error'
    });
  }
});

server.listen(PORT, () => {
  console.log(
    `Smart Trade India backend running on port ${PORT}`
  );
});
