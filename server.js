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

function calculateWilderRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = Number(closes[i]) - Number(closes[i - 1]);

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = Number(closes[i]) - Number(closes[i - 1]);

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return Number(
    (100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)
  );
}

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

function analyseCompletedCandles(candles, intervalMinutes = 5) {
  const completed = getClosedCandles(candles, intervalMinutes);

  if (completed.length < 21) {
    return {
      ready: false,
      reason: "NEED_21_COMPLETED_CANDLES",
      completed_count: completed.length
    };
  }

  const validCandles = completed.filter(c =>
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
  const volumes = validCandles.map(c => Number(c[5]));

  const latest = validCandles[validCandles.length - 1];
  const previous = validCandles[validCandles.length - 2];

  const close = Number(latest[4]);
  const open = Number(latest[1]);
  const previousClose = Number(previous[4]);
  const latestVolume = volumes[volumes.length - 1];

  const averageVolume =
    volumes.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;

  const rsi14 = calculateWilderRSI(closes, 14);

  function calculateEMA(values, period) {
    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema = values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return Number(ema.toFixed(2));
  }

  const ema20 = calculateEMA(closes, 20);

  let totalPV = 0;
  let totalVolume = 0;

  for (const candle of validCandles) {
    const typicalPrice =
      (Number(candle[2]) +
        Number(candle[3]) +
        Number(candle[4])) / 3;

    const volume = Number(candle[5]);

    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  const vwap =
    totalVolume > 0
      ? Number((totalPV / totalVolume).toFixed(2))
      : null;

  const previousCandles = validCandles.slice(-21, -1);

  const resistance = Math.max(
    ...previousCandles.map(c => Number(c[2]))
  );

  const support = Math.min(
    ...previousCandles.map(c => Number(c[3]))
  );

  const volumeRatio =
    averageVolume > 0 ? latestVolume / averageVolume : 0;

  const volumePass =
    averageVolume > 0 &&
    latestVolume >= averageVolume * 1.5;

  const bullishBreakout = close > resistance;
  const bearishBreakdown = close < support;

  const bullishTrend =
    close > open &&
    ema20 !== null &&
    close > ema20 &&
    vwap !== null &&
    close > vwap;

  const bearishTrend =
    close < open &&
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
    rsi14,
    currentVolume: latestVolume,
    averageVolume: Number(averageVolume.toFixed(2)),
    volumeRatio: Number(volumeRatio.toFixed(2)),
    volumePass,
    ema20,
    vwap,
    support: Number(support.toFixed(2)),
    resistance: Number(resistance.toFixed(2)),
    bullishBreakout,
    bearishBreakdown,
    bullishTrend,
    bearishTrend,
    callConfirmation,
    putConfirmation,
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
// UPSTOX MARKET DATA HELPERS
// ==================================================

function getAccessTokenStatus() {
  return Boolean(process.env.UPSTOX_ACCESS_TOKEN);
}

function getInstrumentKey(url) {
  return (
    url.searchParams.get("instrument_key") ||
    url.searchParams.get("instrumentKey") ||
    ""
  ).trim();
}

async function getMarketQuote(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  apiUrl.searchParams.set("instrument_key", instrumentKey);

  return upstoxRequest(apiUrl.toString());
}

async function getOptionContracts(instrumentKey, expiryDate) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/option/contract`
  );

  apiUrl.searchParams.set("instrument_key", instrumentKey);

  if (expiryDate) {
    apiUrl.searchParams.set("expiry_date", expiryDate);
  }

  return upstoxRequest(apiUrl.toString());
}

async function getOptionChain(instrumentKey, expiryDate) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/option/chain`
  );

  apiUrl.searchParams.set("instrument_key", instrumentKey);

  if (expiryDate) {
    apiUrl.searchParams.set("expiry_date", expiryDate);
  }

  return upstoxRequest(apiUrl.toString());
}

async function getHistoricalCandles(
  instrumentKey,
  interval = "5minute"
) {
  const today = new Date().toISOString().slice(0, 10);

  const apiUrl = new URL(
    `${UPSTOX_BASE}/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${today}`
  );

  return upstoxRequest(apiUrl.toString());
}

async function getIntradayCandles(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/5`
  );

  return upstoxRequest(apiUrl.toString());
}

function extractQuote(quoteData, instrumentKey) {
  const data = quoteData?.data || {};

  if (data[instrumentKey]) {
    return data[instrumentKey];
  }

  const firstKey = Object.keys(data)[0];

  return firstKey ? data[firstKey] : null;
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
  const volume = Number(
    quote?.volume ??
    quote?.volume_traded ??
    quote?.volumeTraded ??
    quote?.total_traded_quantity ??
    quote?.total_volume ??
    0
  );

  return Number.isFinite(volume) && volume > 0 ? volume : 0;
}

function extractOI(quote) {
  return Number(
    quote?.oi ??
    quote?.open_interest ??
    0
  );
}

function extractCandles(response) {
  return response?.data?.candles || [];
}

function getNearestExpiry(contracts) {
  const dates = (Array.isArray(contracts) ? contracts : [])
    .map(c => c.expiry)
    .filter(Boolean)
    .sort();

  if (!dates.length) {
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);

  return dates.find(date => date >= today) || dates[0];
}

function normaliseOptionContract(contract) {
  return {
    instrument_key: contract?.instrument_key || "",
    trading_symbol: contract?.trading_symbol || "",
    name: contract?.name || "",
    expiry: contract?.expiry || "",
    strike_price: Number(contract?.strike_price || 0),
    instrument_type: contract?.instrument_type || "",
    lot_size: Number(contract?.lot_size || 0)
  };
}

// ==================================================
// OPTION SIGNAL HELPERS
// ==================================================

// ==================================================
// SMART MONEY OPTION BUY SIGNAL
// ==================================================

function createOptionSignal(contract, quote, previous) {
  const price = extractPrice(quote);
  const volume = extractVolume(quote);
  const oi = extractOI(quote);

  const previousPrice = previous?.price ?? null;
  const previousVolume = previous?.volume ?? null;
  const previousOI = previous?.oi ?? null;

  const priceUp =
    previousPrice !== null &&
    price > previousPrice;

  const volumeUp =
    previousVolume !== null &&
    volume > previousVolume;

  const oiUp =
    previousOI !== null &&
    oi > previousOI;

  const validData =
    price > 0 &&
    previousPrice !== null &&
    previousVolume !== null &&
    previousOI !== null;

  const longBuildUp =
    validData &&
    priceUp &&
    volumeUp &&
    oiUp;

  return {
    symbol: contract.trading_symbol,
    instrument_key: contract.instrument_key,
    expiry: contract.expiry,
    strike_price: contract.strike_price,
    option_type: contract.instrument_type,

    price,
    volume,
    oi,

    previous_price: previousPrice,
    previous_volume: previousVolume,
    previous_oi: previousOI,

    price_up: priceUp,
    volume_up: volumeUp,
    oi_up: oiUp,

    long_build_up: longBuildUp,

    long_build_up_signal: longBuildUp
      ? "LONG_BUILD_UP"
      : "WAIT",

    smart_money_buy: longBuildUp,

    signal: longBuildUp
      ? "BULLISH"
      : "WAIT",

    signal_time: new Date().toISOString()
  };
}// ==================================================
// PART 2/3 — ZERO HERO + STRONG MOMENTUM SCANNER
// ==================================================

const DEFAULT_INDEXES = {
  NIFTY: {
    name: "NIFTY",
    instrument_key: "NSE_INDEX|Nifty 50"
  },
  BANKNIFTY: {
    name: "BANKNIFTY",
    instrument_key: "NSE_INDEX|Nifty Bank"
  },
  FINNIFTY: {
    name: "FINNIFTY",
    instrument_key: "NSE_INDEX|Nifty Fin Service"
  },
  SENSEX: {
    name: "SENSEX",
    instrument_key: "BSE_INDEX|SENSEX"
  }
};

// --------------------------------------------------
// OPTION CONTRACT HELPERS
// --------------------------------------------------

function getOptionType(contract) {
  const type = String(
    contract?.instrument_type ||
    contract?.option_type ||
    ""
  ).toUpperCase();

  if (type === "CE" || type === "CALL") return "CE";
  if (type === "PE" || type === "PUT") return "PE";

  return "";
}

function getOptionStrike(contract) {
  const strike = Number(
    contract?.strike_price ??
    contract?.strike ??
    0
  );

  return Number.isFinite(strike) ? strike : 0;
}

// --------------------------------------------------
// OPTION COMPLETED 5-MINUTE VOLUME ANALYSIS
// --------------------------------------------------

function getCompletedOptionVolumeAnalysis(candles) {
  const completed = getClosedCandles(candles, 5);

  if (completed.length < 21) {
    return {
      ready: false,
      reason: "NEED_21_COMPLETED_OPTION_CANDLES",
      completed_count: completed.length,
      volume_blast: false,
      volume_ratio: 0
    };
  }

  const latest = completed[completed.length - 1];

  const latestVolume = Number(latest[5] || 0);

  const previous20 = completed
    .slice(-21, -1)
    .map(c => Number(c[5] || 0));

  const averageVolume =
    previous20.reduce((sum, volume) => sum + volume, 0) / 20;

  const volumeRatio =
    averageVolume > 0
      ? latestVolume / averageVolume
      : 0;

  return {
    ready: averageVolume > 0,
    latest_volume: latestVolume,
    average_volume: Number(averageVolume.toFixed(2)),
    volume_ratio: Number(volumeRatio.toFixed(2)),
    volume_blast:
      averageVolume > 0 &&
      latestVolume >= averageVolume * 1.5,
    completed_count: completed.length
  };
}

// --------------------------------------------------
// UNDERLYING TREND CLASSIFICATION
// --------------------------------------------------

function classifyUnderlyingTrend(analysis) {
  if (!analysis || !analysis.ready) {
    return {
      trend: "UNKNOWN",
      bullish: false,
      bearish: false,
      strong_bullish: false,
      strong_bearish: false
    };
  }

  const close = Number(analysis.close);
  const ema20 = Number(analysis.ema20);
  const vwap = Number(analysis.vwap);
  const rsi = Number(analysis.rsi14);

  const valid =
    Number.isFinite(close) &&
    Number.isFinite(ema20) &&
    Number.isFinite(vwap) &&
    Number.isFinite(rsi);

  if (!valid) {
    return {
      trend: "UNKNOWN",
      bullish: false,
      bearish: false,
      strong_bullish: false,
      strong_bearish: false
    };
  }

  const bullish =
    close > ema20 &&
    close > vwap &&
    rsi >= 60;

  const bearish =
    close < ema20 &&
    close < vwap &&
    rsi <= 40;

  return {
    trend: bullish
      ? "BULLISH"
      : bearish
        ? "BEARISH"
        : "SIDEWAYS",

    bullish,
    bearish,

    strong_bullish: bullish && rsi >= 70,
    strong_bearish: bearish && rsi <= 30,

    rsi14: rsi,
    ema20,
    vwap,
    close
  };
}

// --------------------------------------------------
// SNAPSHOT HELPERS
// --------------------------------------------------

function saveOptionSnapshot(instrumentKey, quote) {
  optionSnapshots.set(instrumentKey, {
    price: extractPrice(quote),
    volume: extractVolume(quote),
    oi: extractOI(quote),
    timestamp: Date.now()
  });
}

function saveStockOptionSnapshot(instrumentKey, quote) {
  stockOptionSnapshots.set(instrumentKey, {
    price: extractPrice(quote),
    volume: extractVolume(quote),
    oi: extractOI(quote),
    timestamp: Date.now()
  });
}

// --------------------------------------------------
// SCAN ZERO HERO AND STRONG MOMENTUM OPTIONS
// --------------------------------------------------

async function scanZeroHeroAndMomentum(url) {
  const requestedIndexes = (
    url.searchParams.get("indexes") ||
    "NIFTY,BANKNIFTY,SENSEX,FINNIFTY"
  )
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  const zeroHero = [];
  const strongMomentum = [];
  const allCandidates = [];
  const errors = [];

  const premiumMin = Number(
    url.searchParams.get("min_premium") || 10
  );

  const premiumMax = Number(
    url.searchParams.get("max_premium") || 50
  );

  const minimumRSI = Number(
    url.searchParams.get("min_rsi") || 60
  );

  const strongRSI = Number(
    url.searchParams.get("strong_rsi") || 70
  );

  for (const indexName of requestedIndexes) {
    const index = DEFAULT_INDEXES[indexName];

    if (!index) {
      errors.push({
        index: indexName,
        error: "UNSUPPORTED_INDEX"
      });
      continue;
    }

    try {
      // 1. Underlying quote
      const underlyingQuoteResponse =
        await getMarketQuote(index.instrument_key);

      const underlyingQuote = extractQuote(
        underlyingQuoteResponse,
        index.instrument_key
      );

      if (!underlyingQuote) {
        errors.push({
          index: indexName,
          error: "UNDERLYING_QUOTE_NOT_FOUND"
        });
        continue;
      }

      const underlyingPrice = extractPrice(underlyingQuote);

      // 2. Underlying 5-minute candles
      const underlyingCandleResponse =
        await getIntradayCandles(index.instrument_key);

      const underlyingCandles =
        extractCandles(underlyingCandleResponse);

      const underlyingAnalysis =
        analyseCompletedCandles(underlyingCandles, 5);

      const trend =
        classifyUnderlyingTrend(underlyingAnalysis);

      // 3. Option contracts
      const contractsResponse =
        await getOptionContracts(index.instrument_key);

      const rawContracts =
        Array.isArray(contractsResponse?.data)
          ? contractsResponse.data
          : [];

      if (!rawContracts.length) {
        errors.push({
          index: indexName,
          error:error.message
      });
    }
  }

  return {
    success: true,
    scanner: "ZERO_HERO_AND_STRONG_MOMENTUM",
    timestamp: new Date().toISOString(),

    settings: {
      indexes: requestedIndexes,
      min_premium: premiumMin,
      max_premium: premiumMax,
      minimum_rsi: minimumRSI,
      strong_rsi: strongRSI,
      option_volume_blast_multiplier: 1.5
    },

    summary: {
      candidates_checked: allCandidates.length,
      zero_hero_count: zeroHero.length,
      strong_momentum_count: strongMomentum.length,
      error_count: errors.length
    },

    zero_hero: zeroHero,
    strong_momentum: strongMomentum,
    all_candidates: allCandidates,
    errors
  };
  }// ==================================================
// PART 3/3 — API ROUTES + SERVER START
// ==================================================

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const baseUrl = `http://${req.headers.host || "localhost"}`;
  const url = new URL(req.url, baseUrl);
  const pathname = url.pathname;

  try {
    // ----------------------------------------------
    // HEALTH CHECK
    // ----------------------------------------------
    if (pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, {
        success: true,
        message: "Smart Market Scanner backend is running",
        timestamp: new Date().toISOString()
      });
    }

    // ----------------------------------------------
    // UPSTOX CONNECTION STATUS
    // ----------------------------------------------
    if (
      pathname === "/api/upstox/status" &&
      req.method === "GET"
    ) {
      return sendJson(res, 200, {
        success: true,
        connected: getAccessTokenStatus(),
        message: getAccessTokenStatus()
          ? "Upstox access token is configured"
          : "UPSTOX_ACCESS_TOKEN is missing",
        timestamp: new Date().toISOString()
      });
    }

    // ----------------------------------------------
    // MARKET QUOTE
    // ----------------------------------------------
    if (
      pathname === "/api/market/quote" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key query parameter is required"
        });
      }

      const data = await getMarketQuote(instrumentKey);

      return sendJson(res, 200, {
        success: true,
        instrument_key: instrumentKey,
        data,
        timestamp: new Date().toISOString()
      });
    }

    // ----------------------------------------------
    // MARKET 5-MINUTE CANDLES
    // ----------------------------------------------
    if (
      pathname === "/api/market/candles" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key query parameter is required"
        });
      }

      const response =
        await getIntradayCandles(instrumentKey);

      const candles = extractCandles(response);
      const analysis =
        analyseCompletedCandles(candles, 5);

      return sendJson(res, 200, {
        success: true,
        instrument_key: instrumentKey,
        timeframe: "5minute",
        analysis,
        timestamp: new Date().toISOString()
      });
    }

    // ----------------------------------------------
    // ZERO HERO + STRONG MOMENTUM SCANNER
    // ----------------------------------------------
    if (
      pathname === "/api/options/zero-hero-momentum" &&
      req.method === "GET"
    ) {
      const result = await scanZeroHeroAndMomentum(url);

      return sendJson(res, 200, result);
    }

    // ----------------------------------------------
    // OPTION CONTRACTS
    // ----------------------------------------------
    if (
      pathname === "/api/options/contracts" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);
      const expiry = url.searchParams.get("expiry");

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key query parameter is required"
        });
      }

      const data = await getOptionContracts(
        instrumentKey,
        expiry
      );

      return sendJson(res, 200, {
        success: true,
        instrument_key: instrumentKey,
        expiry: expiry || null,
        data
      });
    }

    // ----------------------------------------------
    // OPTION CHAIN
    // ----------------------------------------------
    if (
      pathname === "/api/options/chain" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);
      const expiry = url.searchParams.get("expiry");

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key query parameter is required"
        });
      }

      const data = await getOptionChain(
        instrumentKey,
        expiry
      );

      return sendJson(res, 200, {
        success: true,
        instrument_key: instrumentKey,
        expiry: expiry || null,
        data
      });
    }

    // ----------------------------------------------
    // SCANNER CONFIGURATION
    // ----------------------------------------------
    if (
      pathname === "/api/scanner/config" &&
      req.method === "GET"
    ) {
      return sendJson(res, 200, {
        success: true,
        indexes: Object.keys(DEFAULT_INDEXES),
        settings: {
          timeframe: "5minute",
          zero_hero_min_premium: 10,
          zero_hero_max_premium: 50,
          default_rsi: 60,
          strong_rsi: 70,
          volume_blast_multiplier: 1.5,
          completed_candles_required: 21
        },
        scanner_endpoint:
          "/api/options/zero-hero-momentum"
      });
    }

    // ----------------------------------------------
    // NOT FOUND
    // ----------------------------------------------
    return sendJson(res, 404, {
      success: false,
      error: "API route not found",
      path: pathname
    });

  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${pathname}:`,
      error.message
    );

    return sendJson(res, 500, {
      success: false,
      error: error.message,
      path: pathname,
      timestamp: new Date().toISOString()
    });
  }
});

// ----------------------------------------------
// START SERVER
// ----------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Smart Market Scanner server listening on port ${PORT}`
  );
});

// ----------------------------------------------
// GRACEFUL SHUTDOWN
// ----------------------------------------------
process.on("SIGTERM", () => {
  console.log("SIGTERM received. Closing server...");

  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});
