// ==========================================
// SMART TRADE INDIA
// ORB + VOLUME + SMART MONEY SCANNER
// Node.js 20+
// Upstox V3 API
// 5 Minute Closed Candle Scanner
// ==========================================

"use strict";

const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

// ==========================================
// CONFIGURATION
// ==========================================

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ==========================================
// SCANNER SETTINGS
// ==========================================

const SCAN_LIMIT = Number(
    process.env.ORB_SCAN_LIMIT || 100
);

const REQUEST_GAP_MS = Number(
    process.env.UPSTOX_REQUEST_GAP_MS || 500
);

const VOLUME_MULTIPLIER = 1.5;

const RSI_BUY = 65;

const RSI_SELL = 35;

const ADX_MIN = 20;

const OI_MIN_PERCENT = 0.5;

const ATR_STOP_MULTIPLIER = 1.2;

const RR1 = 2;

const RR2 = 3;

// ==========================================
// CACHE
// ==========================================

const candleCache = new Map();

const dailyCache = new Map();

const scanCache = new Map();

const CANDLE_CACHE_MS = 60000;

const DAILY_CACHE_MS = 21600000;

const SCAN_CACHE_MS = 120000;

// ==========================================
// GLOBAL VARIABLES
// ==========================================

let instruments = [];

let fnoSymbols = new Set();

let futuresByUnderlying = new Map();

let lastMasterUpdate = null;

let masterLoading = false;

let lastScanTime = null;

let lastScanError = null;

let lastRateLimitAt = null;

let requestQueue = Promise.resolve();

let lastRequestAt = 0;

// ==========================================
// HELPERS
// ==========================================

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

const round = n =>
    Number(Number(n).toFixed(2));

function istDate(date = new Date()) {

    return new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }
    ).format(date);
}

function istTime(date) {

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }
    ).format(date);
}

// ==========================================
// JSON RESPONSE
// ==========================================

function sendJson(res, status, data) {

    res.writeHead(status, {

        "Content-Type":
        "application/json; charset=utf-8",

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
        "Content-Type, Authorization"

    });

    res.end(JSON.stringify(data));
}

// ==========================================
// FETCH TIMEOUT
// ==========================================

