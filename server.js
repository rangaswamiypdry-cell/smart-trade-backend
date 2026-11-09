// ============================================================
// SMART TRADE INDIA - ORB + VOLUME BLAST + OI + SMART MONEY V3
// NSE EQUITY / NSE F&O | Upstox V3 | Node.js 20+
// ============================================================

"use strict";

const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const API_BASE = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const SCAN_LIMIT = Math.max(1, Number(process.env.ORB_SCAN_LIMIT || 2500));
const CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY || 4));

const CACHE_MS = 25000;
const MASTER_CACHE_MS = 86400000;
const DAILY_CACHE_MS = 21600000;

const VOLUME_MULTIPLIER = Number(process.env.VOLUME_MULTIPLIER || 2.5);

const RSI_BUY = Number(process.env.RSI_BUY || 65);
const RSI_SELL = Number(process.env.RSI_SELL || 35);

const REQUIRE_OI =
String(process.env.REQUIRE_OI || "true").toLowerCase() === "true";

const REQUIRE_ADR =
String(process.env.REQUIRE_ADR || "false").toLowerCase() === "true";

const ADR_MIN_PERCENT = Number(process.env.ADR_MIN_PERCENT || 1.0);

const BREAKOUT_BUFFER_PERCENT =
Number(process.env.BREAKOUT_BUFFER_PERCENT || 0.05);

const RR1 = 2;
const RR2 = 3;

let instruments = [];
let fnoSymbols = new Set();

let masterUpdatedAt = 0;
let masterLoading = false;

const scanCache = new Map();
const dailyCache = new Map();
const lastScanStatus = {};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const round = n =>
Number.isFinite(Number(n))
? Number(Number(n).toFixed(2))
: null;

const istDate = (d = new Date()) =>
new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
}).format(d);

const istTime = d =>
new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
}).format(d);


// FETCH TIMEOUT

async function fetchTimeout(url, options = {}, timeout = 15000) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
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


// UPSTOX API

