// ======================================================
// SMART TRADE INDIA V8 PRO
// LIVE NSE F&O + ORB + OPTIONS SCANNER
// PART 1 OF 3
// NODE.JS 20+
// ======================================================

"use strict";

const http = require("http");
const zlib = require("zlib");

// ======================================================
// ENVIRONMENT
// ======================================================

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ======================================================
// CONFIGURATION
// ======================================================

const CONFIG = {

    VERSION: "SMART_TRADE_INDIA_V8_PRO",

    TIMEFRAME: 5,

    ORB_START: "09:15",

    ORB_END: "09:30",

    RSI_PERIOD: 14,

    RSI_BUY: 55,

    RSI_SELL: 45,

    VOLUME_MULTIPLIER: 1.5,

    STRONG_VOLUME: 2,

    MIN_CANDLES: 21,

    SCAN_LIMIT: 224,

    CONCURRENCY: 3,

    CACHE_MS: 10000,

    OPTION_DELTA_MIN: 0.40,

    OPTION_DELTA_MAX: 0.70,

    OPTION_SL_PERCENT: 25,

    OPTION_TARGET1_PERCENT: 50,

    OPTION_TARGET2_PERCENT: 75

};

// ======================================================
// GLOBAL VARIABLES
// ======================================================

let equityMaster = [];

let futuresMaster = [];

let fnoStocks = [];

let masterLoaded = false;

let masterLoading = false;

let scanRunning = false;

let scanCache = null;

let lastScan = {
    status: "IDLE",
    scanned: 0,
    bullish: 0,
    bearish: 0,
    waiting: 0,
    errors: 0
};

// ======================================================
// HELPERS
// ======================================================

function round(value) {

    const n = Number(value);

    return Number.isFinite(n)
        ? Number(n.toFixed(2))
        : null;
}

function sleep(ms) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );

}

function istDate(date = new Date()) {

    return new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }
    ).format(date);

}

function istTime(date = new Date()) {

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }
    ).format(date);

}

// ======================================================
// MARKET HOURS
// ======================================================

function isMarketOpen() {

    const day = new Intl.DateTimeFormat(
        "en-US",
        {
            timeZone: "Asia/Kolkata",
            weekday: "short"
        }
    ).format(new Date());

    if (day === "Sat" || day === "Sun") {
        return false;
    }

    const time = istTime();

    return time >= "09:15" && time <= "15:30";

}

// ======================================================
// UPSTOX API REQUEST
// ======================================================

