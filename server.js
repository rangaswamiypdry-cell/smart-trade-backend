// ======================================================
// SMART TRADE INDIA V3.1 PRO
// NSE F&O ONLY
// ORB + VOLUME BLAST + FUTURES OI
// SMART MONEY + FAKE BREAKOUT FILTER
// UPSTOX V3 | NODE.JS 20+
// ======================================================

"use strict";

const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// SETTINGS

const SCAN_LIMIT = Number(process.env.ORB_SCAN_LIMIT || 2500);

const CONCURRENCY = 3;

const CACHE_TIME = 20000;

const VOLUME_MULTIPLIER = 2.5;

const RSI_BUY = 65;

const RSI_SELL = 35;

const REQUIRE_OI = true;

const REQUIRE_VWAP_CROSS = true;

const REQUIRE_RETEST = true;

const RR1 = 2;

const RR2 = 3;

// GLOBAL

let equityMaster = [];

let futuresMaster = [];

let futuresMap = new Map();

let masterLoading = false;

let masterUpdated = 0;

let scanCache = {};

let scanStatus = {};

// HELPERS

const sleep = ms =>
new Promise(resolve => setTimeout(resolve, ms));

const round = n =>
Number.isFinite(Number(n))
? Number(Number(n).toFixed(2))
: null;

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

// FETCH

async function fetchData(url, timeout = 15000) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {

        return await fetch(url, {
            headers: {
                "Accept": "application/json",
                "Authorization": "Bearer " + TOKEN
            },
            signal: controller.signal
        });

    } finally {

        clearTimeout(timer);

    }

}

// UPSTOX REQUEST

async function upstox(path) {

    if (!TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN MISSING");
    }

    const response = await fetchData(API + path);

    const data = await response.json();

    if (!response.ok) {

        throw new Error(
            "UPSTOX ERROR " +
            response.status + " " +
            JSON.stringify(data)
        );

    }

    return data;

}

// LOAD NSE MASTER

async function loadMaster(force = false) {

    if (masterLoading) {

        while (masterLoading) {
            await sleep(200);
        }

        if (equityMaster.length) return;

    }

    if (
        !force &&
        equityMaster.length &&
        Date.now() - masterUpdated < 86400000
    ) {
        return;
    }

    masterLoading = true;

    try {

        console.log("DOWNLOADING NSE MASTER...");

        const response = await fetch(
            MASTER_URL
        );

        if (!response.ok) {
            throw new Error("MASTER DOWNLOAD FAILED");
        }

        const buffer = Buffer.from(
            await response.arrayBuffer()
        );

        let jsonBuffer;

        try {
            jsonBuffer = zlib.gunzipSync(buffer);
        } catch {
            jsonBuffer = buffer;
        }

        const raw = JSON.parse(
            jsonBuffer.toString("utf8")
        );

        if (!Array.isArray(raw)) {
            throw new Error("INVALID MASTER");
        }

        // NSE EQUITY

        equityMaster = raw.filter(x =>

            x.segment === "NSE_EQ" &&
            x.instrument_type === "EQ" &&
            x.instrument_key &&
            x.trading_symbol

        );

        // NSE STOCK FUTURES

        futuresMaster = raw.filter(x =>

            x.segment === "NSE_FO" &&
            x.instrument_type === "FUT" &&
            x.underlying_symbol &&
            x.instrument_key &&
            x.expiry

        );

        futuresMap.clear();

        for (const future of futuresMaster) {

            const symbol = future.underlying_symbol;

            if (!futuresMap.has(symbol)) {
                futuresMap.set(symbol, []);
            }

            futuresMap.get(symbol).push(future);

        }

        masterUpdated = Date.now();

        console.log(
            "EQUITY:",
            equityMaster.length
        );

        console.log(
            "STOCK FUTURES:",
            futuresMaster.length
        );

    } catch (error) {

        console.error(
            "MASTER ERROR:",
            error.message
        );

        if (!equityMaster.length) throw error;

    } finally {

        masterLoading = false;

    }

}

// NEAREST FUTURES

function getNearestFuture(symbol) {

    const contracts = futuresMap.get(symbol) || [];

    const today = istDate();

    const valid = contracts

        .filter(x => x.expiry >= today)

        .sort((a, b) =>
            a.expiry.localeCompare(b.expiry)
        );

    return valid[0] || null;

}

// GET NSE F&O STOCKS

