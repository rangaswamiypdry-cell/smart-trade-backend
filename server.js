// ======================================================
// SMART TRADE INDIA V7
// NSE F&O SHORT TERM SWING SCANNER
// BACKEND - PART 1 / 3
// NODE.JS 20+ | UPSTOX V3 | RENDER
// ======================================================

"use strict";

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
// SCANNER SETTINGS
// ======================================================

const SCAN_LIMIT = 250;
const SCAN_CONCURRENCY = 5;

const CACHE_TIME = 60000;

const CANDLE_INTERVAL = 5;

const MIN_CANDLES = 25;

// ======================================================
// GLOBAL VARIABLES
// ======================================================

let instruments = [];

let stockCache = [];

let lastScanTime = null;

let lastScanError = null;

let scanBusy = false;

let masterBusy = false;

let masterLoadedAt = 0;

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, statusCode, data) {

    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    res.end(JSON.stringify(data));

}

// ======================================================
// HTTP REQUEST
// ======================================================

async function requestUrl(url, options = {}) {

    const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000)
    });

    const text = await response.text();

    let data;

    try {

        data = JSON.parse(text);

    } catch {

        throw new Error(
            "Invalid API response: " + text.slice(0, 200)
        );

    }

    if (!response.ok) {

        throw new Error(
            "API Error " +
            response.status +
            ": " +
            JSON.stringify(data).slice(0, 300)
        );

    }

    return data;

}

// ======================================================
// UPSTOX API REQUEST
// ======================================================

async function upstoxRequest(path) {

    if (!ACCESS_TOKEN) {

        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing in Render"
        );

    }

    const url = UPSTOX_BASE + path;

    return requestUrl(url, {

        method: "GET",

        headers: {
            "Accept": "application/json",
            "Authorization": "Bearer " + ACCESS_TOKEN
        }

    });

}

// ======================================================
// EXPIRY NORMALIZATION
// ======================================================

function getExpiryTime(value) {

    if (!value) return 0;

    if (typeof value === "number") {

        return value < 1000000000000
            ? value * 1000
            : value;

    }

    const parsed = Date.parse(value);

    return Number.isFinite(parsed)
        ? parsed
        : 0;

}

// ======================================================
// DOWNLOAD NSE INSTRUMENT MASTER
// ======================================================

