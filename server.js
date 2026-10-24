const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = "https://api.upstox.com";

const optionSnapshots = new Map();
const stockSnapshots = new Map();

const DEFAULT_INDEXES = [
  { name: "NIFTY", instrument_key: "NSE_INDEX|Nifty 50" },
  { name: "BANKNIFTY", instrument_key: "NSE_INDEX|Nifty Bank" },
  { name: "FINNIFTY", instrument_key: "NSE_INDEX|Nifty Fin Service" },
  { name: "SENSEX", instrument_key: "BSE_INDEX|SENSEX" }
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;

  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify(data));
}

async function upstoxRequest(apiUrl) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error("UPSTOX_ACCESS_TOKEN_MISSING");
  }

  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Upstox returned invalid JSON: HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `Upstox API error: HTTP ${response.status}`
    );
  }

  return data;
}

function extractPrice(quote) {
  return Number(
    quote?.last_price ??
    quote?.ltp ??
    quote?.last_traded_price ??
    0
  );
}

function extractVolume(quote) {
  const value = Number(
    quote?.volume ??
    quote?.volume_traded ??
    quote?.volumeTraded ??
    quote?.total_traded_quantity ??
    quote?.total_volume ??
    0
  );

  return Number.isFinite(value) && value > 0 ? value : 0;
}

function extractOI(quote) {
  return Number(
    quote?.oi ??
    quote?.open_interest ??
    0
  );
}

function extractQuote(response, instrumentKey) {
  const data = response?.data || {};

  if (data[instrumentKey]) {
    return data[instrumentKey];
  }

  const firstKey = Object.keys(data)[0];

  return firstKey ? data[firstKey] : null;
}

function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gain += change;
    else loss += Math.abs(change);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  return Number(
    (100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)
  );
}

function calculateEMA(values, period = 20) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return Number(ema.toFixed(2));
}

function getClosedCandles(candles, intervalMinutes = 5) {
  const intervalMs = intervalMinutes * 60 * 1000;

  return (Array.isArray(candles) ? candles : [])
    .filter(c =>
      Array.isArray(c) &&
      Number.isFinite(new Date(c[0]).getTime())
    )
    .filter(c =>
      new Date(c[0]).getTime() + intervalMs <= Date.now()
    )
    .sort((a, b) =>
      new Date(a[0]).getTime() - new Date(b[0]).getTime()
    );
}

function analyseCandles(candles) {
  const valid = getClosedCandles(candles, 5).filter(c =>
    [1, 2, 3, 4, 5].every(i =>
      Number.isFinite(Number(c[i]))
    )
  );

  if (valid.length < 21) {
    return {
      ready: false,
      signal: "WAIT",
      reason: "Need at least 21 completed 5-minute candles",
      completed_count: valid.length
    };
  }

  const closes = valid.map(c => Number(c[4]));
  const latest = valid[valid.length - 1];
  const previous = valid[valid.length - 2];

  const close = Number(latest[4]);
  const open = Number(latest[1]);
  const volume = Number(latest[5]);

  const avgVolume =
    valid.slice(-21, -1).reduce((sum, c) =>
      sum + Number(c[5]), 0
    ) / 20;

  const rsi = calculateRSI(closes);
  const ema20 = calculateEMA(closes, 20);

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of valid) {
    const typical =
      (Number(c[2]) + Number(c[3]) + Number(c[4])) / 3;

    const v = Number(c[5]);

    totalPV += typical * v;
    totalVolume += v;
  }

  const vwap =
    totalVolume > 0 ? totalPV / totalVolume : null;

  const previousCandles = valid.slice(-21, -1);

  const resistance = Math.max(
    ...previousCandles.map(c => Number(c[2]))
  );

  const support = Math.min(
    ...previousCandles.map(c => Number(c[3]))
  );

  const volumePass =
    avgVolume > 0 && volume >= avgVolume * 1.5;

  const bullish =
    close > open &&
    close > ema20 &&
    vwap !== null &&
    close > vwap &&
    close > resistance &&
    rsi !== null &&
    rsi > 65 &&
    volumePass;

  const bearish =
    close < open &&
    close < ema20 &&
    vwap !== null &&
    close < vwap &&
    close < support &&
    rsi !== null &&
    rsi < 35 &&
    volumePass;

  return {
    ready: true,
    close,
    previousClose: Number(previous[4]),
    rsi14: rsi,
    ema20,
    vwap: vwap === null ? null : Number(vwap.toFixed(2)),
    currentVolume: volume,
    averageVolume: Number(avgVolume.toFixed(2)),
    volumePass,
    resistance,
    support,
    bullish,
    bearish,
    signal: bullish ? "CALL_CONFIRMATION" :
      bearish ? "PUT_CONFIRMATION" : "WAIT",
    latestClosedCandle: latest,
    completed_count: valid.length
  };
}

function saveSnapshot(map, key, quote) {
  const price = extractPrice(quote);
  const volume = extractVolume(quote);
  const oi = extractOI(quote);

  if (!key || price <= 0) return;

  map.set(key, {
    price,
    volume,
    oi,
    time: Date.now()
  });
}