async function fetchTimeout(
    url,
    options = {},
    timeout = 25000
) {

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

// ==========================================
// UPSTOX REQUEST QUEUE
// ==========================================

function upstoxRequest(path) {

    const task = async () => {

        if (!TOKEN) {

            throw new Error(
                "UPSTOX_ACCESS_TOKEN missing"
            );

        }

        const wait = Math.max(
            0,
            REQUEST_GAP_MS -
            (Date.now() - lastRequestAt)
        );

        if (wait) {

            await sleep(wait);

        }

        for (
            let attempt = 0;
            attempt < 4;
            attempt++
        ) {

            lastRequestAt = Date.now();

            const response = await fetchTimeout(

                API + path,

                {

                    headers: {

                        Accept: "application/json",

                        Authorization:
                        "Bearer " + TOKEN

                    }

                }

            );

            let data;

            try {

                data = await response.json();

            } catch {

                data = {};

            }

            if (response.ok) {

                return data;

            }

            if (
                response.status === 429 ||
                response.status >= 500
            ) {

                if (response.status === 429) {

                    lastRateLimitAt =
                    new Date().toISOString();

                }

                await sleep(
                    Math.min(
                        20000,
                        1200 * (2 ** attempt)
                    )
                );

                continue;

            }

            throw new Error(
                "Upstox API " +
                response.status +
                ": " +
                JSON.stringify(data)
            );

        }

        throw new Error(
            "Upstox retry limit reached"
        );

    };

    const result =
        requestQueue.then(task, task);

    requestQueue =
        result.catch(() => {});

    return result;
}

// ==========================================
// LOAD NSE INSTRUMENT MASTER
// ==========================================

function expiryTime(value) {

    if (!value) {

        return Number.MAX_SAFE_INTEGER;

    }

    const parsed = Date.parse(value);

    return Number.isFinite(parsed)
        ? parsed
        : Number.MAX_SAFE_INTEGER;
}

async function loadInstruments(force = false) {

    if (masterLoading) {

        while (masterLoading) {

            await sleep(150);

        }

        return instruments.length;

    }

    if (
        !force &&
        instruments.length &&
        lastMasterUpdate &&
        Date.now() - lastMasterUpdate <
        86400000
    ) {

        return instruments.length;

    }

    masterLoading = true;

    try {

        const response = await fetchTimeout(
            MASTER_URL,
            {},
            60000
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

        let decoded;

        try {

            decoded = zlib.gunzipSync(buffer);

        } catch {

            decoded = buffer;

        }

        const rows = JSON.parse(
            decoded.toString("utf8")
        );

        if (!Array.isArray(rows)) {

            throw new Error(
                "Invalid instrument master"
            );

        }

        const equities = rows.filter(x =>

            x.segment === "NSE_EQ" &&

            x.instrument_type === "EQ" &&

            x.instrument_key &&

            x.trading_symbol &&

            x.security_type !== "SM"

        );

        const nextFno = new Set();

        const futures = new Map();

        const now = Date.now();

        for (const x of rows) {

            if (
                x.segment !== "NSE_FO" ||
                !x.underlying_symbol
            ) continue;

            if (
                ["FUT", "CE", "PE"].includes(
                    x.instrument_type
                )
            ) {

                nextFno.add(
                    x.underlying_symbol
                );

            }

            if (
                x.instrument_type === "FUT" &&
                expiryTime(x.expiry) >= now
            ) {

                const old =
                    futures.get(x.underlying_symbol);

                if (
                    !old ||
                    expiryTime(x.expiry) <
                    expiryTime(old.expiry)
                ) {

                    futures.set(
                        x.underlying_symbol,
                        x
                    );

                }

            }

        }

        instruments = equities;

        fnoSymbols = nextFno;

        futuresByUnderlying = futures;

        lastMasterUpdate = Date.now();

        console.log(
            "NSE MASTER LOADED:",
            instruments.length,
            "FNO:",
            fnoSymbols.size
        );

        return instruments.length;

    } finally {

        masterLoading = false;

    }

}

// ==========================================
// GET STOCK LIST
// ==========================================

function getStocksForScan(type = "FNO") {

    const mode =
        String(type).toUpperCase();

    if (!["FNO", "ALL"].includes(mode)) {

        throw new Error(
            "Invalid scanner type"
        );

    }

    const list = mode === "FNO"

        ? instruments.filter(x =>
            fnoSymbols.has(x.trading_symbol)
        )

        : instruments;

    return list.slice(0, SCAN_LIMIT).map(x => ({

        symbol: x.trading_symbol,

        instrumentKey: x.instrument_key

    }));

}

// ==========================================
// PREPARE 5 MINUTE CANDLES
// ==========================================

function prepareCandles(raw) {

    const now = Date.now();

    return (raw || []).map(c => ({

        time: c[0],

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5]),

        oi: Number(c[6] || 0)

    })).filter(c => {

        const t =
            new Date(c.time).getTime();

        return (

            Number.isFinite(t) &&

            t + 5 * 60000 <= now &&

            [
                c.open,
                c.high,
                c.low,
                c.close,
                c.volume,
                c.oi
            ].every(Number.isFinite)

        );

    }).sort((a, b) =>

        new Date(a.time) -
        new Date(b.time)

    );

}

// ==========================================
// GET STOCK CANDLES
// ==========================================

async function getStockCandles(stock) {

    const key = stock.instrumentKey;

    const cached = candleCache.get(key);

    if (
        cached &&
        Date.now() - cached.time <
        CANDLE_CACHE_MS
    ) {

        return cached.candles;

    }

    const result = await upstoxRequest(

        "/v3/historical-candle/intraday/" +

        encodeURIComponent(key) +

        "/minutes/5"

    );

    const candles = prepareCandles(
        result?.data?.candles || []
    );

    candleCache.set(key, {

        time: Date.now(),

        candles

    });

    return candles;

}

// ==========================================
// GET DAILY CANDLES
// ==========================================

async function getDailyCandles(stock) {

    const key = stock.instrumentKey;

    const cached = dailyCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < DAILY_CACHE_MS
    ) {
        return cached.candles;
    }

    const to = istDate();

    const from = istDate(
        new Date(Date.now() - 35 * 86400000)
    );

    const result = await upstoxRequest(
        `/v3/historical-candle/${encodeURIComponent(key)}/days/1/${to}/${from}`
    );

    const candles = (result?.data?.candles || [])
        .map(c => ({
            time: c[0],
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5]),
            oi: Number(c[6] || 0)
        }))
        .filter(c =>
            [
                c.open,
                c.high,
                c.low,
                c.close
            ].every(Number.isFinite)
        )
        .sort((a, b) =>
            new Date(a.time) - new Date(b.time)
        );

    dailyCache.set(key, {
        time: Date.now(),
        candles
    });

    return candles;
}

// ==========================================
// FUTURES OI CANDLES
// ==========================================

