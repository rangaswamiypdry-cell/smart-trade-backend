// ======================================================
// SMART TRADE INDIA V2 - ORB + VOLUME BREAKOUT SCANNER
// Node.js 20+ | Upstox API V3 | NSE Equity / F&O
// Signals use completed 5-minute candles only.
// ======================================================

"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const UPSTOX_BASE = "https://api.upstox.com";

const SCAN_LIMIT = Math.max(
    1,
    Number(process.env.ORB_SCAN_LIMIT || 300)
);

const SCAN_CONCURRENCY = Math.max(
    1,
    Number(process.env.ORB_SCAN_CONCURRENCY || 3)
);

const CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

const SETTINGS = {
    volumeMultiplier: 2.5,
    buyRsi: 65,
    sellRsi: 35,
    minAdx: 25,
    minCandles: 35,
    atrStopMultiplier: 1.0,
    reward1: 2,
    reward2: 3
};

// GLOBAL VARIABLES

let instruments = [];
let fnoSymbols = new Set();

let masterLoadedAt = null;
let masterLoading = false;
let masterError = null;

let lastScanTime = null;
let lastScanError = null;

const scanCache = new Map();

// ======================================
// JSON RESPONSE
// ======================================

function sendJson(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

// ======================================
// IST TIME
// ======================================

function istParts(date = new Date()) {

    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date);

    const out = {};

    for (const p of parts) {
        if (p.type !== "literal") {
            out[p.type] = p.value;
        }
    }

    return out;
}

function istDate(date) {

    const p = istParts(date);

    return `${p.year}-${p.month}-${p.day}`;
}

function istTime(date) {

    const p = istParts(date);

    return `${p.hour}:${p.minute}`;
}

function safeNumber(value, digits = 2) {

    const n = Number(value);

    return Number.isFinite(n)
        ? Number(n.toFixed(digits))
        : null;
}

// ======================================
// DOWNLOAD MASTER
// ======================================

async function fetchBuffer(url, timeout = 60000) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {

        const response = await fetch(url, {
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status} while downloading instrument master`
            );
        }

        return Buffer.from(
            await response.arrayBuffer()
        );

    } finally {

        clearTimeout(timer);

    }
}

// ======================================
// UPSTOX API
// ======================================

async function upstoxGet(path) {

    if (!UPSTOX_TOKEN) {

        throw new Error(
            "UPSTOX_ACCESS_TOKEN is missing in Render environment variables"
        );

    }

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
    );

    try {

        const response = await fetch(
            UPSTOX_BASE + path,
            {
                method: "GET",

                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${UPSTOX_TOKEN}`
                },

                signal: controller.signal
            }
        );

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {

            const message =
                body?.errors?.[0]?.message ||
                body?.message ||
                JSON.stringify(body);

            throw new Error(
                `Upstox ${response.status}: ${message}`
            );

        }

        return body;

    } finally {

        clearTimeout(timer);

    }
}

// ======================================
// LOAD NSE INSTRUMENT MASTER
// ======================================

