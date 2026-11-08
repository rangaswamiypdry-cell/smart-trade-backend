// SMART TRADE INDIA - ORB + VOLUME BREAKOUT SCANNER
// Node.js 20+ | Upstox V3 | 5-minute completed candles

"use strict";

const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// SCANNER SETTINGS

const SCAN_LIMIT = Math.max(
    1,
    Number(process.env.ORB_SCAN_LIMIT || 100)
);

const CONCURRENCY = Math.max(
    1,
    Number(process.env.ORB_CONCURRENCY || 1)
);

const REQUEST_GAP_MS = Math.max(
    250,
    Number(process.env.UPSTOX_REQUEST_GAP_MS || 400)
);

const CANDLE_CACHE_MS = 60000;
const SCAN_CACHE_MS = 5 * 60 * 1000;

const VOLUME_MULTIPLIER = 2.5;

const RSI_BUY = 65;
const RSI_SELL = 35;

const ADX_MIN = 25;

const MIN_EXPECTED_MOVE = 38;

const ATR_MOVE_MULTIPLIER = 1.5;

const RR1 = 2;
const RR2 = 3;

const MAX_EQUITY_POSITIONS = 2;
const MAX_OPTION_POSITIONS = 2;

// GLOBAL VARIABLES

let instruments = [];
let fnoSymbols = new Set();

let lastMasterUpdate = null;
let masterLoading = false;

let lastScanTime = null;
let lastScanError = null;
let lastRateLimitAt = null;

const candleCache = new Map();
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

// FETCH WITH TIMEOUT

