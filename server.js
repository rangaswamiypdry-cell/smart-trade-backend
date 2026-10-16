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
  const highs = validCandles.map(c => Number(c[2]));
  const lows = validCandles.map(c => Number(c[3]));
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

  // EMA calculation
  function calculateEMA(values, period) {
    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema = values.slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return Number(ema.toFixed(2));
  }

  const ema20 = calculateEMA(closes, 20);

  // VWAP for available completed candles
  let totalPV = 0;
  let totalVolume = 0;

  for (const candle of validCandles) {
    const typicalPrice =
      (Number(candle[2]) + Number(candle[3]) + Number(candle[4])) / 3;

    const volume = Number(candle[5]);

    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  const vwap =
    totalVolume > 0
      ? Number((totalPV / totalVolume).toFixed(2))
      : null;

  // Previous 20 candles' resistance and support
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
    averageVolume > 0 && latestVolume >= averageVolume * 1.5;

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
    rsi14 >= 65 &&
    volumePass &&
    bullishTrend &&
    bullishBreakout;

  const putConfirmation =
    rsi14 !== null &&
    rsi14 <= 35 &&
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
  )
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

function createOptionSignal(contract, quote, previous) {// LONG BUILD-UP DETECTION
const longBuildUp = detectLongBuildUp(
  quote,
  previous
);

signal.long_build_up = longBuildUp.long_build_up;
signal.long_build_up_signal = longBuildUp.signal;
signal.long_build_up_details = longBuildUp;

if (longBuildUp.long_build_up) {
  signal.signal = "LONG_BUILD_UP";
}
  const price = extractPrice(quote);
  const volume = extractVolume(quote);
  const oi = extractOI(quote);

  const previousPrice = previous?.price ?? null;
  const previousVolume = previous?.volume ?? null;
  const previousOI = previous?.oi ?? null;

  const priceUp =
    previousPrice !== null && price > previousPrice;

  const volumeUp =
    previousVolume !== null && volume > previousVolume;

  const oiUp =
    previousOI !== null && oi > previousOI;

  const validData =
    price > 0 &&
    previousPrice !== null &&
    previousVolume !== null &&
    previousOI !== null;

  const buy = validData && priceUp && volumeUp && oiUp;

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
    smart_money_buy: buy,
    signal: buy ? "BULLISH" : "WAIT",
    signal_time: new Date().toISOString()
  };
   }

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
  const previousPrice = extractPrice(previous);

  const volume = extractVolume(current);
  const previousVolume = extractVolume(previous);

  const oi = extractOI(current);
  const previousOI = extractOI(previous);

  const priceUp =
    price > 0 && previousPrice > 0 &&
    price > previousPrice;

  const volumeUp =
    volume > 0 && previousVolume > 0 &&
    volume > previousVolume;

  const oiUp =
    oi > 0 && previousOI > 0 &&
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
      : "All three conditions are not confirmed",
    signal_time: new Date().toISOString()
  };
}
// ==================================================
// STOCK SYMBOL HELPERS
// ==================================================
// ==================================================
// STOCK SYMBOL HELPERS
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
  },
  {
    name: "SENSEX",
    instrument_key: "BSE_INDEX|SENSEX"
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

  return DEFAULT_INDEXES.filter(index =>
    requested.includes(index.name)
  );
}
// ==================================================
// SMART MONEY + STRONG MOMENTUM BUY FILTER
// ==================================================

function detectSmartMoneyBuy(data) {
  if (!data || typeof data !== "object") {
    return {
      buy: false,
      signal: "WAIT",
      reason: "Market data unavailable"
    };
  }

  const price = Number(data.price);
  const previousPrice = Number(data.previousPrice);
  const volume = Number(data.volume);
  const averageVolume20 = Number(data.averageVolume20);
  const oi = Number(data.oi);
  const previousOI = Number(data.previousOI);
  const rsi = Number(data.rsi14);
  const close = Number(data.close);
  const open = Number(data.open);
  const vwap = Number(data.vwap);
  const resistance = Number(data.resistance);
  const cmf = Number(data.cmf20);

  const values = [
    price, previousPrice, volume, averageVolume20,
    oi, previousOI, rsi, close, open, vwap,
    resistance, cmf
  ];

  if (!values.every(Number.isFinite)) {
    return {
      buy: false,
      signal: "WAIT",
      reason: "Indicator data missing"
    };
  }

  const conditions = {
    priceRising: price > previousPrice,
    bullishCandle: close > open,
    volumeSpike:
      averageVolume20 > 0 &&
      volume >= averageVolume20 * 1.5,
    oiIncreasing: oi > previousOI,
    rsiStrong: rsi > 55,
    aboveVWAP: close > vwap,
    resistanceBreakout: close > resistance,
    positiveMoneyFlow: cmf > 0
  };

  const buy = Object.values(conditions).every(Boolean);

  return {
    buy,
    signal: buy ? "SMART_MONEY_BUY" : "WAIT",
    conditions,
    price,
    rsi
  };
}

