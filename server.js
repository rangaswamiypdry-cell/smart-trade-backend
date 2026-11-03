// ==========================================
// STRONG BTST + GAP UP OPEN SCANNER
// NSE F&O FUTURES
// ==========================================

const BTST_SETTINGS = {
  minPriceChange: 1.0,
  minVolumeRatio: 1.5,
  minOIChange: 2.0,
  minRSI: 60,
  minClosePosition: 0.75
};

const GAP_SETTINGS = {
  minGapPercent: 1.0,
  minPriceChange: 0.5,
  minVolumeRatio: 1.5,
  minOIChange: 2.0
};

function percentChange(current, previous) {
  if (!previous || previous <= 0) return 0;

  return ((current - previous) / previous) * 100;
}

// ==========================================
// STRONG BTST ANALYSIS
// ==========================================

function analyseStrongBTST(daily, instrument) {

  if (!daily || daily.length < 22) return null;

  const last = daily[daily.length - 1];
  const previous = daily[daily.length - 2];

  const history = daily.slice(-21, -1);

  const avgVolume =
    history.reduce((sum, c) => sum + (c.volume || 0), 0) /
    history.length;

  const volumeRatio =
    avgVolume > 0 ? last.volume / avgVolume : 0;

  const priceChange = percentChange(
    last.close,
    previous.close
  );

  const oiChange = percentChange(
    last.oi,
    previous.oi
  );

  const rsiValue = rsi(daily.map(c => c.close), 14);

  const emaValue = ema(
    daily.map(c => c.close),
    20
  );

  const candleRange = last.high - last.low;

  const closePosition =
    candleRange > 0
      ? (last.close - last.low) / candleRange
      : 0;

  const conditions = {
    priceIncrease:
      priceChange >= BTST_SETTINGS.minPriceChange,

    volumeIncrease:
      volumeRatio >= BTST_SETTINGS.minVolumeRatio,

    oiIncrease:
      oiChange >= BTST_SETTINGS.minOIChange,

    rsiStrong:
      rsiValue >= BTST_SETTINGS.minRSI,

    aboveEMA:
      last.close > emaValue,

    strongClose:
      closePosition >= BTST_SETTINGS.minClosePosition
  };

  const strongBTST = Object.values(conditions).every(Boolean);

  if (!strongBTST) return null;

  return {
    symbol: instrument.underlying,
    instrumentKey: instrument.instrument_key,
    signal: "STRONG_BTST",
    price: last.close,
    priceChange: Number(priceChange.toFixed(2)),
    volume: last.volume,
    volumeRatio: Number(volumeRatio.toFixed(2)),
    oi: last.oi,
    oiChange: Number(oiChange.toFixed(2)),
    rsi: Number(rsiValue.toFixed(2)),
    ema20: Number(emaValue.toFixed(2)),
    closePosition: Number(closePosition.toFixed(2)),
    conditions
  };
}

// ==========================================
// STRONG GAP-UP OPEN CONFIRMATION
// ==========================================

function analyseStrongGapOpen(
  previousDaily,
  todayCandles,
  instrument
) {

  if (!previousDaily || !todayCandles ||
      todayCandles.length < 2) return null;

  const previousClose = previousDaily.close;

  const first = todayCandles[0];
  const last = todayCandles[todayCandles.length - 1];

  const gapPercent = percentChange(
    first.open,
    previousClose
  );

  const priceChange = percentChange(
    last.close,
    first.open
  );

  const previousCandles = todayCandles.slice(-21, -1);

  if (previousCandles.length < 1) return null;

  const avgVolume =
    previousCandles.reduce(
      (sum, c) => sum + (c.volume || 0), 0
    ) / previousCandles.length;

  const volumeRatio =
    avgVolume > 0 ? last.volume / avgVolume : 0;

  const oiChange = percentChange(
    last.oi,
    previousCandles[previousCandles.length - 1].oi
  );

  const conditions = {
    gapUp:
      gapPercent >= GAP_SETTINGS.minGapPercent,

    priceIncrease:
      priceChange >= GAP_SETTINGS.minPriceChange,

    volumeIncrease:
      volumeRatio >= GAP_SETTINGS.minVolumeRatio,

    oiIncrease:
      oiChange >= GAP_SETTINGS.minOIChange,

    bullishCandle:
      last.close > last.open
  };

  const strongGapUp = Object.values(conditions).every(Boolean);

  if (!strongGapUp) return null;

  return {
    symbol: instrument.underlying,
    instrumentKey: instrument.instrument_key,
    signal: "STRONG_GAP_UP_OPEN",
    previousClose,
    open: first.open,
    price: last.close,
    gapPercent: Number(gapPercent.toFixed(2)),
    priceChange: Number(priceChange.toFixed(2)),
    volume: last.volume,
    volumeRatio: Number(volumeRatio.toFixed(2)),
    oi: last.oi,
    oiChange: Number(oiChange.toFixed(2)),
    conditions
  };
}// ==========================================
// PART 2
// DAILY CANDLE DATA
// BTST + GAP-UP SCAN ENGINE
// ==========================================