async function getFutureCandles(symbol) {

    const future = futuresByUnderlying.get(symbol);

    if (!future?.instrument_key) return [];

    const key = future.instrument_key;

    const cacheKey = "FUT:" + key;

    const cached = candleCache.get(cacheKey);

    if (
        cached &&
        Date.now() - cached.time < CANDLE_CACHE_MS
    ) {
        return cached.candles;
    }

    const result = await upstoxRequest(
        `/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/5`
    );

    const candles = prepareCandles(
        result?.data?.candles || []
    );

    candleCache.set(cacheKey, {
        time: Date.now(),
        candles
    });

    return candles;
}

// ==========================================
// ORB CALCULATION
// ==========================================

function calculateORB(candles) {

    const opening = candles.filter(c => {

        const time = istTime(new Date(c.time));

        return [
            "09:15",
            "09:20",
            "09:25"
        ].includes(time);

    });

    if (opening.length !== 3) return null;

    return {

        high: Math.max(
            ...opening.map(c => c.high)
        ),

        low: Math.min(
            ...opening.map(c => c.low)
        )

    };
}

// ==========================================
// EMA
// ==========================================

function calculateEMA(values, period) {

    if (values.length < period) return null;

    const k = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        ema =
            values[i] * k +
            ema * (1 - k);

    }

    return ema;
}

// ==========================================
// RSI
// ==========================================

function calculateRSI(values, period = 14) {

    if (values.length <= period) return null;

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const d = values[i] - values[i - 1];

        if (d > 0) gain += d;
        else loss -= d;

    }

    let avgGain = gain / period;
    let avgLoss = loss / period;

    for (let i = period + 1; i < values.length; i++) {

        const d = values[i] - values[i - 1];

        avgGain =
            (avgGain * 13 + Math.max(d, 0)) / 14;

        avgLoss =
            (avgLoss * 13 + Math.max(-d, 0)) / 14;

    }

    if (avgLoss === 0) return 100;

    return 100 - 100 / (1 + avgGain / avgLoss);
}

// ==========================================
// VWAP
// ==========================================

function calculateVWAP(candles) {

    let pv = 0;
    let volume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        pv += typical * c.volume;

        volume += c.volume;

    }

    return volume > 0 ? pv / volume : null;
}

// ==========================================
// ATR
// ==========================================

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) return null;

    const tr = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const p = candles[i - 1];

        tr.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        ));

    }

    const values = tr.slice(-period);

    return values.reduce((a, b) => a + b, 0)
        / values.length;
}

// ==========================================
// ADX
// ==========================================

function calculateADX(candles, period = 14) {

    if (candles.length < period * 2 + 1) return null;

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

        plus.push(up > down && up > 0 ? up : 0);

        minus.push(down > up && down > 0 ? down : 0);

    }

    const dx = [];

    for (let i = period - 1; i < tr.length; i++) {

        let sumTR = 0;
        let sumP = 0;
        let sumM = 0;

        for (let j = i - period + 1; j <= i; j++) {

            sumTR += tr[j];
            sumP += plus[j];
            sumM += minus[j];

        }

        if (!sumTR) continue;

        const pdi = 100 * sumP / sumTR;
        const mdi = 100 * sumM / sumTR;

        dx.push(
            pdi + mdi === 0
                ? 0
                : 100 * Math.abs(pdi - mdi) / (pdi + mdi)
        );

    }

    if (dx.length < period) return null;

    let adx = dx
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < dx.length; i++) {

        adx = (adx * (period - 1) + dx[i]) / period;

    }

    return adx;
}

// ==========================================
// CANDLE STRENGTH
// ==========================================

function candleStrength(c, direction) {

    const range = c.high - c.low;

    if (range <= 0) return false;

    const body =
        Math.abs(c.close - c.open) / range;

    if (direction === "BUY") {

        return (
            c.close > c.open &&
            body >= 0.60 &&
            (c.high - c.close) / range <= 0.20
        );

    }

    return (
        c.close < c.open &&
        body >= 0.60 &&
        (c.close - c.low) / range <= 0.20
    );
}

// ==========================================
// ADR14
// ==========================================

function calculateADR(daily, price) {

    const completed = daily
        .filter(c =>
            istDate(new Date(c.time)) !== istDate()
        )
        .slice(-14);

    if (completed.length < 10) return null;

    const avg = completed.reduce(
        (s, c) => s + c.high - c.low,
        0
    ) / completed.length;

    return {

        points: avg,

        percent: avg / price * 100,

        days: completed.length

    };
}

// ==========================================
// TRADE CALCULATION
// ==========================================

