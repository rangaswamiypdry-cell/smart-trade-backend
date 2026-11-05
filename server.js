// ======================================================
// SMART TRADE INDIA V7
// ALL NSE EQUITY SHORT TERM RALLY SCANNER
// 1-2 DAYS UPSIDE MOMENTUM
// NODE.JS 20+ | UPSTOX V3 | RENDER
// ======================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const UPSTOX_BASE = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
// SETTINGS

const SCAN_LIMIT = 2751;
const SCAN_CONCURRENCY = 3;
const CACHE_TIME = 60000;

let instruments = [];
let stockCache = [];
let lastScanTime = null;
let lastScanError = null;
let scanBusy = false;

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });

    res.end(JSON.stringify(data));

}

// ======================================================
// UPSTOX API REQUEST
// ======================================================

async function upstoxRequest(url) {

    if (!ACCESS_TOKEN) {
        throw new Error("UPSTOX ACCESS TOKEN MISSING");
    }

    const response = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "Authorization": "Bearer " + ACCESS_TOKEN
        }
    });

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid Upstox API response");
    }

    if (!response.ok) {
        throw new Error(
            "Upstox HTTP " + response.status +
            ": " + JSON.stringify(data)
        );
    }

    return data;

}

// ======================================================
// DOWNLOAD MASTER FILE
// ======================================================

function downloadBuffer(url) {

    return new Promise((resolve, reject) => {

        https.get(url, response => {

            if (response.statusCode !== 200) {
                reject(
                    new Error("Master download failed: " +
                    response.statusCode)
                );
                response.resume();
                return;
            }

            const chunks = [];

            response.on("data", chunk => chunks.push(chunk));

            response.on("end", () => {
                resolve(Buffer.concat(chunks));
            });

        }).on("error", reject);

    });

}

// ======================================================
// LOAD ALL NSE EQUITY
// ======================================================

async function loadInstruments() {

    if (instruments.length > 0) {
        return instruments;
    }

    console.log("DOWNLOADING NSE MASTER...");

    const buffer = await downloadBuffer(MASTER_URL);

    let master;

    try {
        master = JSON.parse(
            zlib.gunzipSync(buffer).toString("utf8")
        );
    } catch (error) {
        throw new Error("NSE master parsing failed");
    }

    instruments = master.filter(item =>
        item.segment === "NSE_EQ" &&
        item.instrument_type === "EQ" &&
        item.instrument_key &&
        item.trading_symbol
    );

    console.log("NSE EQUITY:", instruments.length);

    return instruments;

}

// ======================================================
// DATE FORMAT
// ======================================================

function formatISTDate(date) {

    const parts = new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }
    ).formatToParts(date);

    const values = {};

    for (const part of parts) {
        values[part.type] = part.value;
    }

    return `${values.year}-${values.month}-${values.day}`;

}

// ======================================================
// DAILY CANDLES
// ======================================================

async function getDailyCandles(instrumentKey) {

    const toDate = new Date();

    const fromDate = new Date();

    fromDate.setDate(fromDate.getDate() - 120);

    const url =
        UPSTOX_BASE +
        "/v3/historical-candle/" +
        encodeURIComponent(instrumentKey) +
        "/days/1/" +
        formatISTDate(toDate) +
        "/" +
        formatISTDate(fromDate);

    const data = await upstoxRequest(url);

    return data?.data?.candles || [];

}

// ======================================================
// INTRADAY 5 MINUTE CANDLES
// ======================================================

async function getIntradayCandles(instrumentKey) {

    const url =
        UPSTOX_BASE +
        "/v3/historical-candle/intraday/" +
        encodeURIComponent(instrumentKey) +
        "/minutes/5";

    const data = await upstoxRequest(url);

    return data?.data?.candles || [];

}
// ======================================================
// SMART TRADE INDIA V7
// PART 2 - INDICATORS + RALLY ANALYSIS
// ======================================================

// ======================================================
// CANDLE NORMALIZER
// ======================================================

function normalizeCandles(candles) {

    return (candles || [])
        .map(c => ({
            time: new Date(c[0]).getTime(),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5] || 0)
        }))
        .filter(c =>
            Number.isFinite(c.time) &&
            c.close > 0 &&
            c.high > 0 &&
            c.low > 0
        )
        .sort((a, b) => a.time - b.time);

}