async function fetchTimeout(
    url,
    options = {},
    timeout = 20000
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

// UPSTOX API WITH RATE LIMIT PROTECTION

function upstoxRequest(path) {

    const task = async () => {

        if (!TOKEN) {
            throw new Error(
                "UPSTOX_ACCESS_TOKEN environment variable is missing"
            );
        }

        const wait = Math.max(
            0,
            REQUEST_GAP_MS -
            (Date.now() - lastRequestAt)
        );

        if (wait) await sleep(wait);

        let attempt = 0;

        while (attempt < 4) {

            lastRequestAt = Date.now();

            const response = await fetchTimeout(
                API + path,
                {
                    headers: {
                        Accept: "application/json",
                        Authorization: "Bearer " + TOKEN
                    }
                },
                20000
            );

            let data;

            try {
                data = await response.json();
            } catch {
                data = {
                    message: "Invalid JSON response"
                };
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

                const retryAfter = Number(
                    response.headers.get("retry-after")
                );

                const delay = retryAfter > 0
                    ? retryAfter * 1000
                    : Math.min(
                        15000,
                        1000 * (2 ** attempt)
                    );

                attempt++;

                await sleep(delay);

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

async function loadInstruments(force = false) {

    if (masterLoading) {

        while (masterLoading) {
            await sleep(150);
        }

        if (instruments.length) {
            return instruments.length;
        }

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
            throw new Error(
                "Invalid instrument master format"
            );
        }

        const nextEquity = rows.filter(x =>
            x.segment === "NSE_EQ" &&
            x.instrument_type === "EQ" &&
            x.instrument_key &&
            x.trading_symbol &&
            x.security_type !== "SM"
        );

        const nextFno = new Set();

        for (const x of rows) {

            if (
                x.segment === "NSE_FO" &&
                ["FUT", "CE", "PE"].includes(
                    x.instrument_type
                ) &&
                x.underlying_symbol
            ) {

                nextFno.add(x.underlying_symbol);

            }

        }

        instruments = nextEquity;

        fnoSymbols = nextFno;

        lastMasterUpdate = Date.now();

        console.log(
            `Instrument master loaded: ${instruments.length} equity; ${fnoSymbols.size} F&O underlyings`
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

// GET 5 MINUTE CANDLES

async function getStockCandles(stock) {

    const key = stock.instrumentKey;

    const cached = candleCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < CANDLE_CACHE_MS
    ) {

        return cached.candles;

    }

    const encoded = encodeURIComponent(key);

    const path =
        `/v3/historical-candle/intraday/${encoded}/minutes/5`;

    const result = await upstoxRequest(path);

    const candles = prepareCandles(
        result?.data?.candles || []
    );

    candleCache.set(key, {
        time: Date.now(),
        candles
    });

    return candles;

}

// PREPARE COMPLETED CANDLES

function prepareCandles(raw) {

    const today = istDate();

    const now = Date.now();

    return raw.map(c => ({

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
            istDate(new Date(t)) === today &&
            t + 5 * 60000 <= now &&
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

// ORB CALCULATION

function calculateORB(candles) {

    const opening = candles.filter(c =>
        [
            "09:15",
            "09:20",
            "09:25"
        ].includes(
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

// EMA

function calculateEMA(values, period) {

    if (values.length < period) {
        return null;
    }

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

    if (values.length <= period) {
        return null;
    }

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const d = values[i] - values[i - 1];

        if (d > 0) gain += d;
        else loss -= d;

    }

    let avgGain = gain / period;
    let avgLoss = loss / period;

    for (
        let i = period + 1;
        i < values.length;
        i++
    ) {

        const d = values[i] - values[i - 1];

        avgGain =
            (avgGain * (period - 1) +
            Math.max(d, 0)) / period;

        avgLoss =
            (avgLoss * (period - 1) +
            Math.max(-d, 0)) / period;

    }

    if (avgLoss === 0) return 100;

    return 100 -
        100 / (1 + avgGain / avgLoss);

}

// VWAP

function calculateVWAP(candles) {

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

// ATR

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) {
        return null;
    }

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

    const recent = tr.slice(-period);

    return recent.reduce(
        (a, b) => a + b,
        0
    ) / recent.length;

}

// ADX

function calculateADX(candles, period = 14) {

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

        plus.push(
            up > down && up > 0 ? up : 0
        );

        minus.push(
            down > up && down > 0 ? down : 0
        );

        tr.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        ));

    }

    const dx = [];

    for (
        let i = period - 1;
        i < tr.length;
        i++
    ) {

        const start = i - period + 1;

        const sumTR = tr
            .slice(start, i + 1)
            .reduce((a, b) => a + b, 0);

        if (!sumTR) continue;

        const pdi =
            100 *
            plus.slice(start, i + 1)
                .reduce((a, b) => a + b, 0) /
            sumTR;

        const mdi =
            100 *
            minus.slice(start, i + 1)
                .reduce((a, b) => a + b, 0) /
            sumTR;

        dx.push(
            pdi + mdi === 0
                ? 0
                : 100 * Math.abs(pdi - mdi) /
                  (pdi + mdi)
        );

    }

    if (dx.length < period) {
        return null;
    }

    return dx.slice(-period).reduce(
        (a, b) => a + b,
        0
    ) / period;

}

// CANDLE STRENGTH

function candleStrength(c, direction) {

    const range = c.high - c.low;

    if (range <= 0) return false;

    const bodyRatio =
        Math.abs(c.close - c.open) / range;

    if (direction === "BUY") {

        return (
            c.close > c.open &&
            bodyRatio >= 0.60 &&
            (c.high - c.close) / range <= 0.20
        );

    }

    return (
        c.close < c.open &&
        bodyRatio >= 0.60 &&
        (c.close - c.low) / range <= 0.20
    );

}

// TRADE CALCULATION

function calculateTrade(direction, price, atr) {

    const risk = Math.max(
        atr,
        price * 0.005
    );

    if (direction === "BUY") {

        return {

            entry: round(price),

            stopLoss: round(price - risk),

            target1: round(price + risk * RR1),

            target2: round(price + risk * RR2),

            riskPoints: round(risk)

        };

    }

    return {

        entry: round(price),

        stopLoss: round(price + risk),

        target1: round(price - risk * RR1),

        target2: round(price - risk * RR2),

        riskPoints: round(risk)

    };

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

    if (
        ![
            ema20,
            rsi,
            vwap,
            atr,
            adx
        ].every(Number.isFinite)
    ) {
        return null;
    }

    // ORB

    const orb = calculateORB(candles);

    if (!orb) {
        return null;
    }

    // PREVIOUS 20 CANDLE VOLUME

    const previousVolumes = candles
        .slice(-21, -1)
        .map(c => c.volume);

    if (previousVolumes.length !== 20) {
        return null;
    }

    const averageVolume =
        previousVolumes.reduce(
            (a, b) => a + b,
            0
        ) / 20;

    const volumeRatio =
        averageVolume > 0
            ? last.volume / averageVolume
            : 0;

    const estimatedMovePoints =
        atr * ATR_MOVE_MULTIPLIER;

    const commonPass =
        volumeRatio >= VOLUME_MULTIPLIER &&
        adx >= ADX_MIN &&
        estimatedMovePoints >= MIN_EXPECTED_MOVE;

    // BULLISH

    const bullish =
        commonPass &&
        last.close > last.open &&
        last.close > ema20 &&
        last.close > vwap &&
        previous.close <= orb.high &&
        last.close > orb.high &&
        rsi >= RSI_BUY &&
        candleStrength(last, "BUY");

    // BEARISH

    const bearish =
        commonPass &&
        last.close < last.open &&
        last.close < ema20 &&
        last.close < vwap &&
        previous.close >= orb.low &&
        last.close < orb.low &&
        rsi <= RSI_SELL &&
        candleStrength(last, "SELL");

    if (!bullish && !bearish) {
        return null;
    }

    const direction = bullish ? "BUY" : "SELL";

    return {

        symbol: stock.symbol,

        instrumentKey: stock.instrumentKey,

        signal: direction,

        strength: `VERY STRONG ${direction}`,

        price: round(last.close),

        candleTime: last.time,

        timeframe: "5 MIN",

        indicators: {

            rsi: round(rsi),

            adx: round(adx),

            ema20: round(ema20),

            vwap: round(vwap),

            atr: round(atr),

            volumeRatio: round(volumeRatio),

            estimatedMovePoints:
                round(estimatedMovePoints)

        },

        orb: {

            high: round(orb.high),

            low: round(orb.low)

        },

        trade: calculateTrade(
            direction,
            last.close,
            atr
        ),

        note:
            "Completed 5-minute candle signal. ATR-based targets are estimates, not guaranteed."

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

                if (value) {
                    results.push(value);
                }

            } catch (error) {

                console.error(
                    `Scan error: ${item.symbol}: ${error.message}`
                );

            }

        }

    }

    await Promise.all(
        Array.from(
            {
                length: Math.min(limit, items.length)
            },
            runner
        )
    );

    return results;

}

// ORB SCANNER

async function scanOrbStocks(type = "FNO") {

    const mode = String(type).toUpperCase();

    const bucket = Math.floor(
        Date.now() / SCAN_CACHE_MS
    );

    const cacheKey = `${mode}_${bucket}`;

    if (scanCache.has(cacheKey)) {
        return scanCache.get(cacheKey);
    }

    if (!instruments.length) {
        await loadInstruments();
    }

    const stocks = getStocksForScan(mode);

    const signals = await runConcurrent(
        stocks,
        CONCURRENCY,
        async stock => {

            const candles = await getStockCandles(stock);

            return analyseStock(stock, candles);

        }
    );

    signals.sort((a, b) =>
        b.indicators.volumeRatio * b.indicators.adx -
        a.indicators.volumeRatio * a.indicators.adx
    );

    const result = {

        success: true,

        type: mode,

        totalScanned: stocks.length,

        totalSignals: signals.length,

        scanTime: new Date().toISOString(),

        signals

    };

    scanCache.clear();

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

                reject(
                    new Error("Request body too large")
                );

            }

        });

        req.on("end", () => {

            try {

                resolve(
                    body ? JSON.parse(body) : {}
                );

            } catch {

                reject(
                    new Error("Invalid JSON body")
                );

            }

        });

        req.on("error", reject);

    });

}

// ADD POSITION

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

        throw new Error(
            `Maximum ${type} positions reached`
        );

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

    const position = {

        id:
            Date.now().toString(36) +
            Math.random().toString(36).slice(2, 8),

        type,

        symbol: String(data.symbol),

        direction:
            data.direction === "SELL"
                ? "SELL"
                : "BUY",

        entryPrice,

        quantity,

        status: "OPEN",

        createdAt: new Date().toISOString()

    };

    positions[type].push(position);

    return position;

}