async function loadInstruments(force = false) {

    if (masterLoading) {

        while (masterLoading) {

            await new Promise(resolve =>
                setTimeout(resolve, 200)
            );

        }

        if (instruments.length) {
            return instruments.length;
        }

    }

    if (
        !force &&
        instruments.length &&
        masterLoadedAt &&
        Date.now() - new Date(masterLoadedAt).getTime()
            < 24 * 60 * 60 * 1000
    ) {

        return instruments.length;

    }

    masterLoading = true;
    masterError = null;

    try {

        const buffer = await fetchBuffer(MASTER_URL);

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

            throw new Error(
                "Instrument master response is not an array"
            );

        }

        const equity = raw.filter(item =>

            item.segment === "NSE_EQ" &&
            item.instrument_type === "EQ" &&
            item.instrument_key &&
            item.trading_symbol

        );

        const fno = new Set();

        for (const item of raw) {

            if (
                item.segment === "NSE_FO" &&
                ["FUT", "CE", "PE"].includes(item.instrument_type) &&
                item.underlying_symbol
            ) {

                fno.add(
                    String(item.underlying_symbol).toUpperCase()
                );

            }

        }

        instruments = equity.map(item => ({

            symbol: String(
                item.trading_symbol
            ).toUpperCase(),

            company:
                item.name || item.trading_symbol,

            instrumentKey:
                item.instrument_key

        }));

        fnoSymbols = fno;

        masterLoadedAt = new Date().toISOString();

        console.log(
            `Instrument master loaded: ${instruments.length} NSE EQ; ${fnoSymbols.size} F&O underlyings`
        );

        return instruments.length;

    } catch (error) {

        masterError = error.message;

        console.error(
            "MASTER LOAD ERROR:",
            error.message
        );

        throw error;

    } finally {

        masterLoading = false;

    }

}

// ======================================
// GET NSE STOCKS
// ======================================

function getStocksForScan(type) {

    const mode = String(type || "FNO").toUpperCase();

    if (!["ALL", "FNO"].includes(mode)) {

        throw new Error(
            "type must be ALL or FNO"
        );

    }

    const list = mode === "FNO"

        ? instruments.filter(item =>
            fnoSymbols.has(item.symbol)
        )

        : instruments;

    return list.slice(0, SCAN_LIMIT);

}

// ======================================
// GET 5 MINUTE CANDLES
// ======================================

async function getFiveMinuteCandles(instrumentKey) {

    const encodedKey = encodeURIComponent(
        instrumentKey
    );

    const result = await upstoxGet(

        `/v3/historical-candle/intraday/${encodedKey}/minutes/5`

    );

    return result?.data?.candles || [];

}

// ======================================
// COMPLETED 5 MIN CANDLES
// ======================================

function completedTodayCandles(raw) {

    const today = istDate(new Date());

    const now = Date.now();

    return raw.map(c => ({

        time: String(c[0]),

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5]),

        oi: Number(c[6] || 0)

    })).filter(c => {

        const timestamp = new Date(c.time).getTime();

        return (

            Number.isFinite(timestamp) &&

            istDate(new Date(timestamp)) === today &&

            timestamp + 5 * 60 * 1000 <= now &&

            [
                c.open,
                c.high,
                c.low,
                c.close,
                c.volume
            ].every(Number.isFinite)

        );

    }).sort((a, b) =>

        new Date(a.time) - new Date(b.time)

    );

}

// ======================================
// EMA
// ======================================

function ema(values, period) {

    if (values.length < period) {
        return null;
    }

    const k = 2 / (period + 1);

    let value = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        value =
            values[i] * k +
            value * (1 - k);

    }

    return value;

}

// ======================================
// RSI
// ======================================

function rsi(values, period = 14) {

    if (values.length <= period) {
        return null;
    }

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            values[i] - values[i - 1];

        if (change > 0) {
            gain += change;
        } else {
            loss -= change;
        }

    }

    let avgGain = gain / period;
    let avgLoss = loss / period;

    for (
        let i = period + 1;
        i < values.length;
        i++
    ) {

        const change =
            values[i] - values[i - 1];

        avgGain =
            (avgGain * (period - 1) +
            Math.max(change, 0)) / period;

        avgLoss =
            (avgLoss * (period - 1) +
            Math.max(-change, 0)) / period;

    }

    if (avgLoss === 0) {
        return 100;
    }

    return 100 - 100 / (
        1 + avgGain / avgLoss
    );

}

// ======================================
// VWAP
// ======================================

function vwap(candles) {

    let pv = 0;
    let volume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        pv += typical * c.volume;

        volume += c.volume;

    }

    return volume > 0
        ? pv / volume
        : null;

}

// ======================================
// ATR
// ======================================

