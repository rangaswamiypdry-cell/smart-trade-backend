// ======================================================
// SMART TRADE INDIA V6
// EQUITY + FUTURES MOMENTUM SCANNER
// NODE JS 20+
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

// ======================================================
// GLOBAL DATA
// ======================================================

let instruments = [];

let equityMaster = [];

let futuresMaster = [];

let stockCache = [];

let futuresCache = [];

let optionCache = [];

let lastScanTime = null;

let scanBusy = false;

let masterLoaded = false;

const CACHE_TIME = 60000;

// ======================================================
// CORS
// ======================================================

function cors(res) {

    res.setHeader(
        "Access-Control-Allow-Origin", "*"
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
// UPSTOX API REQUEST
// ======================================================

async function upstoxRequest(path) {

    if (!ACCESS_TOKEN) {

        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing"
        );

    }

    const response = await fetch(
        UPSTOX_BASE + path,
        {
            method: "GET",

            headers: {
                "Accept": "application/json",
                "Authorization": "Bearer " + ACCESS_TOKEN
            },

            signal: AbortSignal.timeout(20000)
        }
    );

    const text = await response.text();

    let data;

    try {

        data = JSON.parse(text);

    } catch {

        throw new Error(
            "Invalid Upstox JSON response"
        );

    }

    if (!response.ok) {

        throw new Error(
            "Upstox HTTP " +
            response.status +
            " : " +
            (data.message || text.slice(0, 200))
        );

    }

    return data;

}

// ======================================================
// DOWNLOAD INSTRUMENT MASTER
// ======================================================

async function downloadMaster() {

    console.log("Downloading Upstox Master...");

    const response = await fetch(
        MASTER_URL,
        {
            signal: AbortSignal.timeout(60000)
        }
    );

    if (!response.ok) {

        throw new Error(
            "Master download failed: " +
            response.status
        );

    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    let jsonBuffer;

    try {

        jsonBuffer = zlib.gunzipSync(buffer);

    } catch {

        jsonBuffer = buffer;

    }

    const master = JSON.parse(
        jsonBuffer.toString("utf8")
    );

    // NSE FUTURES - FIXED

futuresMaster = master.filter(item => {

    const expiryTime = Number(item.expiry);

    return (
        item.segment === "NSE_FO" &&
        item.instrument_key &&
        item.underlying_symbol &&
        String(item.instrument_type).toUpperCase() === "FUT" &&
        Number.isFinite(expiryTime) &&
        expiryTime >= Date.now()
    );

});
    // NSE EQUITY

    equityMaster = master.filter(item => {

        return (
            item.segment === "NSE_EQ" &&
            item.instrument_key &&
            item.trading_symbol &&
            item.instrument_type === "EQ"
        );

    });

    // NSE FUTURES

    futuresMaster = master.filter(item => {

        return (
            item.segment === "NSE_FO" &&
            item.instrument_key &&
            item.underlying_symbol &&
            String(item.instrument_type)
                .toUpperCase()
                .includes("FUT") &&
            item.expiry >= today
        );

    });

    // NEAREST EXPIRY FUTURES

    const nearestFutures = new Map();

    for (const item of futuresMaster) {

        const symbol = item.underlying_symbol;

        const old = nearestFutures.get(symbol);

        if (
            !old ||
            item.expiry < old.expiry
        ) {

            nearestFutures.set(symbol, item);

        }

    }

    futuresMaster = Array.from(
        nearestFutures.values()
    );

    // MATCH EQUITY + FUTURES

    const equityMap = new Map();

    for (const item of equityMaster) {

        equityMap.set(
            item.trading_symbol,
            item
        );

    }

    instruments = futuresMaster
        .map(future => {

            const equity = equityMap.get(
                future.underlying_symbol
            );

            if (!equity) return null;

            return {

                symbol: future.underlying_symbol,

                equityKey: equity.instrument_key,

                futuresKey: future.instrument_key,

                futuresTradingSymbol:
                    future.trading_symbol,

                expiry: future.expiry

            };

        })
        .filter(Boolean);

    masterLoaded = true;

    console.log(
        "EQUITY:",
        equityMaster.length
    );

    console.log(
        "FUTURES:",
        futuresMaster.length
    );

    console.log(
        "MATCHED F&O STOCKS:",
        instruments.length
    );

    return instruments;

}

// ======================================================
// LOAD MASTER
// ======================================================

async function getInstruments() {

    if (masterLoaded && instruments.length > 0) {

        return instruments;

    }

    return await downloadMaster();

}// ======================================================
// SMART TRADE INDIA V6
// PART 2/3
// INDICATORS + MOMENTUM ANALYSIS
// ======================================================

// ======================================================
// RSI 14
// ======================================================

function calculateRSI(candles, period = 14) {

    if (candles.length <= period) return 0;

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            candles[i].close - candles[i - 1].close;

        if (change > 0) gain += change;
        else loss += Math.abs(change);

    }

    let avgGain = gain / period;
    let avgLoss = loss / period;

    for (let i = period + 1; i < candles.length; i++) {

        const change =
            candles[i].close - candles[i - 1].close;

        avgGain =
            (avgGain * (period - 1) +
            Math.max(change, 0)) / period;

        avgLoss =
            (avgLoss * (period - 1) +
            Math.max(-change, 0)) / period;

    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - (100 / (1 + rs));

}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period) {

    if (values.length < period) return 0;

    const multiplier = 2 / (period + 1);

    let ema =
        values.slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        ema =
            (values[i] - ema) * multiplier + ema;

    }

    return ema;

}

