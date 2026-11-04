// ======================================================
// SMART TRADE INDIA V5
// INSTITUTIONAL MOMENTUM SCANNER
// NSE F&O STOCK FUTURES
// NODE.JS 20+
// UPSTOX V3 API
// ======================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const UPSTOX_BASE = "https://api.upstox.com";

const ACCESS_TOKEN =
    process.env.UPSTOX_ACCESS_TOKEN || "";

const MASTER_URL =
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

let instruments = [];

let stockCache = [];

let optionCache = [];

let lastScanTime = null;

let scanBusy = false;

const CACHE_TIME = 60000;

// ======================================================
// CORS
// ======================================================

function cors(res) {

    res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );

}

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {

    cors(res);

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));

}

// ======================================================
// UPSTOX REQUEST
// ======================================================

async function upstoxRequest(path) {

    if (!ACCESS_TOKEN) {

        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing in Render"
        );

    }

    const response = await fetch(
        UPSTOX_BASE + path,
        {
            method: "GET",

            headers: {
                "Accept": "application/json",
                "Authorization":
                    "Bearer " + ACCESS_TOKEN
            },

            signal: AbortSignal.timeout(20000)
        }
    );

    const text = await response.text();

    let data;

    try {

        data = JSON.parse(text);

    } catch (e) {

        throw new Error(
            "Invalid Upstox JSON response"
        );

    }

    if (!response.ok) {

        throw new Error(
            "Upstox HTTP " +
            response.status +
            ": " +
            (data.message || text.slice(0, 200))
        );

    }

    return data;

}

// ======================================================
// DOWNLOAD NSE INSTRUMENT MASTER
// ======================================================

async function downloadMaster() {

    console.log("Downloading NSE instrument master...");

    const response = await fetch(MASTER_URL, {
        signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {

        throw new Error(
            "Instrument master download failed: " +
            response.status
        );

    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    let jsonBuffer;

    try {

        jsonBuffer = zlib.gunzipSync(buffer);

    } catch (e) {

        jsonBuffer = buffer;

    }

    const master = JSON.parse(
        jsonBuffer.toString("utf8")
    );

    const today = new Date()
        .toISOString()
        .slice(0, 10);

    const futures = master.filter(item => {

        return (

            item.segment === "NSE_FO" &&

            String(item.instrument_type)
                .toUpperCase()
                .includes("FUT") &&

            item.instrument_key &&

            item.underlying_symbol &&

            item.expiry >= today

        );

    });

    // Nearest expiry for each underlying

    const unique = new Map();

    for (const item of futures) {

        const symbol = item.underlying_symbol;

        const previous = unique.get(symbol);

        if (
            !previous ||
            item.expiry < previous.expiry
        ) {

            unique.set(symbol, item);

        }

    }

    instruments = Array.from(unique.values());

    console.log(
        "NSE F&O futures loaded:",
        instruments.length
    );

    return instruments;

}

// ======================================================
// LOAD MASTER WITH CACHE
// ======================================================

async function getInstruments() {

    if (instruments.length > 0) {

        return instruments;

    }

    return await downloadMaster();

}

// ======================================================
// GET 5 MINUTE INTRADAY CANDLES
// ======================================================

async function getCandles(instrumentKey) {

    const encoded = encodeURIComponent(
        instrumentKey
    );

    const path =
        "/v3/historical-candle/intraday/" +
        encoded +
        "/minutes/5";

    const response = await upstoxRequest(path);

    const candles =
        response.data?.candles || [];

    return candles
        .map(c => ({

            time: new Date(c[0]).getTime(),

            open: Number(c[1]),

            high: Number(c[2]),

            low: Number(c[3]),

            close: Number(c[4]),

            volume: Number(c[5]),

            oi: Number(c[6] || 0)

        }))
        .filter(c =>
            Number.isFinite(c.time) &&
            Number.isFinite(c.close) &&
            Number.isFinite(c.volume)
        )
        .sort((a, b) => a.time - b.time);

}

// ======================================================
// CLOSED CANDLES ONLY
// ======================================================

function getClosedCandles(candles) {

    const now = Date.now();

    return candles.filter(c => {

        return c.time + 5 * 60 * 1000 <= now;

    });

}// ======================================================
// RSI CALCULATION - WILDER
// ======================================================

function calculateRSI(candles, period = 14) {

    if (candles.length <= period) return 0;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        if (change > 0) gains += change;
        else losses += Math.abs(change);

    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < candles.length; i++) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);

        avgGain =
            (avgGain * (period - 1) + gain) / period;

        avgLoss =
            (avgLoss * (period - 1) + loss) / period;

    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - (100 / (1 + rs));

}

// ======================================================
// EMA CALCULATION
// ======================================================

function calculateEMA(values, period = 20) {

    if (values.length < period) return 0;

    const multiplier = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        ema =
            (values[i] - ema) * multiplier + ema;

    }

    return ema;

}

