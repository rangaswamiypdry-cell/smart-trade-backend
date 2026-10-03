const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      app: "Smart Trade India Backend",
      status: "running"
    });
  }

  // Upstox OAuth callback
  if (url.pathname === "/ups" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) {
      return sendText(
        res,
        400,
        "<h2>Upstox Login Failed</h2><p>Authorization code not received.</p>"
      );
    }

    return sendJson(res, 200, {
      success: true,
      message: "Upstox authorization code received.",
      code_received: true,
      state_received: !!state,
      next: "Backend token exchange will be added next."
    });
  }

  // Exchange Upstox authorization code for access token
  if (url.pathname === "/api/upstox/token" && req.method === "POST") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const code = data.code;

        if (!code) {
          return sendJson(res, 400, {
            success: false,
            error: "Authorization code is required"
          });
        }

        const clientId = process.env.UPSTOX_API_KEY;
        const clientSecret = process.env.UPSTOX_API_SECRET;
        const redirectUri =
          process.env.UPSTOX_REDIRECT_URI ||
          "https://www.smartmarketsignal.in/ups";

        if (!clientId || !clientSecret) {
          return sendJson(res, 500, {
            success: false,
            error: "Upstox credentials are not configured on the server"
          });
        }

        const form = new URLSearchParams({
          code: code,
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
          return sendJson(res, response.status, {
            success: false,
            error: result
          });
        }

        // Do NOT log or expose the access token.
        return sendJson(res, 200, {
          success: true,
          message: "Upstox authentication successful.",
          token_received: !!result.access_token
        });

      } catch (error) {
        return sendJson(res, 500, {
          success: false,
          error: "Server error",
          message: error.message
        });
      }
    });

    return;
  }

  return sendJson(res, 404, {
    success: false,
    error: "Endpoint not found"
  });
});

server.listen(PORT, () => {
  console.log(`Smart Trade India backend running on port ${PORT}`);
});