// ======================================================
// VWAP
// ======================================================

function calculateVWAP(candles) {

    let pv = 0;
    let volume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        pv += typical * c.volume;

        volume += c.volume;

    }

    return volume > 0 ? pv / volume : 0;

}

// ======================================================
// ATR
// ======================================================

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) return 0;

    const ranges = [];

    for (
        let i = candles.length - period;
        i < candles.length;
        i++
    ) {

        const current = candles[i];
        const previous = candles[i - 1];

        const tr = Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        );

        ranges.push(tr);

    }

    return ranges.reduce((a, b) => a + b, 0) / period;

}

// ======================================================
// TREND STRENGTH
// ======================================================

function calculateTrendStrength(candles) {

    if (candles.length < 15) return 0;

    let bullish = 0;
    let bearish = 0;

    for (
        let i = candles.length - 14;
        i < candles.length;
        i++
    ) {

        const change =
            candles[i].close - candles[i - 1].close;

        if (change > 0) bullish += change;
        else bearish += Math.abs(change);

    }

    const total = bullish + bearish;

    if (!total) return 0;

    return Math.round(
        Math.abs(bullish - bearish) / total * 100
    );

}

// ======================================================
// CANDLE STRENGTH
// ======================================================

function candleStrength(candle) {

    const range = candle.high - candle.low;

    if (range <= 0) return 0;

    return (
        (candle.close - candle.low) / range
    );

}

// ======================================================
// STOCK MOMENTUM ANALYSIS
// ======================================================

