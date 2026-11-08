// SMART TRADE INDIA - ORB + VOLUME + SMART MONEY + OI SCANNER
// Node.js 20+ | Upstox V3 | Closed 5-minute candles only
// Smart-money is a price/volume/OI proxy, NOT verified institutional order-flow.

"use strict";

const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// SETTINGS

const SCAN_LIMIT = Math.max(
    1,
    Number(process.env.ORB_SCAN_LIMIT || 5000)
);

const REQUEST_GAP_MS = Math.max(
    350,
    Number(process.env.UPSTOX_REQUEST_GAP_MS || 500)
);

const VOLUME_MULTIPLIER = Number(process.env.VOLUME_MULTIPLIER || 2);

const RSI_BUY = Number(process.env.RSI_BUY || 65);
const RSI_SELL = Number(process.env.RSI_SELL || 35);

const ADX_MIN = Number(process.env.ADX_MIN || 20);

const ADR_MIN_PERCENT = Number(process.env.ADR_MIN_PERCENT || 2.0);

const OI_MIN_PERCENT = Number(process.env.OI_MIN_PERCENT || 0.5);

const ATR_STOP_MULTIPLIER = Number(process.env.ATR_STOP_MULTIPLIER || 1.2);

const RR1 = Number(process.env.RR1 || 2);
const RR2 = Number(process.env.RR2 || 3);

const CANDLE_CACHE_MS = 60000;
const DAILY_CACHE_MS = 6 * 60 * 60 * 1000;
const SCAN_CACHE_MS = 2 * 60 * 1000;

const MAX_EQUITY_POSITIONS = 2;
const MAX_OPTION_POSITIONS = 2;

// GLOBAL VARIABLES

let instruments = [];
let fnoSymbols = new Set();
let futuresByUnderlying = new Map();

let lastMasterUpdate = null;
let masterLoading = false;

let lastScanTime = null;
let lastScanError = null;
let lastRateLimitAt = null;

const candleCache = new Map();
const dailyCache = new Map();
const scanCache = new Map();

const positions = {
    equity: [],
    options: []
};

let requestQueue = Promise.resolve();
let lastRequestAt = 0;

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

const round = n =>
    Number(Number(n).toFixed(2));

// TIME HELPERS

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

// JSON RESPONSE

function sendJson(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    res.end(JSON.stringify(data));

}

// FETCH TIMEOUT

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

// UPSTOX API RATE LIMIT PROTECTION

function upstoxRequest(path, timeout = 25000) {

    const task = async () => {

        if (!TOKEN) {
            throw new Error(
                "UPSTOX_ACCESS_TOKEN environment variable is missing"
            );
        }

        const wait = Math.max(
            0,
            REQUEST_GAP_MS - (Date.now() - lastRequestAt)
        );

        if (wait) await sleep(wait);

        for (let attempt = 0; attempt < 4; attempt++) {

            lastRequestAt = Date.now();

            const response = await fetchTimeout(
                API + path,
                {
                    headers: {
                        Accept: "application/json",
                        Authorization: "Bearer " + TOKEN
                    }
                },
                timeout
            );

            let data;

            try {
                data = await response.json();
            } catch {
                data = {
                    message: "Invalid JSON response"
                };
            }

            if (response.ok) return data;

            if (
                response.status === 429 ||
                response.status >= 500
            ) {

                if (response.status === 429) {
                    lastRateLimitAt = new Date().toISOString();
                }

                const retryAfter = Number(
                    response.headers.get("retry-after")
                );

                await sleep(
                    retryAfter > 0
                        ? retryAfter * 1000
                        : Math.min(20000, 1200 * (2 ** attempt))
                );

                continue;
            }

            throw new Error(
                `Upstox API ${response.status}: ${JSON.stringify(data)}`
            );

        }

        throw new Error(
            "Upstox rate limit/server error: retry limit reached"
        );

    };

    const result = requestQueue.then(task, task);

    requestQueue = result.catch(() => {});

    return result;

}

// LOAD NSE INSTRUMENT MASTER

