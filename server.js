const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = "https://api.upstox.com";

const optionSnapshots = new Map();
const stockOptionSnapshots = new Map();

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
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Upstox returned non-JSON response (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `Upstox API request failed (HTTP ${response.status})`
    );
  }

  return data;
}

// ==================================================
// RSI CALCULATION
// ==================================================

function calculateWilderRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      Number(closes[i]) - Number(closes[i - 1]);

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change =
      Number(closes[i]) - Number(closes[i - 1]);

    avgGain =
      (avgGain * (period - 1) +
        Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) +
        Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return Number(
    (
      100 -
      100 / (1 + avgGain / avgLoss)
    ).toFixed(2)
  );
}

// ==================================================
// COMPLETED CANDLES ONLY
// ==================================================

function getClosedCandles(candles, intervalMinutes = 5) {
  const intervalMs = intervalMinutes * 60 * 1000;

  return (Array.isArray(candles) ? candles : [])
    .filter(
      c =>
        Array.isArray(c) &&
        Number.isFinite(new Date(c[0]).getTime())
    )
    .filter(
      c =>
        new Date(c[0]).getTime() + intervalMs <= Date.now()
    )
    .sort(
      (a, b) =>
        new Date(a[0]).getTime() -
        new Date(b[0]).getTime()
    );
}

// ==================================================
// ORDER BLOCK APPROXIMATION
// Heuristic only; not institutional order-flow data.
// ==================================================

function detectOrderBlock(candles) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return {
      detected: false,
      type: "NONE",
      reason: "Need at least 3 candles"
    };
  }

  const valid = candles.filter(
    c =>
      Array.isArray(c) &&
      c.length >= 5 &&
      [1, 2, 3, 4].every(
        i => Number.isFinite(Number(c[i]))
      )
  );

  if (valid.length < 3) {
    return {
      detected: false,
      type: "NONE",
      reason: "Insufficient valid candles"
    };
  }

  const last = valid[valid.length - 1];
  const prev = valid[valid.length - 2];

  const lastOpen = Number(last[1]);
  const lastClose = Number(last[4]);

  const prevOpen = Number(prev[1]);
  const prevClose = Number(prev[4]);

  const bullish =
    prevClose < prevOpen &&
    lastClose > lastOpen &&
    lastClose > prevOpen &&
    lastOpen <= prevClose;

  const bearish =
    prevClose > prevOpen &&
    lastClose < lastOpen &&
    lastClose < prevOpen &&
    lastOpen >= prevClose;

  if (bullish) {
    return {
      detected: true,
      type: "BULLISH",
      low: Math.min(Number(prev[3]), lastOpen),
      high: Math.max(prevOpen, lastClose),
      candle_time: last[0],
      method: "Completed-candle engulfing heuristic"
    };
  }

  if (bearish) {
    return {
      detected: true,
      type: "BEARISH",
      low: Math.min(prevOpen, lastClose),
      high: Math.max(Number(prev[2]), lastOpen),
      candle_time: last[0],
      method: "Completed-candle engulfing heuristic"
    };
  }

  return {
    detected: false,
    type: "NONE",
    reason: "No qualifying candle pattern"
  };
}

// ==================================================
// 5-MINUTE CANDLE ANALYSIS
// ==================================================