function analyseStock(item, candles) {

    if (!candles || candles.length < 51) {
        return null;
    }

    const latest = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const volumes = candles.map(c => c.volume);

    // INDICATORS

    const rsi = calculateRSI(candles, 14);

    const ema20 = calculateEMA(closes, 20);

    const ema50 = calculateEMA(closes, 50);

    const vwap = calculateVWAP(candles);

    const atr = calculateATR(candles, 14);

    const trendStrength =
        calculateTrendStrength(candles);

    // VOLUME

    const previousVolumes =
        volumes.slice(-21, -1);

    const averageVolume =
        previousVolumes.reduce(
            (a, b) => a + b, 0
        ) / previousVolumes.length;

    const volumeRatio =
        averageVolume > 0
        ? latest.volume / averageVolume
        : 0;

    const volumeBlast = volumeRatio >= 1.5;

    // PRICE MOVEMENT

    const priceChange =
        previous.close > 0
        ? (
            (latest.close - previous.close) /
            previous.close
        ) * 100
        : 0;

    const priceUp = latest.close > previous.close;

    const priceDown = latest.close < previous.close;

    // OI MOVEMENT

    const oiChange =
        previous.oi > 0
        ? (
            (latest.oi - previous.oi) /
            previous.oi
        ) * 100
        : 0;

    const longBuildup =
        priceUp &&
        latest.oi > previous.oi;

    const shortBuildup =
        priceDown &&
        latest.oi > previous.oi;

    // SUPPORT AND RESISTANCE

    const previousCandles =
        candles.slice(-21, -1);

    const resistance = Math.max(
        ...previousCandles.map(c => c.high)
    );

    const support = Math.min(
        ...previousCandles.map(c => c.low)
    );

    // BREAKOUT / BREAKDOWN

    const breakout =
        latest.close > resistance;

    const breakdown =
        latest.close < support;

    // TREND CONDITIONS

    const bullishTrend =
        latest.close > ema20 &&
        ema20 > ema50 &&
        latest.close > vwap;

    const bearishTrend =
        latest.close < ema20 &&
        ema20 < ema50 &&
        latest.close < vwap;

    // CANDLE CONFIRMATION

    const candlePower =
        candleStrength(latest);

    const strongBullCandle =
        candlePower >= 0.70;

    const strongBearCandle =
        candlePower <= 0.30;

    // SIGNAL CONDITIONS

    const bullish =
        bullishTrend &&
        rsi >= 55 &&
        priceUp &&
        volumeBlast &&
        strongBullCandle;

    const bearish =
        bearishTrend &&
        rsi <= 45 &&
        priceDown &&
        volumeBlast &&
        strongBearCandle;

    // SIGNAL

    let signal = "WATCH";

    if (bullish && breakout) {

        signal = "STRONG BUY";

    } else if (bearish && breakdown) {

        signal = "STRONG SELL";

    } else if (bullish) {

        signal = "BUY";

    } else if (bearish) {

        signal = "SELL";

    }

    // ENTRY / SL / TARGET

    const entry = latest.close;

    let stopLoss = 0;
    let target1 = 0;
    let target2 = 0;

    if (signal.includes("BUY")) {

        stopLoss = entry - atr * 1.5;

        target1 = entry + atr * 2;

        target2 = entry + atr * 3;

    }

    if (signal.includes("SELL")) {

        stopLoss = entry + atr * 1.5;

        target1 = entry - atr * 2;

        target2 = entry - atr * 3;

    }

    // CONFIDENCE SCORE

    let score = 0;

    if (latest.close > ema20) score += 15;

    if (ema20 > ema50) score += 15;

    if (latest.close > vwap) score += 15;

    if (rsi >= 55) score += 15;

    if (volumeBlast) score += 15;

    if (longBuildup) score += 10;

    if (breakout) score += 15;

    return {

        symbol: item.underlying_symbol,

        tradingSymbol: item.trading_symbol,

        instrumentKey: item.instrument_key,

        signal,

        price: entry,

        priceChange,

        oiChange,

        volume: latest.volume,

        volumeRatio,

        rsi,

        ema20,

        ema50,

        vwap,

        atr,

        trendStrength,

        confidence: Math.min(score, 100),

        longBuildup,

        shortBuildup,

        volumeBlast,

        breakout,

        breakdown,

        candlePower,

        entry,

        stopLoss,

        target1,

        target2,

        resistance,

        support,

        riskReward: 2,

        candleTime: latest.time

    };

}
// ======================================================
// SMART TRADE INDIA V6
// PART 3/3
// SCANNER + API + SERVER
// ======================================================

const SCAN_LIMIT = 100;
const SCAN_CONCURRENCY = 5;
let lastScanError = null;

// ======================================================
// SCAN STOCKS WITH CONCURRENCY
// ======================================================

