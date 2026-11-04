// ======================================================
// SMART TRADE INDIA
// INSTITUTIONAL MOMENTUM SCANNER V5
//
// NSE F&O STOCKS
// STOCK FUTURES + STOCK OPTIONS
//
// STRONG BUY / STRONG SELL
// CALL BUY / PUT BUY
// LONG BUILDUP / SHORT BUILDUP
// VOLUME BLAST
// SUDDEN MOMENTUM
// ORDER BLOCK
//
// NODE.JS 20+
// UPSTOX V3
// ======================================================

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const BASE = "https://api.upstox.com";

// ======================================================
// SETTINGS
// ======================================================

const CONFIG = {

    TIMEFRAME: 5,

    RSI_BUY: 60,
    RSI_STRONG: 70,
    RSI_SELL: 40,

    VOLUME_SPIKE: 2,
    VOLUME_BLAST: 3,

    OI_INCREASE: 2,

    EMA_FAST: 20,
    EMA_SLOW: 50,

    ADX_MIN: 25,

    BREAKOUT_LOOKBACK: 20,

    ORDER_BLOCK_LOOKBACK: 20,

    OPTION_MIN_DELTA: 0.40,
    OPTION_MAX_DELTA: 0.80,

    MAX_SPREAD: 2,

    TARGET_1: 1.5,
    TARGET_2: 2.5,

    MAX_STOCKS: Number(
        process.env.MAX_STOCKS || 200
    ),

    WORKERS: 3
};

// ======================================================
// GLOBAL DATA
// ======================================================

let instruments = [];
let equityMap = {};

let stockResults = [];
let optionResults = [];

let lastScanTime = null;
let scanRunning = false;

const optionSnapshots = new Map();

// ======================================================
// UPSTOX REQUEST
// ======================================================

async function upstoxRequest(url) {

    if (!TOKEN) {
        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing"
        );
    }

    const response = await fetch(url, {

        method: "GET",

        headers: {

            "Accept": "application/json",

            "Authorization": `Bearer ${TOKEN}`

        },

        signal: AbortSignal.timeout(20000)

    });

    const data = await response.json();

    if (!response.ok) {

        throw new Error(
            data.message ||
            `Upstox Error ${response.status}`
        );
    }

    return data;
}

// ======================================================
// LOAD NSE INSTRUMENTS
// ======================================================

async function loadInstruments() {

    const url =
        "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

    const response = await fetch(url);

    if (!response.ok) {

        throw new Error(
            "NSE instrument download failed"
        );
    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    const json = JSON.parse(
        zlib.gunzipSync(buffer).toString("utf8")
    );

    const today =
        new Date().toISOString().slice(0, 10);

    const equities = json.filter(x =>

        x.segment === "NSE_EQ" &&
        x.instrument_type === "EQ" &&
        x.trading_symbol

    );

    equityMap = {};

    for (const stock of equities) {

        equityMap[stock.trading_symbol] =
            stock.instrument_key;
    }

    const futures = json.filter(x =>

        x.segment === "NSE_FO" &&
        x.instrument_type === "FUT" &&
        x.expiry >= today &&
        x.underlying_symbol

    );

    const nearest = new Map();

    for (const future of futures) {

        const old = nearest.get(
            future.underlying_symbol
        );

        if (!old || future.expiry < old.expiry) {

            nearest.set(
                future.underlying_symbol,
                future
            );
        }
    }

    instruments = [...nearest.values()]

        .filter(x => equityMap[x.underlying_symbol])

        .slice(0, CONFIG.MAX_STOCKS);

    return instruments.length;
}

// ======================================================
// CANDLE DATA
// ======================================================

async function getCandles(key) {

    const url =
        `${BASE}/v3/historical-candle/intraday/` +
        `${encodeURIComponent(key)}/minutes/5`;

    const result = await upstoxRequest(url);

    const raw =
        result.data?.candles ||
        result.data?.candle ||
        [];

    const now = Date.now();

    return raw.map(c => ({

        time: c[0],

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5]),

        oi: Number(c[6] || 0)

    }))

    .filter(c => {

        const start =
            new Date(c.time).getTime();

        return (
            Number.isFinite(start) &&
            start + 300000 <= now
        );
    })

    .sort((a, b) =>
        new Date(a.time) - new Date(b.time)
    );
}

// ======================================================
// RSI
// ======================================================

