// ============================================================
// SMART MARKET SCANNER — UPSTOX FUTURES + NEWS ALERTS
// Node.js 18+ | Save as server.js
// Uses completed 5-minute candles.
// ============================================================
"use strict";

const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const BASE = "https://api.upstox.com";
const SNAPSHOTS = new Map();

let instrumentCache = { time: 0, data: [] };
const CACHE_MS = 15 * 60 * 1000;

const INDEXES = [
  { name: "NIFTY", symbol: "NIFTY", type: "FUTIDX" },
  { name: "BANKNIFTY", symbol: "BANKNIFTY", type: "FUTIDX" },
  { name: "FINNIFTY", symbol: "FINNIFTY", type: "FUTIDX" },
  { name: "MIDCAPNIFTY", symbol: "MIDCPNIFTY", type: "FUTIDX" },
  { name: "SENSEX", symbol: "SENSEX", type: "FUTIDX", exchange: "BSE_FO" }
];

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}

function send(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    ...cors(),
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(body));
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

async function upstox(url) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN_MISSING: configure it in Render Environment Variables"
    );
  }

  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(25000)
  });

  const t = await r.text();
  let j;

  try {
    j = JSON.parse(t);
  } catch {
    throw new Error(`UPSTOX_NON_JSON_RESPONSE_HTTP_${r.status}`);
  }

  if (!r.ok) {
    throw new Error(
      j?.errors?.[0]?.message ||
      j?.message ||
      `UPSTOX_HTTP_${r.status}`
    );
  }

  return j;
}

function closedCandles(raw, minutes = 5) {
  const map = new Map();
  const step = minutes * 60000;
  const now = Date.now();

  for (const c of (Array.isArray(raw) ? raw : [])) {
    if (!Array.isArray(c) || c.length < 6) continue;

    const ts = new Date(c[0]).getTime();

    if (!Number.isFinite(ts) || ts + step > now) continue;

    map.set(ts, [
      ts,
      n(c[1]),
      n(c[2]),
      n(c[3]),
      n(c[4]),
      n(c[5]),
      n(c[6])
    ]);
  }

  return [...map.values()].sort((a, b) => a[0] - b[0]);
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let g = 0;
  let l = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    g += Math.max(d, 0);
    l += Math.max(-d, 0);
  }

  let ag = g / period;
  let al = l / period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];

    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (ag === 0 && al === 0) return 50;
  if (al === 0) return 100;

  return Number((100 - 100 / (1 + ag / al)).toFixed(2));
}

function ema(values, period = 20) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let e = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return Number(e.toFixed(4));
}

