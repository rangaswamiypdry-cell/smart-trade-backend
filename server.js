// ======================================================
// SMART TRADE INDIA V3 PRO
// ORB + VOLUME BREAKOUT SCANNER
// NSE F&O | UPSTOX V3 | NODE.JS 20+
// ======================================================

"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ======================================================
// SCANNER SETTINGS
// ======================================================

const SCAN_LIMIT = 3000;

const SCAN_CONCURRENCY = 2;

const VOLUME_MULTIPLIER = 2.5;

const BUY_RSI_MIN = 65;

const SELL_RSI_MAX = 35;

const MIN_ADX = 25;

const MIN_ESTIMATED_MOVE = 38;

const ATR_MOVE_MULTIPLIER = 1.5;

const CACHE_TIME = 5 * 60 * 1000;

const REQUEST_DELAY = 350;

// ======================================================
// GLOBAL VARIABLES
// ======================================================

let instruments = [];

let fnoSymbols = new Set();

let lastMasterUpdate = 0;

let masterLoading = false;

let scanRunning = false;

let signalCache = new Map();

let lastScanStatus = {
    running: false,
    total: 0,
    scanned: 0,
    signals: 0,
    errors: 0,
    updated: null
};

// ======================================================
// TIME HELPERS
// ======================================================

function istDate(date = new Date()) {

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

function round(value) {

    return Number(Number(value).toFixed(2));

}

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    res.end(JSON.stringify(data));

}

// ======================================================
// FETCH WITH TIMEOUT
// ======================================================

async function fetchTimeout(url, options = {}, timeout = 20000) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {

        return await fetch(url, {
            ...options,
            signal: controller.signal
        });

    } finally {

        clearTimeout(timer);

    }

}

// ======================================================
// UPSTOX API REQUEST
// ======================================================

async function upstoxRequest(path) {

    if (!UPSTOX_TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const response = await fetchTimeout(
        API + path,
        {
            headers: {
                Accept: "application/json",
                Authorization: "Bearer " + UPSTOX_TOKEN
            }
        },
        20000
    );

    const data = await response.json();

    if (!response.ok) {

        throw new Error(
            "Upstox " +
            response.status +
            ": " +
            JSON.stringify(data)
        );

    }

    return data;

}

// ======================================================
// NSE INSTRUMENT MASTER
// ======================================================

async function loadInstruments(force = false) {

    if (masterLoading) {

        while (masterLoading) {
            await new Promise(r => setTimeout(r, 300));
        }

        if (instruments.length) return;

    }

    if (
        instruments.length &&
        !force &&
        Date.now() - lastMasterUpdate < 86400000
    ) {
        return;
    }

    masterLoading = true;

    try {

        console.log("Loading NSE Instrument Master...");

        const response = await fetchTimeout(
            MASTER_URL,
            {},
            60000
        );

        if (!response.ok) {
            throw new Error("Master download failed");
        }

        const buffer = Buffer.from(
            await response.arrayBuffer()
        );

        let decoded;

        try {
            decoded = zlib.gunzipSync(buffer);
        } catch {
            decoded = buffer;
        }

        const raw = JSON.parse(
            decoded.toString("utf8")
        );

        if (!Array.isArray(raw)) {
            throw new Error("Invalid NSE master data");
        }

        const equity = raw.filter(x =>
            x.segment === "NSE_EQ" &&
            x.instrument_type === "EQ" &&
            x.instrument_key &&
            x.trading_symbol
        );

        const fno = new Set();

        for (const item of raw) {

            if (
                item.segment === "NSE_FO" &&
                ["FUT", "CE", "PE"].includes(
                    item.instrument_type
                ) &&
                item.underlying_symbol
            ) {

                fno.add(item.underlying_symbol);

            }

        }

        instruments = equity;

        fnoSymbols = fno;

        lastMasterUpdate = Date.now();

        console.log("NSE EQUITY:", instruments.length);

        console.log("NSE FNO:", fnoSymbols.size);

    } catch (error) {

        console.error("MASTER ERROR:", error.message);

        if (!instruments.length) {
            throw error;
        }

    } finally {

        masterLoading = false;

    }

}

// ======================================================
// GET NSE F&O STOCKS
// ======================================================

async function getStocksForScan(type = "FNO") {

    await loadInstruments();

    type = String(type).toUpperCase();

    let stocks;

    if (type === "FNO") {

        stocks = instruments.filter(stock =>
            fnoSymbols.has(stock.trading_symbol)
        );

    } else if (type === "ALL") {

        stocks = instruments;

    } else {

        throw new Error("Invalid scan type");

    }

    return stocks.slice(0, SCAN_LIMIT).map(stock => ({
        symbol: stock.trading_symbol,
        instrumentKey: stock.instrument_key
    }));

}

// ======================================================
// GET 5 MINUTE CANDLES
// ======================================================

async function getStockCandles(stock) {

    const key = encodeURIComponent(
        stock.instrumentKey
    );

    const path =
        "/v3/historical-candle/intraday/" +
        key +
        "/minutes/5";

    const result = await upstoxRequest(path);

    return prepareCandles(
        result?.data?.candles || []
    );

}

// ======================================================
// PREPARE COMPLETED CANDLES
// ======================================================

function prepareCandles(raw) {

    const today = istDate();

    const now = Date.now();

    return raw.map(c => ({

        timestamp: c[0],

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5]),

        oi: Number(c[6] || 0)

    })).filter(c => {

        const time = new Date(c.timestamp);

        return (
            Number.isFinite(time.getTime()) &&
            istDate(time) === today &&
            time.getTime() + 5 * 60000 <= now &&
            [
                c.open,
                c.high,
                c.low,
                c.close,
                c.volume
            ].every(Number.isFinite)
        );

    }).sort((a, b) =>
        new Date(a.timestamp) - new Date(b.timestamp)
    );

}

