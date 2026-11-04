// ======================================================
// SMART TRADE INDIA
// NSE F&O SHORT TERM SWING SCANNER V3
// ONLY NSE F&O EQUITY STOCKS
// 1 TO 5 DAYS MOMENTUM SCANNER
// NODE.JS 20+ | UPSTOX V3 | RENDER
// ======================================================

const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const UPSTOX_BASE = "https://api.upstox.com";

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

    INSTRUMENT_CACHE_TIME:
        6 * 60 * 60 * 1000,

    CANDLE_CACHE_TIME:
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

function json(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

// ======================================================
// IST DATE
// ======================================================

function getISTDate() {

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
// LOAD ONLY NSE F&O STOCKS
// ======================================================

async function loadFnoStocks() {

    if (
        fnoStocks.length > 0 &&
        Date.now() - instrumentCacheTime <
        CONFIG.INSTRUMENT_CACHE_TIME
    ) {
        return fnoStocks;
    }

    console.log("Downloading NSE F&O instruments...");

    const response = await fetchWithTimeout(
        INSTRUMENT_URL
    );

    if (!response.ok) {
        throw new Error(
            "F&O Instrument API Error: " +
            response.status
        );
    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    let raw;

    try {

        if (
            buffer[0] === 0x1f &&
            buffer[1] === 0x8b
        ) {
            raw = zlib.gunzipSync(buffer).toString("utf8");
        } else {
            raw = buffer.toString("utf8");
        }

    } catch (error) {

        throw new Error(
            "Instrument decompression failed"
        );
    }

    const parsed = JSON.parse(raw);

    const instruments = Array.isArray(parsed)
        ? parsed
        : parsed.data || [];

    const stocks = new Map();

    for (const item of instruments) {

        if (item.segment !== "NSE_FO") continue;

        if (item.exchange !== "NSE") continue;

        if (item.instrument_type !== "FUT") continue;

        if (item.underlying_type !== "EQUITY") continue;

        const key = item.underlying_key;

        if (!key || !key.startsWith("NSE_EQ|")) {
            continue;
        }

        if (!stocks.has(key)) {

            stocks.set(key, {

                symbol: item.underlying_symbol,

                name: item.name,

                instrumentKey: key,

                segment: "NSE_FO"

            });
        }
    }

    fnoStocks = [...stocks.values()].sort(
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
// UPSTOX DAILY HISTORICAL CANDLES
// ======================================================

async function getDailyCandles(instrumentKey) {

    if (!TOKEN) {
        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing"
        );
    }

    const cached = candleCache.get(instrumentKey);

    if (
        cached &&
        Date.now() - cached.time <
        CONFIG.CANDLE_CACHE_TIME
    ) {
        return cached.candles;
    }

    const today = getISTDate();

    const fromDate = subtractDays(today, 180);

    const url =
        UPSTOX_BASE +
        "/v3/historical-candle/" +
        encodeURIComponent(instrumentKey) +
        "/days/1/" +
        today +
        "/" +
        fromDate;

    const response = await fetchWithTimeout(url, {

        headers: {
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/json"
        }
    });

    if (!response.ok) {

        throw new Error(
            "Historical API Error: " +
            response.status
        );
    }

    const result = await response.json();

    const rawCandles =
        result.data?.candles || [];

    // Only completed daily candles

    const candles = rawCandles

        .filter(c => {

            const candleDate =
                String(c[0]).slice(0, 10);

            return candleDate < today;
        })

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
            c.close > 0 &&
            c.high > 0 &&
            c.volume >= 0
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
// EMA CALCULATION
// ======================================================

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

// ======================================================
// RSI CALCULATION
// ======================================================

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

    return 100 - (100 / (1 + rs));
}

// ======================================================
// ATR CALCULATION
// ======================================================

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) {
        return null;
    }

    const trs = [];

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

        trs.push(tr);
    }

    if (trs.length < period) return null;

    let atr =
        trs.slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < trs.length; i++) {

        atr =
            ((atr * (period - 1)) + trs[i]) / period;
    }

    return atr;
}