function analyseSnapshot(map, key, quote) {
  const price = extractPrice(quote);
  const volume = extractVolume(quote);
  const oi = extractOI(quote);

  if (
    !key ||
    price <= 0 ||
    volume <= 0 ||
    oi <= 0
  ) {
    return {
      signal: "WAIT",
      long_build_up: false,
      reason: "Market data missing or invalid"
    };
  }

  const previous = map.get(key);

  // Store current values for the next scan.
  saveSnapshot(map, key, quote);

  if (!previous) {
    return {
      signal: "WAIT",
      long_build_up: false,
      reason: "WAITING_FOR_BASELINE",
      price,
      volume,
      oi
    };
  }

  const priceUp = price > previous.price;
  const volumeUp = volume > previous.volume;
  const oiUp = oi > previous.oi;

  const longBuildUp = priceUp && volumeUp && oiUp;

  return {
    signal: longBuildUp ? "LONG_BUILD_UP" : "WAIT",
    long_build_up: longBuildUp,
    price,
    previous_price: previous.price,
    volume,
    previous_volume: previous.volume,
    oi,
    previous_oi: previous.oi,
    price_up: priceUp,
    volume_up: volumeUp,
    oi_up: oiUp,
    reason: longBuildUp
      ? "Price, volume and OI increased between scans"
      : "All three conditions are not confirmed",
    signal_time: new Date().toISOString()
  };
}

async function getMarketQuote(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  apiUrl.searchParams.set("instrument_key", instrumentKey);

  return upstoxRequest(apiUrl.toString());
}

async function getOptionContracts(instrumentKey, expiry) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/option/contract`
  );

  apiUrl.searchParams.set("instrument_key", instrumentKey);

  if (expiry) {
    apiUrl.searchParams.set("expiry_date", expiry);
  }

  return upstoxRequest(apiUrl.toString());
}
async function getOptionChain(instrumentKey, expiry) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/option/chain`
  );

  apiUrl.searchParams.set("instrument_key", instrumentKey);

  if (expiry) {
    apiUrl.searchParams.set("expiry_date", expiry);
  }

  return upstoxRequest(apiUrl.toString());
}

async function getIntradayCandles(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v3/historical-candle/intraday/` +
    `${encodeURIComponent(instrumentKey)}/minutes/5`
  );

  return upstoxRequest(apiUrl.toString());
}

function getNearestExpiry(contracts) {
  const today = new Date().toISOString().slice(0, 10);

  const dates = [...new Set(
    (Array.isArray(contracts) ? contracts : [])
      .map(c => c.expiry)
      .filter(Boolean)
  )].sort();

  return dates.find(date => date >= today) || null;
}

function getRequestedIndexes(url) {
  const raw = url.searchParams.get("indexes");

  if (!raw) return DEFAULT_INDEXES;

  const requested = raw.split(",")
    .map(s => s.trim().toUpperCase());

  return DEFAULT_INDEXES.filter(index =>
    requested.includes(index.name)
  );
}

async function getNseFutures() {
  const instrumentsUrl =
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

  const response = await fetch(instrumentsUrl, {
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(
      `NSE instruments download failed: HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const instruments = JSON.parse(
    zlib.gunzipSync(buffer).toString("utf8")
  );

  const contracts = instruments.filter(item =>
    item.segment === "NSE_FO" &&
    item.instrument_type === "FUT" &&
    item.underlying_type === "EQUITY" &&
    item.instrument_key &&
    item.underlying_key
  );

  return contracts;
}

async function scanLongBuildUp() {
  const contracts = await getNseFutures();
  const allResults = [];

  for (const contract of contracts.slice(0, 100)) {
    try {
      const response = await getMarketQuote(
        contract.instrument_key
      );

      const quote = extractQuote(
        response,
        contract.instrument_key
      );

      if (!quote) {
        allResults.push({
          symbol: contract.trading_symbol,
          signal: "WAIT",
          reason: "Quote unavailable"
        });
        continue;
      }

      const analysis = analyseSnapshot(
        stockSnapshots,
        contract.instrument_key,
        quote
      );

      allResults.push({
        symbol: contract.trading_symbol,
        instrument_key: contract.instrument_key,
        expiry: contract.expiry,
        instrument_type: contract.instrument_type,
        ...analysis
      });

    } catch (error) {
      allResults.push({
        symbol: contract.trading_symbol,
        signal: "WAIT",
        error: error.message
      });
    }
  }

  const signals = allResults.filter(
    item => item.long_build_up === true
  );

  return {
    success: true,
    scanner: "NSE_FUTURES_LONG_BUILD_UP",
    checked: allResults.length,
    long_build_up_count: signals.length,
    long_build_up_stocks: signals,
    all_results: allResults,
    timestamp: new Date().toISOString(),
    note: "Snapshots are stored in memory and reset on server restart."
  };
}

