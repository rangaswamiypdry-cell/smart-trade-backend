const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;

// ==================================================
// SMART TRADE INDIA - CONFIRMED SIGNAL BACKEND
// 5-MIN CLOSED CANDLE / NON-REPAINT RULES
// CALL BUY + PUT BUY + ENTRY + SL + TARGETS
// NIFTY + BANKNIFTY + SENSEX + NSE STOCK OPTIONS
// ==================================================

const ALERT_THRESHOLD = 75;
const STRONG_THRESHOLD = 80;
const VOLUME_MULTIPLIER = 1.5;
const ADX_MIN = 20;
const SR_LOOKBACK = 20;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(data));
}

async function upstoxRequest(apiUrl) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    throw new Error("UPSTOX_ACCESS_TOKEN_MISSING");
  }

  const response = await fetch(apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `Upstox API request failed (${response.status})`
    );
  }

  return data;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, digits = 2) {
  const n = num(v);
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function candleTime(c) {
  return new Date(c[0]).getTime();
}

function getClosedCandles(candles, intervalMinutes = 5) {
  const intervalMs = intervalMinutes * 60 * 1000;

  return (candles || [])
    .filter(c => candleTime(c) + intervalMs <= Date.now())
    .sort((a, b) => candleTime(a) - candleTime(b));
}

// ==================================================
// INDICATORS
// ==================================================

function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) {
      gain += change;
    } else {
      loss += Math.abs(change);
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return round(
    100 - 100 / (1 + avgGain / avgLoss),
    2
  );
}

function calculateEMA(values, period = 20) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);

  let ema =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return round(ema, 2);
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    return null;
  }

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const high = num(candles[i][2]);
    const low = num(candles[i][3]);
    const prevClose = num(candles[i - 1][4]);

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  if (tr.length < period) {
    return null;
  }

  let atr =
    tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < tr.length; i++) {
    atr = ((atr * (period - 1)) + tr[i]) / period;
  }

  return round(atr, 2);
}

function calculateADX(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) {
    return null;
  }

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const high = num(candles[i][2]);
    const low = num(candles[i][3]);

    const prevHigh = num(candles[i - 1][2]);
    const prevLow = num(candles[i - 1][3]);
    const prevClose = num(candles[i - 1][4]);

    const up = high - prevHigh;
    const down = prevLow - low;

    plusDM.push(
      up > down && up > 0 ? up : 0
    );

    minusDM.push(
      down > up && down > 0 ? down : 0
    );

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  let atr =
    trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  let pDM =
    plusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;

  let mDM =
    minusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const dx = [];

  let lastPDI = 0;
  let lastMDI = 0;

  for (let i = period; i < trs.length; i++) {
    atr = ((atr * (period - 1)) + trs[i]) / period;

    pDM =
      ((pDM * (period - 1)) + plusDM[i]) / period;

    mDM =
      ((mDM * (period - 1)) + minusDM[i]) / period;

    lastPDI = atr > 0 ? (pDM / atr) * 100 : 0;
    lastMDI = atr > 0 ? (mDM / atr) * 100 : 0;

    const sum = lastPDI + lastMDI;

    dx.push(
      sum > 0
        ? (Math.abs(lastPDI - lastMDI) / sum) * 100
        : 0
    );
  }

  if (dx.length < period) {
    return null;
  }

  let adx =
    dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dx.length; i++) {
    adx = ((adx * (period - 1)) + dx[i]) / period;
  }

  return {
    adx: round(adx, 2),
    plusDI: round(lastPDI, 2),
    minusDI: round(lastMDI, 2)
  };
}

function calculateVWAP(candles) {
  if (!candles?.length) {
    return null;
  }

  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    const typical =
      (num(c[2]) + num(c[3]) + num(c[4])) / 3;

    const v = num(c[5]);

    pv += typical * v;
    volume += v;
  }

  return volume > 0 ? round(pv / volume, 2) : null;
}

function calculateADR(candles, period = 14) {
  if (!candles || candles.length < period) {
    return null;
  }

  const ranges = candles
    .slice(-period)
    .map(c => num(c[2]) - num(c[3]))
    .filter(v => v >= 0);

  if (!ranges.length) {
    return null;
  }

  return round(
    ranges.reduce((a, b) => a + b, 0) / ranges.length,
    2
  );
}

function supportResistance(candles, lookback = SR_LOOKBACK) {
  if (!candles || candles.length < lookback + 2) {
    return null;
  }

  // Current candle is excluded from level calculation.
  const base = candles.slice(-(lookback + 1), -1);

  const resistance = Math.max(
    ...base.map(c => num(c[2]))
  );

  const support = Math.min(
    ...base.map(c => num(c[3]))
  );

  return {
    support: round(support, 2),
    resistance: round(resistance, 2)
  };
}

function candleStructure(c) {
  const open = num(c[1]);
  const high = num(c[2]);
  const low = num(c[3]);
  const close = num(c[4]);

  const range = Math.max(high - low, 0);
  const body = Math.abs(close - open);

  const closePosition =
    range > 0 ? (close - low) / range : 0.5;

  return {
    bullish:
      close > open &&
      closePosition >= 0.65 &&
      body >= range * 0.45,

    bearish:
      close < open &&
      closePosition <= 0.35 &&
      body >= range * 0.45,

    body: round(body, 2),
    range: round(range, 2),
    closePosition: round(closePosition, 2)
  };
      }