async function getFnoStocks() {

    await loadMaster();

    const stocks = equityMaster.filter(stock =>

        futuresMap.has(stock.trading_symbol) &&
        getNearestFuture(stock.trading_symbol)

    );

    return stocks.slice(0, SCAN_LIMIT);

}

// GET CANDLES

async function getCandles(instrumentKey) {

    const key = encodeURIComponent(instrumentKey);

    const result = await upstox(
        `/v3/historical-candle/intraday/${key}/minutes/5`
    );

    return result?.data?.candles || [];

}

// GET DAILY CANDLES

async function getDailyCandles(instrumentKey) {

    const key = encodeURIComponent(instrumentKey);

    const today = istDate();

    const from = istDate(
        new Date(Date.now() - 30 * 86400000)
    );

    const result = await upstox(
        `/v3/historical-candle/${key}/days/1/${today}/${from}`
    );

    return result?.data?.candles || [];

}

// COMPLETED CANDLES

function prepareCandles(raw) {

    const today = istDate();

    const now = Date.now();

    return raw

        .map(c => ({

            time: c[0],

            date: new Date(c[0]),

            open: Number(c[1]),

            high: Number(c[2]),

            low: Number(c[3]),

            close: Number(c[4]),

            volume: Number(c[5] || 0),

            oi: Number(c[6] || 0)

        }))

        .filter(c =>

            Number.isFinite(c.date.getTime()) &&

            istDate(c.date) === today &&

            c.date.getTime() + 300000 <= now

        )

        .sort((a, b) => a.date - b.date);

}

// ORB

function calculateORB(candles) {

    const opening = candles.filter(c =>

        ["09:15", "09:20", "09:25"].includes(
            istTime(c.date)
        )

    );

    if (opening.length !== 3) return null;

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

    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        ema =
            values[i] * multiplier +
            ema * (1 - multiplier);

    }

    return ema;

}

// RSI

function calculateRSI(values, period = 14) {

    if (values.length <= period) return null;

    let gain = 0;

    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const diff = values[i] - values[i - 1];

        if (diff > 0) gain += diff;
        else loss -= diff;

    }

    let avgGain = gain / period;

    let avgLoss = loss / period;

    for (let i = period + 1; i < values.length; i++) {

        const diff = values[i] - values[i - 1];

        avgGain =
            (avgGain * (period - 1) +
            Math.max(diff, 0)) / period;

        avgLoss =
            (avgLoss * (period - 1) +
            Math.max(-diff, 0)) / period;

    }

    if (avgLoss === 0) return 100;

    return 100 - 100 / (1 + avgGain / avgLoss);

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

    return volume > 0 ? pv / volume : null;

}

// VOLUME BLAST

function calculateVolume(candles) {

    if (candles.length < 22) return null;

    const previous = candles.slice(-21, -1);

    const latest = candles[candles.length - 1];

    const average =
        previous.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / 20;

    const ratio =
        average > 0
            ? latest.volume / average
            : 0;

    const range = Math.max(
        latest.high - latest.low,
        0.000001
    );

    const body =
        Math.abs(latest.close - latest.open);

    const closePosition =
        (latest.close - latest.low) / range;

    return {

        average,

        current: latest.volume,

        ratio,

        pass: ratio >= VOLUME_MULTIPLIER,

        bullishQuality:
            body / range >= 0.35 &&
            closePosition >= 0.70,

        bearishQuality:
            body / range >= 0.35 &&
            closePosition <= 0.30

    };

}

// FUTURES OI

function calculateFuturesOI(candles) {

    const valid = candles.filter(c => c.oi > 0);

    if (valid.length < 2) {

        return {
            available: false,
            increasing: false,
            change: null,
            changePercent: null
        };

    }

    const current = valid[valid.length - 1].oi;

    const previous = valid[valid.length - 2].oi;

    const change = current - previous;

    return {

        available: true,

        increasing: change > 0,

        change,

        changePercent:
            previous > 0
                ? change / previous * 100
                : null,

        current,

        previous

    };

}

// ADR14

function calculateADR(daily) {

    const data = daily.slice(-15, -1);

    if (data.length < 10) return null;

    const ranges = data.map(c => {

        const high = Number(c[2]);

        const low = Number(c[3]);

        const close = Number(c[4]);

        return close > 0
            ? (high - low) / close * 100
            : null;

    }).filter(Number.isFinite);

    if (ranges.length < 10) return null;

    return ranges.reduce(
        (a, b) => a + b,
        0
    ) / ranges.length;

}

