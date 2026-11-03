// =====================================================
// SMART TRADE INDIA - PRO SCANNER V2
// Node.js 20+ | Upstox API V3 | Render
// =====================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const UPSTOX_BASE = "https://api.upstox.com";

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const SETTINGS = {
    TIMEFRAME: 5,
    RSI_PERIOD: 14,
    EMA_PERIOD: 20,

    VOLUME_MULTIPLIER: 1.5,
    MIN_RSI_BUY: 60,
    MAX_RSI_SELL: 40,

    MIN_OI_CHANGE: 2,

    STOP_LOSS_PERCENT: 1,
    TARGET_PERCENT: 2,

    MAX_INSTRUMENTS: 100,
    CONCURRENCY: 5
};

let instruments = [];
let lastScan = [];
let lastScanTime = null;

// =====================================================
// JSON RESPONSE
// =====================================================

function send(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, OPTIONS"
    });

    res.end(JSON.stringify(data));
}

// =====================================================
// HTTP REQUEST
// =====================================================

function request(url, options = {}) {
    return new Promise((resolve, reject) => {

        const req = https.request(url, {
            method: options.method || "GET",
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${TOKEN}`,
                ...options.headers
            }
        }, response => {

            let body = "";

            response.on("data", chunk => {
                body += chunk;
            });

            response.on("end", () => {

                try {
                    const json = JSON.parse(body);

                    if (response.statusCode >= 400) {
                        return reject(
                            new Error(
                                json.message ||
                                `Upstox HTTP ${response.statusCode}`
                            )
                        );
                    }

                    resolve(json);

                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on("error", reject);
        req.setTimeout(20000, () => {
            req.destroy(new Error("Request timeout"));
        });

        req.end();
    });
}

// ==========================================
// FIXED UPSTOX INSTRUMENT DOWNLOAD
// ==========================================

async function loadInstruments() {

    const url =
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

    console.log("Downloading Upstox Instruments...");

    try {

        const response = await fetch(url, {
            redirect: "follow",
            headers: {
                "User-Agent": "SmartTradeIndia/2.0",
                "Accept": "application/json"
            },
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok) {
            throw new Error(
                `Download HTTP Error: ${response.status}`
            );
        }

        let buffer = Buffer.from(
            await response.arrayBuffer()
        );

        if (
            buffer.length >= 2 &&
            buffer[0] === 0x1f &&
            buffer[1] === 0x8b
        ) {
            buffer = zlib.gunzipSync(buffer);
        }

        const data = JSON.parse(
            buffer.toString("utf8")
        );

        if (!Array.isArray(data)) {
            throw new Error("Invalid instrument JSON");
        }

        const filtered = data.filter(item => {

            return (
                item.segment === "NSE_FO" &&
                item.instrument_type === "FUT" &&
                item.instrument_key &&
                item.underlying_symbol
            );

        });

        const nearest = new Map();

        for (const item of filtered) {

            const old = nearest.get(
                item.underlying_symbol
            );

            if (
                !old ||
                Number(item.expiry) < Number(old.expiry)
            ) {
                nearest.set(
                    item.underlying_symbol,
                    item
                );
            }
        }

        instruments = [...nearest.values()]
            .slice(0, SETTINGS.MAX_INSTRUMENTS);

        console.log(
            "F&O Instruments Loaded:",
            instruments.length
        );

        if (!instruments.length) {
            throw new Error("No NSE F&O instruments found");
        }

        return instruments;

    } catch (error) {

        console.error(
            "INSTRUMENT ERROR:",
            error.message
        );

        throw error;
    }
            }


// =====================================================
// MARKET QUOTE V3
// =====================================================

async function getQuote(instrumentKey) {

    const url =
        `${UPSTOX_BASE}/v3/market-quote/quotes?instrument_key=` +
        encodeURIComponent(instrumentKey);

    const result = await request(url);

    const data = Object.values(result.data || {})[0];

    if (!data) {
        throw new Error("Quote unavailable");
    }

    return data;
}

// =====================================================
// 5 MINUTE CANDLES
// =====================================================

async function getCandles(instrumentKey) {

    const url =
        `${UPSTOX_BASE}/v3/historical-candle/intraday/` +
        `${encodeURIComponent(instrumentKey)}/minutes/5`;

    const result = await request(url);

    return result.data?.candles || [];
}

// =====================================================
// EMA
// =====================================================

function calculateEMA(values, period) {

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
// RSI
// =====================================================

function calculateRSI(values, period = 14) {

    if (values.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change = values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {

        const change = values[i] - values[i - 1];

        avgGain =
            (avgGain * (period - 1) + Math.max(change, 0)) /
            period;

        avgLoss =
            (avgLoss * (period - 1) + Math.max(-change, 0)) /
            period;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - 100 / (1 + rs);
}

// =====================================================
// VWAP
// =====================================================

function calculateVWAP(candles) {

    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {

        const high = Number(c[2]);
        const low = Number(c[3]);
        const close = Number(c[4]);
        const volume = Number(c[5]);

        const typicalPrice =
            (high + low + close) / 3;

        totalPV += typicalPrice * volume;
        totalVolume += volume;
    }

    return totalVolume
        ? totalPV / totalVolume
        : null;
}

// =====================================================
// CLOSED CANDLE FILTER
// =====================================================

function getClosedCandles(candles) {

    const now = Date.now();

    return candles
        .filter(c => {

            const timestamp = new Date(c[0]).getTime();

            return (
                Number.isFinite(timestamp) &&
                timestamp + 5 * 60 * 1000 <= now
            );

        })
        .slice()
        .reverse();
}

// =====================================================
// ANALYSE STOCK
// =====================================================

async function analyseStock(item) {

    try {

        const quote = await getQuote(item.instrument_key);

        const candlesRaw = await getCandles(item.instrument_key);

        const candles = getClosedCandles(candlesRaw);

        if (candles.length < 21) return null;

        const closes = candles.map(c => Number(c[4]));

        const volumes = candles.map(c => Number(c[5]));

        const latest = candles[candles.length - 1];

        const previous = candles[candles.length - 2];

        const close = Number(latest[4]);

        const open = Number(latest[1]);

        const high = Number(latest[2]);

        const low = Number(latest[3]);

        const volume = Number(latest[5]);

        const previousVolume = Number(previous[5]);

        const averageVolume = volumes
            .slice(-21, -1)
            .reduce((a, b) => a + b, 0) / 20;

        const volumeRatio =
            averageVolume > 0
                ? volume / averageVolume
                : 0;

        const ema20 = calculateEMA(closes, 20);

        const rsi = calculateRSI(closes, 14);

        const vwap = calculateVWAP(candles);

        const ltp = Number(quote.last_price);

        const oi = Number(quote.oi || 0);

        const previousOI = Number(
            quote.previous_oi || 0
        );

        const oiChange = previousOI > 0
            ? ((oi - previousOI) / previousOI) * 100
            : null;

        const priceChange = close > 0
            ? ((close - Number(previous[4])) /
                Number(previous[4])) * 100
            : 0;

        const volumePass =
            volumeRatio >= SETTINGS.VOLUME_MULTIPLIER;

        const oiPass =
            oiChange !== null &&
            oiChange >= SETTINGS.MIN_OI_CHANGE;

        const bullish =
            close > open &&
            close > ema20 &&
            close > vwap &&
            rsi >= SETTINGS.MIN_RSI_BUY &&
            volumePass &&
            oiPass;

        const bearish =
            close < open &&
            close < ema20 &&
            close < vwap &&
            rsi <= SETTINGS.MAX_RSI_SELL &&
            volumePass &&
            oiPass;

        let signal = "WAIT";

        if (bullish && priceChange > 0) {
            signal = "STRONG BUY";
        }

        if (bearish && priceChange < 0) {
            signal = "STRONG SELL";
        }

        const resistance = Math.max(
            ...candles.slice(-21, -1).map(c => Number(c[2]))
        );

        const support = Math.min(
            ...candles.slice(-21, -1).map(c => Number(c[3]))
        );

        const breakout = close > resistance;

        const breakdown = close < support;

        if (signal === "STRONG BUY" && breakout) {
            signal = "STRONG BUY BREAKOUT";
        }

        if (signal === "STRONG SELL" && breakdown) {
            signal = "STRONG SELL BREAKDOWN";
        }

        const entry = close;

        const stopLoss =
            signal.includes("BUY")
                ? entry * (1 - SETTINGS.STOP_LOSS_PERCENT / 100)
                : entry * (1 + SETTINGS.STOP_LOSS_PERCENT / 100);

        const target =
            signal.includes("BUY")
                ? entry * (1 + SETTINGS.TARGET_PERCENT / 100)
                : entry * (1 - SETTINGS.TARGET_PERCENT / 100);

        const bullishBTST =
            close > open &&
            close > ema20 &&
            close > vwap &&
            rsi >= 60 &&
            volumePass &&
            oiPass;

        return {

            symbol: item.underlying_symbol,

            instrumentKey: item.instrument_key,

            expiry: item.expiry,

            price: ltp,

            candleClose: close,

            changePercent: Number(priceChange.toFixed(2)),

            volume,

            volumeRatio: Number(volumeRatio.toFixed(2)),

            oi,

            previousOI,

            oiChange: oiChange === null
                ? null
                : Number(oiChange.toFixed(2)),

            rsi: Number(rsi.toFixed(2)),

            ema20: Number(ema20.toFixed(2)),

            vwap: Number(vwap.toFixed(2)),

            resistance,

            support,

            breakout,

            breakdown,

            signal,

            btst: bullishBTST,

            entry: Number(entry.toFixed(2)),

            stopLoss: Number(stopLoss.toFixed(2)),

            target: Number(target.toFixed(2)),

            candleTime: latest[0],

            candleConfirmed: true

        };

    } catch (error) {

        console.log(
            "Stock Error:",
            item.underlying_symbol,
            error.message
        );

        return null;
    }
}

// =====================================================
// CONCURRENT SCANNER
// =====================================================

async function runScanner() {

    if (!TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    if (!instruments.length) {
        await loadInstruments();
    }

    const results = [];

    for (
        let i = 0;
        i < instruments.length;
        i += SETTINGS.CONCURRENCY
    ) {

        const batch = instruments.slice(
            i,
            i + SETTINGS.CONCURRENCY
        );

        const data = await Promise.all(
            batch.map(analyseStock)
        );

        results.push(
            ...data.filter(Boolean)
        );
    }

    lastScan = results.sort((a, b) => {

        const rank = s => {

            if (s.includes("STRONG BUY")) return 4;

            if (s.includes("STRONG SELL")) return 3;

            if (s === "WAIT") return 1;

            return 0;
        };

        return rank(b.signal) - rank(a.signal);
    });

    lastScanTime = new Date().toISOString();

    return lastScan;
}

// =====================================================
// API ROUTES
// =====================================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {
        return send(res, 200, { success: true });
    }

    const url = new URL(
        req.url,
        `http://${req.headers.host}`
    );

    try {

        // HEALTH

        if (url.pathname === "/health") {

            return send(res, 200, {
                success: true,
                server: "SMART TRADE INDIA V2",
                tokenConfigured: Boolean(TOKEN),
                instruments: instruments.length,
                lastScanTime
            });
        }

        // UPSTOX STATUS

        if (url.pathname === "/api/upstox/status") {

            return send(res, 200, {
                connected: Boolean(TOKEN),
                instrumentsLoaded: instruments.length
            });
        }

        // LOAD INSTRUMENTS

        if (url.pathname === "/api/options/nse-stocks") {

            await loadInstruments();

            return send(res, 200, {
                success: true,
                count: instruments.length,
                stocks: instruments.map(x => ({
                    symbol: x.underlying_symbol,
                    instrumentKey: x.instrument_key,
                    expiry: x.expiry
                }))
            });
        }

        // FULL SCAN

        if (url.pathname === "/api/scan") {

            const data = await runScanner();

            return send(res, 200, {
                success: true,
                count: data.length,
                scanTime: lastScanTime,
                signals: data
            });
        }

        // BUY SIGNALS

        if (url.pathname === "/api/buy") {

            return send(res, 200, {
                signals: lastScan.filter(
                    x => x.signal.includes("BUY")
                )
            });
        }

        // SELL SIGNALS

        if (url.pathname === "/api/sell") {

            return send(res, 200, {
                signals: lastScan.filter(
                    x => x.signal.includes("SELL")
                )
            });
        }

        // BTST

        if (url.pathname === "/api/btst") {

            return send(res, 200, {
                signals: lastScan.filter(x => x.btst)
            });
        }

        // ALL SIGNALS

        if (url.pathname === "/api/signals") {

            return send(res, 200, {
                success: true,
                scanTime: lastScanTime,
                signals: lastScan
            });
        }

        return send(res, 404, {
            success: false,
            message: "API route not found"
        });

    } catch (error) {

        console.error(error);

        return send(res, 500, {
            success: false,
            error: error.message
        });
    }
});

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, () => {

    console.log("--------------------------------");

    console.log("SMART TRADE INDIA V2 STARTED");

    console.log("PORT:", PORT);

    console.log("UPSTOX:", Boolean(TOKEN));

    console.log("--------------------------------");

});