// ======================================================
// VWAP CALCULATION
// ======================================================

function calculateVWAP(candles) {

    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        totalPV += typical * c.volume;

        totalVolume += c.volume;

    }

    if (!totalVolume) return 0;

    return totalPV / totalVolume;

}

// ======================================================
// ADX-LIKE TREND STRENGTH
// ======================================================

function calculateStrength(candles) {

    if (candles.length < 15) return 0;

    let positive = 0;
    let negative = 0;

    for (
        let i = candles.length - 14;
        i < candles.length;
        i++
    ) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        if (change > 0) positive += change;
        else negative += Math.abs(change);

    }

    const total = positive + negative;

    if (!total) return 0;

    return Math.round(
        Math.abs(positive - negative) /
        total * 100
    );

}

// ======================================================
// STOCK ANALYSIS
// ======================================================

function analyseStock(item, candles) {

    if (candles.length < 21) return null;

    const latest = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const volumes = candles.map(c => c.volume);

    const ema20 = calculateEMA(closes, 20);

    const rsi = calculateRSI(candles, 14);

    const vwap = calculateVWAP(candles);

    const avgVolume =
        volumes
        .slice(-21, -1)
        .reduce((a, b) => a + b, 0) / 20;

    const volumeRatio =
        avgVolume > 0
        ? latest.volume / avgVolume
        : 0;

    const priceChange =
        previous.close > 0
        ? (
            (latest.close - previous.close) /
            previous.close
        ) * 100
        : 0;

    const oiChange =
        previous.oi > 0
        ? (
            (latest.oi - previous.oi) /
            previous.oi
        ) * 100
        : 0;

    const resistance = Math.max(
        ...candles.slice(-21, -1).map(c => c.high)
    );

    const support = Math.min(
        ...candles.slice(-21, -1).map(c => c.low)
    );

    const volumeBlast = volumeRatio >= 1.5;

    const priceUp = latest.close > previous.close;

    const priceDown = latest.close < previous.close;

    const bullish =
        latest.close > ema20 &&
        latest.close > vwap &&
        rsi >= 55 &&
        priceUp &&
        volumeBlast;

    const bearish =
        latest.close < ema20 &&
        latest.close < vwap &&
        rsi <= 45 &&
        priceDown &&
        volumeBlast;

    const longBuildup =
        priceUp &&
        latest.oi > previous.oi;

    const shortBuildup =
        priceDown &&
        latest.oi > previous.oi;

    let signal = "WATCH";

    if (bullish && latest.close > resistance) {

        signal = "STRONG BUY";

    } else if (bearish && latest.close < support) {

        signal = "STRONG SELL";

    } else if (bullish) {

        signal = "BUY";

    } else if (bearish) {

        signal = "SELL";

    }

    const entry = latest.close;

    const atr =
        candles.slice(-14).reduce(
            (sum, c) => sum + (c.high - c.low),
            0
        ) / 14;

    let stopLoss = 0;
    let target1 = 0;
    let target2 = 0;

    if (signal.includes("BUY")) {

        stopLoss = entry - atr * 1.5;

        target1 = entry + atr * 1.5;

        target2 = entry + atr * 3;

    } else if (signal.includes("SELL")) {

        stopLoss = entry + atr * 1.5;

        target1 = entry - atr * 1.5;

        target2 = entry - atr * 3;

    }

    return {

        symbol: item.underlying_symbol,

        instrumentKey: item.instrument_key,

        signal,

        price: entry,

        priceChange,

        oiChange,

        volume: latest.volume,

        volumeRatio,

        rsi,

        ema20,

        vwap,

        adx: calculateStrength(candles),

        strength: Math.round(
            Math.min(
                100,
                rsi + volumeRatio * 10
            )
        ),

        longBuildup,

        shortBuildup,

        volumeBlast,

        entry,

        stopLoss,

        target1,

        target2,

        orderBlock: "-",

        resistance,

        support,

        candleTime: latest.time

    };

}