// VWAP CROSS RECENT

function checkVWAPCross(candles, direction) {

    if (candles.length < 4) return false;

    for (
        let i = candles.length - 1;
        i >= Math.max(1, candles.length - 3);
        i--
    ) {

        const previousVWAP =
            calculateVWAP(candles.slice(0, i));

        const currentVWAP =
            calculateVWAP(candles.slice(0, i + 1));

        if (
            previousVWAP === null ||
            currentVWAP === null
        ) continue;

        const previous = candles[i - 1];

        const current = candles[i];

        if (
            direction === "UP" &&
            previous.close <= previousVWAP &&
            current.close > currentVWAP
        ) return true;

        if (
            direction === "DOWN" &&
            previous.close >= previousVWAP &&
            current.close < currentVWAP
        ) return true;

    }

    return false;

}

// ORB RETEST

function checkRetest(candles, orb, direction) {

    if (!REQUIRE_RETEST) return true;

    if (candles.length < 5) return false;

    const recent = candles.slice(-4);

    if (direction === "UP") {

        const breakout = recent.some(c =>
            c.close > orb.high
        );

        const retest = recent.some(c =>
            c.low <= orb.high * 1.002 &&
            c.close >= orb.high
        );

        return breakout && retest &&
            candles[candles.length - 1].close > orb.high;

    }

    const breakdown = recent.some(c =>
        c.close < orb.low
    );

    const retest = recent.some(c =>
        c.high >= orb.low * 0.998 &&
        c.close <= orb.low
    );

    return breakdown && retest &&
        candles[candles.length - 1].close < orb.low;

}

// RISK MANAGEMENT

function calculateRisk(signal, price, candle, orb) {

    const sl = signal === "STRONG BUY"

        ? Math.min(candle.low, orb.high) * 0.999

        : Math.max(candle.high, orb.low) * 1.001;

    const risk = Math.abs(price - sl);

    if (
        risk <= 0 ||
        risk / price > 0.08
    ) return null;

    return {

        entry: round(price),

        stopLoss: round(sl),

        target1: round(
            signal === "STRONG BUY"
                ? price + risk * RR1
                : price - risk * RR1
        ),

        target2: round(
            signal === "STRONG BUY"
                ? price + risk * RR2
                : price - risk * RR2
        ),

        riskReward: "1:2 / 1:3"

    };

}

// MAIN STOCK ANALYSIS