function analyseCompletedCandles(
  candles,
  intervalMinutes = 5
) {
  const completed = getClosedCandles(
    candles,
    intervalMinutes
  );

  if (completed.length < 21) {
    return {
      ready: false,
      reason: "NEED_21_COMPLETED_CANDLES",
      completed_count: completed.length
    };
  }

  const validCandles = completed.filter(
    c =>
      Array.isArray(c) &&
      Number.isFinite(Number(c[1])) &&
      Number.isFinite(Number(c[2])) &&
      Number.isFinite(Number(c[3])) &&
      Number.isFinite(Number(c[4])) &&
      Number.isFinite(Number(c[5]))
  );

  if (validCandles.length < 21) {
    return {
      ready: false,
      reason: "INSUFFICIENT_VALID_CANDLES",
      completed_count: validCandles.length
    };
  }

  const closes = validCandles.map(c => Number(c[4]));
  const highs = validCandles.map(c => Number(c[2]));
  const lows = validCandles.map(c => Number(c[3]));
  const volumes = validCandles.map(c => Number(c[5]));

  const latest = validCandles[validCandles.length - 1];
  const previous = validCandles[validCandles.length - 2];

  const orderBlock = detectOrderBlock(validCandles);

  const close = Number(latest[4]);
  const open = Number(latest[1]);
  const previousClose = Number(previous[4]);

  const latestVolume = volumes[volumes.length - 1];

  const averageVolume =
    volumes
      .slice(-21, -1)
      .reduce((sum, v) => sum + v, 0) / 20;

  const rsi14 = calculateWilderRSI(closes, 14);

  // EMA calculation
  function calculateEMA(values, period) {
    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema =
      values
        .slice(0, period)
        .reduce((sum, value) => sum + value, 0) /
      period;

    for (let i = period; i < values.length; i++) {
      ema =
        (values[i] - ema) * multiplier + ema;
    }

    return Number(ema.toFixed(2));
  }

  const ema20 = calculateEMA(closes, 20);

  // VWAP calculation for available candles
  let totalPV = 0;
  let totalVolume = 0;

  for (const candle of validCandles) {
    const typicalPrice =
      (
        Number(candle[2]) +
        Number(candle[3]) +
        Number(candle[4])
      ) / 3;

    const volume = Number(candle[5]);

    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  const vwap =
    totalVolume > 0
      ? Number((totalPV / totalVolume).toFixed(2))
      : null;

  // Previous 20 candles' resistance and support
  const previousCandles =
    validCandles.slice(-21, -1);

  const resistance = Math.max(
    ...previousCandles.map(c => Number(c[2]))
  );

  const support = Math.min(
    ...previousCandles.map(c => Number(c[3]))
  );

  const volumeRatio =
    averageVolume > 0
      ? Number((latestVolume / averageVolume).toFixed(2))
      : 0;

  const volumePass =
    averageVolume > 0 &&
    latestVolume >= averageVolume * 1.5;

  const bullishBreakout = close > resistance;
  const bearishBreakdown = close < support;

  const bullishTrend =
    ema20 !== null &&
    close > ema20 &&
    vwap !== null &&
    close > vwap;

  const bearishTrend =
    ema20 !== null &&
    close < ema20 &&
    vwap !== null &&
    close < vwap;

  const callConfirmation =
    rsi14 !== null &&
    rsi14 > 65 &&
    volumePass &&
    bullishTrend &&
    bullishBreakout;

  const putConfirmation =
    rsi14 !== null &&
    rsi14 < 35 &&
    volumePass &&
    bearishTrend &&
    bearishBreakdown;

  return {
    ready: rsi14 !== null && averageVolume > 0,
    close,
    open,
    previousClose,
    latestVolume,
    averageVolume: Number(averageVolume.toFixed(2)),
    volumeRatio,
    volumePass,
    rsi14,
    ema20,
    vwap,
    resistance,
    support,
    bullishBreakout,
    bearishBreakdown,
    bullishTrend,
    bearishTrend,
    callConfirmation,
    putConfirmation,
    orderBlock,
    candleSignal: callConfirmation
      ? "CALL_CONFIRMATION"
      : putConfirmation
        ? "PUT_CONFIRMATION"
        : "WAIT",
    latestClosedCandle: latest,
    completed_count: validCandles.length
  };
}
// ==================================================
// PART 2 - UPSTOX MARKET DATA HELPERS
// ==================================================

function getAccessTokenStatus() {
  return Boolean(process.env.UPSTOX_ACCESS_TOKEN);
}

function getInstrumentKey(url) {
  return (
    url.searchParams.get("instrument_key") ||
    url.searchParams.get("symbol") ||
    ""
  );
}

async function getMarketQuote(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKey
  );

  return upstoxRequest(apiUrl.toString());
}