function vwap(candles) {
  let pv = 0;
  let vol = 0;

  for (const c of candles) {
    const v = n(c[5]);
    pv += ((c[2] + c[3] + c[4]) / 3) * v;
    vol += v;
  }

  return vol > 0 ? Number((pv / vol).toFixed(4)) : null;
}
function analyse(candles, oiData = null) {
  if (candles.length < 21) {
    const oi = oiData && Number.isFinite(oiData.oi)
      ? oiData.oi : null;

    const previous_oi =
      oiData && Number.isFinite(oiData.previous_oi)
        ? oiData.previous_oi : null;

    const change_in_oi =
      oiData && Number.isFinite(oiData.change_in_oi)
        ? oiData.change_in_oi
        : (oi !== null && previous_oi !== null
            ? oi - previous_oi : null);

    const oi_increase =
      oi !== null &&
      previous_oi !== null &&
      oi > previous_oi;

    const change_oi_increase =
      change_in_oi !== null &&
      change_in_oi > 0;

    return {
      ready: false,
      reason: "NEED_21_COMPLETED_5M_CANDLES",
      candle_count: candles.length,
      oi,
      previous_oi,
      change_in_oi,
      oi_increase,
      change_oi_increase,
      oi_confirmation: oi_increase && change_oi_increase,
      signal: "NEUTRAL",
      confidence_score: 0
    };
  }

  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const closes = candles.map(x => x[4]);

  const avgVol =
    candles.slice(-21, -1)
      .reduce((s, x) => s + n(x[5]), 0) / 20;

  const volRatio = avgVol > 0 ? n(c[5]) / avgVol : 0;

  const r = rsi(closes);
  const e = ema(closes);
  const w = vwap(candles);

  const resistance = Math.max(
    ...candles.slice(-21, -1).map(x => x[2])
  );

  const support = Math.min(
    ...candles.slice(-21, -1).map(x => x[3])
  );

  const volPass = avgVol > 0 && n(c[5]) >= avgVol * 1.5;

  const priceUp = c[4] > p[4] && c[4] > c[1];
  const priceDown = c[4] < p[4] && c[4] < c[1];

  const breakout = c[4] > resistance;
  const breakdown = c[4] < support;

  const aboveEma = e !== null && c[4] > e;
  const belowEma = e !== null && c[4] < e;

  const aboveVwap = w !== null && c[4] > w;
  const belowVwap = w !== null && c[4] < w;

  const currentOI =
    oiData && Number.isFinite(oiData.oi)
      ? oiData.oi : null;

  const previousOI =
    oiData && Number.isFinite(oiData.previous_oi)
      ? oiData.previous_oi : null;

  const changeOI =
    oiData && Number.isFinite(oiData.change_in_oi)
      ? oiData.change_in_oi
      : (currentOI !== null && previousOI !== null
          ? currentOI - previousOI : null);

  const oiIncrease =
    currentOI !== null &&
    previousOI !== null &&
    currentOI > previousOI;

  const changeOIIncrease =
    changeOI !== null &&
    changeOI > 0;

  const oiPass = oiIncrease && changeOIIncrease;

  const bullish =
    priceUp &&
    volPass &&
    oiPass &&
    r !== null && r > 65 &&
    aboveEma &&
    aboveVwap &&
    breakout;

  const bearish =
    priceDown &&
    volPass &&
    oiPass &&
    r !== null && r < 35 &&
    belowEma &&
    belowVwap &&
    breakdown;

  const checksBull = [
    priceUp, volPass, oiIncrease, changeOIIncrease,
    r !== null && r > 65, aboveEma, aboveVwap, breakout
  ];

  const checksBear = [
    priceDown, volPass, oiIncrease, changeOIIncrease,
    r !== null && r < 35, belowEma, belowVwap, breakdown
  ];

  const scoreBull = Math.round(
    checksBull.filter(Boolean).length / 8 * 100
  );

  const scoreBear = Math.round(
    checksBear.filter(Boolean).length / 8 * 100
  );

  return {
    ready: true,
    candle_time: new Date(c[0]).toISOString(),
    candle_count: candles.length,
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    previous_close: p[4],
    price_change_percent: p[4]
      ? Number(((c[4] - p[4]) / p[4] * 100).toFixed(2))
      : null,

    rsi14: r,
    ema20: e,
    vwap: w,
    volume: n(c[5]),
    average_volume: Number(avgVol.toFixed(2)),
    volume_ratio: Number(volRatio.toFixed(2)),
    volume_spike: volPass,

    oi: currentOI,
    previous_oi: previousOI,
    change_in_oi: changeOI,
    oi_increase: oiIncrease,
    change_oi_increase: changeOIIncrease,
    oi_confirmation: oiPass,

    resistance: Number(resistance.toFixed(4)),
    support: Number(support.toFixed(4)),
    breakout,
    breakdown,
    price_up: priceUp,
    price_down: priceDown,
    above_ema20: aboveEma,
    below_ema20: belowEma,
    above_vwap: aboveVwap,
    below_vwap: belowVwap,

    bullish_confirmation: bullish,
    bearish_confirmation: bearish,

    confidence_score: bullish
      ? scoreBull
      : bearish
        ? scoreBear
        : Math.max(scoreBull, scoreBear),

    signal: bullish
      ? "STRONG_BUY"
      : bearish
        ? "STRONG_SELL"
        : "NEUTRAL"
  };
}

async function candlesFor(key) {
  const u =
    `${BASE}/v3/historical-candle/intraday/` +
    `${encodeURIComponent(key)}/minutes/5`;

  const data = await upstox(u);

  return closedCandles(data?.data?.candles || [], 5);
}