async function analyseStock(stock) {

    const future = getNearestFuture(
        stock.trading_symbol
    );

    if (!future) return null;

    let equityRaw;
    let futuresRaw;

    try {

        [equityRaw, futuresRaw] = await Promise.all([

            getCandles(stock.instrument_key),

            getCandles(future.instrument_key)

        ]);

    } catch (error) {

        console.error(
            "CANDLE ERROR:",
            stock.trading_symbol,
            error.message
        );

        return null;

    }

    const candles = prepareCandles(equityRaw);

    const futureCandles = prepareCandles(futuresRaw);

    if (
        candles.length < 22 ||
        futureCandles.length < 2
    ) return null;

    const orb = calculateORB(candles);

    if (!orb) return null;

    const last = candles[candles.length - 1];

    const prev = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const ema20 = calculateEMA(closes, 20);

    const rsi = calculateRSI(closes, 14);

    const vwap = calculateVWAP(candles);

    const volume = calculateVolume(candles);

    const oi = calculateFuturesOI(futureCandles);

    if (
        ema20 === null ||
        rsi === null ||
        vwap === null ||
        !volume
    ) return null;

    // ADR

    let adr = null;

    if (String(process.env.REQUIRE_ADR || "false") === "true") {

        try {

            const daily = await getDailyCandles(
                stock.instrument_key
            );

            adr = calculateADR(daily);

        } catch (error) {

            console.error(
                "ADR ERROR:",
                stock.trading_symbol,
                error.message
            );

        }

    }

    const adrPass =
        String(process.env.REQUIRE_ADR || "false") !== "true" ||
        (adr !== null && adr >= Number(process.env.ADR_MIN_PERCENT || 1));

    // ORB BREAKOUT

    const bullishBreak =
        last.close > orb.high &&
        prev.close <= orb.high;

    const bearishBreak =
        last.close < orb.low &&
        prev.close >= orb.low;

    // RETEST

    const bullishRetest =
        checkRetest(candles, orb, "UP");

    const bearishRetest =
        checkRetest(candles, orb, "DOWN");

    // VWAP CROSS

    const bullishVWAP =
        checkVWAPCross(candles, "UP") &&
        last.close > vwap;

    const bearishVWAP =
        checkVWAPCross(candles, "DOWN") &&
        last.close < vwap;

    // PRICE

    const priceUp =
        last.close > last.open &&
        last.close > prev.close;

    const priceDown =
        last.close < last.open &&
        last.close < prev.close;

    // FUTURES OI

    const oiBuy =
        oi.available &&
        oi.increasing &&
        priceUp;

    const oiSell =
        oi.available &&
        oi.increasing &&
        priceDown;

    // FINAL SIGNAL

    const bullish =

        bullishBreak &&
        bullishRetest &&
        volume.pass &&
        volume.bullishQuality &&
        oiBuy &&
        rsi >= RSI_BUY &&
        last.close > ema20 &&
        bullishVWAP &&
        adrPass;

    const bearish =

        bearishBreak &&
        bearishRetest &&
        volume.pass &&
        volume.bearishQuality &&
        oiSell &&
        rsi <= RSI_SELL &&
        last.close < ema20 &&
        bearishVWAP &&
        adrPass;

    let signal = "WAIT";

    if (bullish) signal = "STRONG BUY";

    if (bearish) signal = "STRONG SELL";

    const risk = signal === "WAIT"
        ? null
        : calculateRisk(signal, last.close, last, orb);

    if (signal !== "WAIT" && !risk) {
        signal = "WAIT";
    }

    return {

        symbol: stock.trading_symbol,

        company: stock.name,

        signal,

        price: round(last.close),

        futuresSymbol: future.trading_symbol,

        futuresExpiry: future.expiry,

        futuresOIAvailable: oi.available,

        futuresOIChange: oi.change,

        futuresOIChangePercent: round(oi.changePercent),

        futuresOIIncreasing: oi.increasing,

        priceIncreasing: priceUp,

        volume: last.volume,

        averageVolume: Math.round(volume.average),

        volumeRatio: round(volume.ratio),

        volumeBlast: volume.pass,

        rsi: round(rsi),

        ema20: round(ema20),

        vwap: round(vwap),

        orbHigh: round(orb.high),

        orbLow: round(orb.low),

        orbBreakout: bullishBreak,

        orbBreakdown: bearishBreak,

        retestConfirmed:
            bullishRetest || bearishRetest,

        vwapCross:
            bullishVWAP
                ? "UP"
                : bearishVWAP
                    ? "DOWN"
                    : "NONE",

        adr14: round(adr),

        adrPass,

        smartMoneyProxy:
            signal === "WAIT"
                ? "NOT_CONFIRMED"
                : "PRICE_VOLUME_FUTURES_OI",

        candleTime: last.time,

        ...(risk || {

            entry: null,

            stopLoss: null,

            target1: null,

            target2: null,

            riskReward: null

        })

    };

}

// CONCURRENT SCANNER

async function runConcurrent(items, limit, callback) {

    let index = 0;

    const output = [];

    async function worker() {

        while (true) {

            const i = index++;

            if (i >= items.length) return;

            try {

                const result = await callback(items[i]);

                if (result) output.push(result);

            } catch (error) {

                console.error(
                    "SCAN ERROR:",
                    items[i].trading_symbol,
                    error.message
                );

            }

        }

    }

    await Promise.all(

        Array.from(
            {
                length: Math.min(limit, items.length)
            },
            () => worker()
        )

    );

    return output;

}

// MAIN SCAN

