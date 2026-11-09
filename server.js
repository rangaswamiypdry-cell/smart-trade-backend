// ======================================================
// SMART TRADE INDIA V3 PRO
// ORB VERY STRONG MOMENTUM SCANNER
// NSE F&O | UPSTOX V3 | NODE.JS 20+
// ======================================================

"use strict";

const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const UPSTOX_BASE = "https://api.upstox.com";

const SCAN_LIMIT = Number(process.env.ORB_SCAN_LIMIT || 3000);

const CONCURRENCY = 4;

// STRONG MOMENTUM SETTINGS

const VOLUME_MULTIPLIER = 2.5;

const RSI_BUY = 65;
const RSI_SELL = 35;

const ADX_MIN = 25;

const MIN_EXPECTED_MOVE = 38;

const EXPECTED_MOVE_ATR_MULTIPLIER = 1.5;

const RR_TARGET_1 = 2;
const RR_TARGET_2 = 3;

const SIGNAL_CACHE_MS = 5 * 60 * 1000;

const MAX_EQUITY_POSITIONS = 2;
const MAX_OPTION_POSITIONS = 2;

// GLOBAL VARIABLES

let instruments = [];

let fnoSymbols = new Set();

let lastMasterUpdate = null;

let masterLoading = false;

let scanCache = {};

let lastScanStatus = {};

const positions = {
    equity: [],
    options: []
};

// ======================================================
// TIME HELPERS
// ======================================================

function istDateTime(date = new Date()) {

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

function round(value) {

    return Number(Number(value).toFixed(2));

}

// ======================================================
// JSON RESPONSE
// ======================================================

function sendJson(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    res.end(JSON.stringify(data));

}

// ======================================================
// FETCH HELPER
// ======================================================

async function fetchWithTimeout(
    url,
    options = {},
    timeout = 15000
) {

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

// ======================================================
// UPSTOX API
// ======================================================

async function upstoxRequest(path) {

    if (!UPSTOX_TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const response = await fetchWithTimeout(
        UPSTOX_BASE + path,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: "Bearer " + UPSTOX_TOKEN
            }
        },
        15000
    );

    const data = await response.json();

    if (!response.ok) {

        throw new Error(
            "Upstox API " +
            response.status +
            ": " +
            JSON.stringify(data)
        );

    }

    return data;

}

// ======================================================
// DOWNLOAD NSE INSTRUMENT MASTER
// ======================================================

async function loadInstruments(force = false) {

    if (masterLoading) {

        while (masterLoading) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (instruments.length) return;

    }

    if (
        instruments.length &&
        !force &&
        lastMasterUpdate &&
        Date.now() - lastMasterUpdate < 86400000
    ) {

        return;

    }

    masterLoading = true;

    try {

        console.log("Downloading Upstox Instrument Master...");

        const response = await fetchWithTimeout(
            MASTER_URL,
            {},
            60000
        );

        if (!response.ok) {
            throw new Error("Instrument master download failed");
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
            throw new Error("Invalid instrument master");
        }

        const equity = raw.filter(x =>
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

        instruments = equity;

        fnoSymbols = fno;

        lastMasterUpdate = Date.now();

        console.log("NSE EQUITY:", instruments.length);

        console.log("NSE FNO:", fnoSymbols.size);

    } catch (error) {

        console.error("MASTER ERROR:", error.message);

        if (!instruments.length) throw error;

    } finally {

        masterLoading = false;

    }

}

// ======================================================
// GET NSE FNO STOCKS
// ======================================================

async function getNseStockOptions(type = "FNO") {

    type = String(type).toUpperCase();

    if (!["ALL", "FNO"].includes(type)) {
        throw new Error("Invalid scan type");
    }

    await loadInstruments();

    const stocks = type === "FNO"
        ? instruments.filter(stock =>
            fnoSymbols.has(stock.trading_symbol)
        )
        : instruments;

    return stocks.slice(0, SCAN_LIMIT);

}

// ======================================================
// GET 5 MINUTE CANDLES
// ======================================================

async function getCandles(instrumentKey) {

    const key = encodeURIComponent(instrumentKey);

    const path =
        "/v3/historical-candle/intraday/" +
        key +
        "/minutes/5";

    const result = await upstoxRequest(path);

    return result?.data?.candles || [];

}

// ======================================================
// PREPARE COMPLETED CANDLES
// ======================================================

function prepareCandles(raw) {

    const today = istDateTime();

    const now = Date.now();

    return raw.map(c => ({

        time: c[0],

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5]),

        oi: Number(c[6] || 0)

    })).filter(c => {

        const d = new Date(c.time);

        return (
            Number.isFinite(d.getTime()) &&
            istDateTime(d) === today &&
            d.getTime() + 5 * 60000 <= now &&
            [
                c.open,
                c.high,
                c.low,
                c.close,
                c.volume
            ].every(Number.isFinite)
        );

    }).sort((a, b) =>
        new Date(a.time) - new Date(b.time)
    );

}

