const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const UPSTOX_BASE = "https://api.upstox.com";

const INDEXES = {
  NIFTY: "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  SENSEX: "BSE_INDEX|SENSEX",
  FINNIFTY: "NSE_INDEX|Nifty Fin Service"
};

const activeSignals = new Map();

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  });

  res.end(JSON.stringify(data));
}

async function upstoxRequest(path) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error("UPSTOX_ACCESS_TOKEN is not configured");
  }

  const response = await fetch(`${UPSTOX_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      body.message || `Upstox API error: ${response.status}`
    );
  }

  return body;
}

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = values.slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain = (avgGain * (period - 1) +
      Math.max(change, 0)) / period;

    avgLoss = (avgLoss * (period - 1) +
      Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateMACD(values) {
  if (!Array.isArray(values) || values.length < 35) {
    return null;
  }

  const macdValues = [];

  for (let i = 25; i < values.length; i++) {
    const subset = values.slice(0, i + 1);

    const ema12 = calculateEMA(subset, 12);
    const ema26 = calculateEMA(subset, 26);

    if (ema12 !== null && ema26 !== null) {
      macdValues.push(ema12 - ema26);
    }
  }

  if (macdValues.length < 9) return null;

  const macd = macdValues[macdValues.length - 1];
  const signal = calculateEMA(macdValues, 9);

  return {
    macd,
    signal,
    bullish: signal !== null && macd > signal,
    bearish: signal !== null && macd < signal
  };
}

function calculateVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const candle of candles) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume);

    if (![high, low, close, volume].every(Number.isFinite)) {
      continue;
    }

    const typicalPrice = (high + low + close) / 3;

    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  return totalVolume > 0 ? totalPV / totalVolume : null;
                          }
// ================================================
// PART 2: MARKET ANALYSIS + ENTRY / SL / TARGETS
// ================================================

function getCandleValues(candles) {
  return candles.map(c => ({
    timestamp: c.timestamp ?? c.time ?? null,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume ?? 0),
    oi: Number(c.oi ?? c.open_interest ?? 0)
  })).filter(c =>
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  );
}

function calculateVolumeRatio(candles) {
  if (candles.length < 21) return null;

  const previous20 = candles.slice(-21, -1);

  const averageVolume =
    previous20.reduce((sum, c) => sum + c.volume, 0) / 20;

  const latestVolume = candles[candles.length - 1].volume;

  if (averageVolume <= 0) return null;

  return {
    averageVolume,
    latestVolume,
    ratio: latestVolume / averageVolume
  };
}

function calculateOIChange(candles) {
  if (candles.length < 2) return null;

  const previous = candles[candles.length - 2].oi;
  const current = candles[candles.length - 1].oi;

  if (
    !Number.isFinite(previous) ||
    !Number.isFinite(current) ||
    previous <= 0 ||
    current <= 0
  ) {
    return null;
  }

  return {
    previousOI: previous,
    currentOI: current,
    change: current - previous,
    changePercent: ((current - previous) / previous) * 100
  };
}

function analyseMarket(candlesInput) {
  const candles = getCandleValues(candlesInput);

  if (candles.length < 35) {
    return {
      success: false,
      message: "At least 35 completed candles are required"
    };
  }

  const closes = candles.map(c => c.close);
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema20 = calculateEMA(closes, 20);
  const rsi14 = calculateRSI(closes, 14);
  const vwap = calculateVWAP(candles);
  const macd = calculateMACD(closes);
  const volume = calculateVolumeRatio(candles);
  const oi = calculateOIChange(candles);

  if (
    ema20 === null ||
    rsi14 === null ||
    vwap === null ||
    macd === null ||
    volume === null
  ) {
    return {
      success: false,
      message: "Indicator data is insufficient"
    };
  }

  const priceChangePercent =
    previous.close !== 0
      ? ((latest.close - previous.close) / previous.close) * 100
      : 0;

  const bullishVWAPCross =
    previous.close <= vwap &&
    latest.close > vwap;

  const bearishVWAPCross =
    previous.close >= vwap &&
    latest.close < vwap;

  const bullish =
    latest.close > latest.open &&
    priceChangePercent > 0 &&
    latest.close > ema20 &&
    latest.close > vwap &&
    rsi14 >= 65 &&
    macd.bullish &&
    volume.ratio >= 1.5;

  const bearish =
    latest.close < latest.open &&
    priceChangePercent < 0 &&
    latest.close < ema20 &&
    latest.close < vwap &&
    rsi14 <= 35 &&
    macd.bearish &&
    volume.ratio >= 1.5;

  const oiIncreasing =
    oi !== null && oi.changePercent > 0;

  const oiDecreasing =
    oi !== null && oi.changePercent < 0;

  let signal = "NEUTRAL";
  let buildUp = "NO CONFIRMATION";

  if (bullish && oiIncreasing) {
    signal = "STRONG_BUY";
    buildUp = "LONG_BUILD_UP";
  } else if (bearish && oiIncreasing) {
    signal = "STRONG_SELL";
    buildUp = "SHORT_BUILD_UP";
  } else if (bullish && oiDecreasing) {
    signal = "BULLISH";
    buildUp = "SHORT_COVERING";
  } else if (bearish && oiDecreasing) {
    signal = "BEARISH";
    buildUp = "LONG_UNWINDING";
  }

  const entry = latest.close;

  // Illustrative risk settings; tune using backtesting.
  const slPercent = 0.5;
  const target1Percent = 0.75;
  const target2Percent = 1.5;
  const target3Percent = 2.25;

  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (signal === "STRONG_BUY" || signal === "BULLISH") {
    sl = entry * (1 - slPercent / 100);
    tp1 = entry * (1 + target1Percent / 100);
    tp2 = entry * (1 + target2Percent / 100);
    tp3 = entry * (1 + target3Percent / 100);
  } else if (
    signal === "STRONG_SELL" ||
    signal === "BEARISH"
  ) {
    sl = entry * (1 + slPercent / 100);
    tp1 = entry * (1 - target1Percent / 100);
    tp2 = entry * (1 - target2Percent / 100);
    tp3 = entry * (1 - target3Percent / 100);
  }

  const bullishScore = [
    latest.close > ema20,
    latest.close > vwap,
    rsi14 >= 65,
    macd.bullish,
    volume.ratio >= 1.5,
    oiIncreasing
  ].filter(Boolean).length;

  const bearishScore = [
    latest.close < ema20,
    latest.close < vwap,
    rsi14 <= 35,
    macd.bearish,
    volume.ratio >= 1.5,
    oiIncreasing
  ].filter(Boolean).length;

  return {
    success: true,
    timeframe: "5m",
    candleTimestamp: latest.timestamp,
    signal,
    buildUp,
    entry: roundPrice(entry),
    sl: sl === null ? null : roundPrice(sl),
    targets: {
      tp1: tp1 === null ? null : roundPrice(tp1),
      tp2: tp2 === null ? null : roundPrice(tp2),
      tp3: tp3 === null ? null : roundPrice(tp3)
    },
    indicators: {
      price: latest.close,
      priceChangePercent: roundPrice(priceChangePercent),
      ema20: roundPrice(ema20),
      rsi14: roundPrice(rsi14),
      vwap: roundPrice(vwap),
      bullishVWAPCross,
      bearishVWAPCross,
      macd,
      volumeRatio: roundPrice(volume.ratio),
      oiChangePercent:
        oi === null ? null : roundPrice(oi.changePercent)
    },
    score: {
      bullish: bullishScore,
      bearish: bearishScore,
      maximum: 6
    }
  };
}

function roundPrice(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
      }
// ================================================
// PART 3: NSE FUTURES + OPTIONS SCANNER
// ================================================

const scanCache = new Map();

const SCAN_SETTINGS = {
  minRSI: 65,
  minVolumeRatio: 1.5,
  minOIChangePercent: 2,
  scanIntervalMs: 30000,
  maxOptionsPerStock: 10
};

// NSE index instrument keys.
// Confirm each key against your Upstox instruments list.
const EXTRA_INDEXES = {
  MIDCAPNIFTY: "NSE_INDEX|Nifty Midcap Select"
};

function makeSignalId(symbol, instrumentKey, timestamp) {
  return `${symbol}:${instrumentKey}:${timestamp}`;
}

function normaliseInstrumentKey(value) {
  return String(value || "").trim();
}

function scoreStrongMomentum(analysis) {
  if (!analysis || !analysis.success) {
    return {
      score: 0,
      label: "INSUFFICIENT_DATA"
    };
  }

  const x = analysis.indicators || {};
  let score = 0;

  if (x.priceChangePercent > 0) score++;
  if (x.oiChangePercent > 0) score++;
  if (x.volumeRatio >= SCAN_SETTINGS.minVolumeRatio) score++;
  if (x.rsi14 >= SCAN_SETTINGS.minRSI) score++;
  if (x.price > x.ema20 && x.price > x.vwap) score++;
  if (x.macd?.bullish) score++;

  return {
    score,
    maximum: 6,
    label: score >= 6
      ? "VERY_STRONG_BULLISH"
      : score >= 4
        ? "BULLISH_MOMENTUM"
        : "NO_STRONG_SIGNAL"
  };
}

function calculateTradeLevels(entry, direction) {
  if (!Number.isFinite(entry) || entry <= 0) {
    return null;
  }

  // Illustrative underlying/option risk settings.
  const slPct = 0.5;
  const t1Pct = 0.75;
  const t2Pct = 1.5;
  const t3Pct = 2.25;

  if (direction === "BUY") {
    return {
      entry: roundPrice(entry),
      sl: roundPrice(entry * (1 - slPct / 100)),
      tp1: roundPrice(entry * (1 + t1Pct / 100)),
      tp2: roundPrice(entry * (1 + t2Pct / 100)),
      tp3: roundPrice(entry * (1 + t3Pct / 100))
    };
  }

  return {
    entry: roundPrice(entry),
    sl: roundPrice(entry * (1 + slPct / 100)),
    tp1: roundPrice(entry * (1 - t1Pct / 100)),
    tp2: roundPrice(entry * (1 - t2Pct / 100)),
    tp3: roundPrice(entry * (1 - t3Pct / 100))
  };
}

function selectOptionCandidate(options, direction) {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }

  const filtered = options.filter(option => {
    const ltp = Number(option.ltp);
    const volume = Number(option.volume);
    const oi = Number(option.oi);

    return (
      Number.isFinite(ltp) &&
      ltp > 0 &&
      Number.isFinite(volume) &&
      volume > 0 &&
      Number.isFinite(oi) &&
      oi >= 0 &&
      option.direction === direction
    );
  });

  if (!filtered.length) return null;

  // Prefer liquid contracts with a valid bid/ask spread.
  filtered.sort((a, b) => {
    const aVolume = Number(a.volume) || 0;
    const bVolume = Number(b.volume) || 0;
    const aSpread = Number(a.spreadPercent ?? 100);
    const bSpread = Number(b.spreadPercent ?? 100);

    const aScore = aVolume / (1 + aSpread);
    const bScore = bVolume / (1 + bSpread);

    return bScore - aScore;
  });

  return filtered[0];
}

function rememberActiveSignal(key, signal) {
  const previous = activeSignals.get(key);

  if (previous && previous.status === "ACTIVE") {
    return {
      ...previous,
      refreshedAt: new Date().toISOString()
    };
  }

  activeSignals.set(key, {
    ...signal,
    status: "ACTIVE",
    createdAt: new Date().toISOString()
  });

  return activeSignals.get(key);
}

function updateSignalStatus(key, currentPrice) {
  const signal = activeSignals.get(key);

  if (!signal || signal.status !== "ACTIVE") {
    return signal || null;
  }

  const price = Number(currentPrice);
  if (!Number.isFinite(price)) return signal;

  if (signal.direction === "BUY") {
    if (price <= signal.sl) signal.status = "SL_HIT";
    else if (price >= signal.tp3) signal.status = "TP3_HIT";
    else if (price >= signal.tp2) signal.status = "TP2_HIT";
    else if (price >= signal.tp1) signal.status = "TP1_HIT";
  } else {
    if (price >= signal.sl) signal.status = "SL_HIT";
    else if (price <= signal.tp3) signal.status = "TP3_HIT";
    else if (price <= signal.tp2) signal.status = "TP2_HIT";
    else if (price <= signal.tp1) signal.status = "TP1_HIT";
  }

  activeSignals.set(key, signal);
  return signal;
                             }
// ================================================
// PART 4: API ROUTES + SIGNAL ALERTS
// ================================================

function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) return resolve({});

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

async function handleScannerRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { success: true });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      success: true,
      service: "Smart Market Scanner",
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/upstox/status") {
    return sendJson(res, 200, {
      success: true,
      token_configured: Boolean(process.env.UPSTOX_ACCESS_TOKEN)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/scanner/signals") {
    return sendJson(res, 200, {
      success: true,
      count: activeSignals.size,
      signals: Array.from(activeSignals.values())
    });
  }

  if (req.method === "POST" && url.pathname === "/api/scanner/analyse") {
    try {
      const body = await getJsonBody(req);
      const candles = body.candles;

      if (!Array.isArray(candles)) {
        return sendJson(res, 400, {
          success: false,
          error: "candles array is required"
        });
      }

      const analysis = analyseMarket(candles);
      const momentum = scoreStrongMomentum(analysis);

      return sendJson(res, 200, {
        success: true,
        analysis,
        momentum
      });
    } catch (error) {
      return sendJson(res, 400, {
        success: false,
        error: error.message
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/scanner/indexes") {
    return sendJson(res, 200, {
      success: true,
      indexes: {
        ...INDEXES,
        ...EXTRA_INDEXES
      }
    });
  }

  return sendJson(res, 404, {
    success: false,
    error: "Route not found"
  });
    }
// ================================================
// START SERVER — ONLY ONCE
// ================================================

const server = http.createServer((req, res) => {
  handleScannerRequest(req, res).catch(error => {
    console.error("Request error:", error.message);

    if (!res.headersSent) {
      sendJson(res, 500, {
        success: false,
        error: "Internal server error"
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Smart Market Scanner running on port ${PORT}`);
});
