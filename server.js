// ======================================================
// SMART TRADE INDIA - NSE F&O SWING SCANNER V4
// LIVE MARKET PRICE - UPTSOX API V3
// NODE.JS 20+ | RENDER
// ======================================================

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const BASE = "https://api.upstox.com";

const INSTRUMENT_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ======================================================
// CONFIG
// ======================================================

const CONFIG = {

    EMA_FAST: 20,
    EMA_SLOW: 50,

    RSI_PERIOD: 14,

    RSI_MIN: 55,
    RSI_MAX: 75,

    VOLUME_MULTIPLIER: 1.5,

    RESISTANCE_DAYS: 10,

    MIN_SCORE: 60,

    BUY_SCORE: 70,

    STRONG_BUY_SCORE: 85,

    DEFAULT_LIMIT: 100,

    MAX_LIMIT: 100,

    BATCH_SIZE: 4,

    INSTRUMENT_CACHE_MS:
        6 * 60 * 60 * 1000,

    CANDLE_CACHE_MS:
        5 * 60 * 1000

};

// ======================================================
// CACHE
// ======================================================

let fnoStocks = [];

let instrumentCacheTime = 0;

const candleCache = new Map();

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {

    res.writeHead(status, {

        "Content-Type":
            "application/json; charset=utf-8",

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods":
            "GET, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, Authorization",

        "Cache-Control": "no-store"

    });

    res.end(JSON.stringify(data));

}

// ======================================================
// FETCH TIMEOUT
// ======================================================

async function fetchTimeout(
    url,
    options = {},
    ms = 25000
) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        ms
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
// IST DATE
// ======================================================

function istDate() {

    return new Intl.DateTimeFormat("en-CA", {

        timeZone: "Asia/Kolkata",

        year: "numeric",

        month: "2-digit",

        day: "2-digit"

    }).format(new Date());

}

function subtractDays(date, days) {

    const d = new Date(date + "T00:00:00Z");

    d.setUTCDate(d.getUTCDate() - days);

    return d.toISOString().slice(0, 10);

}

// ======================================================
// UPTSOX AUTHENTICATION
// ======================================================

function authHeaders() {

    if (!TOKEN) {

        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing in Render"
        );

    }

    return {

        Authorization: `Bearer ${TOKEN}`,

        Accept: "application/json"

    };

}

// ======================================================
// LOAD NSE F&O EQUITY STOCKS
// ======================================================

