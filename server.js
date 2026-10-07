const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

// ==================================================
// CORS
// ==================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

// ==================================================
// JSON RESPONSE
// ==================================================

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

// ==================================================
// UPSTOX REQUEST
// ==================================================

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

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      "Upstox API request failed"
    );
  }

  return data;
}

// ==================================================
// OPTION SNAPSHOTS
// ==================================================

const optionSnapshots = new Map();

function analyseOption(option) {
  const key = option.instrument_key;

  const previous = optionSnapshots.get(key);

  const ltp = Number(option.ltp || 0);
  const volume = Number(option.volume || 0);
  const oi = Number(option.oi || 0);

  let priceChange = 0;
  let volumeChange = 0;
  let oiChange = 0;

  if (previous) {
    if (previous.ltp > 0) {
      priceChange =
        ((ltp - previous.ltp) / previous.ltp) * 100;
    }

    if (previous.volume > 0) {
      volumeChange =
        ((volume - previous.volume) / previous.volume) * 100;
    }

    if (previous.oi > 0) {
      oiChange =
        ((oi - previous.oi) / previous.oi) * 100;
    }
  }

  optionSnapshots.set(key, {
    ltp,
    volume,
    oi,
    timestamp: Date.now()
  });

  const strong =
    Math.abs(priceChange) >= 1 &&
    volumeChange >= 20 &&
    oiChange >= 5;

  let signal = "NEUTRAL";

  if (
    priceChange > 0 &&
    volumeChange > 0 &&
    oiChange > 0
  ) {
    signal = "BULLISH";
  }

  if (
    priceChange < 0 &&
    volumeChange > 0 &&
    oiChange > 0
  ) {
    signal = "BEARISH";
  }

  return {
    ...option,

    price_change_percent:
      Number(priceChange.toFixed(2)),

    volume_change_percent:
      Number(volumeChange.toFixed(2)),

    oi_change_percent:
      Number(oiChange.toFixed(2)),

    signal,
    strong
  };
}

// ==================================================
// OPTION CHAIN
// ==================================================

async function getOptionChain(instrumentKey, expiry) {
  const apiUrl =
    `https://api.upstox.com/v2/option/chain` +
    `?instrument_key=${encodeURIComponent(instrumentKey)}` +
    `&expiry_date=${encodeURIComponent(expiry)}`;

  return await upstoxRequest(apiUrl);
}

// ==================================================
// BUILD OPTION ROWS
// ==================================================

function buildOptionRows(chainData, underlyingName = "") {
  const rows = [];

  for (const item of chainData || []) {
    const strike = item.strike_price;

    // ==================================================
    // CE
    // ==================================================

    if (item.call_options) {
      const md = item.call_options.market_data || {};

      rows.push(
        analyseOption({
          instrument_key:
            item.call_options.instrument_key,

          underlying_key:
            item.underlying_key,

          underlying_name:
            underlyingName,

          strike_price:
            strike,

          option_type:
            "CE",

          expiry:
            item.expiry,

          ltp:
            md.ltp || 0,

          volume:
            md.volume || 0,

          oi:
            md.oi || 0,

          prev_oi:
            md.prev_oi || 0,

          bid_price:
            md.bid_price || 0,

          ask_price:
            md.ask_price || 0
        })
      );
    }

    // ==================================================
    // PE
    // ==================================================

    if (item.put_options) {
      const md = item.put_options.market_data || {};

      rows.push(
        analyseOption({
          instrument_key:
            item.put_options.instrument_key,

          underlying_key:
            item.underlying_key,

          underlying_name:
            underlyingName,

          strike_price:
            strike,

          option_type:
            "PE",

          expiry:
            item.expiry,

          ltp:
            md.ltp || 0,

          volume:
            md.volume || 0,

          oi:
            md.oi || 0,

          prev_oi:
            md.prev_oi || 0,

          bid_price:
            md.bid_price || 0,

          ask_price:
            md.ask_price || 0
        })
      );
    }
  }

  return rows;
}// ==================================================
// AUTOMATIC OPTION SCANNER
// NIFTY + BANKNIFTY + SENSEX
// AUTO EXPIRY
// ==================================================

async function getNearestExpiry(instrumentKey) {
  const apiUrl =
    `https://api.upstox.com/v2/option/contract` +
    `?instrument_key=${encodeURIComponent(instrumentKey)}`;

  const result =
    await upstoxRequest(apiUrl);

  const contracts =
    Array.isArray(result?.data)
      ? result.data
      : [];

  const expiries = [
    ...new Set(
      contracts
        .map(item => item.expiry)
        .filter(Boolean)
    )
  ].sort();

  if (!expiries.length) {
    throw new Error(
      `No expiry found for ${instrumentKey}`
    );
  }

  return expiries[0];
}