function expiryTime(value) {

    if (value == null) return Number.MAX_SAFE_INTEGER;

    if (typeof value === "number") {
        return value > 1e12 ? value : value * 1000;
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

        if (instruments.length) return instruments.length;

    }

    if (
        !force &&
        instruments.length &&
        lastMasterUpdate &&
        Date.now() - lastMasterUpdate < 86400000
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
                `Instrument master download failed: ${response.status}`
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
            throw new Error("Invalid instrument master format");
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
                ["FUT", "CE", "PE"].includes(x.instrument_type)
            ) {
                nextFno.add(x.underlying_symbol);
            }

            if (
                x.instrument_type === "FUT" &&
                expiryTime(x.expiry) >= now
            ) {

                const old = futures.get(x.underlying_symbol);

                if (
                    !old ||
                    expiryTime(x.expiry) < expiryTime(old.expiry)
                ) {
                    futures.set(x.underlying_symbol, x);
                }

            }

        }

        instruments = equities;
        fnoSymbols = nextFno;
        futuresByUnderlying = futures;

        lastMasterUpdate = Date.now();

        console.log(
            `Instrument master loaded: ${instruments.length} NSE_EQ; ${fnoSymbols.size} F&O underlyings; ${futuresByUnderlying.size} futures`
        );

        return instruments.length;

    } finally {

        masterLoading = false;

    }

}

// GET NSE STOCKS

function getStocksForScan(type = "FNO") {

    const mode = String(type).toUpperCase();

    if (!["FNO", "ALL"].includes(mode)) {
        throw new Error("type must be FNO or ALL");
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

// PREPARE CANDLES

function prepareCandles(raw, onlyToday = true) {

    const today = istDate();
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

        const t = new Date(c.time).getTime();

        return (
            Number.isFinite(t) &&
            (!onlyToday || istDate(new Date(t)) === today) &&
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
        new Date(a.time) - new Date(b.time)
    );

}

// GET STOCK CANDLES

async function getStockCandles(stock) {

    const key = stock.instrumentKey;

    const cached = candleCache.get(key);

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
        result?.data?.candles || [],
        true
    );

    candleCache.set(key, {
        time: Date.now(),
        candles
    });

    return candles;

}

// DAILY CANDLES FOR ADR14

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

    const fromDate = new Date(
        Date.now() - 35 * 86400000
    );

    const from = istDate(fromDate);

    const result = await upstoxRequest(
        `/v3/historical-candle/${encodeURIComponent(key)}/days/1/${to}/${from}`
    );

    const candles = (
        result?.data?.candles || []
    ).map(c => ({

        time: c[0],
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
        oi: Number(c[6] || 0)

    })).filter(c =>
        [
            c.open,
            c.high,
            c.low,
            c.close
        ].every(Number.isFinite)
    ).sort((a, b) =>
        new Date(a.time) - new Date(b.time)
    );

    dailyCache.set(key, {
        time: Date.now(),
        candles
    });

    return candles;

}

// GET FUTURES OI CANDLES

async function getFutureCandles(symbol) {

    const future = futuresByUnderlying.get(symbol);

    if (!future?.instrument_key) return [];

    const key = future.instrument_key;

    const cached = candleCache.get("FUT:" + key);

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
        result?.data?.candles || [],
        true
    );

    candleCache.set("FUT:" + key, {
        time: Date.now(),
        candles
    });

    return candles;

}

// ORB CALCULATION

function calculateORB(candles) {

    const opening = candles.filter(c =>
        ["09:15", "09:20", "09:25"].includes(
            istTime(new Date(c.time))
        )
    );

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

// EMA

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

// RSI

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
            (avgGain * (period - 1) + Math.max(d, 0)) / period;

        avgLoss =
            (avgLoss * (period - 1) + Math.max(-d, 0)) / period;

    }

    if (avgLoss === 0) return 100;

    return 100 - 100 / (1 + avgGain / avgLoss);

}

// VWAP

function calculateVWAP(candles) {

    let pv = 0;
    let vol = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        pv += typical * c.volume;
        vol += c.volume;

    }

    return vol > 0 ? pv / vol : null;

}

// ATR

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

    const a = tr.slice(-period);

    return a.reduce((x, y) => x + y, 0) / a.length;

}

// ADX

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

        const start = i - period + 1;

        let sumTR = 0;
        let sumP = 0;
        let sumM = 0;

        for (let j = start; j <= i; j++) {

            sumTR += tr[j];
            sumP += plus[j];
            sumM += minus[j];

        }

        if (sumTR === 0) continue;

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
        adx = ((adx * (period - 1)) + dx[i]) / period;
    }

    return adx;

}

// CANDLE STRENGTH