async function loadFnoStocks() {

    if (

        fnoStocks.length > 0 &&

        Date.now() - instrumentCacheTime <
        CONFIG.INSTRUMENT_CACHE_MS

    ) {

        return fnoStocks;

    }

    console.log(
        "Downloading NSE F&O instruments..."
    );

    const response = await fetchTimeout(
        INSTRUMENT_URL
    );

    if (!response.ok) {

        throw new Error(
            "Instrument API Error: " +
            response.status
        );

    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    const raw = (

        buffer[0] === 0x1f &&
        buffer[1] === 0x8b

    )

        ? zlib.gunzipSync(buffer).toString("utf8")

        : buffer.toString("utf8");

    const parsed = JSON.parse(raw);

    const items = Array.isArray(parsed)
        ? parsed
        : parsed.data || [];

    const unique = new Map();

    for (const item of items) {

        if (item.segment !== "NSE_FO") continue;

        if (item.exchange !== "NSE") continue;

        if (item.instrument_type !== "FUT") continue;

        if (item.underlying_type !== "EQUITY") continue;

        const key = item.underlying_key;

        if (!key || !key.startsWith("NSE_EQ|")) {
            continue;
        }

        if (!unique.has(key)) {

            unique.set(key, {

                symbol:
                    item.underlying_symbol ||
                    item.trading_symbol || "",

                name:
                    item.name ||
                    item.underlying_symbol || "",

                instrumentKey: key,

                segment: "NSE_FO"

            });

        }

    }

    fnoStocks = [...unique.values()].sort(
        (a, b) => a.symbol.localeCompare(b.symbol)
    );

    instrumentCacheTime = Date.now();

    console.log(
        "NSE F&O Stocks Loaded:",
        fnoStocks.length
    );

    return fnoStocks;

}

// ======================================================
// DAILY HISTORICAL CANDLES
// ======================================================

async function getDailyCandles(instrumentKey) {

    const cached = candleCache.get(instrumentKey);

    if (

        cached &&

        Date.now() - cached.time <
        CONFIG.CANDLE_CACHE_MS

    ) {

        return cached.candles;

    }

    const today = istDate();

    const fromDate = subtractDays(today, 180);

    const url =

        `${BASE}/v3/historical-candle/` +

        `${encodeURIComponent(instrumentKey)}` +

        `/days/1/${today}/${fromDate}`;

    const response = await fetchTimeout(url, {

        headers: authHeaders()

    });

    const body = await response.json().catch(
        () => ({})
    );

    if (!response.ok) {

        throw new Error(
            "Historical API Error: " +
            response.status
        );

    }

    const candles = (body.data?.candles || [])

        .filter(c =>
            String(c[0]).slice(0, 10) < today
        )

        .map(c => ({

            time: c[0],

            open: Number(c[1]),

            high: Number(c[2]),

            low: Number(c[3]),

            close: Number(c[4]),

            volume: Number(c[5] || 0),

            oi: Number(c[6] || 0)

        }))

        .filter(c =>
            c.close > 0 && c.high > 0
        )

        .sort((a, b) =>
            new Date(a.time) - new Date(b.time)
        );

    candleCache.set(instrumentKey, {

        time: Date.now(),

        candles

    });

    return candles;

}

// ======================================================
// LIVE MARKET PRICE - UPTSOX V3
// IMPORTANT: USE last_price ONLY
// ======================================================

async function getLiveQuotes(stocks) {

    const quotesByKey = new Map();

    const keys = stocks.map(
        s => s.instrumentKey
    );

    for (
        let i = 0;
        i < keys.length;
        i += 500
    ) {

        const group = keys.slice(i, i + 500);

        const url =

            `${BASE}/v3/market-quote/quotes?instrument_key=` +

            encodeURIComponent(group.join(","));

        const response = await fetchTimeout(url, {

            headers: authHeaders()

        });

        const body = await response.json().catch(
            () => ({})
        );

        if (!response.ok) {

            throw new Error(
                "Live Quote API Error: " +
                response.status
            );

        }

        const data = body.data || {};

        for (const quote of Object.values(data)) {

            const key = quote.instrument_token;

            const ltp = Number(quote.last_price);

            if (
                key &&
                Number.isFinite(ltp) &&
                ltp > 0
            ) {

                quotesByKey.set(key, {

                    lastPrice: ltp,

                    volume: Number(
                        quote.volume || 0
                    ),

                    averagePrice: Number(
                        quote.average_price || 0
                    ),

                    previousClose: Number(
                        quote.prev_close_price ||
                        quote.ohlc?.close || 0
                    ),

                    netChange: Number(
                        quote.net_change || 0
                    ),

                    lastTradeTime:
                        quote.last_trade_time || null,

                    quoteTimestamp:
                        quote.timestamp || null

                });

            }

        }

    }

    return quotesByKey;

}
// ======================================================
// EMA CALCULATION
// ======================================================

function ema(values, period) {

    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let value = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        value =
            values[i] * multiplier +
            value * (1 - multiplier);

    }

    return value;

}

// ======================================================
// RSI CALCULATION
// ======================================================

function rsi(values, period = 14) {

    if (values.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses += Math.abs(change);

    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

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

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - 100 / (1 + rs);

}

// ======================================================
// ATR CALCULATION
// ======================================================

function atr(candles, period = 14) {

    if (candles.length < period + 1) {
        return null;
    }

    const ranges = [];

    for (let i = 1; i < candles.length; i++) {

        const current = candles[i];
        const previous = candles[i - 1];

        const tr = Math.max(

            current.high - current.low,

            Math.abs(
                current.high - previous.close
            ),

            Math.abs(
                current.low - previous.close
            )

        );

        ranges.push(tr);

    }

    let value =
        ranges.slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < ranges.length; i++) {

        value =
            (
                value * (period - 1) +
                ranges[i]
            ) / period;

    }

    return value;

}

// ======================================================
// STOCK ANALYSIS
// INDICATORS = COMPLETED DAILY CANDLES
// PRICE = LIVE UPTSOX LTP
// ======================================================

