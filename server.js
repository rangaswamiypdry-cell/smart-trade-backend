// =====================================================
// SMART TRADE INDIA V4 PRO
// ORB + VOLUME BREAKOUT SCANNER
// NSE F&O | UPSTOX V3 | NODE.JS 20+
// =====================================================

"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const API = "https://api.upstox.com";
const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const CONFIG = {
    INTERVAL: 5,
    ORB_MINUTES: 15,
    VOLUME_MULTIPLIER: 1.5,
    RSI_BULLISH: 65,
    RSI_BEARISH: 35,
    EMA_PERIOD: 20,
    SCAN_LIMIT: 100,
    REQUEST_DELAY: 350,
    CONCURRENCY: 2
};

let instruments = [];
let lastSignals = [];
let lastScanTime = null;
let scanRunning = false;

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

// =====================================================
// JSON RESPONSE
// =====================================================

function sendJson(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });

    res.end(JSON.stringify(data));
}

// =====================================================
// UPSTOX API
// =====================================================

async function upstoxRequest(path) {

    if (!TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const response = await fetch(API + path, {
        method: "GET",
        headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${TOKEN}`
        },
        signal: AbortSignal.timeout(15000)
    });

    const body = await response.text();

    if (!response.ok) {
        throw new Error(
            `Upstox ${response.status}: ${body.slice(0, 250)}`
        );
    }

    return JSON.parse(body);
}

// =====================================================
// NSE F&O MASTER LOAD
// =====================================================

async function loadInstrumentMaster() {

    console.log("Loading NSE instrument master...");

    const response = await fetch(MASTER_URL);

    if (!response.ok) {
        throw new Error("Instrument master download failed");
    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    const jsonBuffer = zlib.gunzipSync(buffer);

    const master = JSON.parse(
        jsonBuffer.toString("utf8")
    );

    const foSymbols = new Set(
        master
            .filter(x =>
                x.segment === "NSE_FO" &&
                x.instrument_type === "FUT" &&
                x.underlying_symbol
            )
            .map(x => x.underlying_symbol)
    );

    instruments = master
        .filter(x =>
            x.segment === "NSE_EQ" &&
            x.instrument_type === "EQ" &&
            foSymbols.has(x.trading_symbol)
        )
        .map(x => ({
            symbol: x.trading_symbol,
            key: x.instrument_key
        }));

    console.log(
        "NSE F&O Stocks Loaded:",
        instruments.length
    );

    return instruments.length;
}

// =====================================================
// GET 5 MINUTE CANDLES
// =====================================================

async function getCandles(instrumentKey) {

    const key = encodeURIComponent(instrumentKey);

    const result = await upstoxRequest(
        `/v3/historical-candle/intraday/${key}/minutes/5`
    );

    const candles = result?.data?.candles || [];

    return candles
        .map(c => ({
            time: new Date(c[0]),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5]),
            oi: Number(c[6] || 0)
        }))
        .filter(c =>
            Number.isFinite(c.close) &&
            Number.isFinite(c.volume)
        )
        .sort((a, b) => a.time - b.time);
}

// =====================================================
// REMOVE RUNNING CANDLE
// =====================================================

function getClosedCandles(candles) {

    const now = Date.now();

    return candles.filter(c =>
        c.time.getTime() + 5 * 60 * 1000 <= now
    );
}

// =====================================================
// RSI CALCULATION
// =====================================================

function calculateRSI(candles, period = 14) {

    if (candles.length < period + 1) {
        return null;
    }

    let gains = 0;
    let losses = 0;

    const start = candles.length - period;

    for (let i = start; i < candles.length; i++) {

        const change =
            candles[i].close - candles[i - 1].close;

        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    if (losses === 0) return 100;

    const rs = gains / losses;

    return 100 - (100 / (1 + rs));
}

// =====================================================
// EMA CALCULATION
// =====================================================

function calculateEMA(values, period = 20) {

    if (values.length < period) return null;

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

// =====================================================
// VWAP CALCULATION
// =====================================================

function calculateVWAP(candles) {

    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        totalPV += typical * c.volume;
        totalVolume += c.volume;
    }

    if (!totalVolume) return null;

    return totalPV / totalVolume;
}
// =====================================================
// SMART TRADE INDIA V4 PRO
// ORB + VOLUME BREAKOUT SCANNER
// PART 2
// =====================================================

// =====================================================
// ORB CALCULATION
// First 15 Minutes: 9:15 to 9:30
// =====================================================

function calculateORB(candles) {

    const first = candles.filter(c => {

        const d = c.time;

        const minutes =
            d.getHours() * 60 + d.getMinutes();

        return minutes >= 555 && minutes < 570;
    });

    if (first.length < 3) {
        return null;
    }

    return {
        high: Math.max(...first.map(c => c.high)),
        low: Math.min(...first.map(c => c.low)),
        candles: first.length
    };
}

// =====================================================
// VOLUME ANALYSIS
// =====================================================

function analyseVolume(candles) {

    if (candles.length < 21) {
        return null;
    }

    const previous = candles.slice(-21, -1);

    const average =
        previous.reduce((sum, c) =>
            sum + c.volume, 0
        ) / previous.length;

    const current =
        candles[candles.length - 1].volume;

    return {
        current,
        average,
        ratio: average > 0 ? current / average : 0,
        strong: average > 0 &&
            current >= average * CONFIG.VOLUME_MULTIPLIER
    };
}

// =====================================================
// SMART MONEY ANALYSIS
// =====================================================

function analyseSmartMoney(candles) {

    if (candles.length < 3) {
        return {
            bullish: false,
            bearish: false,
            oiChange: 0
        };
    }

    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const oiChange =
        current.oi > 0 && previous.oi > 0
            ? ((current.oi - previous.oi) /
                previous.oi) * 100
            : 0;

    const priceUp = current.close > previous.close;
    const priceDown = current.close < previous.close;

    const oiIncreasing = oiChange > 0;

    return {
        bullish: priceUp && oiIncreasing,
        bearish: priceDown && oiIncreasing,
        oiChange: Number(oiChange.toFixed(2))
    };
}

// =====================================================
// FAKE BREAKOUT FILTER
// =====================================================

function detectFakeBreakout(candles, orb) {

    if (candles.length < 2 || !orb) {
        return {
            bullishFake: false,
            bearishFake: false
        };
    }

    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    return {

        bullishFake:
            previous.high > orb.high &&
            previous.close <= orb.high &&
            current.close <= orb.high,

        bearishFake:
            previous.low < orb.low &&
            previous.close >= orb.low &&
            current.close >= orb.low
    };
}

// =====================================================
// MAIN SCANNER ANALYSIS
// =====================================================

function analyseStock(symbol, candles) {

    if (candles.length < 25) {
        return null;
    }

    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const rsi = calculateRSI(candles);
    const ema20 = calculateEMA(closes, 20);
    const vwap = calculateVWAP(candles);

    const orb = calculateORB(candles);
    const volume = analyseVolume(candles);
    const smart = analyseSmartMoney(candles);

    if (
        rsi === null ||
        ema20 === null ||
        vwap === null ||
        !orb ||
        !volume
    ) {
        return null;
    }

    const fake = detectFakeBreakout(candles, orb);

    // Bullish confirmation

    const bullish =
        current.close > orb.high &&
        previous.close <= orb.high &&
        current.close > current.open &&
        current.close > vwap &&
        current.close > ema20 &&
        rsi >= CONFIG.RSI_BULLISH &&
        volume.strong &&
        !fake.bullishFake;

    // Bearish confirmation

    const bearish =
        current.close < orb.low &&
        previous.close >= orb.low &&
        current.close < current.open &&
        current.close < vwap &&
        current.close < ema20 &&
        rsi <= CONFIG.RSI_BEARISH &&
        volume.strong &&
        !fake.bearishFake;

    let signal = "NO SIGNAL";

    if (bullish) {
        signal = "STRONG BUY";
    }

    if (bearish) {
        signal = "STRONG SELL";
    }

    return {

        symbol,

        signal,

        price: current.close,

        orbHigh: Number(orb.high.toFixed(2)),

        orbLow: Number(orb.low.toFixed(2)),

        rsi: Number(rsi.toFixed(2)),

        ema20: Number(ema20.toFixed(2)),

        vwap: Number(vwap.toFixed(2)),

        volume: current.volume,

        averageVolume: Math.round(volume.average),

        volumeRatio: Number(volume.ratio.toFixed(2)),

        oiChange: smart.oiChange,

        smartMoney:
            signal === "STRONG BUY"
                ? smart.bullish
                : signal === "STRONG SELL"
                    ? smart.bearish
                    : false,

        candleTime: current.time.toISOString(),

        timeframe: "5 MINUTES",

        fakeBreakout: false
    };
}

// =====================================================
// STOCK SCAN
// =====================================================

async function scanStock(stock) {

    try {

        const candles = await getCandles(stock.key);

        const closed = getClosedCandles(candles);

        const analysis = analyseStock(
            stock.symbol,
            closed
        );

        return analysis;

    } catch (error) {

        console.error(
            "Stock scan error:",
            stock.symbol,
            error.message
        );

        return null;
    }
}

// =====================================================
// SCANNER ENGINE
// =====================================================

async function runScanner() {

    if (scanRunning) {
        return lastSignals;
    }

    scanRunning = true;

    const signals = [];

    try {

        const stocks = instruments.slice(
            0,
            CONFIG.SCAN_LIMIT
        );

        for (
            let i = 0;
            i < stocks.length;
            i += CONFIG.CONCURRENCY
        ) {

            const batch = stocks.slice(
                i,
                i + CONFIG.CONCURRENCY
            );

            const results = await Promise.all(
                batch.map(scanStock)
            );

            for (const result of results) {

                if (
                    result &&
                    result.signal !== "NO SIGNAL"
                ) {
                    signals.push(result);
                }
            }

            await sleep(CONFIG.REQUEST_DELAY);
        }

        lastSignals = signals;

        lastScanTime = new Date().toISOString();

        console.log(
            "Scanner completed:",
            signals.length,
            "signals"
        );

    } catch (error) {

        console.error(
            "Scanner error:",
            error.message
        );

    } finally {

        scanRunning = false;
    }

    return lastSignals;
}

// =====================================================
// HTTP SERVER
// =====================================================

const server = http.createServer(
    async (req, res) => {

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            });
            return res.end();
        }

        const path = new URL(
            req.url,
            `http://${req.headers.host}`
        ).pathname;

        try {

            // HEALTH

            if (path === "/health") {

                return sendJson(res, 200, {
                    status: "ONLINE",
                    app: "SMART TRADE INDIA V4 PRO",
                    scanner: "ORB + VOLUME BREAKOUT",
                    instruments: instruments.length,
                    lastScan: lastScanTime
                });
            }

            // STATUS

            if (path === "/api/status") {

                return sendJson(res, 200, {
                    status: "ONLINE",
                    tokenConfigured: Boolean(TOKEN),
                    masterLoaded: instruments.length > 0,
                    totalStocks: instruments.length,
                    scanRunning,
                    lastScanTime
                });
            }

            // STOCK MASTER

            if (path === "/api/stocks") {

                return sendJson(res, 200, {
                    count: instruments.length,
                    stocks: instruments
                });
            }

            // SIGNALS

            if (path === "/api/signals") {

                return sendJson(res, 200, {
                    success: true,
                    count: lastSignals.length,
                    lastScanTime,
                    signals: lastSignals
                });
            }

            // START SCANNER

            if (path === "/api/scan") {

                if (scanRunning) {

                    return sendJson(res, 200, {
                        success: true,
                        message: "Scan already running",
                        signals: lastSignals
                    });
                }

                runScanner().catch(console.error);

                return sendJson(res, 202, {
                    success: true,
                    message: "Scanner started"
                });
            }

            return sendJson(res, 404, {
                error: "API route not found"
            });

        } catch (error) {

            return sendJson(res, 500, {
                error: error.message
            });
        }
    }
);

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, async () => {

    console.log(
        `SMART TRADE INDIA V4 PRO running on ${PORT}`
    );

    if (!TOKEN) {
        console.error(
            "UPSTOX_ACCESS_TOKEN missing"
        );
        return;
    }

    try {

        await loadInstrumentMaster();

        console.log(
            "NSE F&O MASTER LOADED SUCCESSFULLY"
        );

    } catch (error) {

        console.error(
            "MASTER LOAD ERROR:",
            error.message
        );
    }
});

