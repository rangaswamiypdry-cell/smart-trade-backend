// ============================================
// PART 1/3
// NSE STOCK OPTIONS MOMENTUM SCANNER
// ============================================

const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = "https://api.upstox.com";

const optionSnapshots = new Map();
const stockSnapshots = new Map();

// ============================================
// CORS
// ============================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
    "Access-Control-Allow-Methods":
      "GET, OPTIONS"
  };
}

// ============================================
// JSON RESPONSE
// ============================================

function sendJson(res, status, data) {
  if (res.writableEnded) return;

  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify(data));
}

// ============================================
// UPSTOX API
// ============================================

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
      `Invalid Upstox response: HTTP ${response.status}`
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

// ============================================
// LOAD NSE OPTION CONTRACTS
// ============================================

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

    const compressed = Buffer.from(
      await response.arrayBuffer()
    );

    const jsonText = zlib.gunzipSync(
      compressed
    ).toString("utf8");

    const instruments = JSON.parse(jsonText);

    if (!Array.isArray(instruments)) {
      throw new Error("Invalid instrument data");
    }

    // Only actual stock option contracts.
    const contracts = instruments.filter(item =>
      item.segment === "NSE_FO" &&
      item.instrument_type === "CE" &&
      item.underlying_type === "EQUITY" &&
      item.underlying_symbol &&
      item.instrument_key &&
      item.expiry
    );

    const putContracts = instruments.filter(item =>
      item.segment === "NSE_FO" &&
      item.instrument_type === "PE" &&
      item.underlying_type === "EQUITY" &&
      item.underlying_symbol &&
      item.instrument_key &&
      item.expiry
    );

    const allContracts = [
      ...contracts,
      ...putContracts
    ];

    const today = new Date()
      .toISOString()
      .slice(0, 10);

    const validContracts = allContracts.filter(
      item => String(item.expiry) >= today
    );

    return {
      success: true,
      scanner: "NSE_STOCK_OPTIONS",
      count: validContracts.length,
      contracts: validContracts,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    return {
      success: false,
      scanner: "NSE_STOCK_OPTIONS",
      count: 0,
      contracts: [],
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// ============================================
// OPTION CONTRACT NORMALISATION
// ============================================

function normaliseContract(contract) {
  return {
    symbol:
      contract.underlying_symbol ||
      contract.name ||
      "",
    trading_symbol:
      contract.trading_symbol || "",
    instrument_key:
      contract.instrument_key || "",
    instrument_type:
      contract.instrument_type || "",
    strike_price:
      Number(contract.strike_price || 0),
    lot_size:
      Number(contract.lot_size || 0),
    expiry:
      contract.expiry || ""  };
}
      // ============================================
// PART 2/3
// HIGH MOMENTUM + STRIKE PRICE SELECTION
// ============================================

// ============================================
// GET OPTION QUOTE
// ============================================

async function getOptionQuote(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKey
  );

  const response = await upstoxRequest(
    apiUrl.toString()
  );

  const data = response?.data || {};

  return (
    data[instrumentKey] ||
    Object.values(data)[0] ||
    null
  );
}

// ============================================
// QUOTE HELPERS
// ============================================

function getOptionPrice(quote) {
  return Number(
    quote?.last_price ??
    quote?.ltp ??
    0
  );
}

function getOptionVolume(quote) {
  return Number(
    quote?.volume ??
    quote?.volume_traded ??
    quote?.volumeTraded ??
    0
  );
}

function getOptionOI(quote) {
  return Number(
    quote?.oi ??
    quote?.open_interest ??
    0
  );
}

// ============================================
// HIGH MOMENTUM DETECTION
// ============================================

function analyseOptionMomentum(contract, quote) {
  const key = contract.instrument_key;

  const price = getOptionPrice(quote);
  const volume = getOptionVolume(quote);
  const oi = getOptionOI(quote);

  const previous = optionSnapshots.get(key);

  const validPrice =
    Number.isFinite(price) &&
    price >= 1 &&
    price <= 50;

  const priceUp =
    previous !== undefined &&
    price > previous.price;

  const volumeUp =
    previous !== undefined &&
    volume > previous.volume;

  const oiUp =
    previous !== undefined &&
    oi > previous.oi;

  // Long build-up requires price, volume and OI
  // to increase compared with the previous scan.
  const longBuildUp =
    previous !== undefined &&
    priceUp &&
    volumeUp &&
    oiUp;

  // Save current quote for the next comparison.
  optionSnapshots.set(key, {
    price,
    volume,
    oi,
    time: Date.now()
  });

  return {
    symbol:
      contract.underlying_symbol ||
      contract.name ||
      "",
    trading_symbol:
      contract.trading_symbol || "",
    instrument_key: key,
    option_type:
      contract.instrument_type || "",
    strike_price:
      Number(contract.strike_price || 0),
    expiry: contract.expiry || "",
    premium: price,
    volume,
    oi,
    price_up: priceUp,
    volume_up: volumeUp,
    oi_up: oiUp,
    long_build_up: longBuildUp,
    premium_filter_pass: validPrice,
    signal:
      validPrice && longBuildUp
        ? "HIGH_MOMENTUM"
        : "WAIT",
    signal_time: new Date().toISOString()
  };
}

// ============================================
// SCAN STOCK OPTION MOMENTUM
// ============================================

async function scanHighMomentumOptions(
  contracts,
  premiumMin = 1,
  premiumMax = 50
) {
  const results = [];

  // Avoid scanning too many contracts in one request.
  const batch = contracts.slice(0, 100);

  for (const rawContract of batch) {
    const contract = normaliseContract(rawContract);

    if (!contract.instrument_key) {
      continue;
    }

    try {
      const quote = await getOptionQuote(
        contract.instrument_key
      );

      if (!quote) {
        continue;
      }

      const signal = analyseOptionMomentum(
        rawContract,
        quote
      );

      const premiumPass =
        signal.premium >= premiumMin &&
        signal.premium <= premiumMax;

      if (premiumPass) {
        results.push(signal);
      }

    } catch (error) {
      results.push({
        symbol: contract.symbol,
        instrument_key: contract.instrument_key,
        error: error.message
      });
    }
  }

  const highMomentum = results.filter(
    item =>
      item.signal === "HIGH_MOMENTUM"
  );

  return {
    success: true,
    scanner: "HIGH_MOMENTUM_STOCK_OPTIONS",
    premium_min: premiumMin,
    premium_max: premiumMax,
    contracts_checked: batch.length,
    momentum_count: highMomentum.length,
    high_momentum_options: highMomentum,
    all_results: results,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// STRIKE PRICE SELECTION
// ============================================

function selectNearATMStrike(
  contracts,
  underlyingPrice
) {
  const price = Number(underlyingPrice);

  if (!Number.isFinite(price) || price <= 0) {
    return [];
  }

  const valid = contracts.filter(contract =>
    Number(contract.strike_price) > 0 &&
    ["CE", "PE"].includes(
      contract.instrument_type
    )
  );

  const strikes = valid
    .map(contract =>
      Number(contract.strike_price)
    )
    .filter(Number.isFinite);

  if (!strikes.length) {
    return [];
  }

  const nearestStrike = strikes.reduce(
    (nearest, strike) =>
      Math.abs(strike - price) <
      Math.abs(nearest - price)
        ? strike
        : nearest
  );

  return valid.filter(
    contract =>
      Number(contract.strike_price) ===
      nearestStrike
  );
}
  // ============================================
// PART 2/3
// HIGH MOMENTUM + STRIKE PRICE SELECTION
// ============================================

// ============================================
// GET OPTION QUOTE
// ============================================

async function getOptionQuote(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKey
  );

  const response = await upstoxRequest(
    apiUrl.toString()
  );

  const data = response?.data || {};

  return (
    data[instrumentKey] ||
    Object.values(data)[0] ||
    null
  );
}

// ============================================
// QUOTE HELPERS
// ============================================

function getOptionPrice(quote) {
  return Number(
    quote?.last_price ??
    quote?.ltp ??
    0
  );
}

function getOptionVolume(quote) {
  return Number(
    quote?.volume ??
    quote?.volume_traded ??
    quote?.volumeTraded ??
    0
  );
}

function getOptionOI(quote) {
  return Number(
    quote?.oi ??
    quote?.open_interest ??
    0
  );
}

// ============================================
// HIGH MOMENTUM DETECTION
// ============================================

function analyseOptionMomentum(contract, quote) {
  const key = contract.instrument_key;

  const price = getOptionPrice(quote);
  const volume = getOptionVolume(quote);
  const oi = getOptionOI(quote);

  const previous = optionSnapshots.get(key);

  const validPrice =
    Number.isFinite(price) &&
    price >= 1 &&
    price <= 50;

  const priceUp =
    previous !== undefined &&
    price > previous.price;

  const volumeUp =
    previous !== undefined &&
    volume > previous.volume;

  const oiUp =
    previous !== undefined &&
    oi > previous.oi;

  // Long build-up requires price, volume and OI
  // to increase compared with the previous scan.
  const longBuildUp =
    previous !== undefined &&
    priceUp &&
    volumeUp &&
    oiUp;

  // Save current quote for the next comparison.
  optionSnapshots.set(key, {
    price,
    volume,
    oi,
    time: Date.now()
  });

  return {
    symbol:
      contract.underlying_symbol ||
      contract.name ||
      "",
    trading_symbol:
      contract.trading_symbol || "",
    instrument_key: key,
    option_type:
      contract.instrument_type || "",
    strike_price:
      Number(contract.strike_price || 0),
    expiry: contract.expiry || "",
    premium: price,
    volume,
    oi,
    price_up: priceUp,
    volume_up: volumeUp,
    oi_up: oiUp,
    long_build_up: longBuildUp,
    premium_filter_pass: validPrice,
    signal:
      validPrice && longBuildUp
        ? "HIGH_MOMENTUM"
        : "WAIT",
    signal_time: new Date().toISOString()
  };
}

// ============================================
// SCAN STOCK OPTION MOMENTUM
// ============================================

async function scanHighMomentumOptions(
  contracts,
  premiumMin = 1,
  premiumMax = 50
) {
  const results = [];

  // Avoid scanning too many contracts in one request.
  const batch = contracts.slice(0, 100);

  for (const rawContract of batch) {
    const contract = normaliseContract(rawContract);

    if (!contract.instrument_key) {
      continue;
    }

    try {
      const quote = await getOptionQuote(
        contract.instrument_key
      );

      if (!quote) {
        continue;
      }

      const signal = analyseOptionMomentum(
        rawContract,
        quote
      );

      const premiumPass =
        signal.premium >= premiumMin &&
        signal.premium <= premiumMax;

      if (premiumPass) {
        results.push(signal);
      }

    } catch (error) {
      results.push({
        symbol: contract.symbol,
        instrument_key: contract.instrument_key,
        error: error.message
      });
    }
  }

  const highMomentum = results.filter(
    item =>
      item.signal === "HIGH_MOMENTUM"
  );

  return {
    success: true,
    scanner: "HIGH_MOMENTUM_STOCK_OPTIONS",
    premium_min: premiumMin,
    premium_max: premiumMax,
    contracts_checked: batch.length,
    momentum_count: highMomentum.length,
    high_momentum_options: highMomentum,
    all_results: results,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// STRIKE PRICE SELECTION
// ============================================

function selectNearATMStrike(
  contracts,
  underlyingPrice
) {
  const price = Number(underlyingPrice);

  if (!Number.isFinite(price) || price <= 0) {
    return [];
  }

  const valid = contracts.filter(contract =>
    Number(contract.strike_price) > 0 &&
    ["CE", "PE"].includes(
      contract.instrument_type
    )
  );

  const strikes = valid
    .map(contract =>
      Number(contract.strike_price)
    )
    .filter(Number.isFinite);

  if (!strikes.length) {
    return [];
  }

  const nearestStrike = strikes.reduce(
    (nearest, strike) =>
      Math.abs(strike - price) <
      Math.abs(nearest - price)
        ? strike
        : nearest
  );

  return valid.filter(
    contract =>
      Number(contract.strike_price) ===
      nearestStrike
  );
}
// ============================================
// PART 2/3
// HIGH MOMENTUM + STRIKE PRICE SELECTION
// ============================================

// ============================================
// GET OPTION QUOTE
// ============================================

async function getOptionQuote(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKey
  );

  const response = await upstoxRequest(
    apiUrl.toString()
  );

  const data = response?.data || {};

  return (
    data[instrumentKey] ||
    Object.values(data)[0] ||
    null
  );
}

// ============================================
// QUOTE HELPERS
// ============================================

function getOptionPrice(quote) {
  return Number(
    quote?.last_price ??
    quote?.ltp ??
    0
  );
}

function getOptionVolume(quote) {
  return Number(
    quote?.volume ??
    quote?.volume_traded ??
    quote?.volumeTraded ??
    0
  );
}

function getOptionOI(quote) {
  return Number(
    quote?.oi ??
    quote?.open_interest ??
    0
  );
}

// ============================================
// HIGH MOMENTUM DETECTION
// ============================================

function analyseOptionMomentum(contract, quote) {
  const key = contract.instrument_key;

  const price = getOptionPrice(quote);
  const volume = getOptionVolume(quote);
  const oi = getOptionOI(quote);

  const previous = optionSnapshots.get(key);

  const validPrice =
    Number.isFinite(price) &&
    price >= 1 &&
    price <= 50;

  const priceUp =
    previous !== undefined &&
    price > previous.price;

  const volumeUp =
    previous !== undefined &&
    volume > previous.volume;

  const oiUp =
    previous !== undefined &&
    oi > previous.oi;

  // Long build-up requires price, volume and OI
  // to increase compared with the previous scan.
  const longBuildUp =
    previous !== undefined &&
    priceUp &&
    volumeUp &&
    oiUp;

  // Save current quote for the next comparison.
  optionSnapshots.set(key, {
    price,
    volume,
    oi,
    time: Date.now()
  });

  return {
    symbol:
      contract.underlying_symbol ||
      contract.name ||
      "",
    trading_symbol:
      contract.trading_symbol || "",
    instrument_key: key,
    option_type:
      contract.instrument_type || "",
    strike_price:
      Number(contract.strike_price || 0),
    expiry: contract.expiry || "",
    premium: price,
    volume,
    oi,
    price_up: priceUp,
    volume_up: volumeUp,
    oi_up: oiUp,
    long_build_up: longBuildUp,
    premium_filter_pass: validPrice,
    signal:
      validPrice && longBuildUp
        ? "HIGH_MOMENTUM"
        : "WAIT",
    signal_time: new Date().toISOString()
  };
}

// ============================================
// SCAN STOCK OPTION MOMENTUM
// ============================================

async function scanHighMomentumOptions(
  contracts,
  premiumMin = 1,
  premiumMax = 50
) {
  const results = [];

  // Avoid scanning too many contracts in one request.
  const batch = contracts.slice(0, 100);

  for (const rawContract of batch) {
    const contract = normaliseContract(rawContract);

    if (!contract.instrument_key) {
      continue;
    }

    try {
      const quote = await getOptionQuote(
        contract.instrument_key
      );

      if (!quote) {
        continue;
      }

      const signal = analyseOptionMomentum(
        rawContract,
        quote
      );

      const premiumPass =
        signal.premium >= premiumMin &&
        signal.premium <= premiumMax;

      if (premiumPass) {
        results.push(signal);
      }

    } catch (error) {
      results.push({
        symbol: contract.symbol,
        instrument_key: contract.instrument_key,
        error: error.message
      });
    }
  }

  const highMomentum = results.filter(
    item =>
      item.signal === "HIGH_MOMENTUM"
  );

  return {
    success: true,
    scanner: "HIGH_MOMENTUM_STOCK_OPTIONS",
    premium_min: premiumMin,
    premium_max: premiumMax,
    contracts_checked: batch.length,
    momentum_count: highMomentum.length,
    high_momentum_options: highMomentum,
    all_results: results,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// STRIKE PRICE SELECTION
// ============================================

function selectNearATMStrike(
  contracts,
  underlyingPrice
) {
  const price = Number(underlyingPrice);

  if (!Number.isFinite(price) || price <= 0) {
    return [];
  }

  const valid = contracts.filter(contract =>
    Number(contract.strike_price) > 0 &&
    ["CE", "PE"].includes(
      contract.instrument_type
    )
  );

  const strikes = valid
    .map(contract =>
      Number(contract.strike_price)
    )
    .filter(Number.isFinite);

  if (!strikes.length) {
    return [];
  }

  const nearestStrike = strikes.reduce(
    (nearest, strike) =>
      Math.abs(strike - price) <
      Math.abs(nearest - price)
        ? strike
        : nearest
  );

  return valid.filter(
    contract =>
      Number(contract.strike_price) ===
      nearestStrike
  );
             }// ============================================
// PART 3/3
// OPTION SIGNAL + API ROUTES + SERVER START
// ============================================

// ============================================
// FILTER HIGH MOMENTUM SIGNALS
// ============================================

function filterHighMomentumSignals(
  signals,
  optionType = null
) {
  return signals.filter(signal => {
    const typePass =
      !optionType ||
      signal.option_type === optionType;

    return (
      signal.signal === "HIGH_MOMENTUM" &&
      signal.premium_filter_pass &&
      typePass
    );
  });
}

// ============================================
// SELECT BEST OPTION
// ============================================

function selectBestOption(signals) {
  if (!Array.isArray(signals) || !signals.length) {
    return null;
  }

  // Rank using volume, OI and premium.
  // This is a ranking heuristic, not a guarantee.
  return [...signals].sort((a, b) => {
    const aScore =
      Number(a.volume || 0) +
      Number(a.oi || 0);

    const bScore =
      Number(b.volume || 0) +
      Number(b.oi || 0);

    return bScore - aScore;
  })[0];
}

// ============================================
// BUILD OPTION SIGNAL
// ============================================

function buildOptionSignal(option) {
  if (!option) {
    return {
      success: false,
      signal: "WAIT",
      message: "No high momentum option found"
    };
  }

  return {
    success: true,
    signal: option.signal,
    symbol: option.symbol,
    trading_symbol: option.trading_symbol,
    instrument_key: option.instrument_key,
    option_type: option.option_type,
    strike_price: option.strike_price,
    expiry: option.expiry,
    premium: option.premium,
    volume: option.volume,
    oi: option.oi,
    price_up: option.price_up,
    volume_up: option.volume_up,
    oi_up: option.oi_up,
    long_build_up: option.long_build_up,
    signal_time: option.signal_time
  };
}

// ============================================
// GET UNDERLYING PRICE
// ============================================

async function getUnderlyingPrice(instrumentKey) {
  const apiUrl = new URL(
    `${UPSTOX_BASE}/v2/market-quote/quotes`
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKey
  );

  const response = await upstoxRequest(
    apiUrl.toString()
  );

  const data = response?.data || {};
  const quote =
    data[instrumentKey] ||
    Object.values(data)[0];

  const price = Number(quote?.last_price || 0);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Underlying price unavailable");
  }

  return price;
}

// ============================================
// SCAN STOCK OPTIONS AND SELECT BEST
// ============================================

async function scanAndSelectBestOption(
  contracts,
  underlyingPrice,
  premiumMin = 1,
  premiumMax = 50,
  optionType = null
) {
  const nearATMContracts = selectNearATMStrike(
    contracts,
    underlyingPrice
  );

  const filteredContracts = nearATMContracts.filter(
    contract =>
      !optionType ||
      contract.instrument_type === optionType
  );

  if (!filteredContracts.length) {
    return {
      success: true,
      scanner: "HIGH_MOMENTUM_STOCK_OPTIONS",
      signal: {
        success: false,
        signal: "WAIT",
        message: "No matching near-ATM contracts"
      },
      timestamp: new Date().toISOString()
    };
  }

  const scanResult = await scanHighMomentumOptions(
    filteredContracts,
    premiumMin,
    premiumMax
  );

  const candidates = filterHighMomentumSignals(
    scanResult.high_momentum_options,
    optionType
  );

  const bestOption = selectBestOption(candidates);

  return {
    success: true,
    scanner: "HIGH_MOMENTUM_STOCK_OPTIONS",
    signal: buildOptionSignal(bestOption),
    contracts_checked: scanResult.contracts_checked,
    momentum_count: candidates.length,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// HTTP SERVER + API ROUTES
// ============================================

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
        message: "Stock Options Scanner running",
        timestamp: new Date().toISOString()
      });
    }

    // NSE STOCK OPTIONS LIST
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
    }

    // HIGH MOMENTUM SCANNER
    if (
      url.pathname === "/api/options/nse-stocks/scan" &&
      req.method === "GET"
    ) {
      const premiumMin = Number(
        url.searchParams.get("min_premium") || 1
      );

      const premiumMax = Number(
        url.searchParams.get("max_premium") || 50
      );

      const requestedType =
        url.searchParams.get("type");

      const optionType =
        requestedType === "CE" ||
        requestedType === "PE"
          ? requestedType
          : null;

      if (
        !Number.isFinite(premiumMin) ||
        !Number.isFinite(premiumMax) ||
        premiumMin < 0 ||
        premiumMax < premiumMin
      ) {
        return sendJson(res, 400, {
          success: false,
          error: "Invalid premium range"
        });
      }

      const contractResult = await getNseStockOptions();

      if (!contractResult.success) {
        return sendJson(res, 502, contractResult);
      }

      const allContracts = contractResult.contracts;

      const symbols = [
        ...new Set(
          allContracts.map(
            contract => contract.underlying_symbol
          ).filter(Boolean)
        )
      ];

      const results = [];

      for (const symbol of symbols.slice(0, 30)) {
        const stockContracts = allContracts.filter(
          contract =>
            contract.underlying_symbol === symbol
        );

        if (!stockContracts.length) continue;

        try {
          const underlyingKey =
            stockContracts[0].underlying_key;

          if (!underlyingKey) continue;

          const underlyingPrice = await getUnderlyingPrice(
            underlyingKey
          );

          const result = await scanAndSelectBestOption(
            stockContracts,
            underlyingPrice,
            premiumMin,
            premiumMax,
            optionType
          );

          if (result.signal?.success) {
            results.push(result.signal);
          }
        } catch (error) {
          results.push({
            symbol,
            signal: "ERROR",
            error: error.message
          });
        }
      }

      return sendJson(res, 200, {
        success: true,
        scanner: "HIGH_MOMENTUM_STOCK_OPTIONS",
        premium_min: premiumMin,
        premium_max: premiumMax,
        option_type: optionType || "CE_AND_PE",
        stocks_checked: Math.min(symbols.length, 30),
        signals: results,
        timestamp: new Date().toISOString()
      });
    }

    // UNKNOWN ROUTE
    return sendJson(res, 404, {
      success: false,
      error: "API route not found",
      path: url.pathname
    });

  } catch (error) {
    return sendJson(res, 502, {
      success: false,
      error: error.message || "Internal server error"
    });
  }
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
  console.log(
    `Stock Options Scanner running on port ${PORT}`
  );
});
    