// ======================================================
// ORB CALCULATION
// ======================================================

function calculateORB(candles) {

    const opening = candles.filter(c =>
        [
            "09:15",
            "09:20",
            "09:25"
        ].includes(istTime(new Date(c.time)))
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

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period) {

    if (values.length < period) return null;

    const k = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        ema =
            values[i] * k +
            ema * (1 - k);

    }

    return ema;

}

// ======================================================
// RSI
// ======================================================

function calculateRSI(values, period = 14) {

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

// ======================================================
// VWAP
// ======================================================

function calculateVWAP(candles) {

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

// ======================================================
// VOLUME BREAKOUT
// ======================================================

function calculateVolume(candles) {

    if (candles.length < 21) return null;

    const previous = candles.slice(-21, -1);

    const latest = candles[candles.length - 1];

    const average =
        previous.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / previous.length;

    const ratio =
        average > 0 ? latest.volume / average : 0;

    return {

        current: latest.volume,

        average,

        ratio,

        pass: ratio >= VOLUME_MULTIPLIER

    };

}

// ======================================================
// ATR
// ======================================================

function calculateATR(candles, period = 14) {

    if (candles.length < period + 1) return null;

    const trs = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const prev = candles[i - 1];

        trs.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low - prev.close)
        ));

    }

    const recent = trs.slice(-period);

    return recent.reduce((a, b) => a + b, 0) / recent.length;

}

// ======================================================
// ADX
// ======================================================

function calculateADX(candles, period = 14) {

    if (candles.length < period * 2 + 1) return null;

    const tr = [];
    const plusDM = [];
    const minusDM = [];

    for (let i = 1; i < candles.length; i++) {

        const c = candles[i];
        const p = candles[i - 1];

        const up = c.high - p.high;
        const down = p.low - c.low;

        plusDM.push(
            up > down && up > 0 ? up : 0
        );

        minusDM.push(
            down > up && down > 0 ? down : 0
        );

        tr.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        ));

    }

    const dx = [];

    for (let i = period - 1; i < tr.length; i++) {

        const start = i - period + 1;

        const sumTR = tr
            .slice(start, i + 1)
            .reduce((a, b) => a + b, 0);

        if (!sumTR) continue;

        const pdi =
            100 *
            plusDM.slice(start, i + 1).reduce((a, b) => a + b, 0) /
            sumTR;

        const mdi =
            100 *
            minusDM.slice(start, i + 1).reduce((a, b) => a + b, 0) /
            sumTR;

        dx.push(
            pdi + mdi === 0
                ? 0
                : 100 * Math.abs(pdi - mdi) / (pdi + mdi)
        );

    }

    if (dx.length < period) return null;

    return dx
        .slice(-period)
        .reduce((a, b) => a + b, 0) / period;

}

// ======================================================
// STRONG CANDLE CONFIRMATION
// ======================================================

function candleStrength(c, direction) {

    const range = c.high - c.low;

    if (range <= 0) return false;

    const body = Math.abs(c.close - c.open);

    const bodyRatio = body / range;

    return direction === "BUY"

        ? c.close > c.open &&
          bodyRatio >= 0.60 &&
          (c.high - c.close) / range <= 0.20

        : c.close < c.open &&
          bodyRatio >= 0.60 &&
          (c.close - c.low) / range <= 0.20;

}

// ======================================================
// PART 2
// SIGNAL ANALYSIS + SCANNER + POSITION MANAGEMENT
// ======================================================

