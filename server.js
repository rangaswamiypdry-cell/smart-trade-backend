
"use strict";

// ======================================================
// SMART TRADE INDIA V11 PRO
// LIVE NSE INDEX + OPTIONS SELL SCANNER
// UPSTOX STANDARD API
// NODE.JS 20+
// PART 1 OF 2
// ======================================================

const http = require("http");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const BASE = "https://api.upstox.com";

const CONFIG = {
  VERSION: "SMART_TRADE_INDIA_V11_PRO",
  TIMEFRAME: "5",
  SCAN_START: "09:20",
  SCAN_INTERVAL: 30000,

  RSI_PERIOD: 14,
  RSI_BEARISH: 35,
  RSI_BULLISH: 55,

  EMA_FAST: 9,
  EMA_SLOW: 21,
  EMA_TREND: 50,

  VOLUME_MULTIPLIER: 1.5,
  OI_INCREASE_MIN: 2,

  ADX_MIN: 20,
  ADR_PERIOD: 14,

  VERY_STRONG_SCORE: 6,
  REQUIRE_ALL_CONDITIONS: true,

  MAX_STRIKES: 10,
  PAPER_MODE: true
};

// ------------------------------------------------------
// INDEX CONFIGURATION
// ------------------------------------------------------

const INDEXES = {
  NIFTY: {
    name: "NIFTY",
    key: "NSE_INDEX|Nifty 50",
    exchange: "NSE"
  },

  BANKNIFTY: {
    name: "BANKNIFTY",
    key: "NSE_INDEX|Nifty Bank",
    exchange: "NSE"
  },

  FINNIFTY: {
    name: "FINNIFTY",
    key: "NSE_INDEX|Nifty Fin Service",
    exchange: "NSE"
  },

  MIDCPNIFTY: {
    name: "MIDCPNIFTY",
    key: "NSE_INDEX|Nifty Midcap Select",
    exchange: "NSE"
  },

  SENSEX: {
    name: "SENSEX",
    key: "BSE_INDEX|SENSEX",
    exchange: "BSE"
  }
};

// ------------------------------------------------------
// GLOBAL DATA
// ------------------------------------------------------

const marketCache = new Map();
const optionCache = new Map();
const previousOI = new Map();
const signals = [];

let lastScanTime = null;
let serverStarted = new Date().toISOString();

// ------------------------------------------------------
// JSON RESPONSE
// ------------------------------------------------------

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data, null, 2));
}

// ------------------------------------------------------
// UPSTOX REQUEST
// ------------------------------------------------------

async function upstoxRequest(path) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN missing in Render");
  }

  const response = await fetch(BASE + path, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": "Bearer " + TOKEN
    },
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      "UPSTOX API ERROR " +
      response.status + ": " +
      JSON.stringify(data)
    );
  }

  return data;
}

// ------------------------------------------------------
// MARKET QUOTES
// ------------------------------------------------------

async function getMarketQuotes(keys) {
  if (!keys || !keys.length) return {};

  const unique = [...new Set(keys)];
  const chunks = [];

  for (let i = 0; i < unique.length; i += 100) {
    chunks.push(unique.slice(i, i + 100));
  }

  const output = {};

  for (const chunk of chunks) {
    const query = encodeURIComponent(chunk.join(","));

    const result = await upstoxRequest(
      "/v3/market-quote/quotes?instrument_key=" + query
    );

    Object.assign(output, result.data || {});
  }

  return output;
}

// ------------------------------------------------------
// EXTRACT QUOTE
// ------------------------------------------------------

function extractQuote(data) {
  const q = data || {};

  return {
    ltp: Number(q.last_price || 0),
    open: Number(q.ohlc?.open || 0),
    high: Number(q.ohlc?.high || 0),
    low: Number(q.ohlc?.low || 0),
    close: Number(q.prev_close_price || q.ohlc?.close || 0),
    volume: Number(q.volume || q.ohlc?.volume || 0),
    oi: Number(q.oi || 0),
    previousOI: Number(q.previous_oi || 0),
    buyQuantity: Number(q.total_buy_quantity || 0),
    sellQuantity: Number(q.total_sell_quantity || 0),
    timestamp: q.last_trade_time || q.timestamp || null
  };
}

// ------------------------------------------------------
// EMA
// ------------------------------------------------------

