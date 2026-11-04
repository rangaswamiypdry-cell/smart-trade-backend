// ==========================================
// SMART TRADE INDIA V2
// 1-5 DAYS SWING TRADING SCANNER
// UPSTOX API V3
// ==========================================

async function getSwingDailyCandles(instrumentKey) {

    const now = new Date();

    const indiaTime = new Date(
        now.toLocaleString("en-US", {
            timeZone: "Asia/Kolkata"
        })
    );

    const toDate =
        indiaTime.getFullYear() + "-" +
        String(indiaTime.getMonth() + 1).padStart(2, "0") + "-" +
        String(indiaTime.getDate()).padStart(2, "0");

    const from = new Date(indiaTime);

    from.setDate(from.getDate() - 180);

    const fromDate =
        from.getFullYear() + "-" +
        String(from.getMonth() + 1).padStart(2, "0") + "-" +
        String(from.getDate()).padStart(2, "0");

    const key = encodeURIComponent(instrumentKey);

    const path =
        `/v3/historical-candle/${key}/days/1/${toDate}/${fromDate}`;

    const response = await upstoxFetch(path);

    const candles = response?.data?.candles || [];

    return candles.map(c => ({

        timestamp: c[0],

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5] || 0)

    })).filter(c =>

        Number.isFinite(c.close) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.volume)

    ).sort((a, b) =>

        Date.parse(a.timestamp) - Date.parse(b.timestamp)

    );
}function swingEMA(values, period) {

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
}function swingRSI(values, period = 14) {

    if (values.length <= period) return null;

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const diff = values[i] - values[i - 1];

        if (diff > 0) gain += diff;
        else loss += Math.abs(diff);
    }

    let avgGain = gain / period;
    let avgLoss = loss / period;

    for (let i = period + 1; i < values.length; i++) {

        const diff = values[i] - values[i - 1];

        avgGain =
            (avgGaifunction swingATR(candles, period = 14) {

    if (candles.length < period + 1) return null;

    const trs = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const p = candles[i - 1];

        trs.push(Math.max(

            c.high - c.low,

            Math.abs(c.high - p.close),

            Math.abs(c.low - p.close)

        ));
    }

    const recent = trs.slice(-period);

    return recent.reduce((a, b) => a + b, 0) / period;
        }n * 13 + Math.max(diff, 0)) / 14;

        avgLoss =
            (avgLoss * 13 + Math.max(-diff, 0)) / 14;
    }

    if (avgLoss === 0) return 100;

    return 100 - (100 / (1 + avgGain / avgLoss));
        }// ==========================================
// 1-5 DAY SWING MOMENTUM ANALYSIS
// ==========================================

function analyseSwing1to5(stock, rawCandles) {

    const candles = rawCandles;

    if (!candles || candles.length < 60) {
        return null;
    }

    const closes = candles.map(c => c.close);

    const latest = candles[candles.length - 1];

    const previous = candles.slice(0, -1);

    const ema20 = swingEMA(closes, 20);

    const ema50 = swingEMA(closes, 50);

    const rsi = swingRSI(closes, 14);

    const atr = swingATR(candles, 14);

    const oldEMA20 = swingEMA(
        closes.slice(0, -5),
        20
    );

    if (!ema20 || !ema50 || !rsi || !atr || !oldEMA20) {
        return null;
    }

    // Previous 10 Day High

    const previous10 = previous.slice(-10);

    const resistance = Math.max(
        ...previous10.map(c => c.high)
    );

    // Previous 20 Day Volume

    const previous20 = previous.slice(-20);

    const avgVolume =
        previous20.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / 20;

    const volumeRatio = avgVolume > 0
        ? latest.volume / avgVolume
        : 0;

    // Average Traded Value

    const avgTurnover =
        previous20.reduce(
            (sum, c) => sum + c.close * c.volume,
            0
        ) / 20;

    // ATR Percentage

    const atrPercent =
        (atr / latest.close) * 100;

    // Candle Strength

    const candleRange = latest.high - latest.low;

    const closePosition = candleRange > 0
        ? (latest.close - latest.low) / candleRange
        : 0;

    // =================================
    // TREND CONDITIONS
    // =================================

    const trendUp =
        latest.close > ema20 &&
        ema20 > ema50;

    const emaRising =
        ema20 > oldEMA20;

    const rsiStrong =
        rsi >= 52 && rsi <= 68;

    const volumeStrong =
        volumeRatio >= 1.5;

    const breakout =
        latest.close > resistance;

    const nearBreakout =
        latest.close >= resistance * 0.97;

    const candleStrong =
        latest.close > latest.open &&
        closePosition >= 0.65;

    const liquidity =
        avgTurnover >= 50000000;

    const volatility =
        atrPercent >= 1 &&
        atrPercent <= 5;

    // =================================
    // SCORE CALCULATION
    // =================================

    let score = 0;

    if (trendUp) score += 25;

    if (emaRising) score += 10;

    if (rsiStrong) score += 15;

    if (volumeRatio >= 1.5) score += 15;
    else if (volumeRatio >= 1.2) score += 8;

    if (breakout) score += 20;
    else if (nearBreakout) score += 12;

    if (candleStrong) score += 10;

    if (volatility) score += 5;

    // =================================
    // SIGNAL
    // =================================

    let signal = "WAIT";

    if (
        score >= 80 &&
        trendUp &&
        emaRising &&
        breakout &&
        liquidity
    ) {

        signal = "STRONG BUY";

    } else if (
        score >= 65 &&
        trendUp &&
        emaRising &&
        liquidity
    ) {

        signal = "BUY WATCH";
    }

    // =================================
    // ENTRY / SL / TARGET
    // =================================

    const entry =
        latest.high * 1.001;

    const stopLoss =
        entry - (1.5 * atr);

    const risk =
        entry - stopLoss;

    const target1 =
        entry + (1.5 * risk);

    const target2 =
        entry + (2.5 * risk);

    return {

        symbol: stock.trading_symbol,

        instrumentKey: stock.instrument_key,

        signal,

        timeframe: "DAILY",

        holdingPeriod: "1-5 DAYS",

        score,

        price: Number(latest.close.toFixed(2)),

        entry: Number(entry.toFixed(2)),

        stopLoss: Number(stopLoss.toFixed(2)),

        target1: Number(target1.toFixed(2)),

        target2: Number(target2.toFixed(2)),

        ema20: Number(ema20.toFixed(2)),

        ema50: Number(ema50.toFixed(2)),

        rsi: Number(rsi.toFixed(2)),

        atr: Number(atr.toFixed(2)),

        atrPercent: Number(atrPercent.toFixed(2)),

        volumeRatio: Number(volumeRatio.toFixed(2)),

        resistance: Number(resistance.toFixed(2)),

        avgTurnover: Math.round(avgTurnover),

        breakout,

        riskReward: "1:1.5 / 1:2.5",

        validForSessions: 2,

        updatedAt: new Date().toISOString()

    };
    }// ==========================================
