// ==================================================
// SMART TRADE INDIA
// 52 WEEK HIGH MOMENTUM SCANNER V2
// NSE ALL STOCKS + NSE F&O STOCKS
// NODE.JS 20+ | UPSTOX V3 | RENDER
// ==================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const UPSTOX = "https://api.upstox.com";

const INSTRUMENT_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

// ==================================================
// SETTINGS
// ==================================================

const SETTINGS = {
    TOUCH_PERCENT: 3,
    BREAKOUT_PERCENT: 0.10,
    MIN_RSI: 60,
    MIN_VOLUME_RATIO: 1.5,
    EMA_PERIOD: 20,
    RSI_PERIOD: 14,
    ATR_PERIOD: 14,
    WORKERS: 3,
    CACHE_TIME: 6 * 60 * 60 * 1000,
    REQUEST_DELAY: 300
};

let instrumentCache = [];

let scanCache = {
    ALL: [],
    FNO: [],
    updatedAt: null
};

let lastScan = 0;

// ==================================================
// HTTP RESPONSE
// ==================================================

function sendJson(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, OPTIONS"
    });

    res.end(JSON.stringify(data));
}

// ==================================================
// UPSTOX REQUEST
// ==================================================

async function upstoxRequest(url) {

    if (!TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const response = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "Authorization": "Bearer " + TOKEN
        },
        signal: AbortSignal.timeout(20000)
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            "Upstox API error " + response.status +
            ": " + JSON.stringify(result)
        );
    }

    return result;
}

// ==================================================
// INSTRUMENT MASTER DOWNLOAD
// ==================================================

async function loadInstruments() {

    if (instrumentCache.length) {
        return instrumentCache;
    }

    const response = await fetch(INSTRUMENT_URL);

    if (!response.ok) {
        throw new Error("Instrument master download failed");
    }

    let buffer = Buffer.from(
        await response.arrayBuffer()
    );

    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        buffer = zlib.gunzipSync(buffer);
    }

    const instruments = JSON.parse(
        buffer.toString("utf8")
    );

    const allStocks = instruments.filter(item =>
        item.segment === "NSE_EQ" &&
        item.instrument_type === "EQ" &&
        item.instrument_key &&
        item.trading_symbol &&
        item.security_type !== "SM"
    );

    const fnoKeys = new Set(
        instruments
            .filter(item =>
                item.segment === "NSE_FO" &&
                item.instrument_type === "FUT" &&
                item.underlying_type === "EQUITY" &&
                item.underlying_key
            )
            .map(item => item.underlying_key)
    );

    instrumentCache = allStocks.map(stock => ({
        ...stock,
        isFNO: fnoKeys.has(stock.instrument_key)
    }));

    return instrumentCache;
}

// ==================================================
// DATE HELPERS
// ==================================================

function getISTDate() {

    return new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }
    ).format(new Date());
}

function getDateBefore(days) {

    const date = new Date();

    date.setUTCDate(date.getUTCDate() - days);

    return date.toISOString().slice(0, 10);
}

// ==================================================
// RSI CALCULATION
// ==================================================

function calculateRSI(values, period = 14) {

    if (values.length <= period) return 0;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change = values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {

        const change = values[i] - values[i - 1];

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

// ==================================================
// EMA CALCULATION
// ==================================================

function calculateEMA(values, period = 20) {

    if (values.length < period) return 0;

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {

        ema =
            (values[i] - ema) * multiplier + ema;
    }

    return ema;
}

// ==================================================
// ATR CALCULATION
// ==================================================

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) return 0;

    const ranges = [];

    for (let i = 1; i < candles.length; i++) {

        const high = Number(candles[i][2]);
        const low = Number(candles[i][3]);

        const previousClose =
            Number(candles[i - 1][4]);

        ranges.push(
            Math.max(
                high - low,
                Math.abs(high - previousClose),
                Math.abs(low - previousClose)
            )
        );
    }

    const recent = ranges.slice(-period);

    return recent.reduce((a, b) => a + b, 0)
        / recent.length;
}

// ==================================================
// HISTORICAL DAILY CANDLES
// ==================================================

async function getDailyCandles(instrumentKey) {

    const toDate = getISTDate();

    const fromDate = getDateBefore(370);

    const url =
        UPSTOX +
        "/v3/historical-candle/" +
        encodeURIComponent(instrumentKey) +
        "/days/1/" +
        toDate +
        "/" +
        fromDate;

    const result = await upstoxRequest(url);

    const candles = result.data?.candles || [];

    return candles
        .filter(c =>
            Array.isArray(c) &&
            c.length >= 6 &&
            String(c[0]).slice(0, 10) < toDate
        )
        .sort((a, b) =>
            new Date(a[0]) - new Date(b[0])
        );
}