function calculateEMA(values, period) {
  if (!values || values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ------------------------------------------------------
// RSI - WILDER
// ------------------------------------------------------

function calculateRSI(values, period = 14) {
  if (!values || values.length <= period) return null;

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

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// ------------------------------------------------------
// VWAP
// ------------------------------------------------------

function calculateVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const typical =
      (c.high + c.low + c.close) / 3;

    totalPV += typical * c.volume;
    totalVolume += c.volume;
  }

  return totalVolume
    ? totalPV / totalVolume
    : null;
}

// ------------------------------------------------------
// ATR / ADR
// ------------------------------------------------------

function calculateADR(candles, period = 14) {
  if (!candles || candles.length < period) return null;

  const recent = candles.slice(-period);

  const ranges = recent.map(c =>
    c.high - c.low
  );

  return ranges.reduce((a, b) => a + b, 0) / period;
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length <= period) return null;

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

  return trs.slice(-period).reduce(
    (a, b) => a + b, 0
  ) / period;
}

// ------------------------------------------------------
// MACD
// ------------------------------------------------------

function calculateMACD(values) {
  if (values.length < 35) return null;

  const fast = calculateEMA(values, 12);
  const slow = calculateEMA(values, 26);

  if (fast === null || slow === null) return null;

  return {
    macd: fast - slow
  };
}

// ------------------------------------------------------
// OI CHANGE
// ------------------------------------------------------

function calculateOIChange(key, currentOI) {
  const previous = previousOI.get(key);

  previousOI.set(key, currentOI);

  if (!previous || previous <= 0) {
    return {
      change: 0,
      percent: 0,
      increasing: false,
      ready: false
    };
  }

  const change = currentOI - previous;

  return {
    change,
    percent: change / previous * 100,
    increasing: change > 0,
    ready: true
  };
}

// ------------------------------------------------------
// ORDER FLOW / FOOTPRINT PROXY
// ------------------------------------------------------

function calculateOrderFlow(quote) {
  const buy = quote.buyQuantity || 0;
  const sell = quote.sellQuantity || 0;
  const total = buy + sell;

  return {
    buyQuantity: buy,
    sellQuantity: sell,
    imbalance: buy - sell,
    imbalancePercent: total
      ? ((buy - sell) / total) * 100
      : 0,
    sellPressure: sell > buy,
    buyPressure: buy > sell
  };
}

// ------------------------------------------------------
// ADX
// ------------------------------------------------------

function calculateADX(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) {
    return null;
  }

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

  for (let i = period; i < tr.length; i++) {
    const t = tr.slice(i - period + 1, i + 1)
      .reduce((a, b) => a + b, 0);

    const p = plusDM.slice(i - period + 1, i + 1)
      .reduce((a, b) => a + b, 0);

    const m = minusDM.slice(i - period + 1, i + 1)
      .reduce((a, b) => a + b, 0);

    if (!t) continue;

    const pdi = 100 * p / t;
    const mdi = 100 * m / t;

    dx.push(
      100 * Math.abs(pdi - mdi) /
      Math.max(pdi + mdi, 0.000001)
    );
  }

  if (dx.length < period) return null;

  return dx.slice(-period).reduce(
    (a, b) => a + b, 0
  ) / period;
}


// ======================================================
// SMART TRADE INDIA V11 PRO
// PART 2 OF 2
// APPEND AFTER PART 1
// ======================================================

// ------------------------------------------------------
// INTRADAY 5-MINUTE CANDLES
// ------------------------------------------------------

async function getCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const result = await upstoxRequest(
    `/v3/historical-candle/intraday/${key}/minutes/5`
  );

  const now = Date.now();

  const candles = (result.data?.candles || [])
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

  return candles;
}

// ------------------------------------------------------
// MACD SERIES
// ------------------------------------------------------

function calculateMACDSignal(values) {
  if (values.length < 35) return null;

  const fastSeries = [];
  const slowSeries = [];

  function emaSeries(data, period) {
    const out = [];
    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        out.push(null);
      } else if (i === period - 1) {
        out.push(ema);
      } else {
        ema = (data[i] - ema) * multiplier + ema;
        out.push(ema);
      }
    }
    return out;
  }

  const e12 = emaSeries(values, 12);
  const e26 = emaSeries(values, 26);

  for (let i = 0; i < values.length; i++) {
    if (e12[i] !== null && e26[i] !== null) {
      fastSeries.push(e12[i] - e26[i]);
    }
  }

  if (fastSeries.length < 9) return null;

  const signal = calculateEMA(fastSeries, 9);
  const macd = fastSeries[fastSeries.length - 1];

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

