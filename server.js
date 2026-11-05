// ======================================================
// SMART TRADE INDIA
// ORB + VOLUME BREAKOUT SCANNER V1
// ALL NSE EQUITY + NSE FNO STOCKS
// UPSTOX V3 API
// NODE.JS 20+
// RENDER BACKEND
// ======================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

// ======================================================
// SETTINGS
// ======================================================

const PORT = Number(process.env.PORT || 10000);

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const UPSTOX_BASE = "https://api.upstox.com";

const SCAN_LIMIT = Number(process.env.ORB_SCAN_LIMIT || 2500);

const CONCURRENCY = 4;

const CACHE_TIME = 30000;

const VOLUME_MULTIPLIER = 1.5;

const RSI_BUY = 60;

const RSI_SELL = 40;

const RR_TARGET_1 = 2;

const RR_TARGET_2 = 3;

// ======================================================
// GLOBAL VARIABLES
// ======================================================

let instruments = [];

let fnoSymbols = new Set();

let lastMasterUpdate = null;

let masterLoading = false;

let scanCache = {};

let lastScanStatus = {};

let serverStartTime = new Date();

// ======================================================
// TIME HELPERS
// ======================================================

function istDateTime(date = new Date()) {

    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
}

function istTime(date) {

    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).format(date);

}

function getCandleTime(candle) {

    return new Date(candle[0]);

}

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    res.end(JSON.stringify(data));

}

// ======================================================
// FETCH HELPER
// ======================================================

async function fetchWithTimeout(url, options = {}, timeout = 15000) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {

        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        return response;

    } finally {

        clearTimeout(timer);

    }

}

// ======================================================
// UPSTOX API
// ======================================================

async function upstoxRequest(path) {

    if (!UPSTOX_TOKEN) {

        throw new Error("UPSTOX_ACCESS_TOKEN missing");

    }

    const response = await fetchWithTimeout(
        UPSTOX_BASE + path,
        {
            method: "GET",

            headers: {
                "Accept": "application/json",
                "Authorization": "Bearer " + UPSTOX_TOKEN
            }
        },
        12000
    );

    const data = await response.json();

    if (!response.ok) {

        throw new Error(
            "Upstox API " +
            response.status +
            ": " +
            JSON.stringify(data)
        );

    }

    return data;

}

// ======================================================
// DOWNLOAD NSE INSTRUMENT MASTER
// ======================================================

async function loadInstruments(force = false) {

    if (masterLoading) return;

    if (
        instruments.length &&
        !force &&
        lastMasterUpdate &&
        Date.now() - lastMasterUpdate < 86400000
    ) {

        return;

    }

    masterLoading = true;

    try {

        console.log("Downloading Upstox instrument master...");

        const response = await fetchWithTimeout(
            MASTER_URL,
            {},
            60000
        );

        if (!response.ok) {

            throw new Error("Instrument master download failed");

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

        const raw = JSON.parse(
            jsonBuffer.toString("utf8")
        );

        if (!Array.isArray(raw)) {

            throw new Error("Invalid instrument master format");

        }

        const allEquity = raw.filter(item => {

            return (
                item.segment === "NSE_EQ" &&
                item.instrument_type === "EQ" &&
                item.instrument_key &&
                item.trading_symbol &&
                item.security_type !== "SM"
            );

        });

        const fno = new Set();

        for (const item of raw) {

            if (
                item.segment === "NSE_FO" &&
                ["FUTSTK", "OPTSTK"].includes(
                    item.instrument_type
                ) &&
                item.underlying_symbol
            ) {

                fno.add(item.underlying_symbol);

            }

        }

        instruments = allEquity;

        fnoSymbols = fno;

        lastMasterUpdate = Date.now();

        console.log(
            "NSE Equity:",
            instruments.length
        );

        console.log(
            "NSE FNO Underlyings:",
            fnoSymbols.size
        );

    } catch (error) {

        console.error(
            "MASTER ERROR:",
            error.message
        );

        if (!instruments.length) {

            throw error;

        }

    } finally {

        masterLoading = false;

    }

}

// ======================================================
// GET 5 MINUTE INTRADAY CANDLES
// ======================================================

async function getCandles(instrumentKey) {

    const key = encodeURIComponent(instrumentKey);

    const path =
        "/v3/historical-candle/intraday/" +
        key +
        "/minutes/5";

    const result = await upstoxRequest(path);

    return result?.data?.candles || [];

}

// ======================================================
// SORT CANDLES OLD TO NEW
// ======================================================

function prepareCandles(raw) {

    const today = istDateTime();

    const now = Date.now();

    return raw

        .map(c => ({
            time: c[0],
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5]),
            oi: Number(c[6] || 0)
        }))

        .filter(c => {

            const date = getCandleTime([c.time]);

            if (!Number.isFinite(date.getTime())) {
                return false;
            }

            // Only today's candles

            if (istDateTime(date) !== today) {
                return false;
            }

            // Only completed candles

            return date.getTime() + 5 * 60000 <= now;

        })

        .sort((a, b) => {

            return (
                getCandleTime([a.time]) -
                getCandleTime([b.time])
            );

        });

}

