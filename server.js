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

  const closes = completed.map(c => Number(c[4]));
  const volumes = completed.map(c => Number(c[5] || 0));

  const latestVolume = volumes[volumes.length - 1];

  const averageVolume =
    volumes.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;

  const rsi14 = calculateWilderRSI(closes, 14);

  return {
    ready: averageVolume > 0 && rsi14 !== null,
    rsi14,
    currentVolume: latestVolume,
    averageVolume: Number(averageVolume.toFixed(2)),
    volumeRatio:
      averageVolume > 0
        ? Number((latestVolume / averageVolume).toFixed(2))
        : 0,
    volumePass:
      averageVolume > 0 &&
      latestVolume >= averageVolume * 1.5,
    close: closes[closes.length - 1],
    previousClose: closes[closes.length - 2],
    latestClosedCandle: completed[completed.length - 1],
    completed_count: completed.length
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
  return Number(
    quote?.volume ??
    quote?.volume_traded ??
    0
  );
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

function createOptionSignal(contract, quote, previous) {
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
    signal:
      priceUp && volumeUp && oiUp
        ? "BULLISH"
        : "WAIT",
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
[15/10, 10:17 pm] rangaswamy: // ==================================================
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
[15/10, 10:18 pm] rangaswamy: // ==================================================
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
