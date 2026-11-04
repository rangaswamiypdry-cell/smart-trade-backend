// ======================================================
// SMART TRADE INDIA V6
// NSE F&O INSTITUTIONAL MOMENTUM SCANNER
// NODE.JS 20+
// UPSTOX API V3
// ======================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const API = "https://api.upstox.com";

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || 50);

const CONCURRENCY = 4;

let instruments = [];

let stocks = [];

let options = [];

let lastScan = null;

let scanBusy = false;

let masterLoading = false;

let lastMasterLoad = 0;

const MASTER_CACHE = 6 * 60 * 60 * 1000;

// ======================================================
// CORS
// ======================================================

function cors(res) {

    res.setHeader("Access-Control-Allow-Origin", "*");

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

    if (!TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const response = await fetch(API + path, {

        method: "GET",

        headers: {
            "Accept": "application/json",
            "Authorization": "Bearer " + TOKEN
        },

        signal: AbortSignal.timeout(15000)

    });

    const text = await response.text();

    let data;

    try {

        data = JSON.parse(text);

    } catch {

        throw new Error(
            "Invalid Upstox response: " + text.slice(0, 150)
        );

    }

    if (!response.ok) {

        throw new Error(
            "Upstox HTTP " +
            response.status +
            ": " +
            (data.message || text.slice(0, 150))
        );

    }

    return data;

}

// ======================================================
// EXPIRY TIMESTAMP FIX
// ======================================================

function expiryTime(value) {

    if (value === undefined || value === null) {
        return 0;
    }

    if (typeof value === "number") {
        return value;
    }

    const n = Number(value);

    if (Number.isFinite(n) && n > 1000000000) {
        return n;
    }

    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : 0;

}

// ======================================================
// MASTER DOWNLOAD
// ======================================================

async function downloadMaster() {

    if (masterLoading) {

        while (masterLoading) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        return instruments;

    }

    masterLoading = true;

    try {

        console.log("Downloading Upstox Instrument Master...");

        const response = await fetch(MASTER_URL, {

            signal: AbortSignal.timeout(60000)

        });

        if (!response.ok) {

            throw new Error(
                "Master download HTTP " + response.status
            );

        }

        let buffer = Buffer.from(
            await response.arrayBuffer()
        );

        // Detect gzip using magic bytes.

        if (
            buffer.length > 2 &&
            buffer[0] === 0x1f &&
            buffer[1] === 0x8b
        ) {

            buffer = zlib.gunzipSync(buffer);

        }

        const parsed = JSON.parse(
            buffer.toString("utf8")
        );

        const master = Array.isArray(parsed)
            ? parsed
            : parsed.data;

        if (!Array.isArray(master)) {

            throw new Error(
                "Instrument master is not an array"
            );

        }

        const now = Date.now();

        const futures = master.filter(item => {

            const expiry = expiryTime(item.expiry);

            return (

                item.segment === "NSE_FO" &&

                String(item.instrument_type)
                    .toUpperCase() === "FUT" &&

                item.instrument_key &&

                item.underlying_symbol &&

                (
                    !item.underlying_type ||
                    item.underlying_type === "EQUITY"
                ) &&

                expiry >= now

            );

        });

        // Nearest expiry per underlying stock.

        const unique = new Map();

        for (const item of futures) {

            const symbol = item.underlying_symbol;

            const previous = unique.get(symbol);

            if (
                !previous ||
                expiryTime(item.expiry) <
                expiryTime(previous.expiry)
            ) {

                unique.set(symbol, item);

            }

        }

        instruments = Array.from(unique.values());

        lastMasterLoad = Date.now();

        console.log(
            "MASTER TOTAL:",
            master.length
        );

        console.log(
            "NSE FUTURES:",
            futures.length
        );

        console.log(
            "UNIQUE EQUITY FUTURES:",
            instruments.length
        );

        if (!instruments.length) {

            throw new Error(
                "NSE F&O futures filter returned zero instruments"
            );

        }

        return instruments;

    } finally {

        masterLoading = false;

    }

}

// ======================================================
// GET INSTRUMENTS
// ======================================================

async function getInstruments() {

    if (
        instruments.length > 0 &&
        Date.now() - lastMasterLoad < MASTER_CACHE
    ) {

        return instruments;

    }

    return await downloadMaster();

}

// ======================================================
// GET 5 MINUTE CANDLES
// ======================================================

async function getCandles(key) {

    const encoded = encodeURIComponent(key);

    const path =
        "/v3/historical-candle/intraday/" +
        encoded +
        "/minutes/5";

    const result = await upstoxRequest(path);

    const raw = result.data?.candles || [];

    return raw.map(c => ({

        time: new Date(c[0]).getTime(),

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5]),

        oi: Number(c[6] || 0)

    }))
    .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.close) &&
        Number.isFinite(c.volume)
    )
    .sort((a, b) => a.time - b.time);

}