// ======================================================
// ORB CALCULATION
// First 3 completed 5-minute candles
// ======================================================

function calculateORB(candles) {

    const opening = candles.filter(c =>
        ["09:15", "09:20", "09:25"].includes(
            istTime(new Date(c.timestamp))
        )
    );

    if (opening.length !== 3) {
        return null;
    }

    return {

        high: Math.max(
            ...opening.map(c => c.high)
        ),

        low: Math.min(
            ...opening.map(c => c.low)
        )

    };

}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period = 20) {

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
// RSI
// ======================================================

function calculateRSI(values, period = 14) {

    if (values.length <= period) return null;

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

        avgGain =
            (avgGain * (period - 1) +
            Math.max(change, 0)) / period;

        avgLoss =
            (avgLoss * (period - 1) +
            Math.max(-change, 0)) / period;

    }

    if (avgLoss === 0) return 100;

    return 100 - 100 / (
        1 + avgGain / avgLoss
    );

}

// ======================================================
// VWAP
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

    return totalVolume > 0
        ? totalPV / totalVolume
        : null;

}

// ======================================================
// ATR
// ======================================================

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) return null;

    const trs = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const p = candles[i - 1];

        trs.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        ));

    }

    const recent = trs.slice(-period);

    return recent.reduce((a, b) => a + b, 0) /
        recent.length;

}

// ======================================================
// ADX
// ======================================================

function calculateADX(candles, period = 14) {

    if (candles.length < period * 2 + 1) {
        return null;
    }

    const tr = [];
    const plusDM = [];
    const minusDM = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const p = candles[i - 1];

        const up = c.high - p.high;
        const down = p.low - c.low;

        plusDM.push(
            up > down && up > 0 ? up : 0
        );

        minusDM.push(
            down > up && down > 0 ? down : 0
        );

        tr.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        ));

    }

    const dx = [];

    for (let i = period - 1; i < tr.length; i++) {

        const start = i - period + 1;

        const sumTR = tr
            .slice(start, i + 1)
            .reduce((a, b) => a + b, 0);

        if (!sumTR) continue;

        const pdi = 100 *
            plusDM.slice(start, i + 1)
                .reduce((a, b) => a + b, 0) / sumTR;

        const mdi = 100 *
            minusDM.slice(start, i + 1)
                .reduce((a, b) => a + b, 0) / sumTR;

        dx.push(
            pdi + mdi === 0
                ? 0
                : 100 * Math.abs(pdi - mdi) / (pdi + mdi)
        );

    }

    if (dx.length < period) return null;

    return dx.slice(-period)
        .reduce((a, b) => a + b, 0) / period;

}

// ======================================================
// VOLUME BREAKOUT
// ======================================================