async function downloadMaster() {

    if (masterBusy) {

        throw new Error(
            "Instrument master download already running"
        );

    }

    masterBusy = true;

    try {

        console.log("Downloading Upstox Master...");

        const response = await fetch(MASTER_URL, {
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok) {

            throw new Error(
                "Master download failed: " + response.status
            );

        }

        const buffer = Buffer.from(
            await response.arrayBuffer()
        );

        const jsonBuffer = zlib.gunzipSync(buffer);

        const master = JSON.parse(
            jsonBuffer.toString("utf8")
        );

        if (!Array.isArray(master)) {

            throw new Error(
                "Invalid Upstox instrument master"
            );

        }

        const today = Date.now();

        // NSE EQUITY INSTRUMENTS

        const equityMaster = master.filter(item => {

            return (
                item.segment === "NSE_EQ" &&
                item.instrument_type === "EQ" &&
                item.instrument_key &&
                item.trading_symbol
            );

        });

        // NSE STOCK FUTURES

        const futuresMaster = master.filter(item => {

            const type = String(
                item.instrument_type || ""
            ).toUpperCase();

            return (
                item.segment === "NSE_FO" &&
                item.instrument_key &&
                item.underlying_symbol &&
                type === "FUT" &&
                getExpiryTime(item.expiry) >= today
            );

        });

        // SELECT NEAREST EXPIRY FUTURE PER STOCK

        const nearestFutures = new Map();

        for (const item of futuresMaster) {

            const symbol = String(
                item.underlying_symbol
            ).toUpperCase();

            const old = nearestFutures.get(symbol);

            const expiry = getExpiryTime(item.expiry);

            if (
                !old ||
                expiry < getExpiryTime(old.expiry)
            ) {

                nearestFutures.set(symbol, item);

            }

        }

        // MATCH EQUITY + FUTURES

        const equityMap = new Map();

        for (const item of equityMaster) {

            const symbol = String(
                item.trading_symbol
            ).toUpperCase();

            equityMap.set(symbol, item);

        }

        const matched = [];

        for (const [symbol, future] of nearestFutures) {

            const equity = equityMap.get(symbol);

            if (!equity) continue;

            matched.push({

                symbol: symbol,

                trading_symbol: future.trading_symbol,

                instrument_key: equity.instrument_key,

                futures_key: future.instrument_key,

                expiry: future.expiry,

                lot_size: Number(
                    future.lot_size || 0
                )

            });

        }

        matched.sort((a, b) =>
            a.symbol.localeCompare(b.symbol)
        );

        instruments = matched;

        masterLoadedAt = Date.now();

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

    } finally {

        masterBusy = false;

    }

}

// ======================================================
// GET INSTRUMENTS WITH CACHE
// ======================================================

async function getInstruments(force = false) {

    const cacheValid =
        instruments.length > 0 &&
        Date.now() - masterLoadedAt < 3600000;

    if (!force && cacheValid) {

        return instruments;

    }

    return downloadMaster();

}

// ======================================================
// UPSTOX HISTORICAL CANDLE DATA
// ======================================================

async function getCandles(instrumentKey) {

    if (!instrumentKey) {

        throw new Error("Instrument key missing");

    }

    const encodedKey = encodeURIComponent(
        instrumentKey
    );

    const path =
        "/v3/historical-candle/intraday/" +
        encodedKey +
        "/minutes/" +
        CANDLE_INTERVAL;

    const response = await upstoxRequest(path);

    const candles =
        response?.data?.candles || [];

    if (!Array.isArray(candles)) {

        throw new Error("Invalid candle data");

    }

    return candles;

}

// ======================================================
// EXTRACT CANDLE VALUES
// ======================================================

function normalizeCandles(rawCandles) {

    if (!Array.isArray(rawCandles)) {

        return [];

    }

    return rawCandles.map(c => ({

        time: new Date(c[0]).getTime(),

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5] || 0),

        oi: Number(c[6] || 0)

    })).filter(c => (

        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)

    )).sort((a, b) => a.time - b.time);

}
// ======================================================
// SMART TRADE INDIA V7
// BACKEND - PART 2 / 3
// INDICATORS + STOCK ANALYSIS + SIGNALS
// ======================================================

// ======================================================
// CLOSED CANDLES ONLY
// ======================================================

function getClosedCandles(rawCandles) {

    const candles = normalizeCandles(rawCandles);

    const now = Date.now();

    return candles.filter(c => {

        return (
            c.time + CANDLE_INTERVAL * 60 * 1000 <= now
        );

    });

}

// ======================================================
// EMA CALCULATION
// ======================================================

function calculateEMA(values, period) {

    if (!Array.isArray(values) ||
        values.length < period) {

        return null;

    }

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
// RSI - WILDER METHOD
// ======================================================

function calculateRSI(values, period = 14) {

    if (values.length <= period) {

        return null;

    }

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const change = values[i] - values[i - 1];

        if (change > 0) gain += change;
        else loss -= change;

    }

    let averageGain = gain / period;
    let averageLoss = loss / period;

    for (let i = period + 1; i < values.length; i++) {

        const change = values[i] - values[i - 1];

        const currentGain = Math.max(change, 0);
        const currentLoss = Math.max(-change, 0);

        averageGain =
            ((averageGain * (period - 1)) + currentGain)
            / period;

        averageLoss =
            ((averageLoss * (period - 1)) + currentLoss)
            / period;

    }

    if (averageLoss === 0) return 100;

    const rs = averageGain / averageLoss;

    return 100 - (100 / (1 + rs));

}

// ======================================================
// VWAP CALCULATION
// ======================================================

function calculateVWAP(candles) {

    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {

        const typicalPrice =
            (c.high + c.low + c.close) / 3;

        totalPV += typicalPrice * c.volume;

        totalVolume += c.volume;

    }

    if (totalVolume === 0) return null;

    return totalPV / totalVolume;

}