function atr(candles, period = 14) {

    if (candles.length < period + 1) {
        return null;
    }

    const ranges = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const prev = candles[i - 1];

        ranges.push(Math.max(

            c.high - c.low,

            Math.abs(c.high - prev.close),

            Math.abs(c.low - prev.close)

        ));

    }

    const recent = ranges.slice(-period);

    return recent.reduce(
        (a, b) => a + b,
        0
    ) / recent.length;

}// ======================================
// ADX
// ======================================

function adx(candles, period = 14) {

    if (candles.length < period * 2 + 1) {
        return null;
    }

    const tr = [];
    const plus = [];
    const minus = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const p = candles[i - 1];

        const up = c.high - p.high;
        const down = p.low - c.low;

        tr.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        ));

        plus.push(
            up > down && up > 0 ? up : 0
        );

        minus.push(
            down > up && down > 0 ? down : 0
        );

    }

    const dx = [];

    for (
        let i = period - 1;
        i < tr.length;
        i++
    ) {

        const start = i - period + 1;

        const trSum = tr
            .slice(start, i + 1)
            .reduce((a, b) => a + b, 0);

        if (!trSum) continue;

        const pdi =
            100 *
            plus.slice(start, i + 1)
                .reduce((a, b) => a + b, 0) /
            trSum;

        const mdi =
            100 *
            minus.slice(start, i + 1)
                .reduce((a, b) => a + b, 0) /
            trSum;

        dx.push(
            pdi + mdi === 0
                ? 0
                : 100 * Math.abs(pdi - mdi) / (pdi + mdi)
        );

    }

    if (dx.length < period) {
        return null;
    }

    return dx
        .slice(-period)
        .reduce((a, b) => a + b, 0) / period;

}

// ======================================
// ORB CALCULATION
// ======================================

