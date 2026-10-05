const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

// =====================================================
// SMART TRADE INDIA BACKEND
// Upstox OAuth + Live Market Data
// =====================================================

let upstoxAccessToken = null;
let tokenCreatedAt = null;

// -----------------------------------------------------
// JSON response
// -----------------------------------------------------
function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });

  res.end(JSON.stringify(data));
}

// -----------------------------------------------------
// HTML response
// -----------------------------------------------------
function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(text);
}

// -----------------------------------------------------
// Read POST body
// -----------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      resolve(body);
    });

    req.on("error", reject);
  });
}

// -----------------------------------------------------
// Get Upstox credentials from Render Environment
// -----------------------------------------------------
function getUpstoxConfig() {
  return {
    clientId: process.env.UPSTOX_API_KEY,
    clientSecret: process.env.UPSTOX_API_SECRET,
    redirectUri:
      process.env.UPSTOX_REDIRECT_URI ||
      "https://www.smartmarketsignal.in/ups"
  };
}

// -----------------------------------------------------
// Create Upstox Login URL
// -----------------------------------------------------
function getUpstoxLoginUrl() {
  const { clientId, redirectUri } = getUpstoxConfig();

  if (!clientId || !redirectUri) {
    return null;
  }

  const loginUrl = new URL(
    "https://api.upstox.com/v2/login/authorization/dialog"
  );

  loginUrl.searchParams.set("response_type", "code");
  loginUrl.searchParams.set("client_id", clientId);
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  loginUrl.searchParams.set("state", "smart-trade-india");

  return loginUrl.toString();
}

// -----------------------------------------------------
// Exchange authorization code for access token
// -----------------------------------------------------
async function exchangeCodeForToken(code) {
  const { clientId, clientSecret, redirectUri } =
    getUpstoxConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Upstox credentials are not configured on Render."
    );
  }

  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch(
    "https://api.upstox.com/v2/login/authorization/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: form.toString()
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result?.errors?.[0]?.message ||
      result?.message ||
      "Upstox token exchange failed."
    );
  }

  if (!result.access_token) {
    throw new Error("Upstox did not return an access token.");
  }

  // Store token only in server memory.
  // Never send it to the frontend.
  upstoxAccessToken = result.access_token;
  tokenCreatedAt = new Date().toISOString();

  return true;
}

// -----------------------------------------------------
// Get access token
// -----------------------------------------------------
function requireAccessToken(res) {
  if (!upstoxAccessToken) {
    sendJson(res, 401, {
      success: false,
      error: "UPSTOX_LOGIN_REQUIRED",
      message:
        "Please connect your Upstox account first."
    });

    return false;
  }

  return true;
}