function analyseStock(stock, candles, quote) {

    if (
        candles.length < 60 ||
        !quote ||
        !(quote.lastPrice > 0)
    ) {
        return null;
    }

    const closes = candles.map(c => c.close);

    const last = candles[candles.length - 1];

    const livePrice = quote.lastPrice;

    // EMA

    const ema20 = ema(closes, 20);

    const ema50 = ema(closes, 50);

    // RSI

    const currentRsi = rsi(closes, 14);

    // ATR

    const currentAtr = atr(candles, 14);

    if (
        ema20 === null ||
        ema50 === null ||
        currentRsi === null ||
        currentAtr === null ||
        currentAtr <= 0
    ) {
        return null;
    }

    // ==========================================
    // VOLUME ANALYSIS
    // ==========================================

    const volumeBars = candles.slice(-21, -1);

    const avgVolume =
        volumeBars.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / Math.max(1, volumeBars.length);

    const dailyVolumeRatio =
        avgVolume > 0
            ? last.volume / avgVolume
            : 0;

    // ==========================================
    // FIVE DAY MOMENTUM
    // ==========================================

    const fiveDayBase =
        candles[candles.length - 6];

    const fiveDayChange =
        (
            (livePrice - fiveDayBase.close) /
            fiveDayBase.close
        ) * 100;

    // ==========================================
    // BREAKOUT
    // ==========================================

    const resistanceBars =
        candles.slice(-11, -1);

    const resistance = Math.max(
        ...resistanceBars.map(c => c.high)
    );

    const breakout =
        livePrice > resistance;

    // ==========================================
    // TREND CONDITIONS
    // ==========================================

    const trendPass =
        ema20 > ema50;

    const pricePass =
        livePrice > ema20;

    const momentumPass =
        livePrice > last.close &&
        fiveDayChange > 0;

    const rsiPass =
        currentRsi >= 55 &&
        currentRsi <= 75;

    const volumePass =
        dailyVolumeRatio >= 1.5;

    const oldEma20 =
        ema(closes.slice(0, -5), 20);

    const emaSlopePass =
        oldEma20 !== null &&
        ema20 > oldEma20;

    // ==========================================
    // SCORE CALCULATION
    // ==========================================

    let score = 0;

    if (trendPass) score += 25;

    if (pricePass) score += 20;

    if (momentumPass) score += 15;

    if (rsiPass) score += 15;

    if (volumePass) score += 15;

    if (breakout) score += 5;

    if (emaSlopePass) score += 5;

    // ==========================================
    // UPTREND FILTER
    // ==========================================

    if (!trendPass) return null;

    if (!pricePass) return null;

    if (!momentumPass) return null;

    if (score < CONFIG.MIN_SCORE) return null;

    // ==========================================
    // BUY SIGNAL
    // ==========================================

    let signal = "WATCH";

    if (
        score >= CONFIG.STRONG_BUY_SCORE &&
        rsiPass &&
        volumePass &&
        breakout
    ) {

        signal = "STRONG BUY";

    } else if (score >= CONFIG.BUY_SCORE) {

        signal = "BUY";

    }

    // ==========================================
    // LIVE ENTRY PRICE
    // ==========================================

    const entry = livePrice;

    // ==========================================
    // STOP LOSS AND TARGET
    // ==========================================

    const riskPercent = Math.min(

        Math.max(
            (currentAtr * 1.5) / entry,
            0.015
        ),

        0.05

    );

    const risk = entry * riskPercent;

    const stopLoss = entry - risk;

    const target1 = entry + risk * 2;

    const target2 = entry + risk * 3;

    // ==========================================
    // FINAL RESULT
    // ==========================================

    return {

        symbol: stock.symbol,

        name: stock.name,

        instrumentKey: stock.instrumentKey,

        signal,

        score,

        price: Number(livePrice.toFixed(2)),

        entry: Number(entry.toFixed(2)),

        stopLoss: Number(stopLoss.toFixed(2)),

        target1: Number(target1.toFixed(2)),

        target2: Number(target2.toFixed(2)),

        riskReward: "1:2 / 1:3",

        rsi: Number(currentRsi.toFixed(2)),

        ema20: Number(ema20.toFixed(2)),

        ema50: Number(ema50.toFixed(2)),

        atr: Number(currentAtr.toFixed(2)),

        volume: quote.volume,

        averageVolume: Math.round(avgVolume),

        volumeRatio: Number(
            dailyVolumeRatio.toFixed(2)
        ),

        fiveDayChange: Number(
            fiveDayChange.toFixed(2)
        ),

        breakout,

        resistance: Number(
            resistance.toFixed(2)
        ),

        trend: "UPTREND",

        holdingPeriod: "1-5 DAYS",

        timeframe: "DAILY",

        candleDate: last.time,

        priceSource: "UPSTOX_V3_LAST_PRICE",

        livePriceAvailable: true,

        lastTradeTime: quote.lastTradeTime,

        previousClose: quote.previousClose,

        netChange: quote.netChange

    };

}

// ======================================================
// SCAN NSE F&O STOCKS
// ======================================================