function candleStrength(c, direction) {

    const range = c.high - c.low;

    if (range <= 0) return false;

    const body = Math.abs(c.close - c.open) / range;

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

// ADR14

function calculateADR(dailyCandles, price) {

    const completed = dailyCandles
        .filter(c =>
            istDate(new Date(c.time)) !== istDate()
        )
        .slice(-14);

    if (completed.length < 10 || !price) return null;

    const avg = completed.reduce(
        (s, c) => s + (c.high - c.low), 0
    ) / completed.length;

    return {
        points: avg,
        percent: avg / price * 100,
        days: completed.length
    };

}

// ENTRY SL TARGET

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
            target2: round(price + risk * RR2),
            riskPoints: round(risk),
            riskReward1: `1:${RR1}`,
            riskReward2: `1:${RR2}`

        };

    }

    return {

        entry: round(price),
        stopLoss: round(price + risk),
        target1: round(price - risk * RR1),
        target2: round(price - risk * RR2),
        riskPoints: round(risk),
        riskReward1: `1:${RR1}`,
        riskReward2: `1:${RR2}`

    };

}

// TECHNICAL ANALYSIS

function analyseTechnical(stock, candles, dailyCandles) {

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

    if (vols.length !== 20) return null;

    const avgVol = vols.reduce((a, b) => a + b, 0) / 20;

    const volumeRatio = avgVol > 0
        ? last.volume / avgVol
        : 0;

    const adr = calculateADR(dailyCandles, last.close);

    if (!adr) return null;

    const breakoutBuffer = Math.max(
        atr * 0.10,
        last.close * 0.0005
    );

    // BULLISH

    const bull =
        last.close > orb.high + breakoutBuffer &&
        prev.close <= orb.high &&
        last.close > ema20 &&
        last.close > vwap &&
        rsi >= RSI_BUY &&
        adx >= ADX_MIN &&
        volumeRatio >= VOLUME_MULTIPLIER &&
        adr.percent >= ADR_MIN_PERCENT &&
        candleStrength(last, "BUY");

    // BEARISH

    const bear =
        last.close < orb.low - breakoutBuffer &&
        prev.close >= orb.low &&
        last.close < ema20 &&
        last.close < vwap &&
        rsi <= RSI_SELL &&
        adx >= ADX_MIN &&
        volumeRatio >= VOLUME_MULTIPLIER &&
        adr.percent >= ADR_MIN_PERCENT &&
        candleStrength(last, "SELL");

    if (!bull && !bear) return null;

    return {
        direction: bull ? "BUY" : "SELL",
        last,
        prev,
        orb,
        ema20,
        rsi,
        vwap,
        atr,
        adx,
        volumeRatio,
        adr,
        breakoutBuffer
    };

}

// FUTURES OI INCREASE

async function addOICheck(symbol) {

    const candles = await getFutureCandles(symbol);

    if (candles.length < 2) {

        return {
            pass: false,
            reason: "Futures OI candles unavailable",
            oi: null,
            oiChangePercent: null
        };

    }

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const change = last.oi - prev.oi;

    const pct = prev.oi > 0
        ? change / prev.oi * 100
        : 0;

    return {

        pass: change > 0 && pct >= OI_MIN_PERCENT,

        oi: last.oi,
        previousOI: prev.oi,
        oiChange: change,
        oiChangePercent: round(pct),
        oiCandleTime: last.time,

        reason: change > 0
            ? "OI increased"
            : "OI did not increase"

    };

}

// SMART MONEY ANALYSIS

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
    const dir = t.direction;

    const smartMoneyScore = Math.min(
        100,
        Math.round(
            25 +
            Math.min(25, (t.volumeRatio - 1) * 12) +
            Math.min(20, (t.adx - 15) * 1.2) +
            Math.min(15, Math.max(0, oi.oiChangePercent) * 3) +
            15
        )
    );

    return {

        symbol: stock.symbol,
        instrumentKey: stock.instrumentKey,

        signal: dir,

        strength: smartMoneyScore >= 80
            ? `VERY STRONG ${dir}`
            : `STRONG ${dir}`,

        smartMoney: {
            score: smartMoneyScore,
            label: "VOLUME + PRICE STRENGTH + FUTURES OI PROXY",
            confirmation: "Not direct institutional order-flow data"
        },

        price: round(t.last.close),

        candleTime: t.last.time,

        timeframe: "5 MIN - CLOSED CANDLE",

        indicators: {

            rsi: round(t.rsi),
            adx: round(t.adx),
            ema20: round(t.ema20),
            vwap: round(t.vwap),
            atr: round(t.atr),
            volumeRatio: round(t.volumeRatio),
            adr14Points: round(t.adr.points),
            adr14Percent: round(t.adr.percent)

        },

        orb: {

            high: round(t.orb.high),
            low: round(t.orb.low),
            breakoutBuffer: round(t.breakoutBuffer)

        },

        oi: { ...oi },

        trade: calculateTrade(
            dir,
            t.last.close,
            t.atr
        ),

        fakeBreakoutFilter: {

            passed: true,

            checks: [
                "previous candle was not beyond ORB",
                "closed candle cleared ORB buffer",
                "strong candle body and close location",
                "volume expansion",
                "VWAP and EMA alignment",
                "ADX and RSI confirmation",
                "futures OI increase"
            ]

        },

        note: "Signal is a scanner alert, not a guaranteed trade. Confirm liquidity, spread and risk before placing an order."

    };

}