// ======================================================
// CLOSED CANDLES ONLY
// ======================================================

function getClosedCandles(candles) {

    const now = Date.now();

    return candles.filter(c => {

        return (
            c.time + 5 * 60 * 1000 <= now
        );

    });

}

// ======================================================
// RSI
// ======================================================

function calculateRSI(candles, period = 14) {

    if (candles.length <= period) return 0;

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        gain += Math.max(change, 0);

        loss += Math.max(-change, 0);

    }

    let avgGain = gain / period;

    let avgLoss = loss / period;

    for (let i = period + 1; i < candles.length; i++) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        avgGain =
            (avgGain * 13 + Math.max(change, 0)) / 14;

        avgLoss =
            (avgLoss * 13 + Math.max(-change, 0)) / 14;

    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - 100 / (1 + rs);

}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period = 20) {

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
// STRENGTH
// ======================================================

function calculateStrength(candles) {

    if (candles.length < 15) return 0;

    let up = 0;

    let down = 0;

    for (
        let i = candles.length - 14;
        i < candles.length;
        i++
    ) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        if (change > 0) up += change;

        else down += Math.abs(change);

    }

    const total = up + down;

    if (!total) return 0;

    return Math.round(
        Math.abs(up - down) / total * 100
    );

}

// ======================================================
// STOCK ANALYSIS
// ======================================================

function analyseStock(item, candles) {

    if (candles.length < 21) return null;

    const latest = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const ema20 = calculateEMA(closes, 20);

    const rsi = calculateRSI(candles, 14);

    const vwap = calculateVWAP(candles);

    const previousVolumes =
        candles.slice(-21, -1).map(c => c.volume);

    const avgVolume =
        previousVolumes.reduce((a, b) => a + b, 0) /
        previousVolumes.length;

    const volumeRatio =
        avgVolume > 0
        ? latest.volume / avgVolume
        : 0;

    const priceChange =
        previous.close > 0
        ? (
            (latest.close - previous.close) /
            previous.close
        ) * 100
        : 0;

    const oiChange =
        previous.oi > 0
        ? (
            (latest.oi - previous.oi) /
            previous.oi
        ) * 100
        : 0;

    const previousCandles =
        candles.slice(-21, -1);

    const resistance = Math.max(
        ...previousCandles.map(c => c.high)
    );

    const support = Math.min(
        ...previousCandles.map(c => c.low)
    );

    const volumeBlast = volumeRatio >= 1.5;

    const priceUp = latest.close > previous.close;

    const priceDown = latest.close < previous.close;

    const longBuildup =
        priceUp &&
        latest.oi > previous.oi;

    const shortBuildup =
        priceDown &&
        latest.oi > previous.oi;

    const bullish =
        latest.close > ema20 &&
        latest.close > vwap &&
        rsi >= 55 &&
        priceUp &&
        volumeBlast;

    const bearish =
        latest.close < ema20 &&
        latest.close < vwap &&
        rsi <= 45 &&
        priceDown &&
        volumeBlast;

    const strongBuy =
        bullish &&
        latest.close > resistance;

    const strongSell =
        bearish &&
        latest.close < support;

    let signal = "WATCH";

    if (strongBuy) signal = "STRONG BUY";

    else if (strongSell) signal = "STRONG SELL";

    else if (bullish) signal = "BUY";

    else if (bearish) signal = "SELL";

    const entry = latest.close;

    // Average True Range approximation.

    const ranges = candles.slice(-14).map(c => {

        return Math.max(
            c.high - c.low,
            Math.abs(c.high - previous.close),
            Math.abs(c.low - previous.close)
        );

    });

    const atr =
        ranges.reduce((a, b) => a + b, 0) /
        ranges.length;

    let stopLoss = 0;

    let target1 = 0;

    let target2 = 0;

    if (signal.includes("BUY")) {

        stopLoss = entry - atr * 1.5;

        target1 = entry + atr * 1.5;

        target2 = entry + atr * 3;

    }

    if (signal.includes("SELL")) {

        stopLoss = entry + atr * 1.5;

        target1 = entry - atr * 1.5;

        target2 = entry - atr * 3;

    }

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

        vwap,

        adx: calculateStrength(candles),

        strength: Math.round(
            Math.min(100, rsi + volumeRatio * 10)
        ),

        longBuildup,

        shortBuildup,

        volumeBlast,

        entry,

        stopLoss,

        target1,

        target2,

        resistance,

        support,

        orderBlock: "-",

        candleTime: latest.time

    };

}