// ======================================================
// ATR CALCULATION
// ======================================================

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) {

        return null;

    }

    const ranges = [];

    for (let i = 1; i < candles.length; i++) {

        const current = candles[i];
        const previous = candles[i - 1];

        const tr = Math.max(

            current.high - current.low,

            Math.abs(current.high - previous.close),

            Math.abs(current.low - previous.close)

        );

        ranges.push(tr);

    }

    const recent = ranges.slice(-period);

    return recent.reduce((a, b) => a + b, 0)
        / recent.length;

}

// ======================================================
// SUPPORT / RESISTANCE
// ======================================================

function calculateLevels(candles) {

    const previous = candles.slice(-21, -1);

    if (previous.length < 10) {

        return null;

    }

    const resistance = Math.max(
        ...previous.map(c => c.high)
    );

    const support = Math.min(
        ...previous.map(c => c.low)
    );

    return {
        resistance,
        support
    };

}

// ======================================================
// VOLUME ANALYSIS
// ======================================================

function calculateVolumeRatio(candles) {

    const previous = candles.slice(-21, -1);

    if (previous.length < 10) {

        return 0;

    }

    const averageVolume =
        previous.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / previous.length;

    const latestVolume =
        candles[candles.length - 1].volume;

    if (averageVolume <= 0) return 0;

    return latestVolume / averageVolume;

}

// ======================================================
// CANDLE STRENGTH
// ======================================================

function calculateCandleStrength(candle) {

    const range = candle.high - candle.low;

    if (range <= 0) return 0;

    return (
        (candle.close - candle.low) / range
    );

}

// ======================================================
// MAIN STOCK ANALYSIS
// ======================================================

function analyseStock(item, candles) {

    if (
        !Array.isArray(candles) ||
        candles.length < MIN_CANDLES
    ) {

        return null;

    }

    const closes = candles.map(c => c.close);

    const latest = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const ema20 = calculateEMA(closes, 20);

    const rsi = calculateRSI(closes, 14);

    const vwap = calculateVWAP(candles);

    const atr = calculateATR(candles, 14);

    const levels = calculateLevels(candles);

    const volumeRatio = calculateVolumeRatio(candles);

    if (
        ema20 === null ||
        rsi === null ||
        vwap === null ||
        atr === null ||
        !levels
    ) {

        return null;

    }

    const priceChange =
        ((latest.close - previous.close) /
        previous.close) * 100;

    const candleStrength =
        calculateCandleStrength(latest);

    const priceUp =
        latest.close > previous.close;

    const priceDown =
        latest.close < previous.close;

    const aboveEMA =
        latest.close > ema20;

    const belowEMA =
        latest.close < ema20;

    const aboveVWAP =
        latest.close > vwap;

    const belowVWAP =
        latest.close < vwap;

    const volumePass =
        volumeRatio >= 1.5;

    const bullishBreakout =
        latest.close > levels.resistance;

    const bearishBreakdown =
        latest.close < levels.support;

    // ==============================================
    // BULLISH / BEARISH CONDITIONS
    // ==============================================

    const bullish =
        aboveEMA &&
        aboveVWAP &&
        rsi >= 55 &&
        priceUp &&
        volumePass &&
        candleStrength >= 0.60;

    const bearish =
        belowEMA &&
        belowVWAP &&
        rsi <= 45 &&
        priceDown &&
        volumePass &&
        candleStrength <= 0.40;

    // ==============================================
    // SIGNAL
    // ==============================================

    let signal = "WATCH";

    if (bullish && bullishBreakout) {

        signal = "STRONG BUY";

    } else if (bullish) {

        signal = "BUY";

    } else if (bearish && bearishBreakdown) {

        signal = "STRONG SELL";

    } else if (bearish) {

        signal = "SELL";

    }

    // ==============================================
    // ENTRY / STOP LOSS / TARGETS
    // ==============================================

    const entry = latest.close;

    let stopLoss = null;
    let target1 = null;
    let target2 = null;

    if (
        signal === "BUY" ||
        signal === "STRONG BUY"
    ) {

        stopLoss = Math.min(
            entry - atr * 1.5,
            levels.support
        );

        const risk = entry - stopLoss;

        target1 = entry + risk * 1.5;

        target2 = entry + risk * 2.5;

    } else if (
        signal === "SELL" ||
        signal === "STRONG SELL"
    ) {

        stopLoss = Math.max(
            entry + atr * 1.5,
            levels.resistance
        );

        const risk = stopLoss - entry;

        target1 = entry - risk * 1.5;

        target2 = entry - risk * 2.5;

    }

    // ==============================================
    // CONFIDENCE SCORE
    // ==============================================

    let confidence = 0;

    if (aboveEMA || belowEMA) confidence += 15;

    if (aboveVWAP || belowVWAP) confidence += 15;

    if (volumePass) confidence += 25;

    if (rsi >= 55 || rsi <= 45) confidence += 20;

    if (bullishBreakout || bearishBreakdown) {
        confidence += 25;
    }

    // ==============================================
    // RESULT
    // ==============================================

    return {

        symbol: item.symbol,

        tradingSymbol: item.trading_symbol,

        instrumentKey: item.instrument_key,

        futuresKey: item.futures_key,

        signal,

        price: Number(entry.toFixed(2)),

        priceChange: Number(priceChange.toFixed(2)),

        ema20: Number(ema20.toFixed(2)),

        rsi: Number(rsi.toFixed(2)),

        vwap: Number(vwap.toFixed(2)),

        atr: Number(atr.toFixed(2)),

        volumeRatio: Number(volumeRatio.toFixed(2)),

        volume: latest.volume,

        support: Number(levels.support.toFixed(2)),

        resistance: Number(levels.resistance.toFixed(2)),

        breakout: bullishBreakout,

        breakdown: bearishBreakdown,

        entry: Number(entry.toFixed(2)),

        stopLoss: stopLoss === null
            ? null
            : Number(stopLoss.toFixed(2)),

        target1: target1 === null
            ? null
            : Number(target1.toFixed(2)),

        target2: target2 === null
            ? null
            : Number(target2.toFixed(2)),

        confidence,

        candleTime: new Date(
            latest.time
        ).toISOString(),

        timeframe: "5 MIN",

        candleType: "CLOSED CANDLE"

    };

}
// ======================================================
// SMART TRADE INDIA V7
// BACKEND - PART 3 / 3
// SCANNER + API ROUTES + RENDER SERVER
// ======================================================