// CONCURRENT SCANNER

async function runConcurrent(items, limit, worker) {

    const results = [];

    let index = 0;

    async function runner() {

        while (index < items.length) {

            const item = items[index++];

            try {

                const value = await worker(item);

                if (value) results.push(value);

            } catch (error) {

                console.error(
                    `Scan error ${item.symbol}: ${error.message}`
                );

            }

        }

    }

    await Promise.all(
        Array.from(
            { length: Math.min(limit, items.length) },
            runner
        )
    );

    return results;

}

// ORB SCANNER

async function scanOrbStocks(type = "FNO", force = false) {

    const mode = String(type).toUpperCase();

    const bucket = Math.floor(
        Date.now() / SCAN_CACHE_MS
    );

    const cacheKey = `${mode}_${bucket}`;

    if (!force && scanCache.has(cacheKey)) {
        return scanCache.get(cacheKey);
    }

    if (!instruments.length) {
        await loadInstruments();
    }

    const stocks = getStocksForScan(mode);

    const signals = await runConcurrent(
        stocks,
        1,
        analyseStock
    );

    signals.sort((a, b) =>
        b.smartMoney.score - a.smartMoney.score ||
        b.indicators.volumeRatio - a.indicators.volumeRatio
    );

    const result = {

        success: true,

        type: mode,

        totalUniverse: mode === "FNO"
            ? fnoSymbols.size
            : instruments.length,

        totalScanned: stocks.length,

        totalSignals: signals.length,

        scanTime: new Date().toISOString(),

        settings: {
            volumeMultiplier: VOLUME_MULTIPLIER,
            rsiBuy: RSI_BUY,
            rsiSell: RSI_SELL,
            adxMin: ADX_MIN,
            adrMinPercent: ADR_MIN_PERCENT,
            oiMinPercent: OI_MIN_PERCENT
        },

        signals

    };

    scanCache.set(cacheKey, result);

    lastScanTime = result.scanTime;
    lastScanError = null;

    return result;

}

// FILTER SIGNALS

function filterSignals(signals, direction) {

    return signals.filter(
        x => x.signal === direction
    );

}

// READ REQUEST BODY

function readBody(req) {

    return new Promise((resolve, reject) => {

        let body = "";

        req.on("data", chunk => {

            body += chunk;

            if (body.length > 1000000) {
                reject(new Error("Request body too large"));
            }

        });

        req.on("end", () => {

            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON body"));
            }

        });

        req.on("error", reject);

    });

}

// POSITIONS

function addPosition(type, data) {

    if (!positions[type]) {
        throw new Error("Invalid position type");
    }

    const open = positions[type].filter(
        p => p.status === "OPEN"
    );

    const max = type === "equity"
        ? MAX_EQUITY_POSITIONS
        : MAX_OPTION_POSITIONS;

    if (open.length >= max) {
        throw new Error(`Maximum ${type} positions reached`);
    }

    const entryPrice = Number(data.entryPrice);
    const quantity = Number(data.quantity || 1);

    if (
        !data.symbol ||
        !Number.isFinite(entryPrice) ||
        entryPrice <= 0 ||
        !Number.isFinite(quantity) ||
        quantity <= 0
    ) {
        throw new Error(
            "Valid symbol, entryPrice and quantity are required"
        );
    }

    const p = {

        id: Date.now().toString(36) +
            Math.random().toString(36).slice(2, 8),

        type,
        symbol: String(data.symbol),

        direction: data.direction === "SELL"
            ? "SELL"
            : "BUY",

        entryPrice,
        quantity,
        status: "OPEN",
        createdAt: new Date().toISOString()

    };

    positions[type].push(p);

    return p;

}

function closePosition(type, id) {

    const p = positions[type]?.find(
        x => x.id === id && x.status === "OPEN"
    );

    if (!p) return null;

    p.status = "CLOSED";
    p.closedAt = new Date().toISOString();

    return p;

}