// ======================================================
// CONCURRENT SCANNER
// ======================================================

async function scanStocks() {

    if (scanBusy) {

        return stocks;

    }

    scanBusy = true;

    const results = [];

    try {

        const list = await getInstruments();

        const selected = SCAN_LIMIT > 0
            ? list.slice(0, SCAN_LIMIT)
            : list;

        console.log(
            "SCANNING:",
            selected.length
        );

        let index = 0;

        async function worker() {

            while (index < selected.length) {

                const current = index++;

                const item = selected[current];

                try {

                    const candles = await getCandles(
                        item.instrument_key
                    );

                    const closed = getClosedCandles(candles);

                    const result = analyseStock(
                        item,
                        closed
                    );

                    if (result) {

                        results.push(result);

                    }

                } catch (error) {

                    console.log(
                        "SCAN ERROR:",
                        item.underlying_symbol,
                        error.message
                    );

                }

            }

        }

        await Promise.all(
            Array.from(
                { length: CONCURRENCY },
                () => worker()
            )
        );

        results.sort((a, b) =>
            b.strength - a.strength
        );

        stocks = results;

        lastScan = new Date().toISOString();

        console.log(
            "SCAN COMPLETED:",
            stocks.length
        );

        return stocks;

    } finally {

        scanBusy = false;

    }

}

// ======================================================
// OPTIONS
// ======================================================

async function scanOptions() {

    // Options scanning is not implemented in this version.
    // Do not show fake option signals.

    return options;

}

// ======================================================
// SERVER
// ======================================================

const server = http.createServer(async (req, res) => {

    cors(res);

    if (req.method === "OPTIONS") {

        res.writeHead(204);

        return res.end();

    }

    const url = new URL(
        req.url,
        "http://" + (req.headers.host || "localhost")
    );

    const path = url.pathname;

    try {

        // HEALTH

        if (path === "/health") {

            return sendJson(res, 200, {

                success: true,

                status: "ONLINE",

                app: "SMART TRADE INDIA V6",

                upstoxConnected: Boolean(TOKEN),

                totalInstruments: instruments.length,

                cachedStocks: stocks.length,

                lastScan

            });

        }

        // MASTER DEBUG

        if (path === "/api/debug/instruments") {

            const list = await getInstruments();

            return sendJson(res, 200, {

                success: true,

                count: list.length,

                stocks: list.slice(0, 20).map(item => ({

                    symbol: item.underlying_symbol,

                    instrumentKey: item.instrument_key,

                    expiry: item.expiry,

                    expiryDate: new Date(
                        expiryTime(item.expiry)
                    ).toISOString()

                }))

            });

        }

        // MAIN SCAN

        if (path === "/api/scan") {

            const result = await scanStocks();

            return sendJson(res, 200, {

                success: true,

                count: result.length,

                stocks: result,

                lastScan

            });

        }

        // STOCK REFRESH

        if (path === "/api/stocks") {

            return sendJson(res, 200, {

                success: true,

                count: stocks.length,

                stocks,

                lastScan

            });

        }

        // OPTIONS

        if (path === "/api/options") {

            return sendJson(res, 200, {

                success: true,

                implemented: false,

                count: options.length,

                options,

                message:
                    "Live option-chain scanner is not implemented yet"

            });

        }

        // NSE STOCKS

        if (path === "/api/options/nse-stocks") {

            const list = await getInstruments();

            return sendJson(res, 200, {

                success: true,

                count: list.length,

                stocks: list.map(item => ({

                    symbol: item.underlying_symbol,

                    instrumentKey: item.instrument_key,

                    expiry: item.expiry

                }))

            });

        }

        // SCAN STATUS

        if (path === "/api/scan/status") {

            return sendJson(res, 200, {

                success: true,

                scanning: scanBusy,

                totalInstruments: instruments.length,

                totalStocks: stocks.length,

                lastScan

            });

        }

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
// START
// ======================================================

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        "SMART TRADE INDIA V6 STARTED"
    );

    console.log("PORT:", PORT);

});

// ======================================================
// ERROR HANDLING
// ======================================================

process.on("unhandledRejection", error => {

    console.error("UNHANDLED:", error);

});

process.on("uncaughtException", error => {

    console.error("UNCAUGHT:", error);

});