// ======================================================
// COMPLETED DAILY CANDLES
// Exclude current trading day to avoid incomplete data
// ======================================================

function getCompletedDailyCandles(candles) {

    const today = formatISTDate(new Date());

    return normalizeCandles(candles).filter(c => {

        const candleDate = formatISTDate(
            new Date(c.time)
        );

        return candleDate < today;

    });

}

// ======================================================
// COMPLETED 5 MINUTE CANDLES
// ======================================================

function getCompleted5MinCandles(candles) {

    const now = Date.now();

    return normalizeCandles(candles).filter(c => {

        return c.time + (5 * 60 * 1000) <= now;

    });

}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period) {

    if (values.length < period) {
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
// RSI WILDER
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

    let avgGain = gain / period;
    let avgLoss = loss / period;

    for (let i = period + 1; i < values.length; i++) {

        const change = values[i] - values[i - 1];

        const currentGain = Math.max(change, 0);
        const currentLoss = Math.max(-change, 0);

        avgGain =
            ((avgGain * (period - 1)) + currentGain) / period;

        avgLoss =
            ((avgLoss * (period - 1)) + currentLoss) / period;

    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - (100 / (1 + rs));

}

// ======================================================
// DAILY VOLUME RATIO
// ======================================================

function calculateVolumeRatio(candles) {

    if (candles.length < 21) return 0;

    const previous = candles.slice(-21, -1);

    const average =
        previous.reduce((sum, c) => sum + c.volume, 0) /
        previous.length;

    const latest = candles[candles.length - 1];

    if (average <= 0) return 0;

    return latest.volume / average;

}

// ======================================================
// INTRADAY VWAP
// ======================================================

function calculateVWAP(candles) {

    if (!candles.length) return null;

    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {

        const typicalPrice =
            (c.high + c.low + c.close) / 3;

        totalPV += typicalPrice * c.volume;

        totalVolume += c.volume;

    }

    if (totalVolume <= 0) return null;

    return totalPV / totalVolume;

}

// ======================================================
// BREAKOUT LEVEL
// ======================================================

function calculateResistance(candles, period = 10) {

    if (candles.length <= period) return null;

    const previous = candles.slice(
        -(period + 1),
        -1
    );

    return Math.max(
        ...previous.map(c => c.high)
    );

}

// ======================================================
// ATR APPROXIMATION
// ======================================================

function calculateATR(candles, period = 14) {

    if (candles.length <= period) return null;

    const ranges = [];

    for (let i = candles.length - period; i < candles.length; i++) {

        const current = candles[i];
        const previous = candles[i - 1];

        const range = Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        );

        ranges.push(range);

    }

    return ranges.reduce((a, b) => a + b, 0) /
        ranges.length;

}

// ======================================================
// INTRADAY MOMENTUM CONFIRMATION
// ======================================================

function analyseIntraday(candles) {

    if (!candles || candles.length < 5) {

        return {
            confirmed: false,
            vwap: null,
            volumeRatio: 0
        };

    }

    const latest = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const vwap = calculateVWAP(candles);

    const previous20 = candles.slice(-21, -1);

    const averageVolume = previous20.length
        ? previous20.reduce(
            (sum, c) => sum + c.volume, 0
        ) / previous20.length
        : 0;

    const volumeRatio = averageVolume > 0
        ? latest.volume / averageVolume
        : 0;

    const confirmed =
        latest.close > latest.open &&
        latest.close > previous.close &&
        vwap !== null &&
        latest.close > vwap &&
        volumeRatio >= 1.2;

    return {
        confirmed,
        vwap,
        volumeRatio
    };

}

// ======================================================
// MAIN STOCK ANALYSIS
// ======================================================

function analyseStock(
    item,
    rawDailyCandles,
    rawIntradayCandles
) {

    const candles =
        getCompletedDailyCandles(rawDailyCandles);

    if (candles.length < 55) {
        return null;
    }

    const closes = candles.map(c => c.close);

    const latest = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const ema20 = calculateEMA(closes, 20);

    const ema50 = calculateEMA(closes, 50);

    const rsi = calculateRSI(closes, 14);

    const volumeRatio = calculateVolumeRatio(candles);

    const resistance = calculateResistance(candles, 10);

    const atr = calculateATR(candles, 14);

    if (
        ema20 === null ||
        ema50 === null ||
        rsi === null ||
        atr === null ||
        resistance === null
    ) {
        return null;
    }

    const intradayCandles =
        getCompleted5MinCandles(rawIntradayCandles);

    const intraday =
        analyseIntraday(intradayCandles);

    const priceChange =
        ((latest.close - previous.close) /
        previous.close) * 100;

    const dailyTrend =
        latest.close > ema20 &&
        ema20 > ema50;

    const bullishCandle =
        latest.close > latest.open;

    const volumePass =
        volumeRatio >= 1.5;

    const rsiPass =
        rsi >= 55 && rsi <= 75;

    const breakout =
        latest.close > resistance;

    const nearBreakout =
        latest.close >= resistance * 0.985;

    const bullish =
        dailyTrend &&
        bullishCandle &&
        priceChange > 0 &&
        volumePass &&
        rsiPass;

    const strongBuy =
        bullish &&
        breakout &&
        intraday.confirmed;

    const buy =
        bullish &&
        nearBreakout &&
        intraday.confirmed;

    let signal = "WATCH";

    if (strongBuy) signal = "STRONG BUY";
    else if (buy) signal = "BUY";

    const entry = latest.close;

    const stopLoss = Math.max(
        latest.low,
        entry - (atr * 1.2)
    );

    const risk = entry - stopLoss;

    const target1 = entry + (risk * 1.5);

    const target2 = entry + (risk * 2.5);

    const confidence = Math.min(
        95,
        Math.round(
            (dailyTrend ? 20 : 0) +
            (bullishCandle ? 10 : 0) +
            (volumePass ? 20 : 0) +
            (rsiPass ? 15 : 0) +
            (breakout ? 20 : nearBreakout ? 10 : 0) +
            (intraday.confirmed ? 15 : 0)
        )
    );

    return {

        symbol: item.trading_symbol,

        instrumentKey: item.instrument_key,

        signal,

        price: Number(entry.toFixed(2)),

        priceChange: Number(priceChange.toFixed(2)),

        ema20: Number(ema20.toFixed(2)),

        ema50: Number(ema50.toFixed(2)),

        rsi: Number(rsi.toFixed(2)),

        volumeRatio: Number(volumeRatio.toFixed(2)),

        resistance: Number(resistance.toFixed(2)),

        vwap: intraday.vwap
            ? Number(intraday.vwap.toFixed(2))
            : null,

        intradayVolumeRatio:
            Number(intraday.volumeRatio.toFixed(2)),

        breakout,

        entry: Number(entry.toFixed(2)),

        stopLoss: Number(stopLoss.toFixed(2)),

        target1: Number(target1.toFixed(2)),

        target2: Number(target2.toFixed(2)),

        confidence,

        timeframe: "1-2 DAYS",

        confirmation:
            intraday.confirmed
                ? "5 MIN CONFIRMED"
                : "WAIT FOR CONFIRMATION"

    };

}
// ======================================================
// SMART TRADE INDIA V7
// PART 3 - SCANNER + API ROUTES
// ======================================================

// ======================================================
// SCAN ALL NSE STOCKS
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

        const list = await loadInstruments();

        const selected = list.slice(0, SCAN_LIMIT);

        console.log(
            "NSE SCAN STARTED:",
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

                    const [daily, intraday] =
                        await Promise.all([

                            getDailyCandles(
                                item.instrument_key
                            ),

                            getIntradayCandles(
                                item.instrument_key
                            )

                        ]);

                    const analysis = analyseStock(
                        item,
                        daily,
                        intraday
                    );

                    if (analysis) {
                        results.push(analysis);
                    }

                } catch (error) {

                    errors.push({

                        symbol: item.trading_symbol,

                        error: error.message

                    });

                    console.log(
                        "STOCK ERROR:",
                        item.trading_symbol,
                        error.message
                    );

                }

            }

        }

        const workers = [];

        const count = Math.min(
            SCAN_CONCURRENCY,
            selected.length
        );

        for (let i = 0; i < count; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

        // SORT STRONGEST FIRST

        const priority = {

            "STRONG BUY": 1,

            "BUY": 2,

            "WATCH": 3

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
            ? errors.slice(0, 30)
            : null;

        console.log(
            "SCAN COMPLETED",
            "Stocks:",
            selected.length,
            "Signals:",
            results.length,
            "Errors:",
            errors.length
        );

        return stockCache;

    } catch (error) {

        lastScanError = error.message;

        console.error(
            "SCAN FAILED:",
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

function filterStocks(stocks, type = "ALL") {

    if (type === "BUY") {

        return stocks.filter(s =>
            s.signal === "BUY" ||
            s.signal === "STRONG BUY"
        );

    }

    if (type === "STRONG_BUY") {

        return stocks.filter(s =>
            s.signal === "STRONG BUY"
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
// SCAN SUMMARY
// ======================================================

function getSummary(stocks) {

    return {

        total: stocks.length,

        strongBuy: stocks.filter(
            s => s.signal === "STRONG BUY"
        ).length,

        buy: stocks.filter(
            s => s.signal === "BUY"
        ).length,

        watch: stocks.filter(
            s => s.signal === "WATCH"
        ).length

    };

}

// ======================================================
// HTTP API ROUTES
// ======================================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {

        res.writeHead(204, {

            "Access-Control-Allow-Origin": "*",

            "Access-Control-Allow-Methods":
                "GET, POST, OPTIONS",

            "Access-Control-Allow-Headers":
                "Content-Type"

        });

        return res.end();

    }

    const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
    );

    const path = url.pathname;

    try {

        // HEALTH

        if (path === "/health") {

            return sendJson(res, 200, {

                success: true,

                app: "SMART TRADE INDIA V7",

                status: "RUNNING",

                time: new Date().toISOString()

            });

        }

        // STATUS

        if (path === "/api/status") {

            return sendJson(res, 200, {

                success: true,

                upstox: ACCESS_TOKEN
                    ? "CONNECTED"
                    : "TOKEN MISSING",

                stocksLoaded: instruments.length,

                scanBusy,

                lastScanTime,

                lastScanError

            });

        }

        // ALL NSE STOCKS

        if (path === "/api/nse-stocks") {

            const list = await loadInstruments();

            return sendJson(res, 200, {

                success: true,

                count: list.length,

                stocks: list.map(item => ({

                    symbol: item.trading_symbol,

                    instrumentKey: item.instrument_key

                }))

            });

        }

        // MAIN SCANNER

        if (
            path === "/api/scan" ||
            path === "/api/stocks"
        ) {

            const force =
                url.searchParams.get("force") === "true";

            const type = (
                url.searchParams.get("type") || "ALL"
            ).toUpperCase();

            const stocks = await scanStocks(force);

            const filtered = filterStocks(
                stocks,
                type
            );

            return sendJson(res, 200, {

                success: true,

                app: "SMART TRADE INDIA V7",

                timeframe: "1-2 DAYS",

                candleConfirmation: "COMPLETED CANDLES",

                count: filtered.length,

                summary: getSummary(stocks),

                lastScanTime,

                scanBusy,

                stocks: filtered,

                errors: lastScanError

            });

        }

        // BUY

        if (path === "/api/buy") {

            const stocks = await scanStocks(false);

            return sendJson(res, 200, {

                success: true,

                stocks: filterStocks(stocks, "BUY")

            });

        }

        // STRONG BUY

        if (path === "/api/strong-buy") {

            const stocks = await scanStocks(false);

            return sendJson(res, 200, {

                success: true,

                stocks: filterStocks(
                    stocks,
                    "STRONG_BUY"
                )

            });

        }

        // WATCH

        if (path === "/api/watch") {

            const stocks = await scanStocks(false);

            return sendJson(res, 200, {

                success: true,

                stocks: filterStocks(stocks, "WATCH")

            });

        }

        // UNKNOWN ROUTE

        return sendJson(res, 404, {

            success: false,

            message: "API route not found",

            route: path

        });

    } catch (error) {

        console.error(
            "API ERROR:",
            error.message
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

    console.log("================================");

    console.log("SMART TRADE INDIA V7 RUNNING");

    console.log("PORT:", PORT);

    console.log(
        "UPSTOX:",
        ACCESS_TOKEN
            ? "TOKEN CONFIGURED"
            : "TOKEN MISSING"
    );

    console.log("================================");

});