// ------------------------------------------------------
// OPTION CHAIN
// ------------------------------------------------------

async function getOptionChain(instrumentKey) {
  const url =
    "/v2/option/chain?instrument_key=" +
    encodeURIComponent(instrumentKey) +
    "&expiry_date=current_week";

  const result = await upstoxRequest(url);

  return result.data || [];
}

// ------------------------------------------------------
// OPTION CONTRACT SELECTION
// ------------------------------------------------------

function selectSellStrike(chain, direction) {
  const candidates = [];

  for (const item of chain) {
    const spot = Number(item.underlying_spot_price || 0);
    const strike = Number(item.strike_price || 0);

    if (!spot || !strike) continue;

    const option = direction === "PE"
      ? item.put_options
      : item.call_options;

    if (!option?.instrument_key) continue;

    const md = option.market_data || {};
    const greeks = option.option_greeks || {};

    const ltp = Number(md.ltp || 0);
    const oi = Number(md.oi || 0);
    const volume = Number(md.volume || 0);
    const bid = Number(md.bid_price || 0);
    const ask = Number(md.ask_price || 0);
    const delta = Math.abs(Number(greeks.delta || 0));

    const spread = bid > 0 && ask > 0
      ? (ask - bid) / ask * 100
      : 999;

    // Select OTM strike for option selling.
    const isOTM = direction === "PE"
      ? strike < spot
      : strike > spot;

    if (!isOTM) continue;

    // Reject illiquid or wide-spread contracts.
    if (
      ltp <= 0 ||
      oi <= 0 ||
      volume <= 0 ||
      bid <= 0 ||
      ask <= 0 ||
      spread > 3
    ) continue;

    // Prefer moderate absolute delta.
    if (delta > 0 && (delta < 0.10 || delta > 0.40)) {
      continue;
    }

    const distance = Math.abs(strike - spot) / spot;

    const score =
      Math.log10(oi + 1) * 2 +
      Math.log10(volume + 1) * 2 -
      spread -
      distance * 100;

    candidates.push({
      direction,
      strike,
      spot,
      instrumentKey: option.instrument_key,
      expiry: item.expiry,
      ltp,
      oi,
      volume,
      bid,
      ask,
      spreadPercent: Number(spread.toFixed(2)),
      delta,
      gamma: Number(greeks.gamma || 0),
      theta: Number(greeks.theta || 0),
      vega: Number(greeks.vega || 0),
      iv: Number(greeks.iv || 0),
      score
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

// ------------------------------------------------------
// V11 SIX-CONDITION SIGNAL ENGINE
// ------------------------------------------------------

function analyseIndex(indexName, candles, quote, oiData) {
  if (candles.length < 55) {
    return {
      index: indexName,
      status: "WAIT",
      reason: "Need minimum 55 completed candles"
    };
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);

  const rsi = calculateRSI(closes, 14);
  const vwap = calculateVWAP(candles);
  const adx = calculateADX(candles, 14);
  const adr = calculateADR(candles, 14);
  const macd = calculateMACDSignal(closes);

  const avgVolume = candles
    .slice(-21, -1)
    .reduce((sum, c) => sum + c.volume, 0) / 20;

  const volumePass =
    avgVolume > 0 &&
    last.volume >= avgVolume * CONFIG.VOLUME_MULTIPLIER;

  const oiPass = oiData.ready &&
    oiData.percent >= CONFIG.OI_INCREASE_MIN;

  const priceUp = last.close > previous.close;
  const priceDown = last.close < previous.close;

  const trendUp =
    ema9 > ema21 &&
    ema21 > ema50 &&
    adx >= CONFIG.ADX_MIN;

  const trendDown =
    ema9 < ema21 &&
    ema21 < ema50 &&
    adx >= CONFIG.ADX_MIN;

  const macdUp = macd && macd.histogram > 0;
  const macdDown = macd && macd.histogram < 0;

  // PE SELL: underlying bullish.
  const peChecks = {
    trend: trendUp,
    vwap: last.close > vwap,
    rsi: rsi > CONFIG.RSI_BULLISH,
    macd: !!macdUp,
    volume: volumePass,
    oiPrice: oiPass && priceUp
  };

  // CE SELL: underlying bearish.
  const ceChecks = {
    trend: trendDown,
    vwap: last.close < vwap,
    rsi: rsi < CONFIG.RSI_BEARISH,
    macd: !!macdDown,
    volume: volumePass,
    oiPrice: oiPass && priceDown
  };

  const peScore = Object.values(peChecks).filter(Boolean).length;
  const ceScore = Object.values(ceChecks).filter(Boolean).length;

  let direction = null;

  if (peScore === 6) direction = "PE";
  if (ceScore === 6) direction = "CE";

  const orderFlow = calculateOrderFlow(quote);

  return {
    index: indexName,
    status: direction ? "VERY_STRONG_SELL" : "WAIT",
    direction,
    underlyingPrice: quote.ltp,
    candleClose: last.close,
    candleTime: new Date(last.time).toISOString(),
    rsi: Number(rsi.toFixed(2)),
    vwap: Number(vwap.toFixed(2)),
    ema9: Number(ema9.toFixed(2)),
    ema21: Number(ema21.toFixed(2)),
    ema50: Number(ema50.toFixed(2)),
    adx: Number(adx.toFixed(2)),
    adr: Number(adr.toFixed(2)),
    macd,
    volume: last.volume,
    averageVolume: Math.round(avgVolume),
    oiChangePercent: oiData.percent,
    footprintProxy: orderFlow,
    peScore,
    ceScore,
    peChecks,
    ceChecks,
    timestamp: new Date().toISOString()
  };
}

// ------------------------------------------------------
// SCAN ONE INDEX
// ------------------------------------------------------

async function scanOneIndex(name, config) {
  try {
    const [quotes, candles, chain] = await Promise.all([
      getMarketQuotes([config.key]),
      getCandles(config.key),
      getOptionChain(config.key)
    ]);

    const rawQuote = quotes[config.key] ||
      Object.values(quotes)[0] || {};

    const quote = extractQuote(rawQuote);

    if (!quote.ltp) {
      throw new Error("Live quote unavailable");
    }

    // Use completed candle OI when available.
    const lastCandle = candles[candles.length - 1];

    const currentOI = lastCandle?.oi || quote.oi;
    const oiData = calculateOIChange(
      config.key,
      currentOI
    );

    const analysis = analyseIndex(
      name,
      candles,
      quote,
      oiData
    );

    if (analysis.direction) {
      analysis.selectedStrike = selectSellStrike(
        chain,
        analysis.direction
      );

      if (!analysis.selectedStrike) {
        analysis.status = "WAIT";
        analysis.reason =
          "No liquid OTM strike passed selection filters";
      }
    }

    if (
      analysis.status === "VERY_STRONG_SELL" &&
      analysis.selectedStrike
    ) {
      const signalId =
        name + "_" +
        analysis.direction + "_" +
        analysis.candleTime;

      if (!signals.some(s => s.id === signalId)) {
        signals.unshift({
          id: signalId,
          ...analysis
        });

        if (signals.length > 100) signals.pop();
      }
    }

    marketCache.set(name, analysis);

    return analysis;

  } catch (error) {
    return {
      index: name,
      status: "ERROR",
      error: error.message
    };
  }
}
// ------------------------------------------------------
// ALL FIVE INDEX SCANNER
// ------------------------------------------------------

let scanRunning = false;

async function runFullScan() {
  if (scanRunning) {
    return { status: "SCAN_ALREADY_RUNNING" };
  }

  scanRunning = true;

  try {
    const results = {};

    for (const [name, config] of Object.entries(INDEXES)) {
      results[name] = await scanOneIndex(name, config);
    }

    lastScanTime = new Date().toISOString();

    return {
      status: "SUCCESS",
      version: CONFIG.VERSION,
      lastScanTime,
      results
    };

  } finally {
    scanRunning = false;
  }
}

// Replace the OI calculation inside scanOneIndex:

const previousCandle = candles[candles.length - 2];
const lastCandle = candles[candles.length - 1];

const oldOI = previousCandle?.oi || 0;
const currentOI = lastCandle?.oi || 0;

const oiData = {
  ready: oldOI > 0 && currentOI > 0,
  change: currentOI - oldOI,
  percent: oldOI > 0
    ? ((currentOI - oldOI) / oldOI) * 100
    : 0,
  increasing: currentOI > oldOI
};

// ------------------------------------------------------
// MARKET TIME - INDIA
// ------------------------------------------------------

function getIndiaTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const hour = Number(parts.find(p => p.type === "hour").value);
  const minute = Number(parts.find(p => p.type === "minute").value);

  return {
    hour,
    minute,
    minutes: hour * 60 + minute
  };
}

function isMarketTime() {
  const day = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "short"
    }).format(new Date()) === "Sun" ? 0 :
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "short"
    }).format(new Date()) === "Sat" ? 6 : 1
  );

  const t = getIndiaTime();

  return day !== 0 && day !== 6 &&
    t.minutes >= 560 && t.minutes <= 930;
}