async function getHistoricalCandles(
  instrumentKey,
  interval = "5"
) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${interval}`
  );

  return upstoxRequest(apiUrl.toString());
}

async function getIntradayCandles(instrumentKey) {
  return getHistoricalCandles(instrumentKey, "5");
}

function extractQuote(quoteData, instrumentKey) {
  const data = quoteData?.data || {};

  if (data[instrumentKey]) {
    return data[instrumentKey];
  }

  const firstKey = Object.keys(data)[0];

  return firstKey ? data[firstKey] : {};
}

function extractPrice(quote) {
  const price = Number(
    quote?.last_price ??
    quote?.ltp ??
    quote?.last_traded_price ??
    0
  );

  return Number.isFinite(price) ? price : 0;
}

function extractVolume(quote) {
  const volume = Number(
    quote?.volume ??
    quote?.volume_traded ??
    0
  );

  return Number.isFinite(volume) && volume > 0
    ? volume
    : 0;
}

function extractOI(quote) {
  const oi = Number(
    quote?.oi ??
    quote?.open_interest ??
    0
  );

  return Number.isFinite(oi) ? oi : 0;
}

function extractCandles(response) {
  return response?.data?.candles || [];
}

// ==================================================
// OPTION CONTRACT HELPERS
// ==================================================

async function getOptionContracts(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/option/contract`
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKey
  );

  return upstoxRequest(apiUrl.toString());
}