function calculateTrade(direction, price, atr) {

    const risk = Math.max(
        atr * ATR_STOP_MULTIPLIER,
        price * 0.003
    );

    if (direction === "BUY") {

        return {

            entry: round(price),

            stopLoss: round(price - risk),

            target1: round(price + risk * RR1),

            target2: round(price + risk * RR2)

        };

    }

    return {

        entry: round(price),

        stopLoss: round(price + risk),

        target1: round(price - risk * RR1),

        target2: round(price - risk * RR2)

    };
}

// ==========================================
// TECHNICAL ANALYSIS
// ==========================================

function analyseTechnical(stock, candles, daily) {

    if (!candles || candles.length < 35) return null;

    const last = candles[candles.length - 1];

    const prev = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const ema20 = calculateEMA(closes, 20);

    const rsi = calculateRSI(closes, 14);

    const vwap = calculateVWAP(candles);

    const atr = calculateATR(candles, 14);

    const adx = calculateADX(candles, 14);

    const orb = calculateORB(candles);

    if (
        ![ema20, rsi, vwap, atr, adx].every(Number.isFinite) ||
        !orb
    ) return null;

    const vols = candles
        .slice(-21, -1)
        .map(c => c.volume);

    const avgVol = vols.reduce((a, b) => a + b, 0) / 20;

    const volumeRatio = avgVol > 0
        ? last.volume / avgVol
        : 0;

    const adr = calculateADR(daily, last.close);

    if (!adr) return null;

    const buffer = Math.max(
        atr * 0.10,
        last.close * 0.0005
    );

    const bull =

        last.close > orb.high + buffer &&

        prev.close <= orb.high &&

        last.close > ema20 &&

        last.close > vwap &&

        rsi >= RSI_BUY &&

        adx >= ADX_MIN &&

        volumeRatio >= VOLUME_MULTIPLIER &&

        candleStrength(last, "BUY");

    const bear =

        last.close < orb.low - buffer &&

        prev.close >= orb.low &&

        last.close < ema20 &&

        last.close < vwap &&

        rsi <= RSI_SELL &&

        adx >= ADX_MIN &&

        volumeRatio >= VOLUME_MULTIPLIER &&

        candleStrength(last, "SELL");

    if (!bull && !bear) return null;

    return {

        direction: bull ? "BUY" : "SELL",

        last,

        orb,

        ema20,

        rsi,

        vwap,

        atr,

        adx,

        volumeRatio,

        adr

    };
}

// ==========================================
// FUTURES OI CONFIRMATION
// ==========================================

async function addOICheck(symbol) {

    const candles = await getFutureCandles(symbol);

    if (candles.length < 2) {

        return {
            pass: false,
            reason: "Futures OI unavailable"
        };

    }

    const last = candles[candles.length - 1];

    const prev = candles[candles.length - 2];

    const change = last.oi - prev.oi;

    const pct = prev.oi > 0
        ? change / prev.oi * 100
        : 0;

    return {

        pass:
            change > 0 &&
            pct >= OI_MIN_PERCENT,

        oi: last.oi,

        previousOI: prev.oi,

        oiChangePercent: round(pct)

    };
}

// ==========================================
// SMART MONEY SCANNER
// ==========================================

async function analyseStock(stock) {

    const candles = await getStockCandles(stock);

    const daily = await getDailyCandles(stock);

    const technical = analyseTechnical(
        stock,
        candles,
        daily
    );

    if (!technical) return null;

    const oi = await addOICheck(stock.symbol);

    if (!oi.pass) return null;

    const t = technical;

    const score = Math.min(
        100,
        Math.round(
            25 +
            Math.min(25, (t.volumeRatio - 1) * 12) +
            Math.min(20, (t.adx - 15) * 1.2) +
            15
        )
    );

    return {

        symbol: stock.symbol,

        signal: t.direction,

        strength: score >= 80
            ? "VERY STRONG " + t.direction
            : "STRONG " + t.direction,

        smartMoney: {

            score,

            label: "PRICE + VOLUME + OI PROXY",

            confirmation:
                "Not verified institutional order flow"

        },

        price: round(t.last.close),

        candleTime: t.last.time,

        timeframe: "5 MIN CLOSED CANDLE",

        indicators: {

            rsi: round(t.rsi),

            adx: round(t.adx),

            ema20: round(t.ema20),

            vwap: round(t.vwap),

            atr: round(t.atr),

            volumeRatio: round(t.volumeRatio),

            adr14Percent: round(t.adr.percent)

        },

        orb: {

            high: round(t.orb.high),

            low: round(t.orb.low)

        },

        oi,

        trade: calculateTrade(
            t.direction,
            t.last.close,
            t.atr
        ),

        fakeBreakoutFilter: {

            passed: true,

            checks: [
                "ORB breakout",
                "Strong candle",
                "Volume expansion",
                "VWAP confirmation",
                "EMA confirmation",
                "RSI confirmation",
                "ADX confirmation",
                "Futures OI increase"
            ]

        }

    };
}