async function instruments() {
  if (
    instrumentCache.data.length &&
    Date.now() - instrumentCache.time < CACHE_MS
  ) {
    return instrumentCache.data;
  }

  const url =
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

  const r = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });

  if (!r.ok) {
    throw new Error(`INSTRUMENT_FILE_HTTP_${r.status}`);
  }

  const b = Buffer.from(await r.arrayBuffer());
  let txt;

  try {
    txt = zlib.gunzipSync(b).toString("utf8");
  } catch {
    txt = b.toString("utf8");
  }

  const list = JSON.parse(txt);

  instrumentCache = {
    time: Date.now(),
    data: list
  };

  return list;
}

function nearestFuture(
  list,
  symbol,
  type = "FUTSTK",
  exchange = "NSE_FO"
) {
  const today = new Date().toLocaleDateString(
    "en-CA",
    { timeZone: "Asia/Kolkata" }
  );

  const matches = list.filter(x =>
    x.segment === exchange &&
    x.instrument_type === type &&
    (
      x.underlying_symbol === symbol ||
      x.trading_symbol === symbol ||
      x.name === symbol
    ) &&
    typeof x.expiry === "string" &&
    x.expiry >= today &&
    x.instrument_key
  );

  matches.sort((a, b) => a.expiry.localeCompare(b.expiry));

  return matches[0] || null;
}

async function quoteFor(key) {
  const data = await upstox(
    `${BASE}/v3/market-quote/quotes?instrument_key=` +
    encodeURIComponent(key)
  );

  const root = data?.data;
  let q = null;

  if (root && typeof root === "object") {
    q = root[key] ||
      Object.values(root).find(v =>
        v && typeof v === "object" &&
        (
          v.instrument_key === key ||
          v.instrument_token === key
        )
      ) ||
      Object.values(root)[0] ||
      null;
  }

  if (!q) {
    return {
      oi: null,
      previous_oi: null,
      change_in_oi: null
    };
  }

  const oi =
    q.oi !== undefined &&
    q.oi !== null &&
    Number.isFinite(Number(q.oi))
      ? Number(q.oi) : null;

  const prevRaw =
    q.prev_oi ??
    q.previous_oi ??
    q.previous_open_interest;

  const previous_oi =
    prevRaw !== undefined &&
    prevRaw !== null &&
    Number.isFinite(Number(prevRaw))
      ? Number(prevRaw) : null;

  const explicitChange =
    q.change_in_oi ??
    q.change_oi ??
    q.oi_change;

  const change_in_oi =
    explicitChange !== undefined &&
    explicitChange !== null &&
    Number.isFinite(Number(explicitChange))
      ? Number(explicitChange)
      : (oi !== null && previous_oi !== null
          ? oi - previous_oi : null);

  return {
    oi,
    previous_oi,
    change_in_oi
  };
}
async function scanFuture(instrument, category) {
  try {
    const [cs, oiData] = await Promise.all([
      candlesFor(instrument.instrument_key),
      quoteFor(instrument.instrument_key)
    ]);

    const a = analyse(cs, oiData);

    return {
      category,
      symbol:
        instrument.underlying_symbol ||
        instrument.trading_symbol ||
        instrument.name,

      trading_symbol: instrument.trading_symbol,
      instrument_key: instrument.instrument_key,
      expiry: instrument.expiry,
      lot_size: instrument.lot_size || null,

      // OI fields directly available in API response
      oi: a.oi,
      previous_oi: a.previous_oi,
      change_in_oi: a.change_in_oi,
      oi_increase: a.oi_increase,
      change_oi_increase: a.change_oi_increase,
      oi_confirmation: a.oi_confirmation,

      analysis: a,
      signal: a.signal || "NEUTRAL",
      confidence_score: a.confidence_score || 0
    };
  } catch (e) {
    return {
      category,
      symbol:
        instrument.underlying_symbol ||
        instrument.trading_symbol ||
        instrument.name,

      trading_symbol: instrument.trading_symbol,
      instrument_key: instrument.instrument_key,
      expiry: instrument.expiry,
      signal: "ERROR",
      error: e.message
    };
  }
}