// ======================================================
// GET ORB FIRST 15 MINUTES
// ======================================================

function calculateORB(candles) {

    const openingCandles = candles.filter(c => {

        const time = istTime(
            getCandleTime([c.time])
        );

        return [
            "09:15",
            "09:20",
            "09:25"
        ].includes(time);

    });

    if (openingCandles.length !== 3) {

        return null;

    }

    const orbHigh = Math.max(
        ...openingCandles.map(c => c.high)
    );

    const orbLow = Math.min(
        ...openingCandles.map(c => c.low)
    );

    return {

        high: orbHigh,

        low: orbLow

    };

}

// ======================================================
// EMA CALCULATION
// ======================================================

function calculateEMA(values, period) {

    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        ema =
            values[i] * multiplier +
            ema * (1 - multiplier);

    }

    return ema;

}

// ======================================================
// RSI CALCULATION
// ======================================================

function calculateRSI(values, period = 14) {

    if (values.length <= period) return null;

    let gain = 0;

    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const diff = values[i] - values[i - 1];

        if (diff > 0) gain += diff;
        else loss += Math.abs(diff);

    }

    let avgGain = gain / period;

    let avgLoss = loss / period;

    for (let i = period + 1; i < values.length; i++) {

        const diff = values[i] - values[i - 1];

        const currentGain = Math.max(diff, 0);

        const currentLoss = Math.max(-diff, 0);

        avgGain =
            (avgGain * (period - 1) + currentGain) /
            period;

        avgLoss =
            (avgLoss * (period - 1) + currentLoss) /
            period;

    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

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

    if (!totalVolume) return null;

    return totalPV / totalVolume;

}

// ======================================================
// VOLUME BREAKOUT
// ======================================================

function calculateVolume(candles) {

    if (candles.length < 21) {

        return null;

    }

    const previous20 = candles.slice(-21, -1);

    const latest = candles[candles.length - 1];

    const averageVolume =
        previous20.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / 20;

    return {

        current: latest.volume,

        average: averageVolume,

        ratio:
            averageVolume > 0
                ? latest.volume / averageVolume
                : 0,

        pass:
            averageVolume > 0 &&
            latest.volume >=
            averageVolume * VOLUME_MULTIPLIER

    };

}

// ======================================================
// STOP LOSS AND TARGET
// ======================================================

function calculateRisk(signal, entry, candle, orb) {

    let sl;

    if (signal === "STRONG BUY") {

        sl = Math.min(
            candle.low,
            orb.high
        );

    } else {

        sl = Math.max(
            candle.high,
            orb.low
        );

    }

    const risk = Math.abs(entry - sl);

    if (risk <= 0) return null;

    return {

        entry: round(entry),

        stopLoss: round(sl),

        target1: round(
            signal === "STRONG BUY"
                ? entry + risk * RR_TARGET_1
                : entry - risk * RR_TARGET_1
        ),

        target2: round(
            signal === "STRONG BUY"
                ? entry + risk * RR_TARGET_2
                : entry - risk * RR_TARGET_2
        ),

        riskReward: "1:2 / 1:3"

    };

}

function round(value) {

    return Number(value.toFixed(2));

}

// ======================================================
// MAIN STOCK ANALYSIS
// ======================================================