// MAIN 1-5 DAY SWING SCANNER
// ==========================================

async function scanSwingStocks(type = "ALL", limit = 100) {

    const all = await loadInstruments();

    let stocks = type === "FNO"
        ? all.filter(s => s.isFNO)
        : all;

    const scanLimit = Number(
        process.env.SWING_SCAN_LIMIT || 100
    );

    if (scanLimit > 0) {
        stocks = stocks.slice(0, scanLimit);
    }

    if (limit > 0) {
        stocks = stocks.slice(0, limit);
    }

    console.log(
        "SWING SCANNER:",
        type,
        stocks.length
    );

    const results = await runWorkers(

        stocks,

        async stock => {

            try {

                const candles =
                    await getSwingDailyCandles(
                        stock.instrument_key
                    );

                return analyseSwing1to5(
                    stock,
                    candles
                );

            } catch (error) {

                console.error(
                    stock.trading_symbol,
                    error.message
                );

                return null;
            }

        },

        Math.min(SETTINGS.WORKERS || 3, 5)

    );

    const valid = results.filter(Boolean);

    const priority = {
        "STRONG BUY": 3,
        "BUY WATCH": 2,
        "WAIT": 1
    };

    valid.sort((a, b) => {

        if (priority[b.signal] !== priority[a.signal]) {
            return priority[b.signal] - priority[a.signal];
        }

        return b.score - a.score;

    });

    return valid;
}// ==========================================
// SWING TRADING SCANNER API
// ==========================================

if (url.pathname === "/api/scanner/swing") {

    try {

        const type = (
            url.searchParams.get("type") || "ALL"
        ).toUpperCase();

        const limit = Math.min(
            Number(url.searchParams.get("limit") || 100),
            200
        );

        if (!["ALL", "FNO"].includes(type)) {

            return sendJson(res, 400, {
                success: false,
                error: "Use ALL or FNO"
            });
        }

        const results = await scanSwingStocks(
            type,
            limit
        );

        return sendJson(res, 200, {

            success: true,

            scanner: "SMART TRADE INDIA SWING SCANNER",

            timeframe: "DAILY",

            holdingPeriod: "1-5 TRADING DAYS",

            market: type,

            totalScanned: results.length,

            strongBuy: results.filter(
                x => x.signal === "STRONG BUY"
            ).length,

            buyWatch: results.filter(
                x => x.signal === "BUY WATCH"
            ).length,

            wait: results.filter(
                x => x.signal === "WAIT"
            ).length,

            data: results,

            updatedAt: new Date().toISOString()

        });

    } catch (error) {

        console.error("SWING SCANNER ERROR:", error);

        return sendJson(res, 500, {

            success: false,

            error: error.message

        });
    }
              }
