const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

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

    // Health
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

    // Upstox connection status
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

    // Single quote
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

    // Multiple quotes
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

    return sendJson(res, 404, {
      success: false,
      error: "Endpoint not found"
    });

  } catch (error) {
    console.error("SERVER ERROR:", error.message);

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