function analyseStock(stock, rawCandles) {

    const candles = prepareCandles(rawCandles);

    if (candles.length < 22) {

        return null;

    }

    const orb = calculateORB(candles);

    if (!orb) return null;

    const latest = candles[candles.length - 1];

    const closes = candles.map(c => c.close);

    const ema20 = calculateEMA(closes, 20);

    const rsi = calculateRSI(closes, 14);

    const vwap = calculateVWAP(candles);

    const volume = calculateVolume(candles);

    if (
        ema20 === null ||
        rsi === null ||
        vwap === null ||
        volume === null
    ) {

        return null;

    }

    const price = latest.close;

    const bullish =
        price > orb.high &&
        volume.pass &&
        rsi > RSI_BUY &&
        price > vwap &&
        price > ema20;

    const bearish =
        price < orb.low &&
        volume.pass &&
        rsi < RSI_SELL &&
        price < vwap &&
        price < ema20;

    let signal = "WAIT";

    if (bullish) {

        signal = "STRONG BUY";

    } else if (bearish) {

        signal = "STRONG SELL";

    }

    let trade = null;

    if (signal !== "WAIT") {

        trade = calculateRisk(
            signal,
            price,
            latest,
            orb
        );

    }

    return {

        symbol: stock.trading_symbol,

        company: stock.name,

        instrumentKey: stock.instrument_key,

        signal,

        price: round(price),

        orbHigh: round(orb.high),

        orbLow: round(orb.low),

        volume: latest.volume,

        averageVolume: Math.round(volume.average),

        volumeRatio: round(volume.ratio),

        volumeBreakout: volume.pass,

        rsi: round(rsi),

        ema20: round(ema20),

        vwap: round(vwap),

        candleTime: latest.time,

        entry: trade?.entry || null,

        stopLoss: trade?.stopLoss || null,

        target1: trade?.target1 || null,

        target2: trade?.target2 || null,

        riskReward: trade?.riskReward || null

    };

}

// ======================================================
// CONCURRENT SCANNER
// ======================================================

async function runConcurrent(items, limit, callback) {

    let index = 0;

    const results = [];

    async function worker() {

        while (true) {

            const current = index++;

            if (current >= items.length) return;

            try {

                const result = await callback(
                    items[current]
                );

                if (result) {

                    results.push(result);

                }

            } catch (error) {

                // Continue scanning remaining stocks

            }

        }

    }

    const workers = Array.from(
        {
            length: Math.min(limit, items.length)
        },
        () => worker()
    );

    await Promise.all(workers);

    return results;

}

// ======================================================
// MAIN SCAN FUNCTION
// ======================================================

async function scanStocks(type = "ALL") {

    type = type.toUpperCase();

    if (!["ALL", "FNO"].includes(type)) {

        throw new Error("Invalid scan type");

    }

    const cacheKey = type;

    const cached = scanCache[cacheKey];

    if (
        cached &&
        Date.now() - cached.time < CACHE_TIME
    ) {

        return cached.data;

    }

    await loadInstruments();

    let stocks = instruments;

    if (type === "FNO") {

        stocks = instruments.filter(stock => {

            return fnoSymbols.has(
                stock.trading_symbol
            );

        });

    }

    // Avoid scanning more instruments than configured

    stocks = stocks.slice(0, SCAN_LIMIT);

    console.log(
        "Starting ORB scan:",
        type,
        stocks.length
    );

    lastScanStatus[type] = {

        status: "SCANNING",

        totalStocks: stocks.length,

        startedAt: new Date().toISOString()

    };

    const results = await runConcurrent(
        stocks,
        CONCURRENCY,
        async stock => {

            const candles = await getCandles(
                stock.instrument_key
            );

            return analyseStock(
                stock,
                candles
            );

        }
    );

    results.sort((a, b) => {

        return b.volumeRatio - a.volumeRatio;

    });

    const output = {

        success: true,

        scanner: "ORB_VOLUME_BREAKOUT_V1",

        type,

        timeframe: "5 MINUTES",

        orbPeriod: "09:15 TO 09:30",

        totalStocks: stocks.length,

        scannedStocks: stocks.length,

        signals: results.length,

        bullish: results.filter(
            x => x.signal === "STRONG BUY"
        ).length,

        bearish: results.filter(
            x => x.signal === "STRONG SELL"
        ).length,

        data: results,

        scanTime: new Date().toISOString()

    };

    scanCache[cacheKey] = {

        time: Date.now(),

        data: output

    };

    lastScanStatus[type] = {

        status: "COMPLETED",

        totalStocks: stocks.length,

        signals: results.length,

        completedAt: new Date().toISOString()

    };

    return output;

}