// ======================================================
// STOCK ANALYSIS
// ======================================================

function analyseStock(stock, candles) {

    if (candles.length < 60) return null;

    const closes = candles.map(c => c.close);

    const last = candles[candles.length - 1];

    const previous = candles[candles.length - 2];

    const ema20 = calculateEMA(
        closes,
        CONFIG.EMA_FAST
    );

    const ema50 = calculateEMA(
        closes,
        CONFIG.EMA_SLOW
    );

    const rsi = calculateRSI(
        closes,
        CONFIG.RSI_PERIOD
    );

    const atr = calculateATR(candles, 14);

    if (
        ema20 === null ||
        ema50 === null ||
        rsi === null ||
        atr === null ||
        atr <= 0
    ) {
        return null;
    }

    // ==============================================
    // VOLUME
    // ==============================================

    const volumeCandles = candles.slice(-21, -1);

    const averageVolume =
        volumeCandles.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / volumeCandles.length;

    const volumeRatio =
        averageVolume > 0
            ? last.volume / averageVolume
            : 0;

    // ==============================================
    // FIVE DAY PRICE CHANGE
    // ==============================================

    const fiveDayPrevious =
        candles[candles.length - 6];

    const fiveDayChange =
        (
            (last.close - fiveDayPrevious.close) /
            fiveDayPrevious.close
        ) * 100;

    // ==============================================
    // RESISTANCE
    // ==============================================

    const resistanceCandles =
        candles.slice(-11, -1);

    const resistance = Math.max(
        ...resistanceCandles.map(c => c.high)
    );

    const breakout =
        last.close > resistance;

    // ==============================================
    // TREND CONDITIONS
    // ==============================================

    const trendPass =
        ema20 > ema50;

    const pricePass =
        last.close > ema20;

    const momentumPass =
        last.close > previous.close &&
        fiveDayChange > 0;

    const rsiPass =
        rsi >= CONFIG.RSI_MIN &&
        rsi <= CONFIG.RSI_MAX;

    const volumePass =
        volumeRatio >= CONFIG.VOLUME_MULTIPLIER;

    const emaSlopePass =
        ema20 > calculateEMA(
            closes.slice(0, -5),
            CONFIG.EMA_FAST
        );

    // ==============================================
    // SCORE
    // ==============================================

    let score = 0;

    if (trendPass) score += 25;

    if (pricePass) score += 20;

    if (momentumPass) score += 15;

    if (rsiPass) score += 15;

    if (volumePass) score += 15;

    if (breakout) score += 5;

    if (emaSlopePass) score += 5;

    // Only upward trend stocks

    if (!trendPass) return null;

    if (!pricePass) return null;

    if (!momentumPass) return null;

    if (score < CONFIG.MIN_SCORE) return null;

    // ==============================================
    // SIGNAL
    // ==============================================

    let signal = "WATCH";

    if (score >= CONFIG.STRONG_BUY_SCORE) {

        signal = "STRONG BUY";

    } else if (score >= CONFIG.BUY_SCORE) {

        signal = "BUY";
    }

    // ==============================================
    // ENTRY / STOP LOSS / TARGET
    // ==============================================

    const entry = last.close;

    const riskPercent = Math.min(

        Math.max(
            (atr * 1.5) / entry,
            0.015
        ),

        0.05
    );

    const risk = entry * riskPercent;

    const stopLoss = entry - risk;

    const target1 = entry + risk * 2;

    const target2 = entry + risk * 3;

    // ==============================================
    // RESULT
    // ==============================================

    return {

        symbol: stock.symbol,

        name: stock.name,

        instrumentKey: stock.instrumentKey,

        signal,

        score,

        price: Number(entry.toFixed(2)),

        entry: Number(entry.toFixed(2)),

        stopLoss: Number(stopLoss.toFixed(2)),

        target1: Number(target1.toFixed(2)),

        target2: Number(target2.toFixed(2)),

        riskReward: "1:2 / 1:3",

        ema20: Number(ema20.toFixed(2)),

        ema50: Number(ema50.toFixed(2)),

        rsi: Number(rsi.toFixed(2)),

        atr: Number(atr.toFixed(2)),

        volume: last.volume,

        averageVolume: Math.round(averageVolume),

        volumeRatio: Number(
            volumeRatio.toFixed(2)
        ),

        fiveDayChange: Number(
            fiveDayChange.toFixed(2)
        ),

        breakout,

        trend: "UPTREND",

        emaSlopePass,

        holdingPeriod: "1-5 DAYS",

        timeframe: "1 DAY",

        candleDate: last.time

    };
}

