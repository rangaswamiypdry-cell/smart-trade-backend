const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

const optionSnapshots = new Map();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

async function upstoxRequest(url) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error("UPSTOX_ACCESS_TOKEN_MISSING");
  }

  const response = await fetch(url, {
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

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function movement(current, previous) {
  if (!previous || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function analyseOption(option, side, snapshotKey) {
  if (!option || !option.market_data) return null;

  const md = option.market_data;

  const ltp = number(md.ltp);
  const volume = number(md.volume);
  const oi = number(md.oi);
  const prevOi = number(md.prev_oi);

  const old = optionSnapshots.get(snapshotKey);

  const volumeChange = old
    ? movement(volume, old.volume)
    : 0;

  const priceChange = old
    ? movement(ltp, old.ltp)
    : 0;

  const oiChange = old
    ? movement(oi, old.oi)
    : movement(oi, prevOi);

  const bullish =
    priceChange > 0 &&
    volumeChange > 0 &&
    oiChange > 0;

  const bearish =
    priceChange < 0 &&
    volumeChange > 0 &&
    oiChange > 0;

  const strong =
    Math.abs(priceChange) >= 1 &&
    volumeChange >= 20 &&
    oiChange >= 5;

  optionSnapshots.set(snapshotKey, {
    ltp,
    volume,
    oi
  });

  return {
    side,
    instrument_key: option.instrument_key,
    ltp,
    volume,
    oi,
    prev_oi: prevOi,
    price_change_percent: Number(priceChange.toFixed(2)),
    volume_change_percent: Number(volumeChange.toFixed(2)),
    oi_change_percent: Number(oiChange.toFixed(2)),
    bullish,
    bearish,
    strong
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    // =========================
    // HEALTH
    // =========================

    if (
      url.pathname === "/" ||
      url.pathname === "/health"
    ) {
      return sendJson(res, 200, {
        success: true,
        app: "Smart Trade India Backend",
        status: "running",
        upstox_token_configured:
          !!process.env.UPSTOX_ACCESS_TOKEN
      });
    }

    // =========================
    // UPSTOX STATUS
    // =========================

    if (
      url.pathname === "/api/upstox/status" &&
      req.method === "GET"
    ) {
      return sendJson(res, 200, {
        success: true,
        connected:
          !!process.env.UPSTOX_ACCESS_TOKEN
      });
    }

    // =========================
    // SINGLE LIVE QUOTE
    // =========================

    if (
      url.pathname === "/api/market/quote" &&
      req.method === "GET"
    ) {
      const instrumentKey =
        url.searchParams.get("instrument_key");

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_key is required"
        });
      }

      const apiUrl = new URL(
        "https://api.upstox.com/v3/market-quote/quotes"
      );

      apiUrl.searchParams.set(
        "instrument_key",
        instrumentKey
      );

      try {
        const data =
          await upstoxRequest(apiUrl.toString());

        return sendJson(res, 200, {
          success: true,
          data
        });
      } catch (error) {
        return sendJson(res, 502, {
          success: false,
          error: error.message
        });
      }
    }

    // =========================
    // MULTIPLE LIVE QUOTES
    // =========================

    if (
      url.pathname === "/api/market/quotes" &&
      req.method === "GET"
    ) {
      const raw =
        url.searchParams.get("instrument_keys");

      if (!raw) {
        return sendJson(res, 400, {
          success: false,
          error: "instrument_keys is required"
        });
      }

      const keys = raw
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

      if (keys.length > 500) {
        return sendJson(res, 400, {
          success: false,
          error: "Maximum 500 instruments allowed"
        });
      }

      const apiUrl = new URL(
        "https://api.upstox.com/v3/market-quote/quotes"
      );

      apiUrl.searchParams.set(
        "instrument_key",
        keys.join(",")
      );

      try {
        const data =
          await upstoxRequest(apiUrl.toString());

        return sendJson(res, 200, {
          success: true,
          count: keys.length,
          data
        });
      } catch (error) {
        return sendJson(res, 502, {
          success: false,
          error: error.message
        });
      }
    }

    // =========================
    // OPTION CHAIN
    // =========================

    if (
      url.pathname === "/api/options/chain" &&
      req.method === "GET"
    ) {
      const instrumentKey =
        url.searchParams.get("instrument_key");

      const expiry =
        url.searchParams.get("expiry") ||
        "current_week";

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error:
            "instrument_key is required"
        });
      }

      const apiUrl = new URL(
        "https://api.upstox.com/v2/option/chain"
      );

      apiUrl.searchParams.set(
        "instrument_key",
        instrumentKey
      );

      apiUrl.searchParams.set(
        "expiry_date",
        expiry
      );

      try {
        const data =
          await upstoxRequest(apiUrl.toString());

        return sendJson(res, 200, {
          success: true,
          underlying: instrumentKey,
          expiry,
          data
        });
      } catch (error) {
        return sendJson(res, 502, {
          success: false,
          error: error.message
        });
      }
    }

    // =========================
    // OPTION MOVERS
    // =========================

    if (
      url.pathname === "/api/options/movers" &&
      req.method === "GET"
    ) {
      const instrumentKey =
        url.searchParams.get("instrument_key");

      const expiry =
        url.searchParams.get("expiry") ||
        "current_week";

      const minVolumeChange =
        number(
          url.searchParams.get(
            "min_volume_change"
          ) || 0
        );

      const minOiChange =
        number(
          url.searchParams.get(
            "min_oi_change"
          ) || 0
        );

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error:
            "instrument_key is required"
        });
      }

      const apiUrl = new URL(
        "https://api.upstox.com/v2/option/chain"
      );

      apiUrl.searchParams.set(
        "instrument_key",
        instrumentKey
      );

      apiUrl.searchParams.set(
        "expiry_date",
        expiry
      );

      try {
        const response =
          await upstoxRequest(
            apiUrl.toString()
          );

        const rows = response.data || [];

        const movers = [];

        for (const row of rows) {
          const strike =
            number(row.strike_price);

          const call =
            analyseOption(
              row.call_options,
              "CE",
              `${row.call_options?.instrument_key}`
            );

          const put =
            analyseOption(
              row.put_options,
              "PE",
              `${row.put_options?.instrument_key}`
            );

          if (call) {
            const item = {
              strike,
              expiry: row.expiry,
              underlying:
                row.underlying_key,
              spot:
                number(row.underlying_spot_price),
              ...call
            };

            if (
              item.volume_change_percent >=
                minVolumeChange &&
              item.oi_change_percent >=
                minOiChange
            ) {
              movers.push(item);
            }
          }

          if (put) {
            const item = {
              strike,
              expiry: row.expiry,
              underlying:
                row.underlying_key,
              spot:
                number(row.underlying_spot_price),
              ...put
            };

            if (
              item.volume_change_percent >=
                minVolumeChange &&
              item.oi_change_percent >=
                minOiChange
            ) {
              movers.push(item);
            }
          }
        }

        movers.sort(
          (a, b) =>
            Math.abs(
              b.price_change_percent
            ) -
            Math.abs(
              a.price_change_percent
            )
        );

        const alerts =
          movers.filter(
            x => x.strong
          );

        return sendJson(res, 200, {
          success: true,
          underlying: instrumentKey,
          expiry,
          count: movers.length,
          alerts,
          movers
        });

      } catch (error) {
        return sendJson(res, 502, {
          success: false,
          error: error.message
        });
      }
    }

    // =========================
    // NOT FOUND
    // =========================

    return sendJson(res, 404, {
      success: false,
      error: "Endpoint not found"
    });

  } catch (error) {
    console.error(
      "SERVER ERROR:",
      error.message
    );

    return sendJson(res, 500, {
      success: false,
      error: "Internal server error"
    });
  }
});

server.listen(PORT, () => {
  console.log(
    `Smart Trade India Backend running on port ${PORT}`
  );
});