function calculateVolume(candles) {

    if (candles.length < 21) return null;

    const previous = candles.slice(-21, -1);

    const latest = candles[candles.length - 1];

    const average = previous.reduce(
        (sum, c) => sum + c.volume,
        0
    ) / previous.length;

    const ratio = average > 0
        ? latest.volume / average
        : 0;

    return {
        current: latest.volume,
        average: round(average),
        ratio: round(ratio),
        pass: ratio >= VOLUME_MULTIPLIER
    };

}

// ======================================================
// STRONG CANDLE CONFIRMATION
// ======================================================

function candleStrength(candle, direction) {

    const range = candle.high - candle.low;

    if (range <= 0) return false;

    const body = Math.abs(
        candle.close - candle.open
    );

    const bodyRatio = body / range;

    if (direction === "BUY") {

        return (
            candle.close > candle.open &&
            bodyRatio >= 0.60 &&
            (candle.high - candle.close) / range <= 0.20
        );

    }

    return (
        candle.close < candle.open &&
        bodyRatio >= 0.60 &&
        (candle.close - candle.low) / range <= 0.20
    );

}

// ======================================================
// STOCK ANALYSIS
// ======================================================

function analyseStock(stock, candles) {

    if (!candles || candles.length < 35) {
        return null;
    }

    const last = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const ema20 = calculateEMA(closes, 20);

    const rsi = calculateRSI(closes, 14);

    const vwap = calculateVWAP(candles);

    const atr = calculateATR(candles, 14);

    const adx = calculateADX(candles, 14);

    const volume = calculateVolume(candles);

    const orb = calculateORB(candles);

    if (
        ema20 === null ||
        rsi === null ||
        vwap === null ||
        atr === null ||
        adx === null ||
        !volume ||
        !orb
    ) {
        return null;
    }

    // ==============================================
    // COMMON FILTERS
    // ==============================================

    const volumePass =
        volume.ratio >= VOLUME_MULTIPLIER;

    const adxPass =
        adx >= MIN_ADX;

    const estimatedMove =
        atr * ATR_MOVE_MULTIPLIER;

    const movePass =
        estimatedMove >= MIN_ESTIMATED_MOVE;

    // ==============================================
    // BREAKOUT CONFIRMATION
    // ==============================================

    const bullishBreakout =
        previous.close <= orb.high &&
        last.close > orb.high;

    const bearishBreakdown =
        previous.close >= orb.low &&
        last.close < orb.low;

    // ==============================================
    // STRONG CANDLE
    // ==============================================

    const bullishCandle =
        candleStrength(last, "BUY");

    const bearishCandle =
        candleStrength(last, "SELL");

    // ==============================================
    // BULLISH CONDITIONS
    // ==============================================

    const bullish =
        last.close > last.open &&
        last.close > ema20 &&
        last.close > vwap &&
        bullishBreakout &&
        rsi >= BUY_RSI_MIN &&
        volumePass &&
        adxPass &&
        bullishCandle &&
        movePass;

    // ==============================================
    // BEARISH CONDITIONS
    // ==============================================

    const bearish =
        last.close < last.open &&
        last.close < ema20 &&
        last.close < vwap &&
        bearishBreakdown &&
        rsi <= SELL_RSI_MAX &&
        volumePass &&
        adxPass &&
        bearishCandle &&
        movePass;

    if (!bullish && !bearish) {
        return null;
    }

    const direction = bullish ? "BUY" : "SELL";

    // ==============================================
    // STOP LOSS + TARGET
    // ==============================================

    const risk = Math.max(
        atr,
        last.close * 0.005
    );

    let stopLoss;
    let target1;
    let target2;

    if (direction === "BUY") {

        stopLoss = last.close - risk;

        target1 = last.close + risk * 2;

        target2 = last.close + risk * 3;

    } else {

        stopLoss = last.close + risk;

        target1 = last.close - risk * 2;

        target2 = last.close - risk * 3;

    }

    // ==============================================
    // FINAL SIGNAL
    // ==============================================

    return {

        symbol: stock.symbol,

        instrumentKey: stock.instrumentKey,

        signal: direction,

        strength: "VERY STRONG " + direction,

        price: round(last.close),

        candleTime: last.timestamp,

        timeframe: "5 MIN",

        indicators: {

            rsi: round(rsi),

            adx: round(adx),

            ema20: round(ema20),

            vwap: round(vwap),

            atr: round(atr),

            volume: round(last.volume),

            averageVolume: volume.average,

            volumeRatio: volume.ratio,

            estimatedMovePoints: round(estimatedMove)

        },

        orb: {

            high: round(orb.high),

            low: round(orb.low)

        },

        trade: {

            entry: round(last.close),

            stopLoss: round(stopLoss),

            target1: round(target1),

            target2: round(target2),

            riskPoints: round(risk)

        },

        note: "Closed 5-minute candle confirmation only"

    };

}