async function scanIndexOptions(url) {
  const indexes = getRequestedIndexes(url);
  const results = [];

  for (const index of indexes) {
    try {
      const contractsResponse = await getOptionContracts(
        index.instrument_key
      );

      const contracts = contractsResponse?.data || [];

      if (!Array.isArray(contracts) || contracts.length === 0) {
        results.push({
          index: index.name,
          status: "NO_CONTRACTS",
          signals: []
        });
        continue;
      }

      const expiry =
        url.searchParams.get("expiry") ||
        getNearestExpiry(contracts);

      const expiryContracts = contracts.filter(c =>
        c.expiry === expiry &&
        c.instrument_key &&
        ["CE", "PE"].includes(c.instrument_type)
      );

      const chainResponse = await getOptionChain(
        index.instrument_key,
        expiry
      );

      const chain = chainResponse?.data || [];

      const chainKeys = new Set(
        chain.map(item =>
          item?.call_options?.instrument_key ||
          item?.put_options?.instrument_key
        ).filter(Boolean)
      );

      const selected = expiryContracts
        .filter(c => chainKeys.has(c.instrument_key))
        .slice(0, 30);

      const signals = [];

      for (const contract of selected) {
        try {
          const quoteResponse = await getMarketQuote(
            contract.instrument_key
          );

          const quote = extractQuote(
            quoteResponse,
            contract.instrument_key
          );

          if (!quote) continue;

          const analysis = analyseSnapshot(
            optionSnapshots,
            contract.instrument_key,
            quote
          );

          signals.push({
            symbol: contract.trading_symbol,
            instrument_key: contract.instrument_key,
            expiry: contract.expiry,
            strike_price: contract.strike_price,
            option_type: contract.instrument_type,
            price: extractPrice(quote),
            volume: extractVolume(quote),
            oi: extractOI(quote),
            ...analysis
          });

        } catch (error) {
          signals.push({
            symbol: contract.trading_symbol,
            signal: "WAIT",
            error: error.message
          });
        }
      }

      results.push({
        index: index.name,
        expiry,
        contracts_checked: selected.length,
        signals: signals.filter(
          item => item.long_build_up === true
        ),
        all_results: signals
      });

    } catch (error) {
      results.push({
        index: index.name,
        status: "ERROR",
        error: error.message,
        signals: []
      });
    }
  }

  return {
    success: true,
    timestamp: new Date().toISOString(),
    results
  };
  }

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  let url;

  try {
    url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );
  } catch {
    return sendJson(res, 400, {
      success: false,
      error: "Invalid URL"
    });
  }

  try {
    if (
      url.pathname === "/health" &&
      req.method === "GET"
    ) {
      return sendJson(res, 200, {
        success: true,
        timestamp: new Date().toISOString(),
        token_configured: Boolean(
          process.env.UPSTOX_ACCESS_TOKEN
        )
      });
    }

    if (
      url.pathname === "/api/upstox/status" &&
      req.method === "GET"
    ) {
      return sendJson(res, 200, {
        success: true,
        token_configured: Boolean(
          process.env.UPSTOX_ACCESS_TOKEN
        )
      });
    }

    if (
      url.pathname === "/api/market/quote" &&
      req.method === "GET"
    ) {
      const key =
        url.searchParams.get("instrument_key") ||
        url.searchParams.get("instrumentKey");

      if (!key) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const response = await getMarketQuote(key);

      return sendJson(res, 200, {
        success: true,
        data: response.data || {}
      });
    }

    if (
      url.pathname === "/api/market/candles" &&
      req.method === "GET"
    ) {
      const key =
        url.searchParams.get("instrument_key") ||
        url.searchParams.get("instrumentKey");

      if (!key) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const response = await getIntradayCandles(key);

      return sendJson(res, 200, {
        success: true,
        instrument_key: key,
        analysis: analyseCandles(
          response?.data?.candles || []
        )
      });
    }

    if (
      url.pathname === "/api/stocks/long-build-up" &&
      req.method === "GET"
    ) {
      return sendJson(
        res,
        200,
        await scanLongBuildUp()
      );
    }

    if (
      url.pathname === "/api/options/auto-scan" &&
      req.method === "GET"
    ) {
      return sendJson(
        res,
        200,
        await scanIndexOptions(url)
      );
    }

    if (
      url.pathname === "/api/options/nse-stocks" &&
      req.method === "GET"
    ) {
      const contracts = await getNseFutures();

      return sendJson(res, 200, {
        success: true,
        instrument_type: "FUT",
        count: contracts.length,
        contracts
      });
    }

    return sendJson(res, 404, {
      success: false,
      error: "API route not found",
      path: url.pathname
    });

  } catch (error) {
    const status =
      error.message === "UPSTOX_ACCESS_TOKEN_MISSING"
        ? 503
        : 502;

    return sendJson(res, status, {
      success: false,
      error: error.message || "Internal server error",
      timestamp: new Date().toISOString()
    });
  }
});

server.listen(PORT, () => {
  console.log(
    `Smart Trade India Backend running on port ${PORT}`
  );
});