function RSI(candles, period = 14) {

    if (candles.length < period + 1) {
        return 0;
    }

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        if (change > 0) gain += change;

        else loss += Math.abs(change);
    }

    let avgGain = gain / period;
    let avgLoss = loss / period;

    for (
        let i = period + 1;
        i < candles.length;
        i++
    ) {

        const change =
            candles[i].close -
            candles[i - 1].close;

        avgGain = (
            avgGain * (period - 1) +
            Math.max(change, 0)
        ) / period;

        avgLoss = (
            avgLoss * (period - 1) +
            Math.max(-change, 0)
        ) / period;
    }

    if (avgLoss === 0) return 100;

    return 100 -
        (100 / (1 + avgGain / avgLoss));
}

// ======================================================
// EMA
// ======================================================

function EMA(values, period) {

    if (values.length < period) return 0;

    const multiplier = 2 / (period + 1);

    let value = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        value =
            (values[i] - value) *
            multiplier + value;
    }

    return value;
}

// ======================================================
// VWAP
// ======================================================

function VWAP(candles) {

    let pv = 0;
    let volume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        pv += typical * c.volume;

        volume += c.volume;
    }

    return volume ? pv / volume : 0;
}

// ======================================================
// ADX
// ======================================================

function ADX(candles, period = 14) {

    if (candles.length < period + 2) {
        return 0;
    }

    const dx = [];

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {

        const current = candles[i];
        const previous = candles[i - 1];

        const up =
            current.high - previous.high;

        const down =
            previous.low - current.low;

        const plusDM =
            up > down && up > 0 ? up : 0;

        const minusDM =
            down > up && down > 0 ? down : 0;

        const tr = Math.max(

            current.high - current.low,

            Math.abs(
                current.high - previous.close
            ),

            Math.abs(
                current.low - previous.close
            )

        );

        if (!tr) continue;

        const plusDI = plusDM / tr * 100;

        const minusDI = minusDM / tr * 100;

        dx.push(
            Math.abs(plusDI - minusDI) /
            Math.max(plusDI + minusDI, 0.0001) *
            100
        );
    }

    if (!dx.length) return 0;

    return dx.slice(-period)
        .reduce((a, b) => a + b, 0) /
        Math.min(period, dx.length);
}

// ======================================================
// ORDER BLOCK
// ======================================================

function ORDER_BLOCK(candles) {

    if (candles.length < 5) return null;

    const last = candles[candles.length - 1];

    for (
        let i = candles.length - 3;
        i >= candles.length - 5;
        i--
    ) {

        const base = candles[i];

        const next = candles[i + 1];

        const bullish =

            base.close < base.open &&

            next.close > next.open &&

            next.close > base.high;

        const bearish =

            base.close > base.open &&

            next.close < next.open &&

            next.close < base.low;

        if (bullish && last.close > base.high) {

            return {

                type: "BULLISH",

                high: base.high,

                low: base.low

            };
        }

        if (bearish && last.close < base.low) {

            return {

                type: "BEARISH",

                high: base.high,

                low: base.low

            };
        }
    }

    return null;
}

// ======================================================
// ANALYSE STOCK FUTURES
// ======================================================