// ==========================================
// RUN CONCURRENT SCAN
// ==========================================

async function runConcurrent(items, worker) {

    const results = [];

    for (const item of items) {

        try {

            const result = await worker(item);

            if (result) results.push(result);

        } catch (error) {

            console.error(
                "SCAN ERROR:",
                item.symbol,
                error.message
            );

        }

    }

    return results;
}

// ==========================================
// MAIN SCANNER
// ==========================================

async function scanOrbStocks(type = "FNO", force = false) {

    if (!instruments.length) {

        await loadInstruments();

    }

    const mode = String(type).toUpperCase();

    const cacheKey =
        mode + "_" + Math.floor(Date.now() / SCAN_CACHE_MS);

    if (!force && scanCache.has(cacheKey)) {

        return scanCache.get(cacheKey);

    }

    const stocks = getStocksForScan(mode);

    const signals = await runConcurrent(
        stocks,
        analyseStock
    );

    signals.sort((a, b) =>
        b.smartMoney.score - a.smartMoney.score
    );

    const result = {

        success: true,

        type: mode,

        totalUniverse:
            mode === "FNO"
                ? fnoSymbols.size
                : instruments.length,

        totalScanned: stocks.length,

        totalSignals: signals.length,

        scanTime: new Date().toISOString(),

        signals

    };

    scanCache.set(cacheKey, result);

    lastScanTime = result.scanTime;

    lastScanError = null;

    return result;
}

// ==========================================
// HTTP SERVER
// ==========================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {

        res.writeHead(204, {

            "Access-Control-Allow-Origin": "*",

            "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",

            "Access-Control-Allow-Headers":
            "Content-Type, Authorization"

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

                message: "SMART TRADE INDIA RUNNING"

            });

        }

        // STATUS

        if (path === "/api/orb/status") {

            return sendJson(res, 200, {

                success: true,

                tokenConfigured: Boolean(TOKEN),

                instrumentsLoaded:
                    instruments.length > 0,

                totalInstruments:
                    instruments.length,

                totalFnoSymbols:
                    fnoSymbols.size,

                totalFutures:
                    futuresByUnderlying.size,

                lastMasterLoad:
                    lastMasterUpdate,

                lastScanTime,

                lastScanError,

                lastRateLimitAt,

                scanLimit: SCAN_LIMIT,

                settings: {

                    VOLUME_MULTIPLIER,

                    RSI_BUY,

                    RSI_SELL,

                    ADX_MIN,

                    OI_MIN_PERCENT

                }

            });

        }

        // REFRESH MASTER

        if (path === "/api/orb/refresh-master") {

            const total =
                await loadInstruments(true);

            scanCache.clear();

            return sendJson(res, 200, {

                success: true,

                totalInstruments: total,

                totalFnoSymbols: fnoSymbols.size,

                totalFutures:
                    futuresByUnderlying.size

            });

        }

        // STOCK LIST

        if (path === "/api/orb/stocks") {

            if (!instruments.length) {

                await loadInstruments();

            }

            const stocks = getStocksForScan(
                url.searchParams.get("type") || "FNO"
            );

            return sendJson(res, 200, {

                success: true,

                total: stocks.length,

                stocks

            });

        }

        // FULL SCAN

        if (path === "/api/orb/scan") {

            const result = await scanOrbStocks(

                url.searchParams.get("type") || "FNO",

                url.searchParams.get("refresh") === "1"

            );

            return sendJson(res, 200, result);

        }

        // BULLISH / BEARISH

        if (
            path === "/api/orb/bullish" ||
            path === "/api/orb/bearish"
        ) {

            const result = await scanOrbStocks("FNO");

            const direction =
                path.endsWith("bullish")
                    ? "BUY"
                    : "SELL";

            const signals = result.signals.filter(
                x => x.signal === direction
            );

            return sendJson(res, 200, {

                success: true,

                total: signals.length,

                signals

            });

        }

        // STRONG SIGNALS

        if (path === "/api/orb/strong") {

            const result = await scanOrbStocks("FNO");

            const signals = result.signals.filter(
                x => x.smartMoney.score >= 80
            );

            return sendJson(res, 200, {

                success: true,

                total: signals.length,

                signals

            });

        }

        // NOT FOUND

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

        return sendJson(res, 500, {

            success: false,

            error: error.message

        });

    }

});

// ==========================================
// START SERVER
// ==========================================

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA SERVER RUNNING ON PORT " +
        PORT
    );

});