async function scanIndexFutures() {
  const list = await instruments();
  const out = [];

  for (const idx of INDEXES) {
    try {
      const exchange = idx.exchange || "NSE_FO";

      const f = nearestFuture(
        list, idx.symbol, "FUTIDX", exchange
      );

      if (!f) {
        out.push({
          category: "INDEX_FUTURE",
          symbol: idx.name,
          signal: "UNAVAILABLE",
          error:
            "No matching current futures contract found in " +
            "downloaded instrument list. Verify exchange/instrument key."
        });
        continue;
      }

      out.push(await scanFuture(f, "INDEX_FUTURE"));
    } catch (e) {
      out.push({
        category: "INDEX_FUTURE",
        symbol: idx.name,
        signal: "ERROR",
        error: e.message
      });
    }
  }

  return out;
}

async function scanStockFutures(limit = 20) {
  const list = await instruments();

  const today = new Date().toLocaleDateString(
    "en-CA",
    { timeZone: "Asia/Kolkata" }
  );

  const map = new Map();

  for (const x of list) {
    if (
      x.segment !== "NSE_FO" ||
      x.instrument_type !== "FUTSTK" ||
      !x.instrument_key ||
      !x.expiry ||
      x.expiry < today
    ) continue;

    const symbol = x.underlying_symbol || x.trading_symbol;
    if (!symbol) continue;

    const old = map.get(symbol);

    if (!old || x.expiry < old.expiry) {
      map.set(symbol, x);
    }
  }

  const futures = [...map.values()]
    .sort((a, b) =>
      String(a.underlying_symbol)
        .localeCompare(String(b.underlying_symbol))
    )
    .slice(0, limit);

  const results = [];

  for (const f of futures) {
    results.push(await scanFuture(f, "STOCK_FUTURE"));
  }

  return {
    available_stock_futures: map.size,
    requested_limit: limit,
    scanned: results.length,
    results
  };
}