// ==================================================
// CURRENT MARKET QUOTES
// ==================================================

async function getMarketQuotes(instruments) {

    const result = {};

    const batchSize = 500;

    for (let i = 0; i < instruments.length; i += batchSize) {

        const batch = instruments.slice(i, i + batchSize);

        const keys = batch
            .map(x => x.instrument_key)
            .join(",");

        const url =
            UPSTOX +
            "/v3/market-quote/quotes?instrument_key=" +
            encodeURIComponent(keys);

        const data = await upstoxRequest(url);

        Object.assign(result, data.data || {});
    }

    return result;
}

// ==================================================
// 52 WEEK HIGH ANALYSIS
// ==================================================

function analyse52Week(stock, candles, quote) {

    if (!candles || candles.length < 252) {
        return null;
    }

    const closes = candles.map(c => Number(c[4]));

    const volumes = candles.map(c => Number(c[5]));

    const latest = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const previous252 = candles.slice(-252);

    const high52 = Math.max(
        ...previous252.map(c => Number(c[2]))
    );

    const currentPrice = Number(
        quote?.last_price || latest[4]
    );

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return null;
    }

    const rsi = calculateRSI(
        closes,
        SETTINGS.RSI_PERIOD
    );

    const ema20 = calculateEMA(
        closes,
        SETTINGS.EMA_PERIOD
    );

    const atr = calculateATR(
        candles,
        SETTINGS.ATR_PERIOD
    );

    const avgVolume =
        volumes.slice(-21, -1)
            .reduce((a, b) => a + b, 0) / 20;

    const volumeRatio =
        avgVolume > 0
            ? Number(latest[5]) / avgVolume
            : 0;

    const distance =
        ((high52 - currentPrice) / high52) * 100;

    const touch52 =
        currentPrice >= high52 * 0.97 &&
        currentPrice <= high52 * 1.001;

    const breakout52 =
        currentPrice > high52 * 1.001;

    const bullishCandle =
        Number(latest[4]) > Number(latest[1]);

    const bullishTrend =
        currentPrice > ema20;

    const rsiPass =
        rsi >= SETTINGS.MIN_RSI;

    const volumePass =
        volumeRatio >= SETTINGS.MIN_VOLUME_RATIO;

    let signal = "WAIT";

    if (
        breakout52 &&
        bullishTrend &&
        rsiPass &&
        volumePass
    ) {
        signal = "STRONG BUY";
    }

    else if (
        touch52 &&
        bullishTrend &&
        rsiPass &&
        bullishCandle
    ) {
        signal = "BUY WATCH";
    }

    // ==============================================
    // ENTRY / TARGET / STOP LOSS
    // ==============================================

    const entry = currentPrice;

    const safeATR = atr > 0
        ? atr
        : entry * 0.015;

    const stopLoss = Math.max(
        entry - safeATR * 1.5,
        entry * 0.985
    );

    const risk = entry - stopLoss;

    const target1 = entry + risk * 1.5;

    const target2 = entry + risk * 2.5;

    return {

        symbol: stock.trading_symbol,

        name: stock.name,

        instrumentKey: stock.instrument_key,

        market: stock.isFNO ? "NSE F&O" : "NSE ALL",

        signal,

        price: Number(entry.toFixed(2)),

        high52: Number(high52.toFixed(2)),

        distance52: Number(distance.toFixed(2)),

        RSI: Number(rsi.toFixed(2)),

        EMA20: Number(ema20.toFixed(2)),

        volumeRatio: Number(volumeRatio.toFixed(2)),

        entry: Number(entry.toFixed(2)),

        target1: Number(target1.toFixed(2)),

        target2: Number(target2.toFixed(2)),

        stopLoss: Number(stopLoss.toFixed(2)),

        touch52Week: touch52,

        breakout52Week: breakout52,

        bullishTrend,

        volumePass,

        candleDate: String(latest[0]).slice(0, 10)

    };
}

// ==================================================
// WORKER POOL
// ==================================================

async function runWorkers(items, worker, concurrency = 3) {

    let index = 0;

    const results = [];

    async function run() {

        while (true) {

            const current = index++;

            if (current >= items.length) return;

            try {

                const result = await worker(items[current]);

                if (result) results.push(result);

            } catch (error) {

                console.error(
                    "Scan error:",
                    items[current].trading_symbol,
                    error.message
                );
            }

            await new Promise(resolve =>
                setTimeout(resolve, SETTINGS.REQUEST_DELAY)
            );
        }
    }

    const workers = [];

    for (let i = 0; i < concurrency; i++) {
        workers.push(run());
    }

    await Promise.all(workers);

    return results;
}

// ==================================================
// MAIN SCANNER
// ==================================================