// TRADE CALCULATION

function calculateTrade(signal, price, atr) {

    const risk = Math.max(atr, price * 0.005);

    let stopLoss;
    let target1;
    let target2;

    if (signal === "BUY") {

        stopLoss = price - risk;
        target1 = price + risk * 2;
        target2 = price + risk * 3;

    } else {

        stopLoss = price + risk;
        target1 = price - risk * 2;
        target2 = price - risk * 3;
    }

    return {
        entry: Number(price.toFixed(2)),
        stopLoss: Number(stopLoss.toFixed(2)),
        target1: Number(target1.toFixed(2)),
        target2: Number(target2.toFixed(2)),
        riskPoints: Number(risk.toFixed(2))
    };
}


// ======================================================
// STOCK ANALYSIS
// ======================================================

function analyseStock(stock, candles) {

    if (!candles || candles.length < 35) {
        return null;
    }

    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    if (!last || !previous) {
        return null;
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const ema20 = calculateEMA(closes, 20);
    const rsi = calculateRSI(closes, 14);
    const vwap = calculateVWAP(candles);
    const atr = calculateATR(candles, 14);
    const adx = calculateADX(candles, 14);

    if (
        !Number.isFinite(ema20) ||
        !Number.isFinite(rsi) ||
        !Number.isFinite(vwap) ||
        !Number.isFinite(atr) ||
        !Number.isFinite(adx)
    ) {
        return null;
    }

    // Previous 20 candle average volume
    const previousVolumes = volumes.slice(-21, -1);

    if (previousVolumes.length < 20) {
        return null;
    }

    const averageVolume =
        previousVolumes.reduce((a, b) => a + b, 0) /
        previousVolumes.length;

    const volumeRatio =
        averageVolume > 0
            ? last.volume / averageVolume
            : 0;

    // ORB high / low from configured opening range
    const orb = calculateORB(candles);

    if (!orb) {
        return null;
    }

    const bullishCandle = candleStrength(last) >= 0.65;
    const bearishCandle = candleStrength(last) <= 0.35;

    const estimatedMovePoints = atr * 1.5;

    const volumePass = volumeRatio >= MIN_VOLUME_RATIO;
    const adxPass = adx >= MIN_ADX;
    const movePass = estimatedMovePoints >= MIN_ESTIMATED_MOVE;

    const bullish =
        last.close > last.open &&
        last.close > ema20 &&
        last.close > vwap &&
        previous.close <= orb.high &&
        last.close > orb.high &&
        rsi >= BUY_RSI_MIN &&
        volumePass &&
        adxPass &&
        bullishCandle &&
        movePass;

    const bearish =
        last.close < last.open &&
        last.close < ema20 &&
        last.close < vwap &&
        previous.close >= orb.low &&
        last.close < orb.low &&
        rsi <= SELL_RSI_MAX &&
        volumePass &&
        adxPass &&
        bearishCandle &&
        movePass;

    if (!bullish && !bearish) {
        return null;
    }

    const direction = bullish ? "BUY" : "SELL";

    const trade = calculateTrade(
        direction,
        last.close,
        atr
    );

    return {
        symbol: stock.symbol,
        instrumentKey: stock.instrumentKey,

        signal: direction,
        strength: "VERY STRONG " + direction,

        price: Number(last.close.toFixed(2)),

        candleTime: last.timestamp,

        timeframe: "5 MIN",

        indicators: {
            rsi: Number(rsi.toFixed(2)),
            adx: Number(adx.toFixed(2)),
            ema20: Number(ema20.toFixed(2)),
            vwap: Number(vwap.toFixed(2)),
            atr: Number(atr.toFixed(2)),
            volumeRatio: Number(volumeRatio.toFixed(2)),
            estimatedMovePoints:
                Number(estimatedMovePoints.toFixed(2))
        },

        orb: {
            high: Number(orb.high.toFixed(2)),
            low: Number(orb.low.toFixed(2))
        },

        trade,

        note:
            "ATR-based estimated movement only. Not guaranteed."
    };
}


// ======================================================
// CONCURRENT SCANNER
// ======================================================

async function runConcurrent(items, limit, worker) {

    const results = [];
    let index = 0;

    async function runner() {

        while (index < items.length) {

            const currentIndex = index++;

            try {

                const result = await worker(
                    items[currentIndex]
                );

                if (result) {
                    results.push(result);
                }

            } catch (error) {

                console.error(
                    "Stock scan error:",
                    error.message
                );
            }
        }
    }

    const workers = [];

    for (
        let i = 0;
        i < Math.min(limit, items.length);
        i++
    ) {
        workers.push(runner());
    }

    await Promise.all(workers);

    return results;
}


// ======================================================
// ORB STOCK SCANNER
// ======================================================

async function scanOrbStocks(type = "FNO") {

    const now = Date.now();

    // Keep scan results stable for one 5-minute window
    const cacheBucket = Math.floor(
        now / SIGNAL_CACHE_MS
    );

    const cacheKey = type + "_" + cacheBucket;

    if (signalCache.has(cacheKey)) {
        return signalCache.get(cacheKey);
    }

    if (!instruments.length) {
        await loadInstruments();
    }

    const stocks = getStocksForScan(type);

    const signals = await runConcurrent(
        stocks,
        SCAN_CONCURRENCY,
        async stock => {

            const candles = await getStockCandles(stock);

            if (!candles || candles.length < 35) {
                return null;
            }

            return analyseStock(stock, candles);
        }
    );

    signals.sort((a, b) => {

        const scoreA =
            a.indicators.volumeRatio *
            a.indicators.adx;

        const scoreB =
            b.indicators.volumeRatio *
            b.indicators.adx;

        return scoreB - scoreA;
    });

    const result = {
        success: true,
        type,
        totalScanned: stocks.length,
        totalSignals: signals.length,
        scanTime: new Date().toISOString(),
        cacheBucket,
        signals
    };

    signalCache.set(cacheKey, result);

    // Remove old cache entries
    for (const key of signalCache.keys()) {

        if (key !== cacheKey) {
            signalCache.delete(key);
        }
    }

    return result;
}


// ======================================================
// FILTER SIGNALS
// ======================================================

function filterSignals(signals, direction) {

    return signals.filter(signal =>
        signal.signal === direction
    );
}


// ======================================================
// REQUEST BODY
// ======================================================

function readBody(req) {

    return new Promise((resolve, reject) => {

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", () => {

            try {

                resolve(
                    body ? JSON.parse(body) : {}
                );

            } catch (error) {

                reject(
                    new Error("Invalid JSON body")
                );
            }
        });

        req.on("error", reject);
    });
}