async function upstox(path) {

    if (!UPSTOX_TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing in Render environment");
    }

    const response = await fetchTimeout(
        API_BASE + path,
        {
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${UPSTOX_TOKEN}`
            }
        },
        15000
    );

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            `Upstox ${response.status}: ${JSON.stringify(body)}`
        );
    }

    if (body.status && body.status !== "success") {
        throw new Error(`Upstox response: ${JSON.stringify(body)}`);
    }

    return body;

}


// INSTRUMENT MASTER

async function loadInstruments(force = false) {

    if (masterLoading) {

        while (masterLoading) {
            await sleep(200);
        }

        if (instruments.length) return;

    }

    if (
        !force &&
        instruments.length &&
        Date.now() - masterUpdatedAt < MASTER_CACHE_MS
    ) {
        return;
    }

    masterLoading = true;

    try {

        console.log("Downloading Upstox instrument master...");

        const response = await fetchTimeout(
            MASTER_URL,
            {},
            60000
        );

        if (!response.ok) {
            throw new Error(`Instrument master HTTP ${response.status}`);
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
            throw new Error("Invalid instrument master format");
        }

        const eq = raw.filter(x =>
            x.segment === "NSE_EQ" &&
            x.instrument_type === "EQ" &&
            x.instrument_key &&
            x.trading_symbol &&
            x.security_type !== "SM"
        );

        const fno = new Set();

        for (const item of raw) {

            if (
                item.segment === "NSE_FO" &&
                ["FUT", "CE", "PE"].includes(item.instrument_type) &&
                item.underlying_symbol
            ) {

                fno.add(item.underlying_symbol);

            }

        }

        instruments = eq;
        fnoSymbols = fno;

        masterUpdatedAt = Date.now();

        console.log("NSE EQUITY:", eq.length);
        console.log("NSE FNO:", fno.size);

    } catch (error) {

        console.error("MASTER ERROR:", error.message);

        if (!instruments.length) throw error;

    } finally {

        masterLoading = false;

    }

}


// GET STOCKS

async function getStocks(type = "ALL") {

    type = String(type).toUpperCase();

    if (!["ALL", "FNO"].includes(type)) {
        throw new Error("type must be ALL or FNO");
    }

    await loadInstruments();

    const list = type === "FNO"
        ? instruments.filter(x =>
            fnoSymbols.has(x.trading_symbol)
        )
        : instruments;

    return list.slice(0, SCAN_LIMIT);

}


// INTRADAY CANDLES

async function getIntradayCandles(key) {

    const p = encodeURIComponent(key);

    const result = await upstox(
        `/v3/historical-candle/intraday/${p}/minutes/5`
    );

    return result?.data?.candles || [];

}


// DAILY CANDLES

async function getDailyCandles(key) {

    const cached = dailyCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < DAILY_CACHE_MS
    ) {
        return cached.candles;
    }

    const p = encodeURIComponent(key);

    const to = istDate();

    const fromDate = new Date(
        Date.now() - 35 * 86400000
    );

    const from = istDate(fromDate);

    const result = await upstox(
        `/v3/historical-candle/${p}/day/${to}/${from}`
    );

    const candles = result?.data?.candles || [];

    dailyCache.set(key, {
        time: Date.now(),
        candles
    });

    return candles;

}


// COMPLETED CANDLES

function normaliseCandles(raw) {

    const today = istDate();
    const now = Date.now();

    return (raw || [])

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

            c.date.getTime() + 5 * 60000 <= now &&

            [
                c.open,
                c.high,
                c.low,
                c.close,
                c.volume
            ].every(Number.isFinite)

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

function ema(values, period) {

    if (values.length < period) return null;

    const k = 2 / (period + 1);

    let v = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        v = values[i] * k + v * (1 - k);

    }

    return v;

}


// RSI

function rsi(values, period = 14) {

    if (values.length <= period) return null;

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const d = values[i] - values[i - 1];

        if (d > 0) gain += d;
        else loss -= d;

    }

    let ag = gain / period;
    let al = loss / period;

    for (let i = period + 1; i < values.length; i++) {

        const d = values[i] - values[i - 1];

        ag =
            (ag * (period - 1) + Math.max(d, 0)) /
            period;

        al =
            (al * (period - 1) + Math.max(-d, 0)) /
            period;

    }

    if (al === 0) return 100;

    return 100 - 100 / (1 + ag / al);

}


// VWAP

function vwap(candles) {

    let pv = 0;
    let vol = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        pv += typical * c.volume;
        vol += c.volume;

    }

    return vol > 0 ? pv / vol : null;

}


// VOLUME BLAST + FAKE VOLUME FILTER

function volumeStats(candles) {

    if (candles.length < 22) return null;

    const prior = candles.slice(-21, -1);

    const last = candles[candles.length - 1];

    const average =
        prior.reduce(
            (s, c) => s + c.volume,
            0
        ) / prior.length;

    const ratio =
        average > 0 ? last.volume / average : 0;

    const range = Math.max(
        last.high - last.low,
        0.000001
    );

    const body = Math.abs(
        last.close - last.open
    );

    const closePosition =
        (last.close - last.low) / range;

    const bullishQuality =
        body / range >= 0.35 &&
        closePosition >= 0.70;

    const bearishQuality =
        body / range >= 0.35 &&
        closePosition <= 0.30;

    return {

        current: last.volume,
        average,
        ratio,

        pass: ratio >= VOLUME_MULTIPLIER,

        bullishQuality,
        bearishQuality,
        closePosition

    };

}


// OI INCREASE

function oiStats(candles) {

    const usable = candles.filter(c => c.oi > 0);

    if (usable.length < 2) {

        return {
            available: false,
            pass: !REQUIRE_OI,
            change: null,
            previous: null,
            current: null
        };

    }

    const current = usable[usable.length - 1].oi;
    const previous = usable[usable.length - 2].oi;

    const change = current - previous;

    return {

        available: true,
        pass: change > 0,
        change,
        previous,
        current,

        changePercent:
            previous > 0
                ? change / previous * 100
                : null

    };

}


// ADR14

function adrStats(rawDaily) {

    const daily = (rawDaily || []).slice(-15, -1);

    if (daily.length < 10) {

        return {
            available: false,
            adrPercent: null,
            pass: !REQUIRE_ADR
        };

    }

    const ranges = daily.map(c => {

        const high = Number(c[2]);
        const low = Number(c[3]);
        const close = Number(c[4]);

        return close > 0
            ? (high - low) / close * 100
            : null;

    }).filter(Number.isFinite);

    if (ranges.length < 10) {

        return {
            available: false,
            adrPercent: null,
            pass: !REQUIRE_ADR
        };

    }

    const adrPercent =
        ranges.reduce((a, b) => a + b, 0) /
        ranges.length;

    return {

        available: true,
        adrPercent,
        pass: adrPercent >= ADR_MIN_PERCENT

    };

}// ============================================================
// SMART TRADE INDIA V3 PRO - PART 2
// ============================================================


// STOP LOSS + TARGET

function makeRisk(signal, entry, candle, orb) {

    const sl = signal === "STRONG BUY"

        ? Math.min(candle.low, orb.high) * 0.999

        : Math.max(candle.high, orb.low) * 1.001;

    const risk = Math.abs(entry - sl);

    if (
        !Number.isFinite(risk) ||
        risk <= 0 ||
        risk / entry > 0.08
    ) {
        return null;
    }

    return {

        entry: round(entry),

        stopLoss: round(sl),

        target1: round(
            signal === "STRONG BUY"
                ? entry + risk * RR1
                : entry - risk * RR1
        ),

        target2: round(
            signal === "STRONG BUY"
                ? entry + risk * RR2
                : entry - risk * RR2
        ),

        riskReward: "1:2 / 1:3"

    };

}


// STOCK ANALYSIS

async function analyseStock(stock, raw) {

    const candles = normaliseCandles(raw);

    if (candles.length < 22) return null;

    const orb = calculateORB(candles);

    if (!orb) return null;

    const last = candles[candles.length - 1];

    const prev = candles[candles.length - 2];

    const closes = candles.map(c => c.close);

    const e20 = ema(closes, 20);

    const r = rsi(closes, 14);

    const vw = vwap(candles);

    const vol = volumeStats(candles);

    const oi = oiStats(candles);

    if (
        e20 === null ||
        r === null ||
        vw === null ||
        !vol
    ) {
        return null;
    }

    let adr = {
        available: false,
        adrPercent: null,
        pass: !REQUIRE_ADR
    };

    try {

        adr = adrStats(
            await getDailyCandles(stock.instrument_key)
        );

    } catch (e) {

        console.warn(
            "ADR DATA ERROR",
            stock.trading_symbol,
            e.message
        );

    }

    const buffer = BREAKOUT_BUFFER_PERCENT / 100;

    const orbBreak =
        last.close > orb.high * (1 + buffer) &&
        prev.close <= orb.high * (1 + buffer);

    const orbBreakDown =
        last.close < orb.low * (1 - buffer) &&
        prev.close >= orb.low * (1 - buffer);

    const previousVWAP =
        vwap(candles.slice(0, -1));

    const vwapCrossUp =
        last.close > vw &&
        prev.close <= previousVWAP;

    const vwapCrossDown =
        last.close < vw &&
        prev.close >= previousVWAP;

    const priceUp =
        last.close > last.open &&
        last.close > prev.close;

    const priceDown =
        last.close < last.open &&
        last.close < prev.close;

    const oiPass = oi.pass || !REQUIRE_OI;

    const adrPass = adr.pass || !REQUIRE_ADR;

    const bullish =
        orbBreak &&
        vol.pass &&
        vol.bullishQuality &&
        oiPass &&
        r >= RSI_BUY &&
        last.close > vw &&
        last.close > e20 &&
        priceUp &&
        adrPass;

    const bearish =
        orbBreakDown &&
        vol.pass &&
        vol.bearishQuality &&
        oiPass &&
        r <= RSI_SELL &&
        last.close < vw &&
        last.close < e20 &&
        priceDown &&
        adrPass;

    let signal = "WAIT";

    if (bullish) {

        signal = "STRONG BUY";

    } else if (bearish) {

        signal = "STRONG SELL";

    }

    const risk = signal === "WAIT"
        ? null
        : makeRisk(signal, last.close, last, orb);

    if (signal !== "WAIT" && !risk) {

        signal = "WAIT";

    }

    return {

        symbol: stock.trading_symbol,

        company: stock.name || stock.trading_symbol,

        instrumentKey: stock.instrument_key,

        signal,

        price: round(last.close),

        orbHigh: round(orb.high),

        orbLow: round(orb.low),

        volume: last.volume,

        averageVolume: Math.round(vol.average),

        volumeRatio: round(vol.ratio),

        volumeBlast: vol.pass,

        fakeVolumeFilter:
            signal !== "WAIT"
                ? "PASSED"
                : vol.pass
                    ? "QUALITY_NOT_CONFIRMED"
                    : "NO_VOLUME_BLAST",

        oiAvailable: oi.available,

        oiChange: oi.change,

        oiChangePercent: round(oi.changePercent),

        oiIncreasing:
            oi.available ? oi.pass : null,

        rsi: round(r),

        ema20: round(e20),

        vwap: round(vw),

        vwapCross:
            vwapCrossUp
                ? "UP"
                : vwapCrossDown
                    ? "DOWN"
                    : "NONE",

        orbBreakout: orbBreak,

        orbBreakdown: orbBreakDown,

        adr14Percent: round(adr.adrPercent),

        adrAvailable: adr.available,

        smartMoneyProxy:
            signal === "WAIT"
                ? "NOT_CONFIRMED"
                : "VOLUME_PRICE_OI_CONFIRMATION",

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

async function mapLimit(items, limit, fn) {

    let index = 0;

    const out = [];

    async function worker() {

        while (true) {

            const i = index++;

            if (i >= items.length) return;

            try {

                const value = await fn(items[i]);

                if (value) {
                    out.push(value);
                }

            } catch (e) {

                console.error(
                    "SCAN ERROR",
                    items[i]?.trading_symbol,
                    e.message
                );

            }

        }

    }

    await Promise.all(
        Array.from(
            { length: Math.min(limit, items.length) },
            worker
        )
    );

    return out;

}


// MAIN SCANNER

async function scan(type = "ALL", force = false) {

    type = String(type).toUpperCase();

    if (!["ALL", "FNO"].includes(type)) {
        throw new Error("type must be ALL or FNO");
    }

    const cached = scanCache.get(type);

    if (
        !force &&
        cached &&
        Date.now() - cached.time < CACHE_MS
    ) {
        return cached.data;
    }

    const stocks = await getStocks(type);

    lastScanStatus[type] = {

        status: "SCANNING",

        totalStocks: stocks.length,

        startedAt: new Date().toISOString()

    };

    console.log(
        `V3 SCAN START | ${type} | ${stocks.length} symbols`
    );

    const results = await mapLimit(
        stocks,
        CONCURRENCY,
        async stock => {

            const raw = await getIntradayCandles(
                stock.instrument_key
            );

            return analyseStock(stock, raw);

        }
    );

    results.sort(
        (a, b) =>
            (b.volumeRatio || 0) -
            (a.volumeRatio || 0)
    );

    const buy = results.filter(
        x => x.signal === "STRONG BUY"
    );

    const sell = results.filter(
        x => x.signal === "STRONG SELL"
    );

    const data = {

        success: true,

        scanner: "SMART_TRADE_INDIA_ORB_SMART_MONEY_V3",

        type,

        timeframe: "5 MINUTES - COMPLETED CANDLES",

        orbPeriod: "09:15 TO 09:30",

        rules: {

            volumeMultiplier: VOLUME_MULTIPLIER,

            rsiBuy: RSI_BUY,

            rsiSell: RSI_SELL,

            requireOI: REQUIRE_OI,

            requireADR: REQUIRE_ADR,

            adrMinPercent: ADR_MIN_PERCENT

        },

        totalStocks: stocks.length,

        analysedStocks: results.length,

        signals: buy.length + sell.length,

        bullish: buy.length,

        bearish: sell.length,

        wait: results.filter(
            x => x.signal === "WAIT"
        ).length,

        data: results,

        scanTime: new Date().toISOString()

    };

    scanCache.set(type, {
        time: Date.now(),
        data
    });

    lastScanStatus[type] = {

        status: "COMPLETED",

        totalStocks: stocks.length,

        analysedStocks: results.length,

        signals: data.signals,

        completedAt: new Date().toISOString()

    };

    return data;

}


// JSON RESPONSE

function send(res, status, body) {

    res.writeHead(status, {

        "Content-Type": "application/json; charset=utf-8",

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods": "GET, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, Authorization"

    });

    res.end(JSON.stringify(body));

}


// HTTP SERVER

const server = http.createServer(
    async (req, res) => {

        if (req.method === "OPTIONS") {

            res.writeHead(204, {

                "Access-Control-Allow-Origin": "*",

                "Access-Control-Allow-Methods": "GET, OPTIONS",

                "Access-Control-Allow-Headers":
                    "Content-Type, Authorization"

            });

            return res.end();

        }

        const url = new URL(
            req.url,
            "http://localhost"
        );

        const path = url.pathname;

        try {

            if (req.method !== "GET") {

                return send(res, 405, {
                    success: false,
                    error: "GET only"
                });

            }


            // HEALTH

            if (path === "/health") {

                return send(res, 200, {

                    success: true,

                    status: "ONLINE",

                    app: "SMART TRADE INDIA",

                    scanner: "ORB + VOLUME + OI V3",

                    tokenConfigured: Boolean(UPSTOX_TOKEN)

                });

            }


            // STATUS

            if (path === "/api/orb/status") {

                return send(res, 200, {

                    success: true,

                    scanner: "V3",

                    apiConnected: Boolean(UPSTOX_TOKEN),

                    instrumentsLoaded: instruments.length,

                    fnoStocks: fnoSymbols.size,

                    masterUpdatedAt: masterUpdatedAt || null,

                    scanStatus: lastScanStatus,

                    config: {

                        volumeMultiplier: VOLUME_MULTIPLIER,

                        rsiBuy: RSI_BUY,

                        rsiSell: RSI_SELL,

                        requireOI: REQUIRE_OI,

                        requireADR: REQUIRE_ADR,

                        adrMinPercent: ADR_MIN_PERCENT

                    }

                });

            }


            // REFRESH MASTER

            if (path === "/api/orb/refresh-master") {

                scanCache.clear();

                await loadInstruments(true);

                return send(res, 200, {

                    success: true,

                    nseStocks: instruments.length,

                    fnoStocks: fnoSymbols.size

                });

            }


            // STOCK LIST

            if (path === "/api/orb/stocks") {

                const type =
                    url.searchParams.get("type") || "ALL";

                const stocks = await getStocks(type);

                return send(res, 200, {

                    success: true,

                    type,

                    total: stocks.length,

                    data: stocks.map(s => ({

                        symbol: s.trading_symbol,

                        company: s.name,

                        instrumentKey: s.instrument_key

                    }))

                });

            }


            // MAIN SCAN

            if (path === "/api/orb/scan") {

                const type =
                    url.searchParams.get("type") || "ALL";

                const force =
                    url.searchParams.get("refresh") === "true";

                return send(
                    res,
                    200,
                    await scan(type, force)
                );

            }


            // BULLISH / BEARISH / STRONG

            if (
                path === "/api/orb/bullish" ||
                path === "/api/orb/bearish" ||
                path === "/api/orb/strong"
            ) {

                const result = await scan("ALL");

                let rows = result.data;

                if (path.endsWith("/bullish")) {

                    rows = rows.filter(
                        x => x.signal === "STRONG BUY"
                    );

                }

                if (path.endsWith("/bearish")) {

                    rows = rows.filter(
                        x => x.signal === "STRONG SELL"
                    );

                }

                if (path.endsWith("/strong")) {

                    rows = rows.filter(x =>

                        x.signal !== "WAIT" &&

                        x.volumeRatio >= 2.5 &&

                        (
                            x.signal === "STRONG BUY"
                                ? x.rsi >= 65
                                : x.rsi <= 35
                        )

                    );

                }

                return send(res, 200, {

                    success: true,

                    type: path.split("/").pop().toUpperCase(),

                    total: rows.length,

                    data: rows

                });

            }


            // ROUTE NOT FOUND

            return send(res, 404, {

                success: false,

                error: "API route not found",

                routes: [

                    "/health",

                    "/api/orb/status",

                    "/api/orb/stocks?type=ALL",

                    "/api/orb/stocks?type=FNO",

                    "/api/orb/scan?type=ALL",

                    "/api/orb/scan?type=FNO",

                    "/api/orb/bullish",

                    "/api/orb/bearish",

                    "/api/orb/strong",

                    "/api/orb/refresh-master"

                ]

            });

        } catch (e) {

            console.error(
                "SERVER ERROR:",
                e.stack || e.message
            );

            return send(res, 500, {

                success: false,

                error: e.message

            });

        }

    }
);


// START SERVER

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA V3 STARTED"
    );

    console.log("PORT:", PORT);

    console.log(
        "UPSTOX TOKEN:",
        UPSTOX_TOKEN ? "CONFIGURED" : "MISSING"
    );

    console.log("RULES:", {

        VOLUME_MULTIPLIER,

        RSI_BUY,

        RSI_SELL,

        REQUIRE_OI,

        REQUIRE_ADR

    });

});