async function scanStocks(force = false) {

    if (scanBusy) {
        return stockCache;
    }

    if (
        !force &&
        stockCache.length > 0 &&
        lastScanTime &&
        Date.now() - new Date(lastScanTime).getTime()
            < CACHE_TIME
    ) {
        return stockCache;
    }

    scanBusy = true;

    const results = [];
    const errors = [];

    try {

        const list = await getInstruments();

        const selected = list.slice(0, SCAN_LIMIT);

        let index = 0;

        async function worker() {

            while (index < selected.length) {

                const currentIndex = index++;

                const item = selected[currentIndex];

                try {

                    const candles = await getCandles(
                        item.instrument_key
                    );

                    const closed = getClosedCandles(candles);

                    const analysis = analyseStock(
                        item,
                        closed
                    );

                    if (analysis) {

                        results.push(analysis);

                    }

                } catch (error) {

                    errors.push({
                        symbol: item.underlying_symbol,
                        error: error.message
                    });

                    console.log(
                        "SCAN ERROR:",
                        item.underlying_symbol,
                        error.message
                    );

                }

            }

        }

        const workers = [];

        for (
            let i = 0;
            i < Math.min(
                SCAN_CONCURRENCY,
                selected.length
            );
            i++
        ) {

            workers.push(worker());

        }

        await Promise.all(workers);

        // SORT RESULTS

        const priority = {
            "STRONG BUY": 1,
            "BUY": 2,
            "WATCH": 3,
            "SELL": 4,
            "STRONG SELL": 5
        };

        results.sort((a, b) => {

            const p =
                priority[a.signal] -
                priority[b.signal];

            if (p !== 0) return p;

            return b.confidence - a.confidence;

        });

        stockCache = results;

        lastScanTime = new Date().toISOString();

        lastScanError = errors.length
            ? errors
            : null;

        console.log(
            "SCAN COMPLETED",
            "Total:",
            selected.length,
            "Results:",
            results.length,
            "Errors:",
            errors.length
        );

        return stockCache;

    } catch (error) {

        lastScanError = error.message;

        console.error(
            "MAIN SCAN ERROR:",
            error.message
        );

        throw error;

    } finally {

        scanBusy = false;

    }

}

// ======================================================
// FILTER STOCKS
// ======================================================

function filterStocks(stocks, type) {

    if (type === "BUY") {

        return stocks.filter(s =>
            s.signal === "BUY" ||
            s.signal === "STRONG BUY"
        );

    }

    if (type === "SELL") {

        return stocks.filter(s =>
            s.signal === "SELL" ||
            s.signal === "STRONG SELL"
        );

    }

    if (type === "STRONG_BUY") {

        return stocks.filter(s =>
            s.signal === "STRONG BUY"
        );

    }

    if (type === "STRONG_SELL") {

        return stocks.filter(s =>
            s.signal === "STRONG SELL"
        );

    }

    if (type === "WATCH") {

        return stocks.filter(s =>
            s.signal === "WATCH"
        );

    }

    return stocks;

}

// ======================================================
// SUMMARY
// ======================================================