async function analyseStock(stock) {

    try {

        const candles =
            await getCandles(stock.instrument_key);

        if (candles.length < 55) return null;

        const last =
            candles[candles.length - 1];

        const prev =
            candles[candles.length - 2];

        const closes =
            candles.map(c => c.close);

        const rsi = RSI(candles);

        const ema20 =
            EMA(closes, 20);

        const ema50 =
            EMA(closes, 50);

        const today =
            new Date(last.time).toDateString();

        const todayCandles =
            candles.filter(c =>
                new Date(c.time).toDateString() === today
            );

        const vwap =
            VWAP(todayCandles);

        const adx =
            ADX(candles);

        const avgVolume =
            candles.slice(-21, -1)
                .reduce((a, c) =>
                    a + c.volume, 0) / 20;

        const volumeRatio =
            avgVolume > 0
                ? last.volume / avgVolume
                : 0;

        const priceChange =
            prev.close > 0
                ? (last.close - prev.close) /
                  prev.close * 100
                : 0;

        const oiChange =
            prev.oi > 0
                ? (last.oi - prev.oi) /
                  prev.oi * 100
                : 0;

        const longBuildup =
            priceChange > 0 &&
            oiChange > CONFIG.OI_INCREASE;

        const shortBuildup =
            priceChange < 0 &&
            oiChange > CONFIG.OI_INCREASE;

        const resistance = Math.max(
            ...candles.slice(-21, -1)
                .map(c => c.high)
        );

        const support = Math.min(
            ...candles.slice(-21, -1)
                .map(c => c.low)
        );

        const breakout =
            last.close > resistance;

        const breakdown =
            last.close < support;

        const vwapCrossUp =
            prev.close <= vwap &&
            last.close > vwap;

        const vwapCrossDown =
            prev.close >= vwap &&
            last.close < vwap;

        const orderBlock =
            ORDER_BLOCK(candles);

        const bullishTrend =
            last.close > ema20 &&
            ema20 > ema50 &&
            last.close > vwap;

        const bearishTrend =
            last.close < ema20 &&
            ema20 < ema50 &&
            last.close < vwap;

        const strongBuy =

            bullishTrend &&

            rsi >= CONFIG.RSI_BUY &&

            rsi <= 75 &&

            volumeRatio >= CONFIG.VOLUME_SPIKE &&

            longBuildup &&

            adx >= CONFIG.ADX_MIN;

        const strongSell =

            bearishTrend &&

            rsi < CONFIG.RSI_SELL &&

            volumeRatio >= CONFIG.VOLUME_SPIKE &&

            shortBuildup &&

            adx >= CONFIG.ADX_MIN;

        let signal = "NO TRADE";

        if (strongBuy && breakout) {

            signal = "STRONG BUY";

        } else if (strongSell && breakdown) {

            signal = "STRONG SELL";

        } else if (strongBuy) {

            signal = "BUY";

        } else if (strongSell) {

            signal = "SELL";
        }

        const direction =
            signal.includes("BUY") ? 1 :
            signal.includes("SELL") ? -1 : 0;

        const entry = last.close;

        const sl = direction === 1
            ? Math.min(last.low, ema20)
            : direction === -1
                ? Math.max(last.high, ema20)
                : 0;

        const risk = Math.abs(entry - sl);

        const target1 = direction
            ? entry + direction *
              risk * CONFIG.TARGET_1
            : 0;

        const target2 = direction
            ? entry + direction *
              risk * CONFIG.TARGET_2
            : 0;

        let strength = 0;

        if (direction) {

            if (volumeRatio >= 2) strength += 15;

            if (volumeRatio >= 3) strength += 10;

            if (Math.abs(oiChange) >= 2) strength += 15;

            if (adx >= 25) strength += 10;

            if (rsi >= 60 && rsi <= 75 &&
                direction === 1) strength += 10;

            if (breakout && direction === 1) strength += 15;

            if (breakdown && direction === -1) strength += 15;

            if (orderBlock &&
                orderBlock.type ===
                (direction === 1 ? "BULLISH" : "BEARISH")
            ) strength += 10;

            if (direction === 1 && vwapCrossUp) {
                strength += 10;
            }

            if (direction === -1 && vwapCrossDown) {
                strength += 10;
            }

            if (bullishTrend || bearishTrend) {
                strength += 5;
            }
        }

        return {

            symbol: stock.underlying_symbol,

            futureSymbol: stock.trading_symbol,

            instrumentKey: stock.instrument_key,

            equityKey: equityMap[stock.underlying_symbol],

            price: entry,

            priceChange,

            oi: last.oi,

            oiChange,

            longBuildup,

            shortBuildup,

            volume: last.volume,

            volumeRatio,

            volumeBlast:
                volumeRatio >= CONFIG.VOLUME_BLAST,

            rsi,

            ema20,

            ema50,

            vwap,

            adx,

            breakout,

            breakdown,

            vwapCrossUp,

            vwapCrossDown,

            orderBlock,

            signal,

            strength: Math.min(strength, 100),

            entry,

            stopLoss: sl,

            target1,

            target2,

            candleTime: last.time

        };

    } catch (error) {

        return {

            symbol: stock.underlying_symbol,

            error: error.message

        };
    }
}

// ======================================================
// OPTION CHAIN
// ======================================================

async function getOptionChain(equityKey) {

    const url =
        `${BASE}/v2/option/contract?instrument_key=` +
        encodeURIComponent(equityKey);

    const contracts = await upstoxRequest(url);

    const all =
        contracts.data || [];

    const today =
        new Date().toISOString().slice(0, 10);

    const expiries = [...new Set(

        all.filter(x => x.expiry >= today)

            .map(x => x.expiry)

    )].sort();

    if (!expiries.length) return [];

    const expiry = expiries[0];

    const chainUrl =
        `${BASE}/v2/option/chain?instrument_key=` +
        encodeURIComponent(equityKey) +
        `&expiry_date=${expiry}`;

    const result =
        await upstoxRequest(chainUrl);

    return result.data || [];
}

// ======================================================
// OPTION MOMENTUM ANALYSIS
// ======================================================