// -----------------------------------------------------
// Get live market quotes from Upstox V3
// -----------------------------------------------------
async function getMarketQuotes(instrumentKeys) {
  if (!upstoxAccessToken) {
    throw new Error("Upstox account is not connected.");
  }

  const apiUrl =
    new URL("https://api.upstox.com/v3/market-quote/quotes");

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKeys.join(",")
  );

  const response = await fetch(apiUrl.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${upstoxAccessToken}`
    }
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result?.errors?.[0]?.message ||
      result?.message ||
      "Unable to get market data from Upstox."
    );
  }

  return result;
}

// =====================================================
// SERVER
// =====================================================

const server = http.createServer(async (req, res) => {
  try {
    // -------------------------------------------------
    // CORS preflight
    // -------------------------------------------------
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization",
        "Access-Control-Allow-Methods":
          "GET, POST, OPTIONS"
      });

      return res.end();
    }

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    // =================================================
    // HEALTH
    // =================================================

    if (
      url.pathname === "/" ||
      url.pathname === "/health"
    ) {
      return sendJson(res, 200, {
        ok: true,
        app: "Smart Trade India Backend",
        status: "running",
        upstox_connected: !!upstoxAccessToken
      });
    }

    // =================================================
    // UPSTOX LOGIN URL
    // =================================================

    if (
      url.pathname === "/api/upstox/login" &&
      req.method === "GET"
    ) {
      const loginUrl = getUpstoxLoginUrl();

      if (!loginUrl) {
        return sendJson(res, 500, {
          success: false,
          error:
            "UPSTOX_API_KEY or UPSTOX_REDIRECT_URI is missing."
        });
      }

      return sendJson(res, 200, {
        success: true,
        login_url: loginUrl
      });
    }

    // =================================================
    // UPSTOX OAUTH CALLBACK
    // =================================================

    if (
      url.pathname === "/ups" &&
      req.method === "GET"
    ) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code) {
        return sendText(
          res,
          400,
          `
          <h2>Upstox Login Failed</h2>
          <p>Authorization code not received.</p>
          `
        );
      }

      try {
        await exchangeCodeForToken(code);

        return sendText(
          res,
          200,
          `
          <html>
            <head>
              <meta name="viewport"
                    content="width=device-width,initial-scale=1">
              <title>Smart Trade India</title>
            </head>
            <body style="font-family:Arial;padding:30px">
              <h2>✅ Upstox Connected</h2>
              <p>Smart Trade India backend is connected to Upstox.</p>
              <p>You can return to the app now.</p>
            </body>
          </html>
          `
        );
      } catch (error) {
        return sendText(
          res,
          500,
          `
          <h2>❌ Upstox Connection Failed</h2>
          <p>${error.message}</p>
          `
        );
      }
    }

    // =================================================
    // MANUAL TOKEN EXCHANGE
    // =================================================

    if (
      url.pathname === "/api/upstox/token" &&
      req.method === "POST"
    ) {
      const body = await readBody(req);

      try {
        const data = JSON.parse(body || "{}");
        const code = data.code;

        if (!code) {
          return sendJson(res, 400, {
            success: false,
            error: "Authorization code is required."
          });
        }

        await exchangeCodeForToken(code);

        return sendJson(res, 200, {
          success: true,
          message: "Upstox authentication successful.",
          token_received: true
        });
      } catch (error) {
        return sendJson(res, 500, {
          success: false,
          error: error.message
        });
      }
    }

    // =================================================
    // UPSTOX CONNECTION STATUS
    // =================================================

    if (
      url.pathname === "/api/upstox/status" &&
      req.method === "GET"
    ) {
      return sendJson(res, 200, {
        success: true,
        connected: !!upstoxAccessToken,
        token_created_at: tokenCreatedAt
      });
    }

    // =================================================
    // LIVE MARKET QUOTE
    //
    // Example:
    // /api/market/quote?instrument_key=NSE_EQ|INE848E01016
    // =================================================

    if (
      url.pathname === "/api/market/quote" &&
      req.method === "GET"
    ) {
      if (!requireAccessToken(res)) {
        return;
      }

      const instrumentKey =
        url.searchParams.get("instrument_key");

      if (!instrumentKey) {
        return sendJson(res, 400, {
          success: false,
          error:
            "instrument_key is required.",
          example:
            "NSE_EQ|INE848E01016"
        });
      }

      try {
        const data = await getMarketQuotes([
          instrumentKey
        ]);

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

    // =================================================
    // MULTIPLE LIVE MARKET QUOTES
    //
    // Example:
    // /api/market/quotes?instrument_keys=NSE_EQ|AAA,NSE_EQ|BBB
    // =================================================

    if (
      url.pathname === "/api/market/quotes" &&
      req.method === "GET"
    ) {
      if (!requireAccessToken(res)) {
        return;
      }

      const rawKeys =
        url.searchParams.get("instrument_keys");

      if (!rawKeys) {
        return sendJson(res, 400, {
          success: false,
          error:
            "instrument_keys is required."
        });
      }

      const instrumentKeys = rawKeys
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

      if (instrumentKeys.length === 0) {
        return sendJson(res, 400, {
          success: false,
          error: "No valid instrument keys provided."
        });
      }

      if (instrumentKeys.length > 500) {
        return sendJson(res, 400, {
          success: false,
          error:
            "Maximum 500 instruments per request."
        });
      }

      try {
        const data =
          await getMarketQuotes(instrumentKeys);

        return sendJson(res, 200, {
          success: true,
          count: instrumentKeys.length,
          data
        });
      } catch (error) {
        return sendJson(res, 502, {
          success: false,
          error: error.message
        });
      }
    }

    // =================================================
    // 404
    // =================================================

    return sendJson(res, 404, {
      success: false,
      error: "Endpoint not found."
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return sendJson(res, 500, {
      success: false,
      error: "Internal server error."
    });
  }
});

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, () => {
  console.log(
    `Smart Trade India backend running on port ${PORT}`
  );
});