// ==================================================
// INDEX OPTIONS AUTO SCANNER
// ==================================================
async function scanIndexOptions(url) {
  const indexes = getRequestedIndexes(url);
  const results = [];

  for (const index of indexes) {
    try {
      const contractsResponse =
        await getOptionContracts(index.instrument_key);

      const contracts = contractsResponse?.data || [];

      if (!contracts.length) {
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

      const expiryContracts = contracts
        .filter(c => !expiry || c.expiry === expiry)
        .map(normaliseOptionContract)
        .filter(c => c.instrument_key);

      const chainResponse =
        await getOptionChain(index.instrument_key, expiry);

      const chain = chainResponse?.data || [];

      const chainKeys = new Set(
        expiryContracts.map(c => c.instrument_key)
      );

      const selectedContracts = expiryContracts
        .filter(c => chainKeys.has(c.instrument_key))
        .slice(0, 30);

      const signals = [];

      for (const contract of selectedContracts) {
        try {
          const quoteResponse =
            await getMarketQuote(contract.instrument_key);

          const quote = extractQuote(
            quoteResponse,
            contract.instrument_key
          );

          if (!quote) continue;

          const previous =
            optionSnapshots.get(contract.instrument_key);

const signal = createOptionSignal(
  contract,
  quote,
  previous
);

// Smart Money filter
const smartMoney = detectSmartMoneyBuy({
  price: quote.price,
  previousPrice: previous?.price,
  volume: quote.volume,
  averageVolume20: quote.averageVolume20,
  oi: quote.oi,
  previousOI: previous?.oi,
  rsi14: quote.rsi14,
  close: quote.close,
  open: quote.open,
  vwap: quote.vwap,
  resistance: quote.resistance,
  cmf20: quote.cmf20
});

signal.smart_money = smartMoney;

if (smartMoney.buy) {
  signal.signal = "BULLISH";
  signal.smart_money_buy = true;
} else {
  signal.smart_money_buy = false;
}

signals.push(signal);          

          saveOptionSnapshot(
            contract.instrument_key,
            quote
          );
        } catch (error) {
          signals.push({
            symbol: contract.trading_symbol,
            error: error.message
          });
        }
      }

      results.push({
        index: index.name,
        expiry,
        contracts_checked: selectedContracts.length,
        signals: signals.filter(
          s => s.signal === "BULLISH"
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

// ==================================================
// NSE STOCK OPTIONS CONTRACT LIST
// ==================================================

async function getNseStockOptions() {
  const indexes = [
    "NSE_INDEX|Nifty 50",
    "NSE_INDEX|Nifty Bank"
  ];

  const allContracts = [];
  const errors = [];

  for (const instrumentKey of indexes) {
    try {
      const response = await getOptionContracts(instrumentKey);
      const contracts = response?.data || [];

      allContracts.push(...contracts);
    } catch (error) {
      errors.push({
        instrument_key: instrumentKey,
        error: error.message
      });
    }
  }

  const unique = new Map();

  for (const contract of allContracts) {
    if (!contract.instrument_key) continue;

    unique.set(
      contract.instrument_key,
      normaliseOptionContract(contract)
    );
  }

  return {
    success: errors.length === 0,
    count: unique.size,
    contracts: Array.from(unique.values()),
    errors
  };
}

// ==================================================
// STOCK OPTION SCANNER
// ==================================================

async function scanStockOptions(contracts) {
  const results = [];

  for (const contract of contracts.slice(0, 20)) {
    try {
      const quoteResponse =
        await getMarketQuote(contract.instrument_key);

      const quote = extractQuote(
        quoteResponse,
        contract.instrument_key
      );

      if (!quote) continue;

      const key = contract.instrument_key;
      const previous = stockOptionSnapshots.get(key);

      const signal = createOptionSignal(
        contract,
        quote,
        previous
      );

      results.push(signal);
      saveStockOptionSnapshot(key, quote);
    } catch (error) {
      results.push({
        symbol: contract.trading_symbol,
        error: error.message
      });
    }
  }

  return {
    success: true,
    timestamp: new Date().toISOString(),
    checked: results.length,
    signals: results.filter(
      s => s.signal === "BULLISH"
    ),
    all_results: results
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
      const instrumentKey = getInstrumentKey(url);

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const quote = await getMarketQuote(instrumentKey);

      return sendJson(res, 200, {
        success: true,
        data: quote.data || {}
      });
    }

    // HISTORICAL CANDLES
    if (
      url.pathname === "/api/market/candles" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const response =
        await getIntradayCandles(instrumentKey);

      const analysis = analyseCompletedCandles(
        extractCandles(response),
        5
      );

      return sendJson(res, 200, {
        success: true,
        instrument_key: instrumentKey,
        analysis
      });
    }

    // INDEX OPTIONS SCANNER
    if (
      url.pathname === "/api/options/auto-scan" &&
      req.method === "GET"
    ) {
      const result = await scanIndexOptions(url);

      return sendJson(res, 200, result);
    }

    // STOCK OPTIONS CONTRACTS
    if (
      url.pathname === "/api/options/nse-stocks" &&
      req.method === "GET"
    ) {
      const result = await getNseStockOptions();

      return sendJson(res, 200, result);
    }

    // STOCK OPTIONS SCANNER
    if (
      url.pathname === "/api/options/nse-stocks/scan" &&
      req.method === "GET"
    ) {
      const contractResponse =
        await getNseStockOptions();

      const contracts = contractResponse.contracts || [];

      const requestedExpiry = url.searchParams.get("expiry");

      const filtered = contracts.filter(contract =>
        !requestedExpiry ||
        contract.expiry === requestedExpiry
      );

      const result = await scanStockOptions(filtered);

      return sendJson(res, 200, result);
    }

    // FULL QUOTE
    if (
      url.pathname === "/api/market/full-quotes" &&
      req.method === "GET"
    ) {
      const instrumentKey = getInstrumentKey(url);

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const response = await getMarketQuote(instrumentKey);

      return sendJson(res, 200, {
        success: true,
        data: response.data || {}
      });
    }

    // NOT FOUND
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