// ------------------------------------------------------
// DASHBOARD HTML
// ------------------------------------------------------

const DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMART TRADE INDIA V11 PRO</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;padding:16px;
  background:#09111f;color:#eaf0ff;
  font-family:Arial,sans-serif
}
h1{font-size:22px;color:#56c5ff}
.sub{color:#a5b4ca;font-size:12px}
.cards{
 display:grid;
 grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
 gap:12px;margin-top:18px
}
.card{
 background:#142238;border:1px solid #2a405e;
 border-radius:12px;padding:15px
}
.name{font-size:18px;font-weight:bold}
.price{font-size:25px;margin:12px 0}
.green{color:#30e49a}
.red{color:#ff697d}
.yellow{color:#ffcf70}
button{
 background:#147bc1;color:white;border:0;
 border-radius:8px;padding:12px;margin:5px;
 font-weight:bold
}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{padding:9px;border-bottom:1px solid #30415a;text-align:left}
.panel{
 overflow:auto;background:#142238;
 padding:12px;border-radius:12px;margin-top:15px
}
.small{font-size:12px;color:#aabbd1}
</style>
</head>
<body>

<h1>SMART TRADE INDIA V11 PRO</h1>
<div class="sub">LIVE NSE / BSE INDEX OPTIONS SELL SCANNER</div>

<button onclick="refresh()">REFRESH SCAN</button>
<button onclick="soundOn()">ENABLE SOUND</button>

<div id="status" class="sub">Connecting...</div>
<div class="cards" id="cards"></div>

<div class="panel">
<h3>VERY STRONG SELL ALERTS</h3>
<table>
<thead>
<tr>
<th>Index</th><th>Signal</th><th>Strike</th>
<th>LTP</th><th>OI</th><th>Time</th>
</tr>
</thead>
<tbody id="alerts"></tbody>
</table>
</div>

<div class="panel">
<h3>Indicator Details</h3>
<div id="details" class="small">Waiting for scan...</div>
</div>

<script>
let soundEnabled=false;
let seen=new Set();

function soundOn(){
 soundEnabled=true;
 const ctx=new (window.AudioContext||window.webkitAudioContext)();
 const osc=ctx.createOscillator();
 osc.connect(ctx.destination);
 osc.start();
 osc.stop(ctx.currentTime+0.1);
}

function beep(){
 if(!soundEnabled)return;
 try{
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  const osc=ctx.createOscillator();
  const gain=ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value=880;
  gain.gain.value=0.15;
  osc.start();
  osc.stop(ctx.currentTime+0.35);
 }catch(e){}
}

function fmt(v){
 return Number(v||0).toLocaleString("en-IN");
}

async function refresh(){
 try{
  const [a,b]=await Promise.all([
   fetch("/api/market"),
   fetch("/api/signals")
  ]);

  const market=await a.json();
  const alerts=await b.json();

  document.getElementById("status").textContent=
   "Last scan: "+(market.lastScanTime||"Waiting")+
   " | Mode: "+(market.mode||"LIVE");

  const results=market.results||{};

  document.getElementById("cards").innerHTML=
   Object.values(results).map(x=>{
    const signal=x.direction||"WAIT";
    const color=signal==="CE"?"red":
     signal==="PE"?"green":"yellow";
    const strike=x.selectedStrike;
    return \`
    <div class="card">
      <div class="name">\${x.index}</div>
      <div class="price">\${fmt(x.underlyingPrice)}</div>
      <div class="\${color}">
       \${x.status==="VERY_STRONG_SELL"
        ? "VERY STRONG "+signal+" SELL"
        : x.status}
      </div>
      <p class="small">
       RSI: \${x.rsi??"-"} |
       ADX: \${x.adx??"-"}<br>
       VWAP: \${fmt(x.vwap)}<br>
       OI Change: \${x.oiChangePercent??"-"}%<br>
       Volume: \${fmt(x.volume)}
      </p>
      <b>\${strike
       ? strike.strike+" "+signal+" SELL"
       : "No confirmed strike"}</b>
    </div>\`;
   }).join("");

  const rows=alerts.signals||[];

  for(const s of rows){
   if(!seen.has(s.id)){
    seen.add(s.id);
    if(seen.size>200)seen.clear();
    beep();
   }
  }

  document.getElementById("alerts").innerHTML=
   rows.map(s=>\`
    <tr>
    <td>\${s.index}</td>
    <td class="red">\${s.direction} SELL</td>
    <td>\${s.selectedStrike?.strike??"-"}</td>
    <td>\${s.selectedStrike?.ltp??"-"}</td>
    <td>\${fmt(s.selectedStrike?.oi)}</td>
    <td>\${new Date(s.timestamp).toLocaleTimeString()}</td>
    </tr>\`
   ).join("");

  document.getElementById("details").innerHTML=
   Object.values(results).map(x=>
    "<p>"+x.index+
    " | PE checks: "+JSON.stringify(x.peChecks||{})+
    "<br>CE checks: "+JSON.stringify(x.ceChecks||{})+
    "</p>"
   ).join("");

 }catch(e){
  document.getElementById("status").textContent=
   "API ERROR: "+e.message;
 }
}

refresh();
setInterval(refresh,5000);
</script>
</body>
</html>`;

// ------------------------------------------------------
// HTTP SERVER
// ------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const url = new URL(
    req.url,
    "http://localhost:" + PORT
  );

  try {
    if (req.method !== "GET") {
      return sendJson(res, 405, {
        error: "GET requests only"
      });
    }

    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });
      return res.end(DASHBOARD);
    }

    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        status: "OK",
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        started: serverStarted,
        lastScanTime
      });
    }

    if (url.pathname === "/api/status") {
      return sendJson(res, 200, {
        version: CONFIG.VERSION,
        tokenConfigured: Boolean(TOKEN),
        scanRunning,
        lastScanTime,
        paperMode: CONFIG.PAPER_MODE
      });
    }

    if (url.pathname === "/api/scan") {
      if (!TOKEN) {
        return sendJson(res, 401, {
          status: "ERROR",
          error: "UPSTOX_ACCESS_TOKEN missing"
        });
      }

      const result = await runFullScan();
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/market") {
      return sendJson(res, 200, {
        version: CONFIG.VERSION,
        mode: TOKEN ? "LIVE_API_POLLING" : "NO_TOKEN",
        lastScanTime,
        results: Object.fromEntries(marketCache)
      });
    }

    if (url.pathname === "/api/signals") {
      return sendJson(res, 200, {
        count: signals.length,
        signals
      });
    }

    if (url.pathname === "/api/indexes") {
      return sendJson(res, 200, {
        indexes: INDEXES
      });
    }

    return sendJson(res, 404, {
      error: "Route not found",
      routes: [
        "/",
        "/health",
        "/api/status",
        "/api/scan",
        "/api/market",
        "/api/signals",
        "/api/indexes"
      ]
    });

  } catch (error) {
    return sendJson(res, 500, {
      status: "ERROR",
      error: error.message
    });
  }
});

// ------------------------------------------------------
// AUTOMATIC SCAN
// ------------------------------------------------------

setInterval(() => {
  if (TOKEN && isMarketTime() && !scanRunning) {
    runFullScan().catch(error => {
      console.error("[V11 SCAN ERROR]", error.message);
    });
  }
}, 60000);

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log("=================================");
  console.log("SMART TRADE INDIA V11 PRO");
  console.log("PORT:", PORT);
  console.log("TOKEN:", TOKEN ? "CONFIGURED" : "MISSING");
  console.log("INDEXES:", Object.keys(INDEXES).join(", "));
  console.log("MODE:", CONFIG.PAPER_MODE ? "PAPER" : "LIVE");
  console.log("=================================");
});
        