async function automaticOptionScan() {

  const underlyings = [
    {
      name: "NIFTY",
      key: "NSE_INDEX|Nifty 50"
    },
    {
      name: "BANKNIFTY",
      key: "NSE_INDEX|Nifty Bank"
    },
    {
      name: "SENSEX",
      key: "BSE_INDEX|SENSEX"
    }
  ];

  const results = [];

  for (const underlying of underlyings) {

    try {

      const expiry =
        await getNearestExpiry(
          underlying.key
        );

      const chain =
        await getOptionChain(
          underlying.key,
          expiry
        );

      const rows =
        buildOptionRows(
          chain?.data || [],
          underlying.name
        );

      const alerts =
        rows.filter(
          item => item.strong
        );

      alerts.sort(
        (a, b) =>
          Math.abs(
            b.price_change_percent || 0
          ) -
          Math.abs(
            a.price_change_percent || 0
          )
      );

      results.push({
        underlying:
          underlying.name,

        instrument_key:
          underlying.key,

        expiry,

        scanned:
          rows.length,

        alert_count:
          alerts.length,

        alerts
      });

    } catch (error) {

      results.push({
        underlying:
          underlying.name,

        error:
          error.message
      });
    }
  }

  return results;
}

// ==================================================
// SERVER
// ==================================================

const server = http.createServer(async (req, res) => {

  // ==================================================
  // OPTIONS / CORS
  // ==================================================

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    // ==================================================
    // HOME
    // ==================================================

    if (url.pathname === "/") {
      return sendJson(res, 200, {
        success: true,
        app: "Smart Trade India Backend",
        status: "running"
      });
    }

    // ==================================================
    // HEALTH
    // ==================================================

    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        success: true,
        app: "Smart Trade India Backend",
        status: "running",
        upstox_token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN
      });
    }

    // ==================================================
    // UPSTOX STATUS
    // ==================================================

    if (url.pathname === "/api/upstox/status") {
      return sendJson(res, 200, {
        success: true,
        token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN
      });
    }

    // ==================================================
    // MARKET QUOTE
    // ==================================================

    if (url.pathname === "/api/market/quote") {

      const instrumentKey =
        url.searchParams.get("instrument_key");

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const apiUrl =
        `https://api.upstox.com/v2/market-quote/ltp` +
        `?instrument_key=${encodeURIComponent(instrumentKey)}`;

      const data =
        await upstoxRequest(apiUrl);

      return sendJson(res, 200, {
        success: true,
        data
      });
    }

    // ==================================================
    // MULTIPLE MARKET QUOTES
    // ==================================================

    if (url.pathname === "/api/market/quotes") {

      const instrumentKeys =
        url.searchParams.get("instrument_keys");

      if (!instrumentKeys) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_keys is required"
        });
      }

      const apiUrl =
        `https://api.upstox.com/v2/market-quote/ltp` +
        `?instrument_key=${encodeURIComponent(instrumentKeys)}`;

      const data =
        await upstoxRequest(apiUrl);

      return sendJson(res, 200, {
        success: true,
        data
      });
    }

    // ==================================================
    // OPTION CONTRACTS
    // ==================================================

    if (url.pathname === "/api/options/contracts") {

      const instrumentKey =
        url.searchParams.get("instrument_key");

      const expiry =
        url.searchParams.get("expiry");

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      let apiUrl =
        `https://api.upstox.com/v2/option/contract` +
        `?instrument_key=${encodeURIComponent(instrumentKey)}`;

      if (expiry) {
        apiUrl +=
          `&expiry_date=${encodeURIComponent(expiry)}`;
      }

      const data =
        await upstoxRequest(apiUrl);

      return sendJson(res, 200, {
        success: true,
        underlying: instrumentKey,
        expiry: expiry || "all",
        count:
          Array.isArray(data?.data)
            ? data.data.length
            : 0,
        data:
          data?.data || []
      });
    }

    // ==================================================
    // OPTION CHAIN
    // ==================================================

    if (url.pathname === "/api/options/chain") {

      const instrumentKey =
        url.searchParams.get("instrument_key");

      const expiry =
        url.searchParams.get("expiry") ||
        "current_week";

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const data =
        await getOptionChain(
          instrumentKey,
          expiry
        );

      return sendJson(res, 200, {
        success: true,
        underlying: instrumentKey,
        expiry,
        data:
          data?.data || []
      });
    }

    // ==================================================
    // OPTION MOVERS
    // ==================================================

    if (url.pathname === "/api/options/movers") {

      const instrumentKey =
        url.searchParams.get("instrument_key");

      const expiry =
        url.searchParams.get("expiry") ||
        "current_week";

      const minVolumeChange =
        Number(
          url.searchParams.get("min_volume_change") || 0
        );

      const minOiChange =
        Number(
          url.searchParams.get("min_oi_change") || 0
        );

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const result =
        await getOptionChain(
          instrumentKey,
          expiry
        );

      const rows =
        buildOptionRows(
          result?.data || [],
          instrumentKey
        );

      const filtered =
        rows.filter(item =>
          item.volume_change_percent >=
            minVolumeChange &&
          item.oi_change_percent >=
            minOiChange
        );

      filtered.sort(
        (a, b) =>
          Math.abs(b.price_change_percent) -
          Math.abs(a.price_change_percent)
      );

      return sendJson(res, 200, {
        success: true,
        underlying: instrumentKey,
        expiry,
        count: filtered.length,

        strong_alerts:
          filtered.filter(
            item => item.strong
          ),

        data: filtered
      });
    }

    // ==================================================
    // OPTION ALERTS
    // ==================================================

    if (url.pathname === "/api/options/alerts") {

      const instrumentKey =
        url.searchParams.get("instrument_key");

      const expiry =
        url.searchParams.get("expiry") ||
        "current_week";

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const result =
        await getOptionChain(
          instrumentKey,
          expiry
        );

      const rows =
        buildOptionRows(
          result?.data || [],
          instrumentKey
        );

      const alerts =
        rows.filter(
          item => item.strong
        );

      alerts.sort(
        (a, b) =>
          Math.abs(b.price_change_percent) -
          Math.abs(a.price_change_percent)
      );

      return sendJson(res, 200, {
        success: true,
        underlying: instrumentKey,
        expiry,
        alert_count: alerts.length,
        alerts
      });
    }

    // ==================================================
    // MULTI INDEX OPTION SCANNER
    // NIFTY + BANKNIFTY + SENSEX
    // ==================================================

    if (url.pathname === "/api/options/scan") {

      const expiry =
        url.searchParams.get("expiry") ||
        "current_week";

      const underlyings = [

        {
          name: "NIFTY",
          key: "NSE_INDEX|Nifty 50"
        },

        {
          name: "BANKNIFTY",
          key: "NSE_INDEX|Nifty Bank"
        },

        {
          name: "SENSEX",
          key: "BSE_INDEX|SENSEX"
        }

      ];

      const allAlerts = [];

      for (const underlying of underlyings) {

        try {

          const result =
            await getOptionChain(
              underlying.key,
              expiry
            );

          const rows =
            buildOptionRows(
              result?.data || [],
              underlying.name
            );

          const alerts =
            rows.filter(
              item => item.strong
            );

          allAlerts.push(...alerts);

        } catch (error) {

          allAlerts.push({
            underlying_name:
              underlying.name,

            error:
              error.message
          });
        }
      }

      allAlerts.sort(
        (a, b) =>
          Math.abs(
            b.price_change_percent || 0
          ) -
          Math.abs(
            a.price_change_percent || 0
          )
      );

      return sendJson(res, 200, {
        success: true,
        expiry,
        alert_count:
          allAlerts.length,
        alerts:
          allAlerts
      });
    }
