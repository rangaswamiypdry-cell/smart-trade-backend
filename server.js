// ======================================================
// SMART TRADE INDIA
// NSE F&O SHORT TERM SWING SCANNER V1
// ONLY NSE F&O UNDERLYING STOCKS
// 1 TO 5 DAYS UP TREND
// UPSTOX V3 | NODE.JS 20+
// ======================================================

const FNO_INSTRUMENT_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

let fnoUniverseCache = [];
let fnoCacheTime = 0;

// SETTINGS
const SWING_CONFIG = {
    RSI_MIN: 55,
    RSI_MAX: 75,
    VOLUME_MULTIPLIER: 1.5,
    MIN_SCORE: 60,
    EMA_FAST: 20,
    EMA_SLOW: 50,
    RESISTANCE_DAYS: 10,
    BATCH_SIZE: 5
};

// ======================================================
// DATE HELPERS
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
// DOWNLOAD NSE F&O STOCK UNIVERSE
// ======================================================

async function getOnlyNseFnoStocks() {

    if (
        fnoUniverseCache.length &&
        Date.now() - fnoCacheTime < 6 * 60 * 60 * 1000
    ) {
        return fnoUniverseCache;
    }

    const response = await fetch(FNO_INSTRUMENT_URL);

    if (!response.ok) {
        throw new Error("Upstox F&O instrument download failed");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    let instruments;

    try {
        instruments = JSON.parse(
            require("zlib").gunzipSync(buffer).toString("utf8")
        );
    } catch (e) {
        instruments = JSON.parse(buffer.toString("utf8"));
    }

    const stocks = new Map();

    for (const item of instruments) {

        if (item.segment !== "NSE_FO") continue;

        if (item.exchange !== "NSE") continue;

        if (item.underlying_type !== "EQUITY") continue;

        if (!["FUT", "CE", "PE"].includes(item.instrument_type)) {
            continue;
        }

        const key = item.underlying_key;

        if (!key || !key.startsWith("NSE_EQ|")) continue;

        if (!stocks.has(key)) {

            stocks.set(key, {
                symbol: item.underlying_symbol,
                name: item.name,
                instrumentKey: key
            });
        }
    }

    fnoUniverseCache = [...stocks.values()];
    fnoCacheTime = Date.now();

    return fnoUniverseCache;
}

// ======================================================
// UPSTOX HISTORICAL DATA
// ======================================================

async function getSwingDailyCandles(instrumentKey) {

    const token = process.env.UPSTOX_ACCESS_TOKEN;

    if (!token) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const today = getISTDate();
    const fromDate = subtractDays(today, 120);

    const url =
        "https://api.upstox.com/v3/historical-candle/" +
        encodeURIComponent(instrumentKey) +
        "/days/1/" + today + "/" + fromDate;

    const response = await fetch(url, {
        headers: {
            "Authorization": "Bearer " + token,
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error("Candle API error: " + response.status);
    }

    const json = await response.json();

    const candles = json.data?.candles || [];

    // Only completed daily candles.
    return candles
        .filter(c => c[0].slice(0, 10) < today)
        .map(c => ({
            time: c[0],
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5]),
            oi: Number(c[6] || 0)
        }))
        .sort((a, b) =>
            new Date(a.time) - new Date(b.time)
        );
}

// ======================================================
// EMA
// ======================================================

function swingEMA(values, period) {

    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {
        ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
}

// ======================================================
// RSI
// ======================================================

function swingRSI(values, period = 14) {

    if (values.length <= period) return 0;

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
            (avgGain * (period - 1) + Math.max(change, 0)) / period;

        avgLoss =
            (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    }

    if (avgLoss === 0) return 100;

    return 100 - (100 / (1 + avgGain / avgLoss));
}

// ======================================================
// ANALYSE SHORT TERM STOCK
// ======================================================

function analyseSwingStock(stock, candles) {

    if (candles.length < 60) return null;

    const closes = candles.map(c => c.close);

    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const ema20 = swingEMA(closes, 20);
    const ema50 = swingEMA(closes, 50);

    const rsi = swingRSI(closes, 14);

    const previous20 = candles.slice(-21, -1);

    const avgVolume =
        previous20.reduce((s, c) => s + c.volume, 0) / 20;

    const volumeRatio =
        avgVolume > 0 ? last.volume / avgVolume : 0;

    const resistance = Math.max(
        ...candles.slice(-11, -1).map(c => c.high)
    );

    const return5 =
        ((last.close - candles[candles.length - 6].close) /
        candles[candles.length - 6].close) * 100;

    // UP TREND CONDITIONS

    const trendPass = ema20 > ema50;

    const pricePass = last.close > ema20;

    const momentumPass =
        last.close > previous.close && return5 > 0;

    const rsiPass =
        rsi >= SWING_CONFIG.RSI_MIN &&
        rsi <= SWING_CONFIG.RSI_MAX;

    const volumePass =
        volumeRatio >= SWING_CONFIG.VOLUME_MULTIPLIER;

    const breakoutPass =
        last.close > resistance;

    // SCORE

    let score = 0;

    if (trendPass) score += 25;
    if (pricePass) score += 20;
    if (momentumPass) score += 15;
    if (rsiPass) score += 15;
    if (volumePass) score += 15;
    if (breakoutPass) score += 10;

    if (score < SWING_CONFIG.MIN_SCORE) return null;

    // ENTRY / SL / TARGET

    const entry = last.close;

    const stopLoss = Math.min(
        entry * 0.975,
        last.low
    );

    const risk = entry - stopLoss;

    if (risk <= 0) return null;

    const target1 = entry + risk * 2;
    const target2 = entry + risk * 3;

    let signal = "WATCH";

    if (score >= 85) signal = "STRONG BUY";
    else if (score >= 70) signal = "BUY";

    return {

        symbol: stock.symbol,
        stockName: stock.name,

        instrumentKey: stock.instrumentKey,

        signal,
        score,

        price: Number(entry.toFixed(2)),

        ema20: Number(ema20.toFixed(2)),
        ema50: Number(ema50.toFixed(2)),

        rsi: Number(rsi.toFixed(2)),

        volumeRatio: Number(volumeRatio.toFixed(2)),

        fiveDayChange: Number(return5.toFixed(2)),

        breakout: breakoutPass,

        entry: Number(entry.toFixed(2)),
        stopLoss: Number(stopLoss.toFixed(2)),
        target1: Number(target1.toFixed(2)),
        target2: Number(target2.toFixed(2)),

        holdingPeriod: "1-5 DAYS",

        candleDate: last.time
    };
}

// ======================================================
// BATCH SCANNER
// ======================================================

async function scanOnlyNseFnoStocks(offset = 0, limit = 100) {

    const universe = await getOnlyNseFnoStocks();

    const selected = universe.slice(
        offset,
        offset + limit
    );

    const results = [];

    let errors = 0;

    for (
        let i = 0;
        i < selected.length;
        i += SWING_CONFIG.BATCH_SIZE
    ) {

        const batch = selected.slice(
            i,
            i + SWING_CONFIG.BATCH_SIZE
        );

        const batchResults = await Promise.all(
            batch.map(async stock => {

                try {

                    const candles =
                        await getSwingDailyCandles(stock.instrumentKey);

                    return analyseSwingStock(stock, candles);

                } catch (error) {

                    errors++;

                    return null;
                }
            })
        );

        results.push(
            ...batchResults.filter(Boolean)
        );
    }

    results.sort((a, b) => b.score - a.score);

    return {

        success: true,

        market: "NSE",

        scanner: "NSE F&O SHORT TERM SWING",

        totalFnoStocks: universe.length,

        scanned: selected.length,

        offset,

        nextOffset:
            offset + limit < universe.length
                ? offset + limit
                : null,

        errors,

        strongBuy: results.filter(
            x => x.signal === "STRONG BUY"
        ).length,

        buy: results.filter(
            x => x.signal === "BUY"
        ).length,

        watch: results.filter(
            x => x.signal === "WATCH"
        ).length,

        signals: results
    };
}