function analyseOption(
    option,
    stock,
    type,
    strike
) {

    if (!option || !option.market_data) return null;

    const md = option.market_data;

    const greeks =
        option.option_greeks || {};

    const price = Number(md.ltp || 0);

    const close = Number(md.close_price || 0);

    const oi = Number(md.oi || 0);

    const previousOI =
        Number(md.prev_oi || 0);

    const volume =
        Number(md.volume || 0);

    const bid =
        Number(md.bid_price || 0);

    const ask =
        Number(md.ask_price || 0);

    const delta =
        Number(greeks.delta || 0);

    const iv =
        Number(greeks.iv || 0);

    const priceChange =
        close > 0
            ? (price - close) / close * 100
            : 0;

    const oiChange =
        previousOI > 0
            ? (oi - previousOI) /
              previousOI * 100
            : 0;

    const spread =
        ask > 0 && bid > 0
            ? (ask - bid) / ask * 100
            : 100;

    const previous =
        optionSnapshots.get(option.instrument_key);

    const previousVolume =
        previous ? previous.volume : 0;

    const previousOIValue =
        previous ? previous.oi : 0;

    const volumeIncrease =
        previousVolume > 0
            ? volume / previousVolume
            : 0;

    const snapshotOIChange =
        previousOIValue > 0
            ? (oi - previousOIValue) /
              previousOIValue * 100
            : 0;

    optionSnapshots.set(option.instrument_key, {

        volume,

        oi

    });

    const directional =
        type === "CE"
            ? stock.signal.includes("BUY")
            : stock.signal.includes("SELL");

    const deltaPass =
        type === "CE"
            ? delta >= CONFIG.OPTION_MIN_DELTA &&
              delta <= CONFIG.OPTION_MAX_DELTA
            : delta <= -CONFIG.OPTION_MIN_DELTA &&
              delta >= -CONFIG.OPTION_MAX_DELTA;

    const spreadPass =
        spread <= CONFIG.MAX_SPREAD;

    const premiumIncrease =
        priceChange > 0;

    const optionLongBuildup =
        premiumIncrease && oiChange > 0;

    let signal = "WATCH";

    if (

        directional &&

        premiumIncrease &&

        deltaPass &&

        spreadPass &&

        optionLongBuildup &&

        volume > 0

    ) {

        signal =
            type === "CE"
                ? "CALL BUY"
                : "PUT BUY";
    }

    return {

        stock: stock.symbol,

        optionSymbol:
            option.trading_symbol,

        instrumentKey:
            option.instrument_key,

        optionType: type,

        strike,

        expiry: option.expiry,

        premium: price,

        premiumChange: priceChange,

        oi,

        oiChange,

        volume,

        snapshotVolumeRatio:
            volumeIncrease,

        snapshotOIChange,

        volumeBlast:
            volumeIncrease >= 3,

        delta,

        iv,

        bid,

        ask,

        spread,

        optionLongBuildup,

        signal

    };
}

// ======================================================
// ANALYSE OPTIONS FOR ONE STOCK
// ======================================================

async function analyseStockOptions(stock) {

    try {

        if (!stock.equityKey) return [];

        const chain =
            await getOptionChain(stock.equityKey);

        if (!chain.length) return [];

        const spot =
            Number(chain[0].underlying_spot_price || 0);

        if (!spot) return [];

        const strikes = [...new Set(
            chain.map(x => Number(x.strike_price))
        )].sort((a, b) => a - b);

        let atm = strikes[0];

        for (const strike of strikes) {

            if (
                Math.abs(strike - spot) <
                Math.abs(atm - spot)
            ) {
                atm = strike;
            }
        }

        const step = strikes.length > 1
            ? Math.min(
                ...strikes.slice(1).map((x, i) =>
                    x - strikes[i]
                )
            )
            : 0;

        const selected =
            chain.filter(x =>
                Math.abs(
                    Number(x.strike_price) - atm
                ) <= step * 2
            );

        const results = [];

        for (const row of selected) {

            const ce = analyseOption(
                row.call_options,
                stock,
                "CE",
                row.strike_price
            );

            const pe = analyseOption(
                row.put_options,
                stock,
                "PE",
                row.strike_price
            );

            if (ce) results.push(ce);

            if (pe) results.push(pe);
        }

        return results;

    } catch (error) {

        return [{
            stock: stock.symbol,
            error: error.message
        }];
    }
}

// ======================================================
// WORKER POOL
// ======================================================

async function processPool(items, worker, limit) {

    const output = new Array(items.length);

    let index = 0;

    async function run() {

        while (true) {

            const current = index++;

            if (current >= items.length) return;

            try {

                output[current] =
                    await worker(items[current]);

            } catch (error) {

                output[current] = null;
            }
        }
    }

    await Promise.all(

        Array.from(
            { length: limit },
            () => run()
        )

    );

    return output;
}