// ==================================================
// AUTOMATIC SCAN API
// ==================================================

if (url.pathname === "/api/options/auto-scan") {

  const results =
    await automaticOptionScan();

  const alerts = [];

  for (const result of results) {
    if (Array.isArray(result.alerts)) {
      alerts.push(...result.alerts);
    }
  }

  alerts.sort(
    (a, b) =>
      Math.abs(
        b.price_change_percent || 0
      ) -
      Math.abs(
        a.price_change_percent || 0
      )
  );

  return sendJson(res, 200, {
    success: true,
    market: "NSE/BSE Options",
    scanned_at:
      new Date().toISOString(),
    total_alerts:
      alerts.length,
    results,
    alerts
  });
   // ==================================================
// 5 MINUTE CANDLE API
// ==================================================

if (url.pathname === "/api/market/candles") {

  const instrumentKey =
    url.searchParams.get("instrument_key");

  const interval =
    url.searchParams.get("interval") || "5";

  if (!instrumentKey) {
    return sendJson(res, 400, {
      success: false,
      error: "instrument_key is required"
    });
  }

  const apiUrl =
    `https://api.upstox.com/v3/historical-candle/intraday/` +
    `${encodeURIComponent(instrumentKey)}/minutes/${encodeURIComponent(interval)}`;

  const data =
    await upstoxRequest(apiUrl);

  const candles =
    data?.data?.candles || [];

  return sendJson(res, 200, {
    success: true,
    instrument_key: instrumentKey,
    interval_minutes: Number(interval),
    candle_count: candles.length,
    candles
  });
}
    // ==================================================
    // NOT FOUND
    // ==================================================

    return sendJson(res, 404, {
      success: false,
      error: "Endpoint not found"
    });

  } catch (error) {

    console.error(error);

    return sendJson(res, 500, {
      success: false,
      error:
        error.message ||
        "Server error"
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