function createSummary(stocks) {

    return {

        totalStocks: stocks.length,

        strongBuy: stocks.filter(
            s => s.signal === "STRONG BUY"
        ).length,

        buy: stocks.filter(
            s => s.signal === "BUY"
        ).length,

        sell: stocks.filter(
            s => s.signal === "SELL"
        ).length,

        strongSell: stocks.filter(
            s => s.signal === "STRONG SELL"
        ).length,

        watch: stocks.filter(
            s => s.signal === "WATCH"
        ).length

    };

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

        // ==========================================
        // HEALTH
        // ==========================================

        if (path === "/health") {

            return sendJson(res, 200, {

                success: true,

                status: "ONLINE",

                app: "SMART TRADE INDIA V6",

                node: process.version,

                upstoxConnected: Boolean(ACCESS_TOKEN),

                totalInstruments: instruments.length,

                cachedStocks: stockCache.length,

                scanning: scanBusy,

                lastScan: lastScanTime,

                lastError: lastScanError

            });

        }

        // ==========================================
        // UPSTOX STATUS
        // ==========================================

        if (path === "/api/upstox/status") {

            return sendJson(res, 200, {

                success: true,

                connected: Boolean(ACCESS_TOKEN),

                masterLoaded: instruments.length > 0,

                message: ACCESS_TOKEN
                    ? "Upstox token configured"
                    : "UPSTOX_ACCESS_TOKEN missing"

            });

        }

        // ==========================================
        // MAIN SCANNER
        // ==========================================

        if (path === "/api/scan") {

            const force =
                url.searchParams.get("refresh") === "1";

            const type = (
                url.searchParams.get("type") || "ALL"
            ).toUpperCase();

            const limit = Math.min(
                Math.max(
                    Number(url.searchParams.get("limit")) || 100,
                    1
                ),
                200
            );

            const stocks = await scanStocks(force);

            const filtered = filterStocks(
                stocks,
                type
            );

            return sendJson(res, 200, {

                success: true,

                app: "SMART TRADE INDIA V6",

                timeframe: "5 MIN",

                candleType: "CLOSED CANDLES ONLY",

                count: filtered.length,

                summary: createSummary(stocks),

                lastScan: lastScanTime,

                stocks: filtered.slice(0, limit)

            });

        }

        // ==========================================
        // BUY STOCKS
        // ==========================================

        if (path === "/api/buy") {

            const stocks = await scanStocks();

            const buyStocks = filterStocks(
                stocks,
                "BUY"
            );

            return sendJson(res, 200, {

                success: true,

                count: buyStocks.length,

                stocks: buyStocks

            });

        }

        // ==========================================
        // SELL STOCKS
        // ==========================================

        if (path === "/api/sell") {

            const stocks = await scanStocks();

            const sellStocks = filterStocks(
                stocks,
                "SELL"
            );

            return sendJson(res, 200, {

                success: true,

                count: sellStocks.length,

                stocks: sellStocks

            });

        }

        // ==========================================
        // STRONG BUY
        // ==========================================

        if (path === "/api/strong-buy") {

            const stocks = await scanStocks();

            const filtered = filterStocks(
                stocks,
                "STRONG_BUY"
            );

            return sendJson(res, 200, {

                success: true,

                count: filtered.length,

                stocks: filtered

            });

        }

        // ==========================================
        // STRONG SELL
        // ==========================================

        if (path === "/api/strong-sell") {

            const stocks = await scanStocks();

            const filtered = filterStocks(
                stocks,
                "STRONG_SELL"
            );

            return sendJson(res, 200, {

                success: true,

                count: filtered.length,

                stocks: filtered

            });

        }

        // ==========================================
        // STOCK CACHE
        // ==========================================

        if (path === "/api/stocks") {

            return sendJson(res, 200, {

                success: true,

                count: stockCache.length,

                lastScan: lastScanTime,

                stocks: stockCache

            });

        }

        // ==========================================
        // NSE F&O STOCK LIST
        // ==========================================

        if (path === "/api/nse-stocks") {

            const list = await getInstruments();

            return sendJson(res, 200, {

                success: true,

                count: list.length,

                stocks: list.map(item => ({

                    symbol: item.underlying_symbol,

                    tradingSymbol: item.trading_symbol,

                    instrumentKey: item.instrument_key,

                    expiry: item.expiry

                }))

            });

        }

        // ==========================================
        // SCAN STATUS
        // ==========================================

        if (path === "/api/scan/status") {

            return sendJson(res, 200, {

                success: true,

                scanning: scanBusy,

                count: stockCache.length,

                lastScan: lastScanTime,

                lastError: lastScanError

            });

        }

        // ==========================================
        // NOT FOUND
        // ==========================================

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
        "SMART TRADE INDIA V6 RUNNING"
    );

    console.log("PORT:", PORT);

    console.log(
        "UPSTOX:",
        ACCESS_TOKEN ? "CONNECTED TOKEN" : "TOKEN MISSING"
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