// Optional NewsAPI.org integration
async function getStockNews(symbol, limit = 5) {
  const apiKey = process.env.NEWS_API_KEY;

  if (!apiKey) {
    return {
      configured: false,
      source: "NewsAPI.org",
      message:
        "Set NEWS_API_KEY to enable headlines. " +
        "Upstox market-data API does not supply general news headlines.",
      articles: []
    };
  }

  const q = encodeURIComponent(
    `"${symbol}" stock OR shares OR results OR order OR contract`
  );

  const url =
    `https://newsapi.org/v2/everything?q=${q}` +
    `&language=en&sortBy=publishedAt&pageSize=${limit}` +
    `&apiKey=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });

  const data = await r.json();

  if (!r.ok || data.status !== "ok") {
    throw new Error(
      data.message || `NEWS_API_HTTP_${r.status}`
    );
  }

  return {
    configured: true,
    source: "NewsAPI.org",
    articles: (data.articles || []).map(a => ({
      title: a.title,
      source: a.source?.name,
      publishedAt: a.publishedAt,
      url: a.url,
      description: a.description
    }))
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    return res.end();
  }

  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    const p = url.pathname;

    if (req.method !== "GET") {
      return send(res, 405, {
        success: false,
        error: "GET only"
      });
    }

    if (p === "/" || p === "/health") {
      return send(res, 200, {
        success: true,
        app: "Smart Market Scanner",
        status: "running",
        version: "3.1.0",
        upstox_token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN,
        news_configured: !!process.env.NEWS_API_KEY
      });
    }

    if (p === "/api/upstox/status") {
      return send(res, 200, {
        success: true,
        token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN
      });
    }

    if (p === "/api/indexes") {
      return send(res, 200, {
        success: true,
        indexes: INDEXES
      });
    }

    if (
      p === "/api/futures/auto-scan" ||
      p === "/api/futures/indexes/scan"
    ) {
      const results = await scanIndexFutures();

      return send(res, 200, {
        success: true,
        scanned_at: new Date().toISOString(),
        results,
        alerts: results.filter(x =>
          x.signal === "STRONG_BUY" ||
          x.signal === "STRONG_SELL"
        ),
        note:
          "OI fields are at the top level and inside analysis. " +
          "Signals require price, volume, RSI, EMA, VWAP, breakout " +
          "and current OI > previous OI with positive change in OI. " +
          "Missing OI data prevents strong signals. Confidence score " +
          "is not statistically verified accuracy."
      });
    }

    if (p === "/api/futures/nse-stocks/scan") {
      const limit = Math.max(
        1,
        Math.min(
          50,
          Number(url.searchParams.get("limit") || 20) || 20
        )
      );

      const result = await scanStockFutures(limit);

      return send(res, 200, {
        success: true,
        scanned_at: new Date().toISOString(),
        ...result,
        alerts: result.results.filter(x =>
          x.signal === "STRONG_BUY" ||
          x.signal === "STRONG_SELL"
        ),
        note:
          "Scans a limited set of current-expiry NSE stock futures."
      });
    }

    if (p === "/api/futures/scan-all") {
      const indexes = await scanIndexFutures();

      const limit = Math.max(
        1,
        Math.min(
          50,
          Number(url.searchParams.get("limit") || 20) || 20
        )
      );

      const stocks = await scanStockFutures(limit);

      return send(res, 200, {
        success: true,
        indexes,
        stock_futures: stocks,
        alerts: [...indexes, ...stocks.results].filter(x =>
          x.signal === "STRONG_BUY" ||
          x.signal === "STRONG_SELL"
        )
      });
    }

    if (p === "/api/market/candles") {
      const key = url.searchParams.get("instrument_key");

      if (!key) {
        return send(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const [cs, oiData] = await Promise.all([
        candlesFor(key),
        quoteFor(key)
      ]);

      const a = analyse(cs, oiData);

      return send(res, 200, {
        success: true,
        instrument_key: key,
        candle_count: cs.length,

        oi: a.oi,
        previous_oi: a.previous_oi,
        change_in_oi: a.change_in_oi,
        oi_increase: a.oi_increase,
        change_oi_increase: a.change_oi_increase,
        oi_confirmation: a.oi_confirmation,

        analysis: a,
        candles: cs
      });
    }

    if (p === "/api/market/full-quotes") {
      const keys = (
        url.searchParams.get("instrument_keys") || ""
      ).split(",").map(x => x.trim()).filter(Boolean);

      if (!keys.length) {
        return send(res, 400, {
          success: false,
          error: "instrument_keys is required"
        });
      }

      if (keys.length > 500) {
        return send(res, 400, {
          success: false,
          error: "Maximum 500 instruments per request"
        });
      }

      const data = await upstox(
        `${BASE}/v3/market-quote/quotes?instrument_key=` +
        encodeURIComponent(keys.join(","))
      );

      return send(res, 200, {
        success: true,
        data
      });
    }

    if (p === "/api/news/stock") {
      const symbol = url.searchParams.get("symbol");

      if (!symbol) {
        return send(res, 400, {
          success: false,
          error: "symbol is required"
        });
      }

      const limit = Math.max(
        1,
        Math.min(
          10,
          Number(url.searchParams.get("limit") || 5) || 5
        )
      );

      return send(res, 200, {
        success: true,
        symbol,
        ...await getStockNews(symbol, limit)
      });
    }

    if (p === "/api/news/alerts") {
      const symbol = url.searchParams.get("symbol");

      if (!symbol) {
        return send(res, 400, {
          success: false,
          error: "symbol is required"
        });
      }

      const news = await getStockNews(symbol, 5);

      return send(res, 200, {
        success: true,
        symbol,
        news_alert: news.articles.length > 0,
        news,
        disclaimer:
          "News presence does not confirm a price rise. " +
          "Verify headline, source, and timestamp."
      });
    }

    return send(res, 404, {
      success: false,
      error: "Route not found",
      path: p,
      available_routes: [
        "/health",
        "/api/indexes",
        "/api/futures/auto-scan",
        "/api/futures/nse-stocks/scan?limit=20",
        "/api/futures/scan-all?limit=20",
        "/api/market/candles?instrument_key=...",
        "/api/market/full-quotes?instrument_keys=...",
        "/api/news/stock?symbol=RELIANCE"
      ]
    });

  } catch (e) {
    console.error("API_ERROR", req.url, e.message);

    return send(res, 500, {
      success: false,
      error: e.message || "Server error"
    });
  }
});

server.listen(PORT, () => {
  console.log(`Smart Market Scanner running on port ${PORT}`);
});
// ================================================
// START SERVER
// ================================================

const server = http.createServer(async (req, res) => {
  // ನಿಮ್ಮ ಈಗಿರುವ request handling code
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Smart Market Scanner running on port ${PORT}`);
});