// ======================================================
// CONCURRENT SCANNER
// ======================================================

async function runConcurrent(items, limit, worker) {

    const results = [];

    let index = 0;

    async function runner() {

        while (index < items.length) {

            const current = index++;

            try {

                const result = await worker(items[current]);

                if (result) {
                    results.push(result);
                }

            } catch (error) {

                lastScanStatus.errors++;

                console.error(
                    "SCAN ERROR:",
                    items[current].symbol,
                    error.message
                );

            }

            await new Promise(resolve =>
                setTimeout(resolve, REQUEST_DELAY)
            );

        }

    }

    const workers = [];

    for (
        let i = 0;
        i < Math.min(limit, items.length);
        i++
    ) {

        workers.push(runner());

    }

    await Promise.all(workers);

    return results;

}

// ======================================================
// ORB STOCK SCANNER
// ======================================================

async function scanOrbStocks(type = "FNO") {

    const cacheKey =
        String(type).toUpperCase() +
        "_" +
        Math.floor(Date.now() / CACHE_TIME);

    if (signalCache.has(cacheKey)) {

        return signalCache.get(cacheKey);

    }

    if (scanRunning) {

        return {
            success: false,
            message: "Scanner already running",
            status: lastScanStatus
        };

    }

    scanRunning = true;

    lastScanStatus = {

        running: true,

        total: 0,

        scanned: 0,

        signals: 0,

        errors: 0,

        updated: new Date().toISOString()

    };

    try {

        const stocks = await getStocksForScan(type);

        lastScanStatus.total = stocks.length;

        console.log(
            "STARTING ORB SCAN:",
            stocks.length
        );

        const signals = await runConcurrent(
            stocks,
            SCAN_CONCURRENCY,

            async stock => {

                const candles =
                    await getStockCandles(stock);

                lastScanStatus.scanned++;

                if (!candles || candles.length < 35) {
                    return null;
                }

                return analyseStock(stock, candles);

            }

        );

        signals.sort((a, b) => {

            const scoreA =
                a.indicators.volumeRatio *
                a.indicators.adx;

            const scoreB =
                b.indicators.volumeRatio *
                b.indicators.adx;

            return scoreB - scoreA;

        });

        const result = {

            success: true,

            scanner: "SMART TRADE INDIA V3 PRO",

            strategy: "ORB + VOLUME BREAKOUT",

            type,

            timeframe: "5 MIN",

            totalStocks: stocks.length,

            scannedStocks: lastScanStatus.scanned,

            totalSignals: signals.length,

            bullishSignals: signals.filter(
                x => x.signal === "BUY"
            ).length,

            bearishSignals: signals.filter(
                x => x.signal === "SELL"
            ).length,

            signals,

            updated: new Date().toISOString()

        };

        lastScanStatus.running = false;

        lastScanStatus.signals = signals.length;

        lastScanStatus.updated = result.updated;

        signalCache.set(cacheKey, result);

        // Keep cache size controlled
        if (signalCache.size > 20) {

            const firstKey =
                signalCache.keys().next().value;

            signalCache.delete(firstKey);

        }

        console.log(
            "SCAN COMPLETE:",
            signals.length,
            "SIGNALS"
        );

        return result;

    } finally {

        scanRunning = false;

        lastScanStatus.running = false;

    }

}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {

        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
        });

        return res.end();

    }

    const url = new URL(
        req.url,
        "http://localhost"
    );

    const path = url.pathname;

    const type =
        String(url.searchParams.get("type") || "FNO")
        .toUpperCase();

    try {

        // ==========================================
        // HOME
        // ==========================================

        if (path === "/") {

            return sendJson(res, 200, {

                success: true,

                name: "SMART TRADE INDIA V3 PRO",

                strategy: "ORB + VOLUME BREAKOUT",

                status: "RUNNING",

                timeframe: "5 MIN"

            });

        }

        // ==========================================
        // HEALTH
        // ==========================================

        if (path === "/health") {

            return sendJson(res, 200, {

                success: true,

                message: "Smart Trade India V3 running",

                time: new Date().toISOString()

            });

        }

        // ==========================================
        // UPSTOX STATUS
        // ==========================================

        if (path === "/api/upstox/status") {

            if (!UPSTOX_TOKEN) {

                return sendJson(res, 400, {

                    success: false,

                    message: "UPSTOX_ACCESS_TOKEN missing"

                });

            }

            const profile =
                await upstoxRequest("/v2/user/profile");

            return sendJson(res, 200, {

                success: true,

                message: "Upstox connected",

                user: profile.data?.user_name || "Connected"

            });

        }

        // ==========================================
        // NSE MASTER STATUS
        // ==========================================

        if (
            path === "/api/nse/master" ||
            path === "/api/orb/status"
        ) {

            return sendJson(res, 200, {

                success: true,

                masterLoaded: instruments.length > 0,

                equityCount: instruments.length,

                fnoCount: fnoSymbols.size,

                lastUpdated: lastMasterUpdate
                    ? new Date(lastMasterUpdate).toISOString()
                    : null,

                scannerRunning: scanRunning

            });

        }

        // ==========================================
        // REFRESH MASTER
        // ==========================================

        if (
            path === "/api/nse/refresh-master" ||
            path === "/api/orb/refresh-master"
        ) {

            await loadInstruments(true);

            return sendJson(res, 200, {

                success: true,

                message: "NSE Master refreshed",

                equityCount: instruments.length,

                fnoCount: fnoSymbols.size

            });

        }

        // ==========================================
        // NSE STOCK LIST
        // ==========================================

        if (
            path === "/api/nse/stocks" ||
            path === "/api/orb/stocks"
        ) {

            const stocks =
                await getStocksForScan(type);

            return sendJson(res, 200, {

                success: true,

                type,

                count: stocks.length,

                stocks

            });

        }

        // ==========================================
        // SCANNER PROGRESS
        // ==========================================

        if (path === "/api/scanner/progress") {

            return sendJson(res, 200, {

                success: true,

                status: lastScanStatus

            });

        }

        // ==========================================
        // MAIN SCANNER
        // ==========================================

        if (
            path === "/api/scanner/scan" ||
            path === "/api/orb/scan" ||
            path === "/api/nse/stocks/scan"
        ) {

            const result =
                await scanOrbStocks(type);

            return sendJson(
                res,
                result.success ? 200 : 202,
                result
            );

        }

        // ==========================================
        // BULLISH SIGNALS
        // ==========================================

        if (
            path === "/api/scanner/bullish" ||
            path === "/api/orb/bullish"
        ) {

            const result =
                await scanOrbStocks(type);

            if (!result.success) {

                return sendJson(res, 202, result);

            }

            return sendJson(res, 200, {

                success: true,

                count: result.signals.filter(
                    x => x.signal === "BUY"
                ).length,

                signals: result.signals.filter(
                    x => x.signal === "BUY"
                )

            });

        }

        // ==========================================
        // BEARISH SIGNALS
        // ==========================================

        if (
            path === "/api/scanner/bearish" ||
            path === "/api/orb/bearish"
        ) {

            const result =
                await scanOrbStocks(type);

            if (!result.success) {

                return sendJson(res, 202, result);

            }

            return sendJson(res, 200, {

                success: true,

                count: result.signals.filter(
                    x => x.signal === "SELL"
                ).length,

                signals: result.signals.filter(
                    x => x.signal === "SELL"
                )

            });

        }

        // ==========================================
        // ROUTE NOT FOUND
        // ==========================================

        return sendJson(res, 404, {

            success: false,

            message: "API route not found",

            path

        });

    } catch (error) {

        console.error(
            "SERVER ERROR:",
            error.message
        );

        return sendJson(res, 500, {

            success: false,

            message: error.message

        });

    }

});

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA V3 PRO RUNNING ON PORT",
        PORT
    );

    console.log(
        "ORB + VOLUME BREAKOUT SCANNER READY"
    );

});