// ======================================================
// POSITION MANAGEMENT
// ======================================================

function addPosition(type, data) {

    if (!["equity", "options"].includes(type)) {
        throw new Error("Invalid position type");
    }

    const sameType = positions.filter(
        p => p.type === type && p.status === "OPEN"
    );

    const maxPositions =
        type === "equity"
            ? MAX_EQUITY_POSITIONS
            : MAX_OPTIONS_POSITIONS;

    if (sameType.length >= maxPositions) {
        throw new Error(
            "Maximum " + type + " positions reached"
        );
    }

    if (!data.symbol || !data.entryPrice) {
        throw new Error(
            "symbol and entryPrice are required"
        );
    }

    const position = {

        id:
            Date.now().toString() +
            Math.random().toString(36).slice(2, 7),

        type,

        symbol: String(data.symbol),

        direction:
            data.direction === "SELL"
                ? "SELL"
                : "BUY",

        entryPrice: Number(data.entryPrice),

        quantity: Number(data.quantity || 1),

        status: "OPEN",

        createdAt: new Date().toISOString()
    };

    positions.push(position);

    return position;
}


function closePosition(type, id) {

    const position = positions.find(
        p =>
            p.id === id &&
            p.type === type &&
            p.status === "OPEN"
    );

    if (!position) {
        return null;
    }

    position.status = "CLOSED";

    position.closedAt = new Date().toISOString();

    return position;
}


// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(async (req, res) => {

    const parsedUrl = new URL(
        req.url,
        "http://localhost"
    );

    const path = parsedUrl.pathname;

    try {

        // HEALTH
        if (req.method === "GET" && path === "/health") {

            return sendJson(res, 200, {
                success: true,
                message: "Smart Trade India V3 running",
                time: new Date().toISOString()
            });
        }


        // ORB STATUS
        if (
            req.method === "GET" &&
            path === "/api/orb/status"
        ) {

            return sendJson(res, 200, {
                success: true,
                instrumentsLoaded: instruments.length > 0,
                totalInstruments: instruments.length,
                lastMasterLoad: lastMasterLoad || null,
                lastScanTime: lastScanTime || null,
                lastScanError: lastScanError || null
            });
        }


        // REFRESH MASTER
        if (
            req.method === "GET" &&
            path === "/api/orb/refresh-master"
        ) {

            const total = await loadInstruments(true);

            return sendJson(res, 200, {
                success: true,
                totalInstruments: total
            });
        }


        // STOCK LIST
        if (
            req.method === "GET" &&
            path === "/api/orb/stocks"
        ) {

            if (!instruments.length) {
                await loadInstruments();
            }

            return sendJson(res, 200, {
                success: true,
                total: getStocksForScan("FNO").length,
                stocks: getStocksForScan("FNO")
            });
        }


        // FULL SCAN
        if (
            req.method === "GET" &&
            path === "/api/orb/scan"
        ) {

            const type =
                parsedUrl.searchParams.get("type") || "FNO";

            const result = await scanOrbStocks(type);

            lastScanTime = result.scanTime;
            lastScanError = null;

            return sendJson(res, 200, result);
        }


        // BULLISH SIGNALS
        if (
            req.method === "GET" &&
            path === "/api/orb/bullish"
        ) {

            const result = await scanOrbStocks("FNO");

            return sendJson(res, 200, {
                success: true,
                total: filterSignals(
                    result.signals,
                    "BUY"
                ).length,
                signals: filterSignals(
                    result.signals,
                    "BUY"
                )
            });
        }


        // BEARISH SIGNALS
        if (
            req.method === "GET" &&
            path === "/api/orb/bearish"
        ) {

            const result = await scanOrbStocks("FNO");

            return sendJson(res, 200, {
                success: true,
                total: filterSignals(
                    result.signals,
                    "SELL"
                ).length,
                signals: filterSignals(
                    result.signals,
                    "SELL"
                )
            });
        }


        // STRONG SIGNALS
        if (
            req.method === "GET" &&
            path === "/api/orb/strong"
        ) {

            const result = await scanOrbStocks("FNO");

            return sendJson(res, 200, {
                success: true,
                total: result.signals.length,
                signals: result.signals
            });
        }


        // GET POSITIONS
        if (
            req.method === "GET" &&
            path === "/api/positions"
        ) {

            return sendJson(res, 200, {
                success: true,
                positions
            });
        }


        // ADD EQUITY POSITION
        if (
            req.method === "POST" &&
            path === "/api/positions/equity"
        ) {

            const body = await readBody(req);

            const position = addPosition(
                "equity",
                body
            );

            return sendJson(res, 201, {
                success: true,
                position
            });
        }


        // ADD OPTIONS POSITION
        if (
            req.method === "POST" &&
            path === "/api/positions/options"
        ) {

            const body = await readBody(req);

            const position = addPosition(
                "options",
                body
            );

            return sendJson(res, 201, {
                success: true,
                position
            });
        }


        // CLOSE EQUITY / OPTIONS POSITION
        const closeMatch = path.match(
            /^\/api\/positions\/(equity|options)\/([^/]+)\/close$/
        );

        if (
            req.method === "POST" &&
            closeMatch
        ) {

            const type = closeMatch[1];
            const id = closeMatch[2];

            const position = closePosition(type, id);

            if (!position) {
                return sendJson(res, 404, {
                    success: false,
                    message: "Open position not found"
                });
            }

            return sendJson(res, 200, {
                success: true,
                position
            });
        }


        // ROUTE NOT FOUND
        return sendJson(res, 404, {
            success: false,
            message: "API route not found",
            path
        });

    } catch (error) {

        lastScanError = error.message;

        console.error("SERVER ERROR:", error);

        return sendJson(res, 500, {
            success: false,
            error: error.message
        });
    }
});


// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

    console.log(
        "SMART TRADE INDIA V3 RUNNING ON PORT " + PORT
    );

});