// ======================================================
// SCAN NSE F&O STOCKS
// ======================================================

async function scanOnlyNseFnoStocks(
    offset = 0,
    limit = 100
) {

    const universe = await loadFnoStocks();

    const selected = universe.slice(
        offset,
        offset + limit
    );

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

                    const candles =
                        await getDailyCandles(
                            stock.instrumentKey
                        );

                    return analyseStock(
                        stock,
                        candles
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

    results.sort((a, b) => {

        if (b.score !== a.score) {
            return b.score - a.score;
        }

        return b.fiveDayChange - a.fiveDayChange;
    });

    return {

        success: true,

        scanner: "SMART TRADE INDIA FNO SWING V3",

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

        timestamp: new Date().toISOString()

    };
}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(
    async (req, res) => {

        if (req.method === "OPTIONS") {

            return json(res, 200, {
                success: true
            });
        }

        const url = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        try {

            // ======================================
            // HEALTH
            // ======================================

            if (url.pathname === "/health") {

                return json(res, 200, {

                    success: true,

                    app: "SMART TRADE INDIA",

                    version: "SWING V3",

                    status: "RUNNING",

                    upstoxConnected: Boolean(TOKEN)

                });
            }

            // ======================================
            // UPSTOX STATUS
            // ======================================

            if (url.pathname === "/api/upstox/status") {

                return json(res, 200, {

                    success: Boolean(TOKEN),

                    connected: Boolean(TOKEN),

                    message: TOKEN
                        ? "Upstox token configured"
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

                return json(res, 200, {

                    success: true,

                    total: stocks.length,

                    market: "NSE F&O",

                    stocks: stocks

                });
            }

            // ======================================
            // MAIN F&O SWING SCANNER
            // ======================================

            if (

                url.pathname === "/api/swing/scan" ||

                url.pathname === "/api/swing/fno-scan"

            ) {

                if (!TOKEN) {

                    return json(res, 503, {

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

                const limit = Math.min(

                    CONFIG.MAX_LIMIT,

                    Math.max(

                        1,

                        Number(
                            url.searchParams.get("limit") ||
                            CONFIG.DEFAULT_LIMIT
                        )

                    )

                );

                const result =
                    await scanOnlyNseFnoStocks(
                        offset,
                        limit
                    );

                return json(res, 200, result);
            }

            // ======================================
            // CLEAR CACHE
            // ======================================

            if (
                url.pathname === "/api/swing/clear-cache"
            ) {

                candleCache.clear();

                fnoStocks = [];

                instrumentCacheTime = 0;

                return json(res, 200, {

                    success: true,

                    message: "Cache cleared"

                });
            }

            // ======================================
            // ROUTE NOT FOUND
            // ======================================

            return json(res, 404, {

                success: false,

                message: "Route not found"

            });

        } catch (error) {

            console.error(
                "SERVER ERROR:",
                error
            );

            return json(res, 500, {

                success: false,

                error: error.message

            });
        }
    }
);

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

    console.log(
        "======================================"
    );

    console.log(
        "SMART TRADE INDIA SWING V3 STARTED"
    );

    console.log(
        "PORT:",
        PORT
    );

    console.log(
        "UPSTOX TOKEN:",
        TOKEN ? "CONFIGURED" : "MISSING"
    );

    console.log(
        "======================================"
    );

});