async function runScan(force = false) {

    if (
        !force &&
        scanCache.data &&
        Date.now() - scanCache.time < CACHE_TIME
    ) {
        return scanCache.data;
    }

    await loadMaster();

    const stocks = await getFnoStocks();

    scanStatus = {

        status: "SCANNING",

        totalStocks: stocks.length,

        startedAt: new Date().toISOString()

    };

    console.log(
        "FNO SCAN START:",
        stocks.length
    );

    const results = await runConcurrent(

        stocks,

        CONCURRENCY,

        analyseStock

    );

    results.sort(
        (a, b) =>
            (b.volumeRatio || 0) -
            (a.volumeRatio || 0)
    );

    const bullish = results.filter(
        x => x.signal === "STRONG BUY"
    );

    const bearish = results.filter(
        x => x.signal === "STRONG SELL"
    );

    const output = {

        success: true,

        scanner: "SMART_TRADE_INDIA_V3_1_PRO",

        market: "NSE F&O STOCKS ONLY",

        timeframe: "5 MINUTE CLOSED CANDLES",

        orbPeriod: "09:15 TO 09:30",

        totalStocks: stocks.length,

        analysedStocks: results.length,

        signals: bullish.length + bearish.length,

        bullish: bullish.length,

        bearish: bearish.length,

        wait: results.filter(
            x => x.signal === "WAIT"
        ).length,

        data: results,

        scanTime: new Date().toISOString()

    };

    scanCache = {

        time: Date.now(),

        data: output

    };

    scanStatus = {

        status: "COMPLETED",

        totalStocks: stocks.length,

        analysedStocks: results.length,

        signals: output.signals,

        completedAt: new Date().toISOString()

    };

    return output;

}

// JSON

function sendJson(res, status, data) {

    res.writeHead(status, {

        "Content-Type": "application/json",

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods": "GET, OPTIONS",

        "Access-Control-Allow-Headers": "Content-Type"

    });

    res.end(JSON.stringify(data));

}

// HTTP SERVER

const server = http.createServer(
    async (req, res) => {

        if (req.method === "OPTIONS") {

            res.writeHead(204);

            return res.end();

        }

        const url = new URL(
            req.url,
            "http://localhost"
        );

        const path = url.pathname;

        try {

            if (path === "/health") {

                return sendJson(res, 200, {

                    success: true,

                    status: "ONLINE",

                    scanner: "V3.1 PRO",

                    tokenConfigured: Boolean(TOKEN)

                });

            }

            if (path === "/api/orb/status") {

                return sendJson(res, 200, {

                    success: true,

                    scanner: "V3.1 PRO",

                    apiConnected: Boolean(TOKEN),

                    equityLoaded: equityMaster.length,

                    futuresLoaded: futuresMaster.length,

                    fnoStocks: futuresMap.size,

                    masterUpdated: masterUpdated || null,

                    scanStatus,

                    settings: {

                        volume: VOLUME_MULTIPLIER,

                        rsiBuy: RSI_BUY,

                        rsiSell: RSI_SELL,

                        requireOI: REQUIRE_OI,

                        requireVWAPCross: REQUIRE_VWAP_CROSS,

                        requireRetest: REQUIRE_RETEST

                    }

                });

            }

            if (path === "/api/orb/refresh-master") {

                scanCache = {};

                await loadMaster(true);

                return sendJson(res, 200, {

                    success: true,

                    equityLoaded: equityMaster.length,

                    futuresLoaded: futuresMaster.length,

                    fnoStocks: futuresMap.size

                });

            }

            if (path === "/api/orb/scan") {

                const force =
                    url.searchParams.get("refresh") === "true";

                return sendJson(
                    res,
                    200,
                    await runScan(force)
                );

            }

            if (path === "/api/orb/bullish") {

                const result = await runScan();

                const data = result.data.filter(
                    x => x.signal === "STRONG BUY"
                );

                return sendJson(res, 200, {

                    success: true,

                    total: data.length,

                    data

                });

            }

            if (path === "/api/orb/bearish") {

                const result = await runScan();

                const data = result.data.filter(
                    x => x.signal === "STRONG SELL"
                );

                return sendJson(res, 200, {

                    success: true,

                    total: data.length,

                    data

                });

            }

            if (path === "/api/orb/strong") {

                const result = await runScan();

                const data = result.data.filter(
                    x =>
                        x.signal !== "WAIT" &&
                        x.volumeRatio >= 2.5
                );

                return sendJson(res, 200, {

                    success: true,

                    total: data.length,

                    data

                });

            }

            return sendJson(res, 404, {

                success: false,

                error: "ROUTE NOT FOUND"

            });

        } catch (error) {

            console.error(
                "SERVER ERROR:",
                error.stack || error.message
            );

            return sendJson(res, 500, {

                success: false,

                error: error.message

            });

        }

    }
);

// START

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA V3.1 PRO STARTED"
    );

    console.log("PORT:", PORT);

    console.log(
        "UPSTOX TOKEN:",
        TOKEN ? "CONFIGURED" : "MISSING"
    );

});