async function scanFno(offset, limit) {

    const universe = await loadFnoStocks();

    const selected = universe.slice(
        offset,
        offset + limit
    );

    // Fetch live market quotes

    const quotes = await getLiveQuotes(selected);

    const results = [];

    const errors = [];

    for (
        let i = 0;
        i < selected.length;
        i += CONFIG.BATCH_SIZE
    ) {

        const batch = selected.slice(
            i,
            i + CONFIG.BATCH_SIZE
        );

        const batchResults = await Promise.all(

            batch.map(async stock => {

                try {

                    const quote = quotes.get(
                        stock.instrumentKey
                    );

                    if (!quote) {

                        errors.push({

                            symbol: stock.symbol,

                            error:
                            "Live LTP missing"

                        });

                        return null;

                    }

                    const candles =
                        await getDailyCandles(
                            stock.instrumentKey
                        );

                    return analyseStock(
                        stock,
                        candles,
                        quote
                    );

                } catch (error) {

                    errors.push({

                        symbol: stock.symbol,

                        error: error.message

                    });

                    return null;

                }

            })

        );

        results.push(
            ...batchResults.filter(Boolean)
        );

    }

    // SORT BY SCORE

    results.sort((a, b) => {

        if (b.score !== a.score) {

            return b.score - a.score;

        }

        return b.fiveDayChange - a.fiveDayChange;

    });

    return {

        success: true,

        scanner:
        "SMART TRADE INDIA NSE F&O SWING V4",

        market: "NSE",

        stockType: "NSE F&O EQUITY ONLY",

        totalFnoStocks: universe.length,

        scanned: selected.length,

        offset,

        limit,

        nextOffset:
            offset + limit < universe.length
                ? offset + limit
                : null,

        previousOffset:
            offset > 0
                ? Math.max(0, offset - limit)
                : null,

        strongBuy: results.filter(
            x => x.signal === "STRONG BUY"
        ).length,

        buy: results.filter(
            x => x.signal === "BUY"
        ).length,

        watch: results.filter(
            x => x.signal === "WATCH"
        ).length,

        errors: errors.length,

        errorDetails: errors.slice(0, 20),

        signals: results,

        priceSource:
        "UPSTOX V3 FULL MARKET QUOTE last_price",

        timestamp: new Date().toISOString()

    };

}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(
    async (req, res) => {

        if (req.method === "OPTIONS") {

            return sendJson(res, 200, {
                success: true
            });

        }

        const url = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        try {

            if (req.method !== "GET") {

                return sendJson(res, 405, {

                    success: false,

                    error: "GET only"

                });

            }

            // ======================================
            // HEALTH CHECK
            // ======================================

            if (url.pathname === "/health") {

                return sendJson(res, 200, {

                    success: true,

                    app: "SMART TRADE INDIA",

                    version: "SWING V4 LIVE PRICE",

                    status: "RUNNING",

                    upstoxConnected: Boolean(TOKEN)

                });

            }

            // ======================================
            // UPTSOX STATUS
            // ======================================

            if (
                url.pathname === "/api/upstox/status"
            ) {

                return sendJson(res, 200, {

                    success: Boolean(TOKEN),

                    connected: Boolean(TOKEN),

                    message: TOKEN
                        ? "Access token configured"
                        : "UPSTOX_ACCESS_TOKEN missing"

                });

            }

            // ======================================
            // NSE F&O STOCK LIST
            // ======================================

            if (
                url.pathname === "/api/swing/stocks"
            ) {

                const stocks = await loadFnoStocks();

                return sendJson(res, 200, {

                    success: true,

                    total: stocks.length,

                    market: "NSE F&O",

                    stocks

                });

            }

            // ======================================
            // MAIN SWING SCANNER
            // ======================================

            if (

                url.pathname === "/api/swing/scan" ||

                url.pathname === "/api/swing/fno-scan"

            ) {

                if (!TOKEN) {

                    return sendJson(res, 503, {

                        success: false,

                        error:
                        "UPSTOX_ACCESS_TOKEN missing in Render"

                    });

                }

                const offset = Math.max(

                    0,

                    Number(
                        url.searchParams.get("offset") || 0
                    )

                );

                const requestedLimit = Number(

                    url.searchParams.get("limit") ||
                    CONFIG.DEFAULT_LIMIT

                );

                const limit = Math.min(

                    CONFIG.MAX_LIMIT,

                    Math.max(
                        1,
                        Number.isFinite(requestedLimit)
                            ? requestedLimit
                            : CONFIG.DEFAULT_LIMIT
                    )

                );

                const result = await scanFno(
                    offset,
                    limit
                );

                return sendJson(res, 200, result);

            }

            // ======================================
            // UNKNOWN ROUTE
            // ======================================

            return sendJson(res, 404, {

                success: false,

                error: "Route not found"

            });

        } catch (error) {

            console.error(
                "API ERROR:",
                error
            );

            return sendJson(res, 500, {

                success: false,

                error:
                error.message ||
                "Internal Server Error"

            });

        }

    }

);

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA SWING V4 RUNNING ON PORT",
        PORT
    );

});
            
