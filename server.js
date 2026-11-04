// =====================================================
// SMART TRADE INDIA
// SHORT TERM SWING SCANNER V2
// ALL NSE EQUITY STOCKS
// DAILY + 5 MINUTE CONFIRMATION
// NODE JS 20+
// UPSTOX API V3
// =====================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const BASE = "https://api.upstox.com/v3";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// =====================================================
// CONFIG
// =====================================================

const CONFIG = {
    minPrice: 50,
    maxPrice: 10000,

    dailyRSI: 55,
    intradayRSI: 55,

    volumeMultiplier: 1.5,

    atrMultiplier: 1.5,

    target1RR: 2,
    target2RR: 3,

    concurrency: 2,

    defaultLimit: 100,
    maxLimit: 300
};

// =====================================================
// HTTP HELPERS
// =====================================================

function json(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS"
    });

    res.end(JSON.stringify(data));
}

async function upstoxFetch(url) {

    if (!TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const response = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${TOKEN}`
        },
        signal: AbortSignal.timeout(20000)
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            `Upstox ${response.status}: ${JSON.stringify(data)}`
        );
    }

    return data?.data?.candles || [];
}

// =====================================================
// DATE HELPERS
// =====================================================

function getIndiaDate(daysAgo = 0) {

    const d = new Date();

    d.setDate(d.getDate() - daysAgo);

    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata"
    }).format(d);
}

// =====================================================
// HISTORICAL DAILY DATA
// =====================================================

async function getDailyCandles(key) {

    const to = getIndiaDate(0);

    const from = getIndiaDate(180);

    const url =
        `${BASE}/historical-candle/` +
        `${encodeURIComponent(key)}/days/1/${to}/${from}`;

    return await upstoxFetch(url);
}

// =====================================================
// HISTORICAL 5 MINUTE DATA
// =====================================================

async function getFiveMinuteCandles(key) {

    const to = getIndiaDate(0);

    const from = getIndiaDate(25);

    const url =
        `${BASE}/historical-candle/` +
        `${encodeURIComponent(key)}/minutes/5/${to}/${from}`;

    const candles = await upstoxFetch(url);

    // Exclude currently forming candle.
    const now = Date.now();

    return candles.filter(c => {
        const start = new Date(c[0]).getTime();

        return start + 5 * 60 * 1000 <= now;
    });
}

// =====================================================
// INSTRUMENT MASTER
// =====================================================

let NSE_STOCKS = [];

let MASTER_LOADED = false;

async function loadNSEStocks() {

    if (MASTER_LOADED) return NSE_STOCKS;

    const response = await fetch(MASTER_URL);

    if (!response.ok) {
        throw new Error("Instrument Master download failed");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const text = zlib.gunzipSync(buffer).toString("utf8");

    const instruments = JSON.parse(text);

    NSE_STOCKS = instruments.filter(item =>

        item.segment === "NSE_EQ" &&
        item.instrument_type === "EQ" &&
        item.instrument_key &&
        item.trading_symbol

    );

    MASTER_LOADED = true;

    return NSE_STOCKS;
}

// =====================================================
// EMA
// =====================================================

function EMA(values, period) {

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

function RSI(values, period = 14) {

    if (values.length <= period) return 0;

    let gain = 0;
    let loss = 0;

    for (
        let i = values.length - period;
        i < values.length;
        i++
    ) {

        const change = values[i] - values[i - 1];

        if (change > 0) gain += change;
        else loss += Math.abs(change);
    }

    if (loss === 0) return 100;

    const rs = gain / loss;

    return 100 - (100 / (1 + rs));
}

// =====================================================
// ATR
// =====================================================

function ATR(candles, period = 14) {

    if (candles.length <= period) return 0;

    const ranges = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];

        const prev = candles[i - 1];

        const tr = Math.max(
            c[2] - c[3],
            Math.abs(c[2] - prev[4]),
            Math.abs(c[3] - prev[4])
        );

        ranges.push(tr);
    }

    const recent = ranges.slice(-period);

    return recent.reduce((a, b) => a + b, 0) /
        recent.length;
}

// =====================================================
// CANDLE ANALYSIS
// =====================================================

function analyseCandles(candles) {

    if (!candles || candles.length < 55) {
        return null;
    }

    // API candles are newest first.
    const sorted = [...candles].sort(
        (a, b) => new Date(a[0]) - new Date(b[0])
    );

    const closes = sorted.map(c => Number(c[4]));

    const latest = sorted[sorted.length - 1];

    const price = Number(latest[4]);

    const ema20 = EMA(closes, 20);

    const ema50 = EMA(closes, 50);

    const rsi = RSI(closes, 14);

    const atr = ATR(sorted, 14);

    const avgVolume = sorted
        .slice(-21, -1)
        .reduce((sum, c) => sum + Number(c[5]), 0) / 20;

    const volume = Number(latest[5]);

    const volumeRatio = avgVolume > 0
        ? volume / avgVolume
        : 0;

    const resistance = Math.max(
        ...sorted.slice(-21, -1).map(c => Number(c[2]))
    );

    const support = Math.min(
        ...sorted.slice(-21, -1).map(c => Number(c[3]))
    );

    return {
        price,
        ema20,
        ema50,
        rsi,
        atr,
        volume,
        volumeRatio,
        resistance,
        support,

        trend:
            price > ema20 && ema20 > ema50
                ? "BULLISH"
                : "WEAK",

        breakout: price > resistance,

        strongVolume:
            volumeRatio >= CONFIG.volumeMultiplier
    };
}

// =====================================================
// SWING SIGNAL ENGINE
// =====================================================

function generateSignal(stock, daily, intraday) {

    const d = analyseCandles(daily);

    const m = analyseCandles(intraday);

    if (!d || !m) return null;

    const price = d.price;

    if (
        price < CONFIG.minPrice ||
        price > CONFIG.maxPrice
    ) return null;

    let score = 0;

    // DAILY CONDITIONS

    if (d.trend === "BULLISH") score += 25;

    if (d.rsi >= CONFIG.dailyRSI) score += 15;

    if (d.strongVolume) score += 15;

    if (d.breakout) score += 15;

    // 5 MIN CONDITIONS

    if (m.trend === "BULLISH") score += 10;

    if (m.rsi >= CONFIG.intradayRSI) score += 10;

    if (m.strongVolume) score += 5;

    if (m.price > m.ema20) score += 5;

    let signal = "WAIT";

    if (score >= 85) {

        signal = "STRONG BUY";

    } else if (score >= 65) {

        signal = "BUY";

    } else if (score < 45) {

        signal = "AVOID";
    }

    // ENTRY AND RISK

    const entry = d.price;

    const atr = d.atr;

    const sl = Math.max(
        d.support,
        entry - atr * CONFIG.atrMultiplier
    );

    const risk = entry - sl;

    if (risk <= 0) return null;

    const target1 =
        entry + risk * CONFIG.target1RR;

    const target2 =
        entry + risk * CONFIG.target2RR;

    return {

        symbol: stock.trading_symbol,

        name: stock.name,

        instrumentKey: stock.instrument_key,

        signal,

        score,

        price: +entry.toFixed(2),

        entry: +entry.toFixed(2),

        stopLoss: +sl.toFixed(2),

        target1: +target1.toFixed(2),

        target2: +target2.toFixed(2),

        daily: {
            rsi: +d.rsi.toFixed(2),
            ema20: +d.ema20.toFixed(2),
            ema50: +d.ema50.toFixed(2),
            volumeRatio: +d.volumeRatio.toFixed(2),
            breakout: d.breakout
        },

        fiveMinute: {
            rsi: +m.rsi.toFixed(2),
            ema20: +m.ema20.toFixed(2),
            volumeRatio: +m.volumeRatio.toFixed(2),
            trend: m.trend
        },

        holdingPeriod: "1-5 DAYS",

        trend: d.trend
    };
}

// =====================================================
// SCAN WORKER
// =====================================================

async function worker(stocks, results, errors) {

    for (const stock of stocks) {

        try {

            const [daily, intraday] = await Promise.all([

                getDailyCandles(stock.instrument_key),

                getFiveMinuteCandles(stock.instrument_key)

            ]);

            const result = generateSignal(
                stock,
                daily,
                intraday
            );

            if (result) results.push(result);

        } catch (error) {

            errors.push({
                symbol: stock.trading_symbol,
                error: error.message
            });

        }

        // Small delay to reduce API pressure.
        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

// =====================================================
// MAIN SCANNER
// =====================================================

async function scanAllStocks(offset = 0, limit = 100) {

    const stocks = await loadNSEStocks();

    const selected = stocks.slice(offset, offset + limit);

    const results = [];

    const errors = [];

    const chunks = [];

    const concurrency = CONFIG.concurrency;

    for (let i = 0; i < selected.length; i += concurrency) {

        chunks.push(selected.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {

        await worker(chunk, results, errors);
    }

    results.sort((a, b) => b.score - a.score);

    return {

        success: true,

        scanner: "SMART TRADE INDIA SWING V2",

        totalNSEStocks: stocks.length,

        scanned: selected.length,

        offset,

        limit,

        strongBuy: results.filter(
            x => x.signal === "STRONG BUY"
        ).length,

        buy: results.filter(
            x => x.signal === "BUY"
        ).length,

        signals: results,

        errors: errors.slice(0, 20),

        timestamp: new Date().toISOString()
    };
}

// =====================================================
// HTTP SERVER
// =====================================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {

        return json(res, 200, { success: true });
    }

    const url = new URL(
        req.url,
        `http://${req.headers.host}`
    );

    try {

        if (url.pathname === "/health") {

            return json(res, 200, {
                success: true,
                app: "SMART TRADE INDIA",
                version: "SWING V2"
            });
        }

        if (url.pathname === "/api/swing/stocks") {

            const stocks = await loadNSEStocks();

            return json(res, 200, {
                success: true,
                total: stocks.length,
                stocks: stocks.slice(0, 100).map(s => ({
                    symbol: s.trading_symbol,
                    name: s.name,
                    instrumentKey: s.instrument_key
                }))
            });
        }

        if (url.pathname === "/api/swing/scan") {

            const offset = Math.max(
                0,
                Number(url.searchParams.get("offset") || 0)
            );

            const limit = Math.min(
                CONFIG.maxLimit,
                Math.max(
                    1,
                    Number(
                        url.searchParams.get("limit") ||
                        CONFIG.defaultLimit
                    )
                )
            );

            const result = await scanAllStocks(
                offset,
                limit
            );

            return json(res, 200, result);
        }

        return json(res, 404, {
            success: false,
            message: "Route not found"
        });

    } catch (error) {

        return json(res, 500, {
            success: false,
            error: error.message
        });
    }
});

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, () => {

    console.log(
        `SMART TRADE INDIA SWING V2 RUNNING ON ${PORT}`
    );

});
