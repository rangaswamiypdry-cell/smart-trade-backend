const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

let upstoxAccessToken = null;
let tokenCreatedAt = null;

function headers() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...headers(),
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    ...headers(),
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(html);
}

function getConfig() {
  return {
    clientId: process.env.UPSTOX_API_KEY,
    clientSecret: process.env.UPSTOX_API_SECRET,
    redirectUri: process.env.UPSTOX_REDIRECT_URI
  };
}

// =====================================================
// UPSTOX LOGIN
// =====================================================

function createLoginUrl() {
  const { clientId, redirectUri } = getConfig();

  if (!clientId || !redirectUri) {
    throw new Error(
      "UPSTOX_API_KEY or UPSTOX_REDIRECT_URI is missing."
    );
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

// =====================================================
// TOKEN EXCHANGE
// =====================================================

async function exchangeCode(code) {
  const {
    clientId,
    clientSecret,
    redirectUri
  } = getConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Upstox credentials are missing in Render."
    );
  }

  const body = new URLSearchParams();

  body.set("code", code);
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("redirect_uri", redirectUri);
  body.set("grant_type", "authorization_code");

  const response = await fetch(
    "https://api.upstox.com/v2/login/authorization/token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: body.toString()
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
    throw new Error(
      "Upstox access token was not received."
    );
  }

  upstoxAccessToken = result.access_token;
  tokenCreatedAt = new Date().toISOString();

  return result;
}

// =====================================================
// MARKET QUOTE V3
// =====================================================

async function getQuotes(instrumentKeys) {
  if (!upstoxAccessToken) {
    throw new Error(
      "UPSTOX_LOGIN_REQUIRED"
    );
  }

  const apiUrl = new URL(
    "https://api.upstox.com/v3/market-quote/quotes"
  );

  apiUrl.searchParams.set(
    "instrument_key",
    instrumentKeys.join(",")
  );

  const response = await fetch(
    apiUrl.toString(),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization:
          `Bearer ${upstoxAccessToken}`
      }
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result?.errors?.[0]?.message ||
      result?.message ||
      "Market data request failed."
    );
  }

  return result;
}

// =====================================================
// SERVER
// =====================================================

const server = http.createServer(
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers());
        return res.end();
      }

      const url = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      // -------------------------------------------------
      // HOME / HEALTH
      // -------------------------------------------------

      if (
        url.pathname === "/" ||
        url.pathname === "/health"
      ) {
        return sendJson(res, 200, {
          success: true,
          app: "Smart Trade India Backend",
          status: "running",
          upstox_connected:
            !!upstoxAccessToken
        });
      }

      // -------------------------------------------------
      // UPSTOX LOGIN
      // -------------------------------------------------

      if (
        url.pathname === "/api/upstox/login" &&
        req.method === "GET"
      ) {
        try {
          const loginUrl = createLoginUrl();

          // DIRECT REDIRECT TO UPSTOX
          res.writeHead(302, {
            Location: loginUrl
          });

          return res.end();

        } catch (error) {
          return sendJson(res, 500, {
            success: false,
            error: error.message
          });
        }
      }

      // -------------------------------------------------
      // UPSTOX CALLBACK
      // -------------------------------------------------

      if (
        url.pathname === "/ups" &&
        req.method === "GET"
      ) {
        const code =
          url.searchParams.get("code");

        if (!code) {
          return sendHtml(
            res,
            400,
            `
            <html>
              <body style="font-family:Arial;padding:30px">
                <h2>❌ Upstox Login Failed</h2>
                <p>Authorization code not received.</p>
              </body>
            </html>
            `
          );
        }

        try {
          await exchangeCode(code);

          return sendHtml(
            res,
            200,
            `
            <html>
              <head>
                <meta name="viewport"
                  content="width=device-width,initial-scale=1">
              </head>
              <body style="font-family:Arial;padding:30px">
                <h2>✅ Upstox Connected</h2>
                <p>Smart Trade India is connected.</p>
                <p>You can return to the app.</p>
              </body>
            </html>
            `
          );

        } catch (error) {
          return sendHtml(
            res,
            500,
            `
            <html>
              <body style="font-family:Arial;padding:30px">
                <h2>❌ Upstox Connection Failed</h2>
                <p>${error.message}</p>
              </body>
            </html>
            `
          );
        }
      }

      // -------------------------------------------------
      // UPSTOX STATUS
      // -------------------------------------------------

      if (
        url.pathname === "/api/upstox/status" &&
        req.method === "GET"
      ) {
        return sendJson(res, 200, {
          success: true,
          connected:
            !!upstoxAccessToken,
          token_created_at:
            tokenCreatedAt
        });
      }

      // -------------------------------------------------
      // SINGLE MARKET QUOTE
      // -------------------------------------------------

      if (
        url.pathname === "/api/market/quote" &&
        req.method === "GET"
      ) {
        if (!upstoxAccessToken) {
          return sendJson(res, 401, {
            success: false,
            error:
              "UPSTOX_LOGIN_REQUIRED",
            message:
              "Please connect Upstox first."
          });
        }

        const key =
          url.searchParams.get(
            "instrument_key"
          );

        if (!key) {
          return sendJson(res, 400, {
            success: false,
            error:
              "instrument_key is required."
          });
        }

        try {
          const data =
            await getQuotes([key]);

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

      // -------------------------------------------------
      // MULTIPLE MARKET QUOTES
      // -------------------------------------------------

      if (
        url.pathname === "/api/market/quotes" &&
        req.method === "GET"
      ) {
        if (!upstoxAccessToken) {
          return sendJson(res, 401, {
            success: false,
            error:
              "UPSTOX_LOGIN_REQUIRED"
          });
        }

        const raw =
          url.searchParams.get(
            "instrument_keys"
          );

        if (!raw) {
          return sendJson(res, 400, {
            success: false,
            error:
              "instrument_keys is required."
          });
        }

        const keys = raw
          .split(",")
          .map(x => x.trim())
          .filter(Boolean);

        if (keys.length > 500) {
          return sendJson(res, 400, {
            success: false,
            error:
              "Maximum 500 instruments allowed."
          });
        }

        try {
          const data =
            await getQuotes(keys);

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

      // -------------------------------------------------
      // 404
      // -------------------------------------------------

      return sendJson(res, 404, {
        success: false,
        error: "Endpoint not found."
      });

    } catch (error) {
      console.error(
        "SERVER ERROR:",
        error
      );

      return sendJson(res, 500, {
        success: false,
        error:
          "Internal server error."
      });
    }
  }
);

// =====================================================
// START
// =====================================================

server.listen(PORT, () => {
  console.log(
    `Smart Trade India Backend running on port ${PORT}`
  );
});