// HTTP SERVER

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {

        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
        });

        return res.end();

    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    try {

        // HEALTH

        if (
            req.method === "GET" &&
            path === "/health"
        ) {

            return sendJson(res, 200, {
                success: true,
                message: "Smart Trade India ORB + Smart Money scanner running",
                time: new Date().toISOString()
            });

        }

        // STATUS

        if (
            req.method === "GET" &&
            path === "/api/orb/status"
        ) {

            return sendJson(res, 200, {

                success: true,

                tokenConfigured: Boolean(TOKEN),

                instrumentsLoaded: instruments.length > 0,

                totalInstruments: instruments.length,

                totalFnoSymbols: fnoSymbols.size,

                totalFutures: futuresByUnderlying.size,

                lastMasterLoad: lastMasterUpdate
                    ? new Date(lastMasterUpdate).toISOString()
                    : null,

                lastScanTime,
                lastScanError,
                lastRateLimitAt,

                scanLimit: SCAN_LIMIT,
                requestGapMs: REQUEST_GAP_MS,

                settings: {
                    VOLUME_MULTIPLIER,
                    RSI_BUY,
                    RSI_SELL,
                    ADX_MIN,
                    ADR_MIN_PERCENT,
                    OI_MIN_PERCENT
                }

            });

        }

        // REFRESH MASTER

        if (
            req.method === "GET" &&
            path === "/api/orb/refresh-master"
        ) {

            const total = await loadInstruments(true);

            scanCache.clear();

            return sendJson(res, 200, {

                success: true,
                totalInstruments: total,
                totalFnoSymbols: fnoSymbols.size,
                totalFutures: futuresByUnderlying.size

            });

        }

        // STOCK LIST

        if (
            req.method === "GET" &&
            path === "/api/orb/stocks"
        ) {

            if (!instruments.length) {
                await loadInstruments();
            }

            const stocks = getStocksForScan(
                url.searchParams.get("type") || "FNO"
            );

            return sendJson(res, 200, {
                success: true,
                total: stocks.length,
                totalFnoSymbols: fnoSymbols.size,
                stocks
            });

        }

        // FULL SCAN

        if (
            req.method === "GET" &&
            path === "/api/orb/scan"
        ) {

            const result = await scanOrbStocks(
                url.searchParams.get("type") || "FNO",
                url.searchParams.get("refresh") === "1"
            );

            return sendJson(res, 200, result);

        }

        // BULLISH / BEARISH / STRONG

        if (
            req.method === "GET" &&
            [
                "/api/orb/bullish",
                "/api/orb/bearish",
                "/api/orb/strong"
            ].includes(path)
        ) {

            const result = await scanOrbStocks(
                "FNO",
                url.searchParams.get("refresh") === "1"
            );

            const signals = path.endsWith("bullish")
                ? filterSignals(result.signals, "BUY")
                : path.endsWith("bearish")
                    ? filterSignals(result.signals, "SELL")
                    : result.signals;

            return sendJson(res, 200, {
                success: true,
                total: signals.length,
                signals
            });

        }

        // GET POSITIONS

        if (
            req.method === "GET" &&
            path === "/api/positions"
        ) {

            return sendJson(res, 200, {
                success: true,
                positions
            });

        }

        // ADD POSITION

        if (
            req.method === "POST" &&
            [
                "/api/positions/equity",
                "/api/positions/options"
            ].includes(path)
        ) {

            const type = path.endsWith("equity")
                ? "equity"
                : "options";

            const position = addPosition(
                type,
                await readBody(req)
            );

            return sendJson(res, 201, {
      success: true,
                position
            });

        }

        // CLOSE POSITION

        const match = path.match(
            /^\/api\/positions\/(equity|options)\/([^/]+)\/close$/
        );

        if (
            req.method === "POST" &&
            match
        ) {

            const position = closePosition(
                match[1],
                match[2]
            );

            if (!position) {
                return sendJson(res, 404, {
                    success: false,
                    message: "Open position not found"
                });
            }

            return sendJson(res, 200, {
                success: true,
                position
            });

        }

        // ROUTE NOT FOUND

        return sendJson(res, 404, {
            success: false,
            message: "API route not found",
            path
        });

    } catch (error) {

        lastScanError = error.message;

        console.error("SERVER ERROR:", error);

        return sendJson(res, 500, {
            success: false,
            error: error.message
        });

    }

});

// START SERVER

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA ORB + SMART MONEY SCANNER RUNNING ON PORT " + PORT
    );

});