// ======================================================
// MAIN SCAN
// ======================================================

async function runScan() {

    if (scanRunning) {

        throw new Error(
            "Scan already running"
        );
    }

    scanRunning = true;

    try {

        if (!instruments.length) {

            await loadInstruments();
        }

        const stockData = await processPool(

            instruments,

            analyseStock,

            CONFIG.WORKERS

        );

        stockResults = stockData

            .flat()

            .filter(x => x && !x.error)

            .sort((a, b) =>
                b.strength - a.strength
            );

        // Scan option chain only for stocks
        // showing meaningful bullish/bearish signals.

        const selectedStocks =
            stockResults.filter(x =>

                x.signal === "STRONG BUY" ||
                x.signal === "STRONG SELL" ||
                x.signal === "BUY" ||
                x.signal === "SELL"

            );

        const optionData = await processPool(

            selectedStocks,

            analyseStockOptions,

            CONFIG.WORKERS

        );

        optionResults = optionData

            .flat()

            .filter(x => x && !x.error)

            .sort((a, b) =>
                Math.abs(b.premiumChange) -
                Math.abs(a.premiumChange)
            );

        lastScanTime =
            new Date().toISOString();

        return {

            success: true,

            scanTime: lastScanTime,

            totalStocks: stockResults.length,

            totalOptions: optionResults.length,

            stocks: stockResults,

            options: optionResults

        };

    } finally {

        scanRunning = false;
    }
}

// ======================================================
// SIGNAL FILTERS
// ======================================================

function getSignals() {

    return {

        strongBuy: stockResults.filter(x =>
            x.signal === "STRONG BUY"
        ),

        strongSell: stockResults.filter(x =>
            x.signal === "STRONG SELL"
        ),

        buy: stockResults.filter(x =>
            x.signal === "BUY"
        ),

        sell: stockResults.filter(x =>
            x.signal === "SELL"
        ),

        longBuildup: stockResults.filter(x =>
            x.longBuildup
        ),

        shortBuildup: stockResults.filter(x =>
            x.shortBuildup
        ),

        volumeBlast: stockResults.filter(x =>
            x.volumeBlast
        ),

        suddenMomentum: stockResults.filter(x =>
            x.volumeBlast &&
            Math.abs(x.priceChange) >= 0.5
        ),

        bullishOrderBlock: stockResults.filter(x =>
            x.orderBlock?.type === "BULLISH"
        ),

        bearishOrderBlock: stockResults.filter(x =>
            x.orderBlock?.type === "BEARISH"
        ),

        callBuy: optionResults.filter(x =>
            x.signal === "CALL BUY"
        ),

        putBuy: optionResults.filter(x =>
            x.signal === "PUT BUY"
        )

    };
}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(async (req, res) => {

    res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
    );

    res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
    );

    if (req.method === "OPTIONS") {

        res.writeHead(204);

        return res.end();
    }

    const send = (status, data) => {

        res.writeHead(status);

        res.end(JSON.stringify(data));
    };

    try {

        if (req.url === "/health") {

            return send(200, {

                status: "OK",

                scanner: "SMART TRADE INDIA V5",

                stocks: instruments.length,

                scanRunning

            });
        }

        if (req.url === "/api/status") {

            return send(200, {

                success: true,

                stocks: stockResults.length,

                options: optionResults.length,

                scanTime: lastScanTime,

                scanRunning

            });
        }

        if (req.url === "/api/scan") {

            if (scanRunning) {

                return send(202, {

                    success: true,

                    message: "Scan already running",

                    scanRunning: true

                });
            }

            const data = await runScan();

            return send(200, data);
        }

        if (req.url === "/api/signals") {

            return send(200, {

                success: true,

                scanTime: lastScanTime,

                ...getSignals()

            });
        }

        if (req.url === "/api/stocks") {

            return send(200, {

                success: true,

                data: stockResults

            });
        }

        if (req.url === "/api/options") {

            return send(200, {

                success: true,

                data: optionResults

            });
        }

        if (req.url === "/api/buy") {

            return send(200, {

                data: stockResults.filter(x =>
                    x.signal.includes("BUY")
                )

            });
        }

        if (req.url === "/api/sell") {

            return send(200, {

                data: stockResults.filter(x =>
                    x.signal.includes("SELL")
                )

            });
        }

        return send(404, {

            success: false,

            message: "API route not found"

        });

    } catch (error) {

        console.error(error);

        return send(500, {

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
        "=================================="
    );

    console.log(
        "SMART TRADE INDIA V5 STARTED"
    );

    console.log(
        "PORT:", PORT
    );

    console.log(
        "=================================="
    );

});