async function dailyCandlesFor(instrumentKey) {

  try {
    const now = new Date();

    const toDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata"
    }).format(now);

    const from = new Date(now.getTime() - 45 * 86400000);

    const fromDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata"
    }).format(from);

    const path =
      `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/days/1/${toDate}/${fromDate}`;

    const response = await upstox(path);

    const raw = response?.data?.candles || [];

    return raw
      .map(c => ({
        time: c[0],
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] || 0),
        oi: Number(c[6] || 0)
      }))
      .sort((a, b) =>
        new Date(a.time) - new Date(b.time)
      );

  } catch (error) {
    console.error(
      "Daily candle error:",
      instrumentKey,
      error.message
    );

    return [];
  }
}// ==========================================
// BTST SCANNER
// ==========================================

async function runBTSTScan(limit = 250) {

  if (scanInProgress) {
    return {
      success: false,
      error: "SCAN_ALREADY_RUNNING"
    };
  }

  scanInProgress = true;

  try {

    const universe = await loadUniverse();

    const stocks = universe.slice(
      0,
      Math.min(Number(limit) || 250, 250)
    );

    const results = await runWorkers(
      stocks,
      CFG.workers,
      async instrument => {

        const daily = await dailyCandlesFor(
          instrument.instrument_key
        );

        if (daily.length < 22) return null;

        const signal = analyseStrongBTST(
          daily,
          instrument
        );

        return signal;
      }
    );

    const alerts = results
      .filter(Boolean)
      .sort((a, b) =>
        b.volumeRatio - a.volumeRatio
      );

    return {
      success: true,
      scanner: "STRONG_BTST",
      totalScanned: stocks.length,
      totalSignals: alerts.length,
      signals: alerts,
      updatedAt: new Date().toISOString()
    };

  } catch (error) {

    return {
      success: false,
      error: error.message
    };

  } finally {
    scanInProgress = false;
  }
}


// ==========================================
// GAP-UP OPEN SCANNER
// ==========================================

async function runGapUpScan(limit = 250) {

  if (scanInProgress) {
    return {
      success: false,
      error: "SCAN_ALREADY_RUNNING"
    };
  }

  scanInProgress = true;

  try {

    const universe = await loadUniverse();

    const stocks = universe.slice(
      0,
      Math.min(Number(limit) || 250, 250)
    );

    const results = await runWorkers(
      stocks,
      CFG.workers,
      async instrument => {

        const daily = await dailyCandlesFor(
          instrument.instrument_key
        );

        if (daily.length < 2) return null;

        const previousDaily =
          daily[daily.length - 2];

        const todayCandles = getCompletedCandles(
          await candlesFor(instrument.instrument_key)
        );

        if (!todayCandles || todayCandles.length < 2) {
          return null;
        }

        return analyseStrongGapOpen(
          previousDaily,
          todayCandles,
          instrument
        );
      }
    );

    const alerts = results
      .filter(Boolean)
      .sort((a, b) =>
        b.gapPercent - a.gapPercent
      );

    return {
      success: true,
      scanner: "STRONG_GAP_UP_OPEN",
      totalScanned: stocks.length,
      totalSignals: alerts.length,
      signals: alerts,
      updatedAt: new Date().toISOString()
    };

  } catch (error) {

    return {
      success: false,
      error: error.message
    };

  } finally {
    scanInProgress = false;
  }
      }// ==========================================
// PART 3
// BTST + GAP-UP API ROUTES
// ==========================================

const requestUrl = new URL(
  req.url,
  "http://localhost"
);

const pathname = requestUrl.pathname;

// ------------------------------------------
// BTST SCANNER API
// ------------------------------------------

if (
  req.method === "GET" &&
  pathname === "/api/btst/scan"
) {
  const limit = Number(
    requestUrl.searchParams.get("limit") || 250
  );

  const result = await runBTSTScan(limit);

  return json(
    res,
    result.success ? 200 : 500,
    result
  );
}

// ------------------------------------------
// GAP-UP OPEN SCANNER API
// ------------------------------------------

if (
  req.method === "GET" &&
  pathname === "/api/gap-up/scan"
) {
  const limit = Number(
    requestUrl.searchParams.get("limit") || 250
  );

  const result = await runGapUpScan(limit);

  return json(
    res,
    result.success ? 200 : 500,
    result
  );
}// ==========================================
// FINAL SERVER RESPONSE
// ==========================================

// OPTIONS / CORS PREFLIGHT
if (req.method === "OPTIONS") {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });

  return res.end();
}

// API ROUTE NOT FOUND
return json(res, 404, {
  success: false,
  error: "API_ROUTE_NOT_FOUND",
  message: "Requested API route does not exist"
});

});

// ==========================================
// SERVER START
// ==========================================

server.listen(PORT, () => {
  console.log("================================");
  console.log("SMART TRADE INDIA SERVER STARTED");
  console.log("PORT:", PORT);
  console.log("BTST SCANNER: ACTIVE");
  console.log("GAP-UP SCANNER: ACTIVE");
  console.log("NSE F&O SCANNER: ACTIVE");
  console.log("================================");
});