// ======================================================
// FILTER STOCKS
// ======================================================

function filterStocks(stocks, type = "ALL") {

    const filters = {

        BUY: ["BUY", "STRONG BUY"],

        SELL: ["SELL", "STRONG SELL"],

        STRONG_BUY: ["STRONG BUY"],

        STRONG_SELL: ["STRONG SELL"],

        WATCH: ["WATCH"]

    };

    if (!filters[type]) {

        return stocks;

    }

    return stocks.filter(stock =>
        filters[type].includes(stock.signal)
    );

}

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

        if (!list.length) {

            throw new Error(
                "No NSE F&O stocks matched in instrument master"
            );

        }

        const selected = list.slice(0, SCAN_LIMIT);

        console.log(
            "SCAN STARTED:",
            selected.length
        );

        let index = 0;

        async function worker() {

            while (true) {

                const currentIndex = index++;

                if (currentIndex >= selected.length) {
                    break;
                }

                const item = selected[currentIndex];

                try {

                    const rawCandles = await getCandles(
                        item.instrument_key
                    );

                    const closed = getClosedCandles(
                        rawCandles
                    );

                    if (closed.length < MIN_CANDLES) {

                        continue;

                    }

                    const analysis = analyseStock(
                        item,
                        closed
                    );

                    if (analysis) {

                        results.push(analysis);

                    }

                } catch (error) {

                    errors.push({

                        symbol: item.symbol,

                        error: error.message

                    });

                    console.log(
                        "SCAN ERROR:",
                        item.symbol,
                        error.message
                    );

                }

            }

        }

        const workers = [];

        const workerCount = Math.min(
            SCAN_CONCURRENCY,
            selected.length
        );

        for (let i = 0; i < workerCount; i++) {

            workers.push(worker());

        }

        await Promise.all(workers);

        // SORT BY SIGNAL PRIORITY

        const priority = {

            "STRONG BUY": 1,

            "BUY": 2,

            "WATCH": 3,

            "SELL": 4,

            "STRONG SELL": 5

        };

        results.sort((a, b) => {

            const p =
                (priority[a.signal] || 99) -
                (priority[b.signal] || 99);

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
// SCAN SUMMARY
// ======================================================

function getScanSummary(stocks) {

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

    if (req.method === "OPTIONS") {

        res.writeHead(204, {

            "Access-Control-Allow-Origin": "*",

            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",

            "Access-Control-Allow-Headers":
                "Content-Type, Authorization"

        });

        return res.end();

    }

    const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
    );

    const path = url.pathname;

    try {

        // ==============================================
        // HEALTH CHECK
        // ==============================================

        if (path === "/health") {

            return sendJson(res, 200, {

                success: true,

                app: "SMART TRADE INDIA V7",

                status: "RUNNING",

                upstoxConnected: Boolean(ACCESS_TOKEN),

                time: new Date().toISOString()

            });

        }

        // ==============================================
        // UPSTOX STATUS
        // ==============================================

        if (path === "/api/upstox/status") {

            return sendJson(res, 200, {

                success: true,

                connected: Boolean(ACCESS_TOKEN),

                message: ACCESS_TOKEN
                    ? "UPSTOX TOKEN CONFIGURED"
                    : "UPSTOX TOKEN MISSING"

            });

        }

        // ==============================================
        // NSE F&O STOCK LIST
        // ==============================================

        if (path === "/api/nse-stocks") {

            const list = await getInstruments();

            return sendJson(res, 200, {

                success: true,

                count: list.length,

                stocks: list.map(item => ({

                    symbol: item.symbol,

                    tradingSymbol: item.trading_symbol,

                    instrumentKey: item.instrument_key,

                    futuresKey: item.futures_key,

                    expiry: item.expiry,

                    lotSize: item.lot_size

                }))

            });

        }
// ==============================================
        // SCAN STATUS
        // ==============================================

        if (path === "/api/scan/status") {

            return sendJson(res, 200, {

                success: true,

                scanBusy,

                lastScan: lastScanTime,

                cachedStocks: stockCache.length,

                lastError: lastScanError

            });

        }

        // ==============================================
        // BUY SIGNALS
        // ==============================================

        if (path === "/api/buy") {

            const stocks = await scanStocks();

            const filtered = filterStocks(
                stocks,
                "BUY"
            );

            return sendJson(res, 200, {

                success: true,

                count: filtered.length,

                stocks: filtered

            });

        }

        // ==============================================
        // SELL SIGNALS
        // ==============================================

        if (path === "/api/sell") {

            const stocks = await scanStocks();

            const filtered = filterStocks(
                stocks,
                "SELL"
            );

            return sendJson(res, 200, {

                success: true,

                count: filtered.length,

                stocks: filtered

            });

        }

        // ==============================================
        // STRONG BUY
        // ==============================================

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

        // ==============================================
        // STRONG SELL
        // ==============================================

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

        // ==============================================
        // OPTIONS STATUS
        // ==============================================

        if (path === "/api/options") {

            return sendJson(res, 200, {

                success: true,

                implemented: false,

                message:
                    "Options chain scanner is not included in V7 backend yet",

                options: []

            });

        }

        // ==============================================
        // NOT FOUND
        // ==============================================

        return sendJson(res, 404, {

            success: false,

            message: "API route not found",

            path

        });

    } catch (error) {

        console.error(
            "SERVER ERROR:",
            error
        );

        return sendJson(res, 500, {

            success: false,

            message: error.message,

            stocks: []

        });

    }

});

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, "0.0.0.0", () => {

    console.log("--------------------------------");

    console.log("SMART TRADE INDIA V7 RUNNING");

    console.log("PORT:", PORT);

    console.log(
        "UPSTOX:",
        ACCESS_TOKEN ? "CONNECTED TOKEN" : "TOKEN MISSING"
    );

    console.log("--------------------------------");

});
        