// ======================================================
// SCAN ALL NSE F&O FUTURES
// ======================================================

async function scanStocks() {

    if (scanBusy) {

        return stockCache;

    }

    scanBusy = true;

    const results = [];

    try {

        const list = await getInstruments();

        // Limit API requests per scan.
        // Increase only after testing API limits.

        const selected = list.slice(0, 50);

        for (const item of selected) {

            try {

                const candles =
                    await getCandles(item.instrument_key);

                const closed =
                    getClosedCandles(candles);

                const analysis =
                    analyseStock(item, closed);

                if (analysis) {

                    results.push(analysis);

                }

            } catch (error) {

                console.log(
                    "Stock scan error:",
                    item.underlying_symbol,
                    error.message
                );

            }

        }

        stockCache = results;

        lastScanTime = new Date().toISOString();

        console.log(
            "Scan completed:",
            results.length
        );

        return results;

    } finally {

        scanBusy = false;

    }

}// ======================================================
// OPTIONS SCANNER
// ======================================================

async function scanOptions() {

    // Options API requires a separate option-chain
    // implementation and valid Upstox option contracts.
    // Return cached data until that is implemented.

    return optionCache;

}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(async (req, res) => {

    cors(res);

    if (req.method === "OPTIONS") {

        res.writeHead(204);
        return res.end();

    }

    const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
    );

    const path = url.pathname;

    try {

        // ==================================
        // HEALTH CHECK
        // ==================================

        if (path === "/health") {

            return sendJson(res, 200, {

                success: true,

                status: "ONLINE",

                app: "SMART TRADE INDIA V5",

                upstoxConnected: Boolean(ACCESS_TOKEN),

                totalInstruments: instruments.length,

                lastScan: lastScanTime

            });

        }

        // ==================================
        // UPSTOX STATUS
        // ==================================

        if (path === "/api/upstox/status") {

            return sendJson(res, 200, {

                success: true,

                connected: Boolean(ACCESS_TOKEN),

                message: ACCESS_TOKEN
                    ? "Access token configured"
                    : "UPSTOX_ACCESS_TOKEN missing"

            });

        }

        // ==================================
        // MAIN STOCK SCAN
        // ==================================

        if (
            path === "/api/scan" ||
            path === "/api/options/nse-stocks/scan"
        ) {

            const results = await scanStocks();

            return sendJson(res, 200, {

                success: true,

                count: results.length,

                lastScan: lastScanTime,

                stocks: results

            });

        }

        // ==================================
        // STOCK REFRESH
        // ==================================

        if (
            path === "/api/stocks" ||
            path === "/api/market/full-quotes"
        ) {

            return sendJson(res, 200, {

                success: true,

                count: stockCache.length,

                stocks: stockCache,

                lastScan: lastScanTime

            });

        }

        // ==================================
        // OPTIONS API
        // ==================================

        if (
            path === "/api/options" ||
            path === "/api/options/auto-scan"
        ) {

            const results = await scanOptions();

            return sendJson(res, 200, {

                success: true,

                count: results.length,

                options: results

            });

        }

        // ==================================
        // NSE STOCK LIST
        // ==================================

        if (path === "/api/options/nse-stocks") {

            const list = await getInstruments();

            return sendJson(res, 200, {

                success: true,

                count: list.length,

                stocks: list.map(item => ({

                    symbol: item.underlying_symbol,

                    instrumentKey: item.instrument_key,

                    expiry: item.expiry

                }))

            });

        }

        // ==================================
        // UNKNOWN ROUTE
        // ==================================

        return sendJson(res, 404, {

            success: false,

            message: "API route not found",

            route: path

        });

    } catch (error) {

        console.error(
            "SERVER ERROR:",
            error.stack || error.message
        );

        return sendJson(res, 500, {

            success: false,

            message: error.message

        });

    }

});

// ======================================================
// SERVER START
// ======================================================

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        "SMART TRADE INDIA V5 SERVER RUNNING"
    );

    console.log(
        "PORT:",
        PORT
    );

});

// ======================================================
// GLOBAL ERROR HANDLING
// ======================================================

process.on("unhandledRejection", error => {

    console.error(
        "UNHANDLED REJECTION:",
        error
    );

});

process.on("uncaughtException", error => {

    console.error(
        "UNCAUGHT EXCEPTION:",
        error
    );

});