async function upstoxGET(path) {

    if (!TOKEN) {
        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing in Render"
        );
    }

    const response = await fetch(
        API + path,
        {
            method: "GET",

            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${TOKEN}`
            },

            signal: AbortSignal.timeout(20000)
        }
    );

    const data = await response.json();

    if (!response.ok) {

        throw new Error(
            data?.errors?.[0]?.message ||
            data?.message ||
            `Upstox HTTP ${response.status}`
        );

    }

    return data;

}

// ======================================================
// DOWNLOAD INSTRUMENT MASTER
// ======================================================

async function downloadMaster() {

    const response = await fetch(
        MASTER_URL,
        {
            signal: AbortSignal.timeout(60000)
        }
    );

    if (!response.ok) {

        throw new Error(
            "Instrument Master Download Failed"
        );

    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    let rows;

    try {

        rows = JSON.parse(
            zlib.gunzipSync(buffer).toString("utf8")
        );

    } catch {

        rows = JSON.parse(
            buffer.toString("utf8")
        );

    }

    if (!Array.isArray(rows)) {

        throw new Error(
            "Invalid Instrument Master"
        );

    }

    return rows;

}

// ======================================================
// BUILD NSE F&O STOCK LIST
// ======================================================

function buildFnoStocks(rows) {

    const equities = rows.filter(x =>

        x.segment === "NSE_EQ" &&

        x.instrument_type === "EQ" &&

        x.instrument_key &&

        x.trading_symbol

    );

    const futures = rows.filter(x =>

        x.segment === "NSE_FO" &&

        x.instrument_type === "FUT" &&

        x.instrument_key &&

        x.underlying_symbol &&

        x.expiry

    );

    const equityMap = new Map();

    for (const item of equities) {

        equityMap.set(
            item.trading_symbol.toUpperCase(),
            item
        );

    }

    const today = istDate();

    const futureMap = new Map();

    for (const item of futures) {

        const symbol = String(
            item.underlying_symbol
        ).toUpperCase();

        const expiry = String(
            item.expiry
        ).slice(0, 10);

        if (expiry < today) continue;

        if (!futureMap.has(symbol)) {
            futureMap.set(symbol, []);
        }

        futureMap.get(symbol).push(item);

    }

    const result = [];

    for (const [symbol, contracts] of futureMap) {

        const equity = equityMap.get(symbol);

        if (!equity) continue;

        contracts.sort((a, b) =>
            String(a.expiry).localeCompare(
                String(b.expiry)
            )
        );

        const future = contracts[0];

        result.push({

            symbol,

            equityKey: equity.instrument_key,

            futuresKey: future.instrument_key,

            futuresSymbol: future.trading_symbol,

            expiry: future.expiry

        });

    }

    return result
        .sort((a, b) =>
            a.symbol.localeCompare(b.symbol)
        )
        .slice(0, CONFIG.SCAN_LIMIT);

}

// ======================================================
// LOAD INSTRUMENT MASTER
// ======================================================

async function loadMaster(force = false) {

    if (masterLoading) {

        while (masterLoading) {
            await sleep(200);
        }

        return;

    }

    if (masterLoaded && !force) return;

    masterLoading = true;

    try {

        const rows = await downloadMaster();

        equityMaster = rows.filter(x =>

            x.segment === "NSE_EQ" &&

            x.instrument_type === "EQ"

        );

        futuresMaster = rows.filter(x =>

            x.segment === "NSE_FO" &&

            x.instrument_type === "FUT"

        );

        fnoStocks = buildFnoStocks(rows);

        masterLoaded = true;

        console.log(
            "[V8] Equity:",
            equityMaster.length
        );

        console.log(
            "[V8] Futures:",
            futuresMaster.length
        );

        console.log(
            "[V8] F&O Stocks:",
            fnoStocks.length
        );

    } finally {

        masterLoading = false;

    }

}

// ======================================================
// GET COMPLETED 5 MINUTE CANDLES
// ======================================================

async function getFiveMinuteCandles(instrumentKey) {

    const key = encodeURIComponent(instrumentKey);

    const result = await upstoxGET(

        `/v3/historical-candle/intraday/${key}/minutes/5`

    );

    const raw = result?.data?.candles || [];

    const now = Date.now();

    return raw

        .map(c => ({

            time: new Date(c[0]).getTime(),

            open: Number(c[1]),

            high: Number(c[2]),

            low: Number(c[3]),

            close: Number(c[4]),

            volume: Number(c[5] || 0),

            oi: Number(c[6] || 0)

        }))

        .filter(c =>

            Number.isFinite(c.time) &&

            c.time + 5 * 60 * 1000 <= now

        )

        .sort((a, b) => a.time - b.time);

}

// ======================================================
// GET FUTURES LIVE QUOTES
// ======================================================

async function getFuturesQuotes(stocks) {

    const quotes = {};

    const keys = stocks
        .map(x => x.futuresKey)
        .filter(Boolean);

    for (let i = 0; i < keys.length; i += 100) {

        const batch = keys.slice(i, i + 100);

        const query = encodeURIComponent(
            batch.join(",")
        );

        const result = await upstoxGET(

            `/v3/market-quote/quotes?instrument_key=${query}`

        );

        Object.assign(
            quotes,
            result.data || {}
        );

    }

    return quotes;

}

// ======================================================
// FIND FUTURES QUOTE
// ======================================================

function findFuturesQuote(stock, quotes) {

    const key = stock.futuresKey;

    if (quotes[key]) return quotes[key];

    return Object.values(quotes).find(q =>

        q.instrument_token === key

    ) || null;

}

// ======================================================
// RSI 14
// ======================================================

function calculateRSI(closes, period = 14) {

    if (closes.length <= period) return null;

    let gains = 0;

    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change = closes[i] - closes[i - 1];

        if (change > 0) gains += change;
        else losses -= change;

    }

    let avgGain = gains / period;

    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {

        const change = closes[i] - closes[i - 1];

        avgGain =
            (
                avgGain * (period - 1) +
                Math.max(change, 0)
            ) / period;

        avgLoss =
            (
                avgLoss * (period - 1) +
                Math.max(-change, 0)
            ) / period;

    }

    if (avgLoss === 0) return 100;

    return round(
        100 - 100 / (1 + avgGain / avgLoss)
    );

}

// ======================================================
// VWAP
// ======================================================

function calculateVWAP(candles) {

    let totalPV = 0;

    let totalVolume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        totalPV += typical * c.volume;

        totalVolume += c.volume;

    }

    if (totalVolume === 0) return null;

    return round(totalPV / totalVolume);

}

// ======================================================
// TODAY CANDLES
// ======================================================

function getTodayCandles(candles) {

    const today = istDate();

    return candles.filter(c =>

        istDate(new Date(c.time)) === today

    );

}

// ======================================================
// SMART TRADE INDIA V8 PRO
// PART 2 OF 3
// AUTOMATIC CE / PE STRIKE SELECTOR
// ======================================================


// ======================================================
// OPTION CONTRACT CACHE
// ======================================================

const optionContractCache = new Map();

const optionChainCache = new Map();


// ======================================================
// GET OPTION CONTRACTS
// ======================================================

async function getOptionContracts(instrumentKey) {

    const cached = optionContractCache.get(instrumentKey);

    if (
        cached &&
        Date.now() - cached.time < 60000
    ) {
        return cached.data;
    }

    const key = encodeURIComponent(instrumentKey);

    const result = await upstoxGET(
        `/v2/option/contract?instrument_key=${key}`
    );

    const contracts = result?.data || [];

    if (!Array.isArray(contracts)) {
        throw new Error("Invalid option contracts response");
    }

    optionContractCache.set(instrumentKey, {
        time: Date.now(),
        data: contracts
    });

    return contracts;
}


// ======================================================
// FIND NEAREST VALID EXPIRY
// ======================================================

function findNearestExpiry(contracts) {

    const today = istDate();

    const expiries = [

        ...new Set(

            contracts

                .map(x => String(x.expiry || "").slice(0, 10))

                .filter(x =>
                    /^\d{4}-\d{2}-\d{2}$/.test(x) &&
                    x >= today
                )

        )

    ].sort();

    return expiries[0] || null;
}


// ======================================================
// GET OPTION CHAIN
// ======================================================

async function getOptionChain(instrumentKey, expiry) {

    const cacheKey = `${instrumentKey}_${expiry}`;

    const cached = optionChainCache.get(cacheKey);

    if (
        cached &&
        Date.now() - cached.time < 5000
    ) {
        return cached.data;
    }

    const key = encodeURIComponent(instrumentKey);

    const exp = encodeURIComponent(expiry);

    const result = await upstoxGET(

        `/v2/option/chain?instrument_key=${key}&expiry_date=${exp}`

    );

    const chain = result?.data || [];

    if (!Array.isArray(chain)) {
        throw new Error("Invalid option chain response");
    }

    optionChainCache.set(cacheKey, {
        time: Date.now(),
        data: chain
    });

    return chain;
}


// ======================================================
// OPTION MARKET DATA
// ======================================================

function getOptionMarketData(option) {

    const market = option?.market_data || {};

    const greeks = option?.option_greeks || {};

    return {

        instrumentKey:
            option?.instrument_key || null,

        ltp:
            Number(market.ltp || 0),

        closePrice:
            Number(market.close_price || 0),

        volume:
            Number(market.volume || 0),

        oi:
            Number(market.oi || 0),

        previousOI:
            Number(market.prev_oi || 0),

        bidPrice:
            Number(market.bid_price || 0),

        bidQty:
            Number(market.bid_qty || 0),

        askPrice:
            Number(market.ask_price || 0),

        askQty:
            Number(market.ask_qty || 0),

        delta:
            Number(greeks.delta || 0),

        gamma:
            Number(greeks.gamma || 0),

        theta:
            Number(greeks.theta || 0),

        iv:
            Number(greeks.iv || 0)

    };

}


// ======================================================
// OPTION LIQUIDITY CHECK
// ======================================================

function checkOptionLiquidity(data) {

    if (
        !data.instrumentKey ||
        data.ltp <= 0 ||
        data.volume <= 0 ||
        data.oi <= 0
    ) {
        return {
            valid: false,
            reason: "Insufficient option liquidity data"
        };
    }

    if (
        data.bidPrice <= 0 ||
        data.askPrice <= 0
    ) {
        return {
            valid: false,
            reason: "Bid/Ask unavailable"
        };
    }

    if (data.askPrice < data.bidPrice) {
        return {
            valid: false,
            reason: "Invalid bid ask spread"
        };
    }

    const spread =
        data.askPrice - data.bidPrice;

    const spreadPercent =
        (spread / data.ltp) * 100;

    if (spreadPercent > 3) {
        return {
            valid: false,
            reason: "Spread too high"
        };
    }

    return {

        valid: true,

        spread: round(spread),

        spreadPercent: round(spreadPercent)

    };

}


// ======================================================
// SCORE OPTION CONTRACT
// ======================================================

function scoreOption(data, direction) {

    const liquidity = checkOptionLiquidity(data);

    if (!liquidity.valid) {
        return null;
    }

    const delta = Math.abs(data.delta);

    if (
        delta < CONFIG.OPTION_DELTA_MIN ||
        delta > CONFIG.OPTION_DELTA_MAX
    ) {
        return null;
    }

    let score = 0;

    // DELTA SCORE

    score += 30 -
        Math.abs(delta - 0.55) * 100;

    // VOLUME SCORE

    if (data.volume >= 10000) {
        score += 20;
    } else if (data.volume >= 3000) {
        score += 15;
    } else if (data.volume >= 1000) {
        score += 8;
    }

    // OPEN INTEREST SCORE

    if (data.oi >= 100000) {
        score += 15;
    } else if (data.oi >= 30000) {
        score += 10;
    } else if (data.oi >= 10000) {
        score += 5;
    }

    // BID ASK SPREAD SCORE

    if (liquidity.spreadPercent <= 0.5) {
        score += 20;
    } else if (liquidity.spreadPercent <= 1) {
        score += 15;
    } else if (liquidity.spreadPercent <= 2) {
        score += 8;
    }

    // BID / ASK QUANTITY

    if (
        data.bidQty > 0 &&
        data.askQty > 0
    ) {
        score += 5;
    }

    // OI INCREASE

    if (
        data.previousOI > 0 &&
        data.oi > data.previousOI
    ) {
        score += 10;
    }

    return {

        score: round(score),

        liquidity,

        direction

    };

}


// ======================================================
// SELECT BEST CE / PE STRIKE
// ======================================================

async function selectBestOption(stock, stockSignal) {

    try {

        if (!stock || !stock.equityKey) {

            return {
                success: false,
                reason: "Underlying instrument key missing"
            };

        }

        let optionType;

        let direction;

        if (stockSignal.signal === "BUY") {

            optionType = "CE";

            direction = "BULLISH";

        } else if (stockSignal.signal === "SELL") {

            optionType = "PE";

            direction = "BEARISH";

        } else {

            return {
                success: false,
                reason: "No confirmed stock signal"
            };

        }

        // GET AVAILABLE CONTRACTS

        const contracts = await getOptionContracts(
            stock.equityKey
        );

        if (!contracts.length) {

            return {
                success: false,
                reason: "No option contracts found"
            };

        }

        // FIND NEAREST EXPIRY

        const expiry = findNearestExpiry(contracts);

        if (!expiry) {

            return {
                success: false,
                reason: "No valid future expiry"
            };

        }

        // GET OPTION CHAIN

        const chain = await getOptionChain(
            stock.equityKey,
            expiry
        );

        if (!chain.length) {

            return {
                success: false,
                reason: "Option chain unavailable"
            };

        }

        const candidates = [];

        for (const row of chain) {

            const option = optionType === "CE"
                ? row.call_options
                : row.put_options;

            if (!option) continue;

            const data = getOptionMarketData(option);

            const result = scoreOption(
                data,
                direction
            );

            if (!result) continue;

            candidates.push({

                symbol: stock.symbol,

                direction,

                optionType,

                strikePrice: Number(row.strike_price),

                expiry,

                instrumentKey: data.instrumentKey,

                tradingSymbol:
                    contracts.find(c =>
                        c.instrument_key === data.instrumentKey
                    )?.trading_symbol || null,

                premium: data.ltp,

                volume: data.volume,

                oi: data.oi,

                previousOI: data.previousOI,

                oiChange:
                    data.oi - data.previousOI,

                bidPrice: data.bidPrice,

                askPrice: data.askPrice,

                bidQty: data.bidQty,

                askQty: data.askQty,

                delta: round(data.delta),

                gamma: round(data.gamma),

                theta: round(data.theta),

                iv: round(data.iv),

                spread: result.liquidity.spread,

                spreadPercent:
                    result.liquidity.spreadPercent,

                score: result.score

            });

        }

        if (!candidates.length) {

            return {
                success: false,
                reason: "No liquid option matched selector filters"
            };

        }

        // BEST SCORE FIRST

        candidates.sort((a, b) =>
            b.score - a.score
        );

        const best = candidates[0];

        // OPTION ENTRY

        const entry = best.askPrice;

        if (!Number.isFinite(entry) || entry <= 0) {

            return {
                success: false,
                reason: "Invalid option entry premium"
            };

        }

        // PREMIUM RISK

        const stopLoss = round(
            entry * (
                1 - CONFIG.OPTION_SL_PERCENT / 100
            )
        );

        const target1 = round(
            entry * (
                1 + CONFIG.OPTION_TARGET1_PERCENT / 100
            )
        );

        const target2 = round(
            entry * (
                1 + CONFIG.OPTION_TARGET2_PERCENT / 100
            )
        );

        return {

            success: true,

            signal: `BUY_${optionType}`,

            symbol: best.symbol,

            optionType: best.optionType,

            direction: best.direction,

            tradingSymbol: best.tradingSymbol,

            instrumentKey: best.instrumentKey,

            strikePrice: best.strikePrice,

            expiry: best.expiry,

            premium: best.premium,

            entry,

            stopLoss,

            target1,

            target2,

            volume: best.volume,

            oi: best.oi,

            oiChange: best.oiChange,

            bidPrice: best.bidPrice,

            askPrice: best.askPrice,

            spreadPercent: best.spreadPercent,

            delta: best.delta,

            score: best.score,

            selectionMethod:
                "DELTA + VOLUME + OI + BID ASK LIQUIDITY",

            updatedAt: new Date().toISOString()

        };

    } catch (error) {

        console.error(
            "[V8 OPTION SELECTOR]",
            stock?.symbol,
            error.message
        );

        return {

            success: false,

            symbol: stock?.symbol || null,

            reason: error.message

        };

    }

}



// ======================================================
// ORB CALCULATION
// ======================================================

function calculateORB(candles) {

    const todayCandles = getTodayCandles(candles);

    const openingCandles = todayCandles.filter(c => {

        const time = istTime(new Date(c.time));

        return (
            time >= CONFIG.ORB_START &&
            time < CONFIG.ORB_END
        );

    });

    if (openingCandles.length < 3) {

        return {
            ready: false,
            reason: "WAITING_FOR_ORB_CANDLES"
        };

    }

    return {

        ready: true,

        high: Math.max(
            ...openingCandles.map(c => c.high)
        ),

        low: Math.min(
            ...openingCandles.map(c => c.low)
        ),

        candles: openingCandles.length

    };

}


// ======================================================
// VOLUME ANALYSIS
// ======================================================

function analyseVolume(candles) {

    if (candles.length < CONFIG.MIN_CANDLES) {

        return {
            valid: false,
            volumePass: false,
            ratio: 0
        };

    }

    const previous = candles.slice(
        -CONFIG.MIN_CANDLES,
        -1
    );

    const averageVolume =
        previous.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / previous.length;

    const last = candles[candles.length - 1];

    const ratio = averageVolume > 0
        ? last.volume / averageVolume
        : 0;

    return {

        valid: true,

        latestVolume: last.volume,

        averageVolume: round(averageVolume),

        ratio: round(ratio),

        volumePass:
            ratio >= CONFIG.VOLUME_MULTIPLIER,

        strongVolume:
            ratio >= CONFIG.STRONG_VOLUME

    };

}


// ======================================================
// CANDLE CONFIRMATION
// ======================================================

function isBullishCandle(candle) {

    const range = candle.high - candle.low;

    if (range <= 0) return false;

    const body = candle.close - candle.open;

    return (
        body > 0 &&
        body / range >= 0.45
    );

}


function isBearishCandle(candle) {

    const range = candle.high - candle.low;

    if (range <= 0) return false;

    const body = candle.open - candle.close;

    return (
        body > 0 &&
        body / range >= 0.45
    );

}


// ======================================================
// ORB BREAKOUT
// ======================================================

function detectORBBreakout(candles, orb) {

    if (!orb.ready) {

        return {
            valid: false,
            reason: orb.reason
        };

    }

    const today = getTodayCandles(candles);

    const afterORB = today.filter(c =>
        istTime(new Date(c.time)) >= CONFIG.ORB_END
    );

    if (afterORB.length < 2) {

        return {
            valid: false,
            reason: "WAITING_POST_ORB"
        };

    }

    const last = afterORB[afterORB.length - 1];

    const previous = afterORB[afterORB.length - 2];

    const valid =

        last.close > orb.high &&

        last.close > last.open &&

        previous.close <= orb.high;

    return {

        valid,

        level: orb.high,

        breakoutPrice: last.close,

        reason: valid
            ? "ORB_BREAKOUT_CONFIRMED"
            : "NO_BREAKOUT"

    };

}


// ======================================================
// ORB BREAKDOWN
// ======================================================

function detectORBBreakdown(candles, orb) {

    if (!orb.ready) {

        return {
            valid: false,
            reason: orb.reason
        };

    }

    const today = getTodayCandles(candles);

    const afterORB = today.filter(c =>
        istTime(new Date(c.time)) >= CONFIG.ORB_END
    );

    if (afterORB.length < 2) {

        return {
            valid: false,
            reason: "WAITING_POST_ORB"
        };

    }

    const last = afterORB[afterORB.length - 1];

    const previous = afterORB[afterORB.length - 2];

    const valid =

        last.close < orb.low &&

        last.close < last.open &&

        previous.close >= orb.low;

    return {

        valid,

        level: orb.low,

        breakdownPrice: last.close,

        reason: valid
            ? "ORB_BREAKDOWN_CONFIRMED"
            : "NO_BREAKDOWN"

    };

}


// ======================================================
// FUTURES OI ANALYSIS
// ======================================================

function detectLongBuildup(quote) {

    if (!quote) {

        return {
            valid: false,
            classification: "UNKNOWN"
        };

    }

    const oi = Number(quote.oi || 0);

    const previousOI =
        Number(quote.previous_oi || 0);

    const price =
        Number(quote.last_price || 0);

    const previousClose =
        Number(quote.prev_close_price || 0);

    if (
        oi <= 0 ||
        previousOI <= 0 ||
        price <= 0 ||
        previousClose <= 0
    ) {

        return {
            valid: false,
            classification: "UNKNOWN"
        };

    }

    const oiChange = oi - previousOI;

    const priceChange = price - previousClose;

    let classification = "NEUTRAL";

    if (oiChange > 0 && priceChange > 0) {
        classification = "LONG_BUILDUP";
    }

    else if (oiChange > 0 && priceChange < 0) {
        classification = "SHORT_BUILDUP";
    }

    else if (oiChange < 0 && priceChange > 0) {
        classification = "SHORT_COVERING";
    }

    else if (oiChange < 0 && priceChange < 0) {
        classification = "LONG_UNWINDING";
    }

    return {

        valid: true,

        oi,

        previousOI,

        oiChange,

        oiChangePercent: round(
            oiChange / previousOI * 100
        ),

        futuresPrice: price,

        previousClose,

        classification

    };

}


// ======================================================
// STOCK ANALYSIS
// ======================================================

function analyseStock(stock, candles, futureQuote) {

    if (
        !Array.isArray(candles) ||
        candles.length < CONFIG.MIN_CANDLES
    ) {

        return {
            symbol: stock.symbol,
            signal: "WAIT",
            signalType: "WAITING",
            reason: "INSUFFICIENT_CANDLES"
        };

    }

    const today = getTodayCandles(candles);

    if (today.length < 5) {

        return {
            symbol: stock.symbol,
            signal: "WAIT",
            signalType: "WAITING",
            reason: "INSUFFICIENT_TODAY_CANDLES"
        };

    }

    const last = candles[candles.length - 1];

    const closes = candles.map(c => c.close);

    const rsi = calculateRSI(
        closes,
        CONFIG.RSI_PERIOD
    );

    const vwap = calculateVWAP(today);

    const orb = calculateORB(candles);

    const volume = analyseVolume(candles);

    const oi = detectLongBuildup(futureQuote);

    const breakout = detectORBBreakout(
        candles,
        orb
    );

    const breakdown = detectORBBreakdown(
        candles,
        orb
    );

    const longBuildup =
        oi.valid &&
        oi.classification === "LONG_BUILDUP";

    const shortBuildup =
        oi.valid &&
        oi.classification === "SHORT_BUILDUP";

    const aboveVWAP =
        vwap !== null &&
        last.close > vwap;

    const belowVWAP =
        vwap !== null &&
        last.close < vwap;

    const rsiBullish =
        rsi !== null &&
        rsi > CONFIG.RSI_BUY;

    const rsiBearish =
        rsi !== null &&
        rsi < (CONFIG.RSI_SELL || 45);

    const strongBuy =

        breakout.valid &&

        volume.volumePass &&

        longBuildup &&

        aboveVWAP &&

        rsiBullish &&

        isBullishCandle(last);

    const strongSell =

        breakdown.valid &&

        volume.volumePass &&

        shortBuildup &&

        belowVWAP &&

        rsiBearish &&

        isBearishCandle(last);

    const longCandidate =

        longBuildup &&
        volume.volumePass &&
        aboveVWAP &&
        rsiBullish;

    const shortCandidate =

        shortBuildup &&
        volume.volumePass &&
        belowVWAP &&
        rsiBearish;

    let signal = "WAIT";

    let signalType = "WAITING";

    if (strongBuy) {

        signal = "BUY";

        signalType = "STRONG_BUY";

    }

    else if (strongSell) {

        signal = "SELL";

        signalType = "STRONG_SELL";

    }

    else if (longCandidate) {

        signalType = "LONG_BUILDUP";

    }

    else if (shortCandidate) {

        signalType = "SHORT_BUILDUP";

    }

    // ENTRY AND RISK

    const entry = last.close;

    let risk = 0;

    if (signal === "BUY") {

        risk = Math.max(
            entry - Math.min(last.low, orb.low),
            entry * 0.002
        );

    }

    else if (signal === "SELL") {

        risk = Math.max(
            Math.max(last.high, orb.high) - entry,
            entry * 0.002
        );

    }

    const stopLoss = signal === "BUY"
        ? round(entry - risk)
        : signal === "SELL"
            ? round(entry + risk)
            : null;

    const target1 = signal === "BUY"
        ? round(entry + risk * 2)
        : signal === "SELL"
            ? round(entry - risk * 2)
            : null;

    const target2 = signal === "BUY"
        ? round(entry + risk * 3)
        : signal === "SELL"
            ? round(entry - risk * 3)
            : null;

    return {

        symbol: stock.symbol,

        signal,

        signalType,

        reason: signalType,

        price: round(last.close),

        rsi,

        vwap,

        volume: last.volume,

        averageVolume: volume.averageVolume,

        volumeRatio: volume.ratio,

        volumePass: volume.volumePass,

        orbHigh: orb.high ?? null,

        orbLow: orb.low ?? null,

        breakout: breakout.valid,

        breakdown: breakdown.valid,

        futuresSymbol: stock.futuresSymbol,

        futuresPrice: oi.futuresPrice ?? null,

        futuresOI: oi.oi ?? 0,

        previousOI: oi.previousOI ?? 0,

        oiChange: oi.oiChange ?? 0,

        oiChangePercent: oi.oiChangePercent ?? 0,

        oiClassification: oi.classification,

        longBuildup,

        shortBuildup,

        entry: signal === "WAIT" ? null : round(entry),

        stopLoss,

        target1,

        target2,

        option: null,

        candleTime: istTime(new Date(last.time)),

        timeframe: "5 MINUTES"

    };

}


// ======================================================
// CONCURRENT WORKERS
// ======================================================

async function runWorkers(items, worker, limit) {

    const results = new Array(items.length);

    let index = 0;

    async function run() {

        while (true) {

            const current = index++;

            if (current >= items.length) return;

            try {

                results[current] =
                    await worker(items[current]);

            }

            catch (error) {

                results[current] = {

                    symbol: items[current].symbol,

                    signal: "ERROR",

                    signalType: "ERROR",

                    reason: error.message

                };

            }

        }

    }

    await Promise.all(

        Array.from(
            {
                length: Math.min(
                    limit,
                    items.length
                )
            },
            () => run()
        )

    );

    return results;

}


// ======================================================
// MAIN SCANNER
// ======================================================

async function runScan(force = false) {

    if (
        !force &&
        scanCache &&
        Date.now() - scanCache.time < CONFIG.CACHE_MS
    ) {

        return scanCache.data;

    }

    if (scanRunning) {

        if (scanCache) return scanCache.data;

        throw new Error("SCANNER_ALREADY_RUNNING");

    }

    scanRunning = true;

    try {

        const currentTime = istTime();

        // ORB must finish first

        if (currentTime < CONFIG.ORB_END) {

            return {

                status: "WAITING",

                message: "WAITING_FOR_09_30_ORB_COMPLETION",

                marketTime: currentTime,

                scanned: 0,

                strongBuyCount: 0,

                strongSellCount: 0,

                bullish: [],

                bearish: []

            };

        }

        await loadMaster();

        if (!fnoStocks.length) {

            throw new Error("NO_NSE_FNO_STOCKS_FOUND");

        }

        const futureQuotes =
            await getFuturesQuotes(fnoStocks);

        const results = await runWorkers(

            fnoStocks,

            async stock => {

                const candles =
                    await getFiveMinuteCandles(
                        stock.equityKey
                    );

                const quote =
                    findFuturesQuote(
                        stock,
                        futureQuotes
                    );

                return analyseStock(
                    stock,
                    candles,
                    quote
                );

            },

            CONFIG.CONCURRENCY || 3

        );

        let strongBuy = results.filter(x =>
            x.signalType === "STRONG_BUY"
        );

        let strongSell = results.filter(x =>
            x.signalType === "STRONG_SELL"
        );

        const longBuildup = results.filter(x =>
            x.signalType === "LONG_BUILDUP"
        );

        const shortBuildup = results.filter(x =>
            x.signalType === "SHORT_BUILDUP"
        );

        const waiting = results.filter(x =>
            x.signalType === "WAITING"
        );

        const errors = results.filter(x =>
            x.signalType === "ERROR"
        );

        // Limit option-chain calls to avoid excessive API requests.

        const optionCandidates = [

            ...strongBuy.slice(0, 5),

            ...strongSell.slice(0, 5)

        ];

        const optionResults = await runWorkers(

            optionCandidates,

            async signal => {

                const stock = fnoStocks.find(
                    x => x.symbol === signal.symbol
                );

                if (!stock) return signal;

                try {

                    const selected =
                        await selectBestOption(
                            stock,
                            signal
                        );

                    return {

                        ...signal,

                        option: selected || null

                    };

                }

                catch (error) {

                    return {

                        ...signal,

                        option: null,

                        optionError: error.message

                    };

                }

            },

            2

        );

        for (const item of optionResults) {

            const indexBuy = strongBuy.findIndex(
                x => x.symbol === item.symbol
            );

            if (indexBuy >= 0) {

                strongBuy[indexBuy] = item;

            }

            const indexSell = strongSell.findIndex(
                x => x.symbol === item.symbol
            );

            if (indexSell >= 0) {

                strongSell[indexSell] = item;

            }

        }

        const data = {

            status: "SUCCESS",

            scanner: CONFIG.VERSION,

            market: "NSE",

            segment: "FNO_STOCKS",

            timeframe: "5 MINUTES",

            scanned: fnoStocks.length,

            strongBuyCount: strongBuy.length,

            strongSellCount: strongSell.length,

            longBuildupCount: longBuildup.length,

            shortBuildupCount: shortBuildup.length,

            waitingCount: waiting.length,

            errorCount: errors.length,

            // Frontend compatibility

            bullishCount: strongBuy.length,

            bearishCount: strongSell.length,

            bullish: strongBuy,

            bearish: strongSell,

            strongBuy,

            strongSell,

            longBuildup,

            shortBuildup,

            waiting,

            errors,

            updatedAt: new Date().toISOString(),

            marketTime: istTime()

        };

        lastScan = {

            status: "SUCCESS",

            scanned: data.scanned,

            strongBuy: data.strongBuyCount,

            strongSell: data.strongSellCount,

            longBuildup: data.longBuildupCount,

            shortBuildup: data.shortBuildupCount,

            waiting: data.waitingCount

        };

        scanCache = {

            time: Date.now(),

            data

        };

        return data;

    }

    finally {

        scanRunning = false;

    }

}


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
// API SERVER
// ======================================================

const server = http.createServer(
    async (req, res) => {

        if (req.method === "OPTIONS") {

            res.writeHead(204, {

                "Access-Control-Allow-Origin": "*",

                "Access-Control-Allow-Methods":
                    "GET, OPTIONS",

                "Access-Control-Allow-Headers":
                    "Content-Type, Authorization"

            });

            return res.end();

        }

        const url = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        const path = url.pathname;

        try {

            // HEALTH

            if (
                path === "/" ||
                path === "/health"
            ) {

                return sendJson(res, 200, {

                    status: "OK",

                    app: "SMART TRADE INDIA",

                    version: CONFIG.VERSION,

                    tokenConfigured:
                        Boolean(TOKEN),

                    marketOpen: isMarketOpen(),

                    marketTime: istTime()

                });

            }

            // STATUS

            if (path === "/api/status") {

                return sendJson(res, 200, {

                    status: "OK",

                    version: CONFIG.VERSION,

                    tokenConfigured:
                        Boolean(TOKEN),

                    masterLoaded,

                    fnoStockCount:
                        fnoStocks.length,

                    lastScan

                });

            }

            // NSE F&O STOCKS

            if (path === "/api/fno-stocks") {

                await loadMaster();

                return sendJson(res, 200, {

                    status: "SUCCESS",

                    count: fnoStocks.length,

                    stocks: fnoStocks.map(x => ({
    symbol: x.symbol,
    equityKey: x.equityKey,
    futuresKey: x.futuresKey,
    futuresSymbol: x.futuresSymbol,
    expiry: x.expiry
}))
                });

            }

            // MAIN SCANNER

            if (path === "/api/scan") {

                const force =
                    url.searchParams.get("force") === "true";

                const data = await runScan(force);

                return sendJson(res, 200, data);

            }

            // STRONG BUY

            if (path === "/api/strong-buy") {

                const data = await runScan();

                return sendJson(res, 200, {

                    status: data.status,

                    count: data.strongBuyCount || 0,

                    stocks: data.strongBuy || []

                });

            }

            // STRONG SELL

            if (path === "/api/strong-sell") {

                const data = await runScan();

                return sendJson(res, 200, {

                    status: data.status,

                    count: data.strongSellCount || 0,

                    stocks: data.strongSell || []

                });

            }

            // LONG BUILDUP

            if (path === "/api/long-buildup") {

                const data = await runScan();

                return sendJson(res, 200, {

                    status: data.status,

                    count: data.longBuildupCount || 0,

                    stocks: data.longBuildup || []

                });

            }

            // SHORT BUILDUP

            if (path === "/api/short-buildup") {

                const data = await runScan();

                return sendJson(res, 200, {

                    status: data.status,

                    count: data.shortBuildupCount || 0,

                    stocks: data.shortBuildup || []

                });

            }

            // OPTION SCAN

            if (path === "/api/options/auto-scan") {

                const data = await runScan();

                return sendJson(res, 200, {

                    status: data.status,

                    bullish: data.strongBuy || [],

                    bearish: data.strongSell || []

                });

            }

            // MASTER REFRESH

            if (path === "/api/master/refresh") {

                await loadMaster(true);

                scanCache = null;

                return sendJson(res, 200, {

                    status: "SUCCESS",

                    fnoStockCount: fnoStocks.length

                });

            }

            // 404

            return sendJson(res, 404, {

                status: "ERROR",

                message: "ROUTE_NOT_FOUND",

                path

            });

        }

        catch (error) {

            console.error(
                "[V8 API ERROR]",
                path,
                error.message
            );

            return sendJson(res, 500, {

                status: "ERROR",

                message: error.message

            });

        }

    }

);


// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, "0.0.0.0", () => {

    console.log("====================================");

    console.log(" SMART TRADE INDIA V8 PRO STARTED");

    console.log(" NSE F&O STOCK SCANNER");

    console.log(" ORB + VOLUME + OI + RSI + VWAP");

    console.log(" AUTOMATIC CE / PE SELECTOR");

    console.log(" PORT:", PORT);

    console.log("====================================");

    loadMaster().catch(error => {

        console.error(
            "[MASTER LOAD ERROR]",
            error.message
        );

    });

});