async function getOptionChain(
  instrumentKey,
  expiryDate
) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/option/chain`
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKey
  );

  apiUrl.searchParams.set(
    "expiry_date",
    expiryDate
  );

  return upstoxRequest(apiUrl.toString());
}

function getNearestExpiry(contracts) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    return null;
  }

  const dates = contracts
    .map(c => c.expiry)
    .filter(Boolean)
    .sort();

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  return dates.find(date => date >= today) || null;
}

function normaliseOptionContract(contract) {
  return {
    instrument_key: contract.instrument_key,
    trading_symbol:
      contract.trading_symbol ||
      contract.name ||
      contract.instrument_key,
    underlying_key: contract.underlying_key,
    underlying_symbol: contract.underlying_symbol,
    expiry: contract.expiry,
    strike_price: Number(contract.strike_price),
    instrument_type: contract.instrument_type
  };
}

// ==================================================
// OPTION SNAPSHOTS
// ==================================================

function saveOptionSnapshot(key, quote) {
  optionSnapshots.set(key, {
    price: extractPrice(quote),
    volume: extractVolume(quote),
    oi: extractOI(quote),
    time: Date.now()
  });
}

function saveStockOptionSnapshot(key, quote) {
  stockOptionSnapshots.set(key, {
    price: extractPrice(quote),
    volume: extractVolume(quote),
    oi: extractOI(quote),
    time: Date.now()
  });
}

// ==================================================
// LONG BUILD-UP DETECTION
// ==================================================

function detectLongBuildUp(current, previous) {
  if (!current || !previous) {
    return {
      signal: "WAIT",
      long_build_up: false,
      reason: "Waiting for previous market data"
    };
  }

  const price = extractPrice(current);
  const previousPrice = Number(previous.price);

  const volume = extractVolume(current);
  const previousVolume = Number(previous.volume);

  const oi = extractOI(current);
  const previousOI = Number(previous.oi);

  const priceUp =
    price > 0 &&
    previousPrice > 0 &&
    price > previousPrice;

  const volumeUp =
    volume > 0 &&
    previousVolume > 0 &&
    volume > previousVolume;

  const oiUp =
    oi > 0 &&
    previousOI > 0 &&
    oi > previousOI;

  const longBuildUp =
    priceUp && volumeUp && oiUp;

  return {
    signal: longBuildUp ? "LONG_BUILD_UP" : "WAIT",
    long_build_up: longBuildUp,
    price,
    previous_price: previousPrice,
    volume,
    previous_volume: previousVolume,
    oi,
    previous_oi: previousOI,
    price_up: priceUp,
    volume_up: volumeUp,
    oi_up: oiUp,
    reason: longBuildUp
      ? "Price, volume and OI are increasing"
      : "All conditions are not confirmed",
    signal_time: new Date().toISOString()
  };
}

// ==================================================
// DEFAULT INDEXES
// ==================================================

const DEFAULT_INDEXES = [
  {
    name: "NIFTY",
    instrument_key: "NSE_INDEX|Nifty 50"
  },
  {
    name: "BANKNIFTY",
    instrument_key: "NSE_INDEX|Nifty Bank"
  },
  {
    name: "FINNIFTY",
    instrument_key: "NSE_INDEX|Nifty Fin Service"
  }
];

function getRequestedIndexes(url) {
  const raw = url.searchParams.get("indexes");

  if (!raw) {
    return DEFAULT_INDEXES;
  }

  const requested = raw
    .split(",")
    .map(s => s.trim().toUpperCase());

  return DEFAULT_INDEXES.filter(
    index => requested.includes(index.name)
  );
}
// ==================================================
// PART 3 - SMART TRADE SCANNER
// ==================================================

// NSE STOCK OPTIONS CONTRACT LIST
async function getNseStockOptions() {
  const instrumentsUrl =
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

  try {
    const response = await fetch(instrumentsUrl);

    if (!response.ok) {
      throw new Error(
        `Instrument download failed: HTTP ${response.status}`
      );
    }

    const zlib = require("zlib");
    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    let jsonText;

    try {
      jsonText = zlib.gunzipSync(buffer).toString("utf8");
    } catch {
      jsonText = buffer.toString("utf8");
    }

    const instruments = JSON.parse(jsonText);

    if (!Array.isArray(instruments)) {
      throw new Error(
        "Unexpected instrument data format"
      );
    }

    // Debug: inspect actual instrument field values
    const segmentCounts = {};
    const typeCounts = {};

    for (const item of instruments) {
      const segment = item.segment || "UNKNOWN";
      const type = item.instrument_type || "UNKNOWN";

      segmentCounts[segment] =
        (segmentCounts[segment] || 0) + 1;

      typeCounts[type] =
        (typeCounts[type] || 0) + 1;
    }

    console.log(
      "Total NSE instruments:",
      instruments.length
    );

    console.log(
      "Instrument segments:",
      JSON.stringify(segmentCounts)
    );

    console.log(
      "Instrument types:",
      JSON.stringify(typeCounts)
    );

    const stockOptions = instruments.filter(item =>
      item.instrument_type === "OPTSTK" &&
      item.instrument_key &&
      item.underlying_key
    );

    console.log(
      "Filtered stock options:",
      stockOptions.length
    );

    return {
      success: true,
      scanner: "NSE_STOCK_OPTIONS",
      total_instruments: instruments.length,
      count: stockOptions.length,
      contracts: stockOptions,
      debug: {
        segment_counts: segmentCounts,
        instrument_type_counts: typeCounts
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(
      "NSE instrument loading error:",
      error.message
    );
return {
success: false,
scanner: "NSE_STOCK_OPTIONS",
count: 0,
contracts: [],
error: error.message,
timestamp: new Date().toISOString()
};
    
  } catch (error) {
    return {
      success: false,
      scanner: "NSE_STOCK_OPTIONS",
      count: 0,
      contracts: [],
      error: error.message
    };
  }
}

// ==================================================
// STOCK OPTIONS SCANNER
// ==================================================

async function scanStockOptions(contracts) {
  const results = [];
  let checked = 0;

  for (const contract of contracts.slice(0, 100)) {
    const key = contract.instrument_key;

    if (!key) continue;

    try {
      const response = await getMarketQuote(key);
      const quote = extractQuote(response, key);
      const previous = stockOptionSnapshots.get(key);

      const price = extractPrice(quote);
      const volume = extractVolume(quote);
      const oi = extractOI(quote);

      const longBuildUp = detectLongBuildUp(
        quote,
        previous
      );

      results.push({
        symbol:
          contract.trading_symbol ||
          contract.name ||
          key,
        instrument_key: key,
        strike_price: contract.strike_price,
        option_type: contract.instrument_type,
        expiry: contract.expiry,
        price,
        volume,
        oi,
        long_build_up: longBuildUp.long_build_up,
        long_build_up_signal: longBuildUp.signal,
        long_build_up_details: longBuildUp,
        signal: longBuildUp.long_build_up
          ? "BULLISH"
          : "WAIT",
        signal_time: new Date().toISOString()
      });

      saveStockOptionSnapshot(key, quote);
      checked++;
    } catch (error) {
      results.push({
        symbol: contract.trading_symbol || key,
        instrument_key: key,
        signal: "WAIT",
        error: error.message
      });
    }
  }

  return {
    success: true,
    scanner: "NSE_STOCK_OPTIONS",
    checked,
    signals: results.filter(
      item => item.long_build_up === true
    ),
    all_results: results,
    timestamp: new Date().toISOString()
  };
}

// ==================================================
// INDEX OPTIONS SCANNER
// ==================================================

async function scanIndexOptions(url) {
  const indexes = getRequestedIndexes(url);
  const results = [];

  for (const index of indexes) {
    try {
      const contractResponse =
        await getOptionContracts(index.instrument_key);

      const contracts = contractResponse?.data || [];

      const expiry = getNearestExpiry(contracts);

      if (!expiry) {
        results.push({
          index: index.name,
          success: false,
          signal: "WAIT",
          reason: "No option expiry found"
        });

        continue;
      }

      const chainResponse = await getOptionChain(
        index.instrument_key,
        expiry
      );

      const chain = chainResponse?.data || [];

      const chainKeys = new Set();

      for (const item of chain) {
        if (item.instrument_key) {
          chainKeys.add(item.instrument_key);
        }

        if (item.call_options?.instrument_key) {
          chainKeys.add(
            item.call_options.instrument_key
          );
        }

        if (item.put_options?.instrument_key) {
          chainKeys.add(
            item.put_options.instrument_key
          );
        }
      }

      const selectedContracts = contracts
        .filter(contract =>
          contract.expiry === expiry &&
          contract.instrument_key &&
          (
            chainKeys.size === 0 ||
            chainKeys.has(contract.instrument_key)
          )
        )
        .slice(0, 20);

      for (const contract of selectedContracts) {
        try {
          const quoteResponse = await getMarketQuote(
            contract.instrument_key
          );

          const quote = extractQuote(
            quoteResponse,
            contract.instrument_key
          );

          const previous = optionSnapshots.get(
            contract.instrument_key
          );

          const price = extractPrice(quote);
          const volume = extractVolume(quote);
          const oi = extractOI(quote);

          const longBuildUp = detectLongBuildUp(
            quote,
            previous
          );

          results.push({
            index: index.name,
            symbol:
              contract.trading_symbol ||
              contract.name ||
              contract.instrument_key,
            instrument_key: contract.instrument_key,
            strike_price: contract.strike_price,
            option_type: contract.instrument_type,
            expiry,
            price,
            volume,
            oi,
            long_build_up: longBuildUp.long_build_up,
            signal: longBuildUp.long_build_up
              ? "BULLISH"
              : "WAIT",
            signal_time: new Date().toISOString()
          });

          saveOptionSnapshot(
            contract.instrument_key,
            quote
          );
        } catch (error) {
          results.push({
            index: index.name,
            instrument_key: contract.instrument_key,
            signal: "WAIT",
            error: error.message
          });
        }
      }
    } catch (error) {
      results.push({
        index: index.name,
        success: false,
        signal: "WAIT",
        error: error.message
      });
    }
  }

  return {
    success: true,
    scanner: "INDEX_OPTIONS",
    checked: results.length,
    signals: results.filter(
      item => item.long_build_up === true
    ),
    all_results: results,
    timestamp: new Date().toISOString()
  };
}

// ==================================================
// HTTP SERVER AND API ROUTES
// ==================================================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {
    // HEALTH CHECK
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        success: true,
        message: "Smart Trade India Backend running",
        timestamp: new Date().toISOString()
      });
    }

    // UPSTOX STATUS
    if (url.pathname === "/api/upstox/status") {
      return sendJson(res, 200, {
        success: true,
        token_configured: getAccessTokenStatus()
      });
    }

    // MARKET QUOTE
    if (
      url.pathname === "/api/market/quote" &&
      req.method === "GET"
    ) {
      const key = getInstrumentKey(url);

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

    // CANDLE ANALYSIS
    if (
      url.pathname === "/api/market/candles" &&
      req.method === "GET"
    ) {
      const key = getInstrumentKey(url);

      if (!key) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const response = await getIntradayCandles(key);

      const analysis = analyseCompletedCandles(
        extractCandles(response),
        5
      );

      return sendJson(res, 200, {
        success: true,
        instrument_key: key,
        analysis
      });
    }

    // INDEX OPTIONS AUTO SCAN
    if (
      url.pathname === "/api/options/auto-scan" &&
      req.method === "GET"
    ) {
      const result = await scanIndexOptions(url);

      return sendJson(res, 200, result);
    }

    // NSE STOCK OPTION CONTRACTS
    if (
      url.pathname === "/api/options/nse-stocks" &&
      req.method === "GET"
    ) {
      const result = await getNseStockOptions();

      return sendJson(
        res,
        result.success ? 200 : 502,
        result
      );
    }// NSE STOCK OPTIONS SCANNER
    if (
      url.pathname === "/api/options/nse-stocks/scan" &&
      req.method === "GET"
    ) {
      const contractResponse =
        await getNseStockOptions();

      if (!contractResponse.success) {
        return sendJson(res, 502, {
          success: false,
          error: contractResponse.error
        });
      }

      const expiry = url.searchParams.get("expiry");

      const contracts = expiry
        ? contractResponse.contracts.filter(
            contract => contract.expiry === expiry
          )
        : contractResponse.contracts;

      const result = await scanStockOptions(contracts);

      return sendJson(res, 200, result);
    }

    // LONG BUILD-UP STOCKS
    if (
      url.pathname === "/api/stocks/long-build-up" &&
      req.method === "GET"
    ) {
      const contractResponse =
        await getNseStockOptions();

      if (!contractResponse.success) {
        return sendJson(res, 502, {
          success: false,
          error: contractResponse.error
        });
      }

      const result = await scanStockOptions(
        contractResponse.contracts
      );

      return sendJson(res, 200, {
        success: true,
        scanner: "LONG_BUILD_UP_STOCKS",
        total_checked: result.checked,
        long_build_up_stocks: result.signals || [],
        all_results: result.all_results || [],
        timestamp: new Date().toISOString()
      });
    }

    // FULL QUOTE
    if (
      url.pathname === "/api/market/full-quotes" &&
      req.method === "GET"
    ) {
      const key = getInstrumentKey(url);

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

    // ROUTE NOT FOUND
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
      error: error.message || "Internal server error"
    });
  }
});

// ==================================================
// START SERVER
// ==================================================

server.listen(PORT, () => {
  console.log(
    `Smart Trade India Backend running on port ${PORT}`
  );
});