async function scanStocks(type = "ALL", limit = 100) {

    const now = Date.now();

    if (
        scanCache.updatedAt &&
        now - lastScan < SETTINGS.CACHE_TIME
    ) {

        return scanCache[type];
    }

    const all = await loadInstruments();

    let stocks = type === "FNO"
        ? all.filter(s => s.isFNO)
        : all;

    // Avoid excessive API requests.
    // Set SCAN_LIMIT=0 in Render to scan the full universe.

    const scanLimit = Number(process.env.SCAN_LIMIT || 300);

    if (scanLimit > 0) {
        stocks = stocks.slice(0, scanLimit);
    }

    if (limit > 0) {
        stocks = stocks.slice(0, limit);
    }

    console.log(
        "Starting scanner:",
        type,
        "Stocks:",
        stocks.length
    );

    const quotes = await getMarketQuotes(stocks);

    const quoteList = Object.values(quotes);

    const quoteMap = {};

    quoteList.forEach(q => {

        if (q.instrument_token) {
            quoteMap[q.instrument_token] = q;
        }
    });

    const results = await runWorkers(
        stocks,
        async stock => {

            const quoteKey =
                "NSE_EQ:" + stock.trading_symbol;

            const quote =
                quotes[quoteKey] ||
                quoteMap[stock.instrument_key];

            const candles = await getDailyCandles(
                stock.instrument_key
            );

            return analyse52Week(
                stock,
                candles,
                quote
            );

        },
        SETTINGS.WORKERS
    );

    const sorted = results.sort((a, b) => {

        const priority = {
            "STRONG BUY": 3,
            "BUY WATCH": 2,
            "WAIT": 1
        };

        return priority[b.signal] - priority[a.signal];
    });

    scanCache[type] = sorted;

    scanCache.updatedAt = new Date().toISOString();

    lastScan = Date.now();

    return sorted;
}

// ==================================================
// API ROUTES
// ==================================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {

        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Methods": "GET, OPTIONS"
        });

        return res.end();
    }

    const url = new URL(
        req.url,
        "http://localhost"
    );

    try {

        // HEALTH

        if (url.pathname === "/health") {

            return sendJson(res, 200, {
                status: "OK",
                app: "SMART TRADE INDIA",
                version: "2.0",
                time: new Date().toISOString()
            });
        }

        // UPSTOX STATUS

        if (url.pathname === "/api/upstox/status") {

            return sendJson(res, 200, {
                connected: Boolean(TOKEN),
                provider: "UPSTOX",
                version: "V3"
            });
        }

        // INSTRUMENT UNIVERSE

        if (url.pathname === "/api/scanner/universe") {

            const stocks = await loadInstruments();

            return sendJson(res, 200, {
                totalNSEStocks: stocks.length,
                totalFNOStocks: stocks.filter(s => s.isFNO).length
            });
        }

        // 52 WEEK HIGH SCANNER

        if (url.pathname === "/api/scanner/52week") {

            const type = (
                url.searchParams.get("type") || "ALL"
            ).toUpperCase();

            const limit = Number(
                url.searchParams.get("limit") || 100
            );

            if (!["ALL", "FNO"].includes(type)) {

                return sendJson(res, 400, {
                    error: "Use type=ALL or type=FNO"
                });
            }

            const results = await scanStocks(
                type,
                limit
            );

            return sendJson(res, 200, {

                success: true,

                scanner: "52 WEEK HIGH MOMENTUM",

                market: type,

                totalScanned: results.length,

                strongBuy: results.filter(
                    x => x.signal === "STRONG BUY"
                ).length,

                buyWatch: results.filter(
                    x => x.signal === "BUY WATCH"
                ).length,

                wait: results.filter(
                    x => x.signal === "WAIT"
                ).length,

                updatedAt: scanCache.updatedAt,

                data: results

            });
        }

        // BUY SIGNALS ONLY

        if (url.pathname === "/api/scanner/buy") {

            const type = (
                url.searchParams.get("type") || "ALL"
            ).toUpperCase();

            const results = await scanStocks(type, 100);

            return sendJson(res, 200, {

                success: true,

                data: results.filter(
                    x =>
                        x.signal === "STRONG BUY" ||
                        x.signal === "BUY WATCH"
                )

            });
        }

        // CACHE CLEAR

        if (url.pathname === "/api/scanner/refresh") {

            lastScan = 0;

            scanCache.ALL = [];

            scanCache.FNO = [];

            scanCache.updatedAt = null;

            return sendJson(res, 200, {
                success: true,
                message: "Scanner cache cleared"
            });
        }

        return sendJson(res, 404, {
            error: "API route not found"
        });

    } catch (error) {

        console.error(error);

        return sendJson(res, 500, {

            success: false,

            error: error.message

        });
    }
});

// ==================================================
// SERVER START
// ==================================================

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA SERVER RUNNING ON PORT",
        PORT
    );

});