// ======================================================
// FILTER HELPERS
// ======================================================

function filterSignals(data, type) {

    if (!data || !data.data) return [];

    if (type === "bullish") {

        return data.data.filter(
            x => x.signal === "STRONG BUY"
        );

    }

    if (type === "bearish") {

        return data.data.filter(
            x => x.signal === "STRONG SELL"
        );

    }

    if (type === "strong") {

        return data.data.filter(
            x =>
                x.signal !== "WAIT" &&
                x.volumeRatio >= 2 &&
                (
                    x.signal === "STRONG BUY"
                        ? x.rsi >= 65
                        : x.rsi <= 35
                )
        );

    }

    return data.data;

}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(
    async (req, res) => {

        if (req.method === "OPTIONS") {

            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization"
            });

            return res.end();

        }

        const url = new URL(
            req.url,
            "http://localhost"
        );

        const path = url.pathname;

        try {

            // HEALTH

            if (path === "/health") {

                return sendJson(res, 200, {

                    success: true,

                    status: "ONLINE",

                    app: "SMART TRADE INDIA",

                    scanner: "ORB VOLUME BREAKOUT V1",

                    uptime: process.uptime(),

                    time: new Date().toISOString()

                });

            }

            // STATUS

            if (path === "/api/orb/status") {

                return sendJson(res, 200, {

                    success: true,

                    scanner: "ORB VOLUME BREAKOUT",

                    apiConnected: Boolean(UPSTOX_TOKEN),

                    instrumentsLoaded:
                        instruments.length,

                    fnoStocks:
                        fnoSymbols.size,

                    lastMasterUpdate:
                        lastMasterUpdate
                            ? new Date(lastMasterUpdate).toISOString()
                            : null,

                    masterLoading,

                    scanStatus:
                        lastScanStatus,

                    cacheTime: CACHE_TIME,

                    timeframe: "5 MINUTES",

                    orbTime: "09:15-09:30"

                });

            }

            // REFRESH INSTRUMENTS

            if (path === "/api/orb/refresh-master") {

                scanCache = {};

                await loadInstruments(true);

                return sendJson(res, 200, {

                    success: true,

                    nseStocks: instruments.length,

                    fnoStocks: fnoSymbols.size

                });

            }

            // MAIN SCAN

            if (path === "/api/orb/scan") {

                const type =
                    url.searchParams.get("type") || "ALL";

                const result = await scanStocks(type);

                return sendJson(res, 200, result);

            }

            // BULLISH SCAN

            if (path === "/api/orb/bullish") {

                const result = await scanStocks("ALL");

                return sendJson(res, 200, {

                    success: true,

                    type: "BULLISH",

                    total:
                        filterSignals(result, "bullish").length,

                    data:
                        filterSignals(result, "bullish")

                });

            }

            // BEARISH SCAN

            if (path === "/api/orb/bearish") {

                const result = await scanStocks("ALL");

                return sendJson(res, 200, {

                    success: true,

                    type: "BEARISH",

                    total:
                        filterSignals(result, "bearish").length,

                    data:
                        filterSignals(result, "bearish")

                });

            }

            // STRONG SCAN

            if (path === "/api/orb/strong") {

                const result = await scanStocks("ALL");

                return sendJson(res, 200, {

                    success: true,

                    type: "STRONG",

                    total:
                        filterSignals(result, "strong").length,

                    data:
                        filterSignals(result, "strong")

                });

            }

            // NOT FOUND

            return sendJson(res, 404, {

                success: false,

                message: "API route not found",

                availableRoutes: [

                    "/health",

                    "/api/orb/scan?type=ALL",

                    "/api/orb/scan?type=FNO",

                    "/api/orb/bullish",

                    "/api/orb/bearish",

                    "/api/orb/strong",

                    "/api/orb/status",

                    "/api/orb/refresh-master"

                ]

            });

        } catch (error) {

            console.error(
                "SERVER ERROR:",
                error.message
            );

            return sendJson(res, 500, {

                success: false,

                error: error.message

            });

        }

    }
);

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA ORB SCANNER STARTED"
    );

    console.log(
        "PORT:",
        PORT
    );

    console.log(
        "UPSTOX TOKEN:",
        UPSTOX_TOKEN ? "CONFIGURED" : "MISSING"
    );

});