// CLOSE POSITION

function closePosition(type, id) {

    const p = positions[type]?.find(
        x =>
            x.id === id &&
            x.status === "OPEN"
    );

    if (!p) {
        return null;
    }

    p.status = "CLOSED";

    p.closedAt = new Date().toISOString();

    return p;

}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(
    async (req, res) => {

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

            if (
                req.method === "GET" &&
                path === "/health"
            ) {

                return sendJson(res, 200, {

                    success: true,

                    message:
                        "Smart Trade India ORB scanner running",

                    time: new Date().toISOString()

                });

            }

            // ORB STATUS

            if (
                req.method === "GET" &&
                path === "/api/orb/status"
            ) {

                return sendJson(res, 200, {

                    success: true,

                    tokenConfigured: Boolean(TOKEN),

                    instrumentsLoaded:
                        instruments.length > 0,

                    totalInstruments:
                        instruments.length,

                    totalFnoSymbols:
                        fnoSymbols.size,

                    lastMasterLoad:
                        lastMasterUpdate
                            ? new Date(lastMasterUpdate).toISOString()
                            : null,

                    lastScanTime,

                    lastScanError,

                    lastRateLimitAt,

                    scanLimit: SCAN_LIMIT,

                    concurrency: CONCURRENCY

                });

            }

            // REFRESH MASTER

            if (
                req.method === "GET" &&
                path === "/api/orb/refresh-master"
            ) {

                const total =
                    await loadInstruments(true);

                return sendJson(res, 200, {

                    success: true,

                    totalInstruments: total,

                    totalFnoSymbols:
                        fnoSymbols.size

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

                    stocks

                });

            }

            // FULL SCAN

            if (
                req.method === "GET" &&
                path === "/api/orb/scan"
            ) {

                return sendJson(
                    res,
                    200,
                    await scanOrbStocks(
                        url.searchParams.get("type") || "FNO"
                    )
                );

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

                const result =
                    await scanOrbStocks("FNO");

                const signals =
                    path.endsWith("bullish")
                        ? filterSignals(
                            result.signals,
                            "BUY"
                        )
                        : path.endsWith("bearish")
                            ? filterSignals(
                                result.signals,
                                "SELL"
                            )
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

                const type =
                    path.endsWith("equity")
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

                        message:
                            "Open position not found"

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

            console.error(
                "SERVER ERROR:",
                error
            );

            return sendJson(res, 500, {

                success: false,

                error: error.message

            });

        }

    }
);

// START SERVER

server.listen(PORT, () => {

    console.log(
        `SMART TRADE INDIA ORB SCANNER RUNNING ON PORT ${PORT}`
    );

});