function getOrb(candles) {

    const opening = candles.filter(c =>

        ["09:15", "09:20", "09:25"].includes(
            istTime(new Date(c.time))
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

// ======================================
// STRONG CANDLE
// ======================================

function candleIsStrong(candle, direction) {

    const range =
        candle.high - candle.low;

    if (range <= 0) {
        return false;
    }

    const bodyRatio =
        Math.abs(candle.close - candle.open) / range;

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

// ======================================
// STOCK ANALYSIS
// ======================================

function analyseStock(stock, rawCandles) {

    const candles =
        completedTodayCandles(rawCandles);

    if (candles.length < SETTINGS.minCandles) {
        return null;
    }

    const last = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const ema20 = ema(closes, 20);

    const rsi14 = rsi(closes, 14);

    const sessionVwap = vwap(candles);

    const atr14 = atr(candles, 14);

    const adx14 = adx(candles, 14);

    const orb = getOrb(candles);

    if (
        [ema20, rsi14, sessionVwap, atr14, adx14]
            .some(v => !Number.isFinite(v)) ||
        !orb
    ) {
        return null;
    }

    const previousVolumes =
        candles.slice(-21, -1).map(c => c.volume);

    if (previousVolumes.length !== 20) {
        return null;
    }

    const averageVolume =
        previousVolumes.reduce((a, b) => a + b, 0) / 20;

    const volumeRatio =
        averageVolume > 0
            ? last.volume / averageVolume
            : 0;

    const volumePass =
        volumeRatio >= SETTINGS.volumeMultiplier;

    const adxPass =
        adx14 >= SETTINGS.minAdx;

    const moveRisk =
        Math.max(atr14, last.close * 0.005);

    // BULLISH CONDITIONS

    const bullish =

        last.close > last.open &&

        last.close > ema20 &&

        last.close > sessionVwap &&

        previous.close <= orb.high &&

        last.close > orb.high &&

        rsi14 >= SETTINGS.buyRsi &&

        volumePass &&

        adxPass &&

        candleIsStrong(last, "BUY");

    // BEARISH CONDITIONS

    const bearish =

        last.close < last.open &&

        last.close < ema20 &&

        last.close < sessionVwap &&

        previous.close >= orb.low &&

        last.close < orb.low &&

        rsi14 <= SETTINGS.sellRsi &&

        volumePass &&

        adxPass &&

        candleIsStrong(last, "SELL");

    if (!bullish && !bearish) {
        return null;
    }

    const direction =
        bullish ? "BUY" : "SELL";

    const entry = last.close;

    const stopLoss =
        direction === "BUY"
            ? entry - moveRisk
            : entry + moveRisk;

    const target1 =
        direction === "BUY"
            ? entry + moveRisk * SETTINGS.reward1
            : entry - moveRisk * SETTINGS.reward1;

    const target2 =
        direction === "BUY"
            ? entry + moveRisk * SETTINGS.reward2
            : entry - moveRisk * SETTINGS.reward2;

    return {

        symbol: stock.symbol,

        company: stock.company,

        instrumentKey: stock.instrumentKey,

        signal:
            direction === "BUY"
                ? "STRONG BUY"
                : "STRONG SELL",

        direction,

        price: safeNumber(last.close),

        entry: safeNumber(entry),

        stopLoss: safeNumber(stopLoss),

        target1: safeNumber(target1),

        target2: safeNumber(target2),

        riskReward:
            `1:${SETTINGS.reward1} / 1:${SETTINGS.reward2}`,

        orbHigh: safeNumber(orb.high),

        orbLow: safeNumber(orb.low),

        volumeRatio: safeNumber(volumeRatio),

        volumeBreakout: volumePass,

        rsi: safeNumber(rsi14),

        adx: safeNumber(adx14),

        vwap: safeNumber(sessionVwap),

        ema20: safeNumber(ema20),

        atr: safeNumber(atr14),

        candleTime: last.time,

        timeframe: "5 MIN",

        note:
            "Signal from completed 5-minute candles; estimated levels are not guaranteed."

    };

}

// ======================================
// CONCURRENT SCANNER
// ======================================

async function runPool(items, concurrency, worker) {

    const results = [];

    let next = 0;

    let errors = 0;

    async function runner() {

        while (true) {

            const index = next++;

            if (index >= items.length) {
                return;
            }

            try {

                const result = await worker(items[index]);

                if (result) {
                    results.push(result);
                }

            } catch (error) {

                errors++;

                if (errors <= 5) {

                    console.error(
                        "Individual stock scan error:",
                        error.message
                    );

                }

            }

        }

    }

    await Promise.all(

        Array.from(
            {
                length: Math.min(concurrency, items.length)
            },
            () => runner()
        )

    );

    return {
        results,
        errors
    };

}

// ======================================
// MAIN ORB SCANNER
// ======================================

async function scanStocks(type = "FNO", force = false) {

    const mode = String(type).toUpperCase();

    if (!["ALL", "FNO"].includes(mode)) {

        throw new Error(
            "Invalid scan type. Use ALL or FNO."
        );

    }

    const cacheKey = mode;

    const cached = scanCache.get(cacheKey);

    if (
        !force &&
        cached &&
        Date.now() - cached.createdAt < CACHE_MS
    ) {

        return {
            ...cached.payload,
            cached: true
        };

    }

    await loadInstruments();

    const universe = getStocksForScan(mode);

    const { results, errors } = await runPool(

        universe,

        SCAN_CONCURRENCY,

        async stock => {

            const candles =
                await getFiveMinuteCandles(stock.instrumentKey);

            return analyseStock(stock, candles);

        }

    );

    results.sort((a, b) =>

        (b.volumeRatio * b.adx) -
        (a.volumeRatio * a.adx)

    );

    const payload = {

        success: true,

        type: mode,

        totalStocks: universe.length,

        fnoStocks: fnoSymbols.size,

        totalScanned: universe.length,

        bullish: results.filter(
            x => x.direction === "BUY"
        ).length,

        bearish: results.filter(
            x => x.direction === "SELL"
        ).length,

        totalSignals: results.length,

        scanErrors: errors,

        scanTime: new Date().toISOString(),

        data: results

    };

    lastScanTime = payload.scanTime;

    lastScanError = errors
        ? `${errors} individual instrument request(s) failed`
        : null;

    scanCache.set(cacheKey, {
        createdAt: Date.now(),
        payload
    });

    return {
        ...payload,
        cached: false
    };

}

// ======================================
// HTTP SERVER
// ======================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {

        return sendJson(res, 200, {
            success: true
        });

    }

    const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
    );

    const path = url.pathname;

    try {

        // HEALTH CHECK

        if (
            req.method === "GET" &&
            path === "/health"
        ) {

            return sendJson(res, 200, {

                success: true,

                message:
                    "Smart Trade India ORB V2 backend running",

                time: new Date().toISOString()

            });

        }

        // API STATUS

        if (
            req.method === "GET" &&
            path === "/api/orb/status"
        ) {

            return sendJson(res, 200, {

                success: true,

                apiOnline: true,

                tokenConfigured: Boolean(UPSTOX_TOKEN),

                instrumentsLoaded: instruments.length > 0,

                totalInstruments: instruments.length,

                totalFnoStocks: fnoSymbols.size,

                masterLoading,

                masterLoadedAt,

                masterError,

                lastScanTime,

                lastScanError,

                scanLimit: SCAN_LIMIT,

                scanConcurrency: SCAN_CONCURRENCY

            });

        }

        // REFRESH NSE MASTER

        if (
            req.method === "GET" &&
            path === "/api/orb/refresh-master"
        ) {

            const total = await loadInstruments(true);

            scanCache.clear();

            return sendJson(res, 200, {

                success: true,

                totalInstruments: total,

                totalFnoStocks: fnoSymbols.size,

                masterLoadedAt

            });

        }

        // FULL SCANNER

        if (
            req.method === "GET" &&
            path === "/api/orb/scan"
        ) {

            const type =
                url.searchParams.get("type") || "FNO";

            const force =
                url.searchParams.get("refresh") === "1";

            const result =
                await scanStocks(type, force);

            return sendJson(res, 200, result);

        }

        // BULLISH SIGNALS

        if (
            req.method === "GET" &&
            path === "/api/orb/bullish"
        ) {

            const result =
                await scanStocks("FNO");

            const data = result.data.filter(
                x => x.direction === "BUY"
            );

            return sendJson(res, 200, {

                success: true,

                total: data.length,

                data

            });

        }

        // BEARISH SIGNALS

        if (
            req.method === "GET" &&
            path === "/api/orb/bearish"
        ) {

            const result =
                await scanStocks("FNO");

            const data = result.data.filter(
                x => x.direction === "SELL"
            );

            return sendJson(res, 200, {

                success: true,

                total: data.length,

                data

            });

        }

        // STRONG SIGNALS

        if (
            req.method === "GET" &&
            path === "/api/orb/strong"
        ) {

            const result =
                await scanStocks("FNO");

            return sendJson(res, 200, {

                success: true,

                total: result.data.length,

                data: result.data

            });

        }

        // ROUTE NOT FOUND

        return sendJson(res, 404, {

            success: false,

            error: "API route not found",

            path

        });

    } catch (error) {

        lastScanError = error.message;

        console.error(
            "SERVER ERROR:",
            error
        );

        const status =
            error.message.includes("UPSTOX_ACCESS_TOKEN")
                ? 503
                : 500;

        return sendJson(res, status, {

            success: false,

            error: error.message

        });

    }

});

// ======================================
// START SERVER
// ======================================

server.listen(PORT, () => {

    console.log(
        `SMART TRADE INDIA ORB V2 running on port ${PORT}`
    );

    // Load NSE master in background

    loadInstruments().catch(error =>

        console.error(
            "Startup master load failed:",
            error.message
        )

    );

});
