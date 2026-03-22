const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const SYMBOL = process.env.SYMBOL || "BTC-USDT";
const ENABLE_TELEGRAM = String(process.env.ENABLE_TELEGRAM || "true") === "true";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 60 * 1000); // 每分钟检查一次，内部会过滤
const BINGX_BASE_URL = process.env.BINGX_BASE_URL || "https://open-api.bingx.com";

let lastSignalKey = null;
let lastScanCandleTime = null;

// =========================
// 工具函数
// =========================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "-";
  return Number(v).toFixed(d);
}

function percent(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "-";
  return `${Number(v).toFixed(d)}%`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function roundToPrice(v) {
  if (v >= 1000) return Number(v.toFixed(1));
  if (v >= 100) return Number(v.toFixed(2));
  return Number(v.toFixed(3));
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// =========================
// BingX K线
// =========================
async function fetchBingxKlines(interval = "5m", limit = 300) {
  try {
    const url = `${BINGX_BASE_URL}/openApi/swap/v3/quote/klines`;

    const res = await axios.get(url, {
      params: {
        symbol: SYMBOL,
        interval,
        limit,
      },
      timeout: 15000,
    });

    const raw = res?.data;

    // 先把原始返回打印出来，方便 Railway logs 看
    console.log("BingX raw response:", JSON.stringify(raw).slice(0, 1000));

    let rows = [];

    // 常见格式 1
    if (Array.isArray(raw?.data)) {
      rows = raw.data;
    }
    // 常见格式 2
    else if (Array.isArray(raw?.data?.data)) {
      rows = raw.data.data;
    }
    // 常见格式 3
    else if (Array.isArray(raw?.data?.klines)) {
      rows = raw.data.klines;
    }
    // 常见格式 4
    else if (Array.isArray(raw?.klines)) {
      rows = raw.klines;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`No kline data from BingX: ${interval} | raw=${JSON.stringify(raw).slice(0, 300)}`);
    }

    const mapped = rows.map((r) => ({
      time: Number(r.time || r.timestamp || r.openTime || r[0] || 0),
      open: Number(r.open || r[1]),
      high: Number(r.high || r[2]),
      low: Number(r.low || r[3]),
      close: Number(r.close || r[4]),
      volume: Number(r.volume || r.vol || r[5] || 0),
    }));

    return mapped
      .filter(c => c.time && !Number.isNaN(c.close))
      .sort((a, b) => a.time - b.time);

  } catch (err) {
    throw new Error(`fetchBingxKlines(${interval}) failed: ${err.message}`);
  }
}

// =========================
// 指标函数
// =========================
function ema(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = mean(values.slice(0, period));
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
    } else if (i === period - 1) {
      out.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return [];
  const out = new Array(values.length).fill(null);

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return [];
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
    } else {
      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }

  const out = new Array(candles.length).fill(null);
  let prevAtr = mean(trs.slice(0, period));
  out[period - 1] = prevAtr;

  for (let i = period; i < trs.length; i++) {
    prevAtr = (prevAtr * (period - 1) + trs[i]) / period;
    out[i] = prevAtr;
  }

  return out;
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = values.map((_, i) => {
    if (fastEma[i] == null || slowEma[i] == null) return null;
    return fastEma[i] - slowEma[i];
  });

  const cleanMacd = macdLine.map((v) => (v == null ? 0 : v));
  const signal = ema(cleanMacd, signalPeriod);

  const hist = macdLine.map((v, i) => {
    if (v == null || signal[i] == null) return null;
    return v - signal[i];
  });

  return { macdLine, signal, hist };
}

function highest(arr) {
  return Math.max(...arr);
}

function lowest(arr) {
  return Math.min(...arr);
}

function volumeRatio(candles, lookback = 20, idx = null) {
  const i = idx == null ? candles.length - 1 : idx;
  if (i < lookback) return 1;
  const avg = mean(candles.slice(i - lookback, i).map((c) => c.volume));
  if (!avg) return 1;
  return candles[i].volume / avg;
}

// 近几根K线 swing
function recentSwingLow(candles, lookback = 10, endIndex = null) {
  const i = endIndex == null ? candles.length - 1 : endIndex;
  const start = Math.max(0, i - lookback + 1);
  return lowest(candles.slice(start, i + 1).map((c) => c.low));
}

function recentSwingHigh(candles, lookback = 10, endIndex = null) {
  const i = endIndex == null ? candles.length - 1 : endIndex;
  const start = Math.max(0, i - lookback + 1);
  return highest(candles.slice(start, i + 1).map((c) => c.high));
}

// =========================
// 趋势 + 结构分析
// =========================
function analyzeTrend(candles) {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const { macdLine, signal, hist } = macd(closes);

  const i = closes.length - 1;
  return {
    price: closes[i],
    ema20: ema20[i],
    ema50: ema50[i],
    ema200: ema200[i],
    rsi: rsi14[i],
    atr: atr14[i],
    macd: macdLine[i],
    macdSignal: signal[i],
    macdHist: hist[i],
    prevHist: hist[i - 1],
  };
}

function getHtfBias(h1) {
  if (!h1.ema50 || !h1.ema200 || !h1.rsi) return "NEUTRAL";

  const bullish =
    h1.price > h1.ema50 &&
    h1.ema50 > h1.ema200 &&
    h1.rsi >= 52 &&
    h1.macd != null &&
    h1.macdSignal != null &&
    h1.macd >= h1.macdSignal;

  const bearish =
    h1.price < h1.ema50 &&
    h1.ema50 < h1.ema200 &&
    h1.rsi <= 48 &&
    h1.macd != null &&
    h1.macdSignal != null &&
    h1.macd <= h1.macdSignal;

  if (bullish) return "LONG";
  if (bearish) return "SHORT";
  return "NEUTRAL";
}

function getMtfConfirmation(m15, bias) {
  if (!m15.ema20 || !m15.ema50 || !m15.rsi) return false;

  if (bias === "LONG") {
    return (
      m15.price > m15.ema20 &&
      m15.ema20 > m15.ema50 &&
      m15.rsi >= 50 &&
      m15.macdHist != null &&
      m15.macdHist >= -5
    );
  }

  if (bias === "SHORT") {
    return (
      m15.price < m15.ema20 &&
      m15.ema20 < m15.ema50 &&
      m15.rsi <= 50 &&
      m15.macdHist != null &&
      m15.macdHist <= 5
    );
  }

  return false;
}

function scoreSignal({
  bias,
  h1,
  m15,
  m5,
  pullbackOk,
  breakoutOk,
  volRatio,
  rr,
  atrPct,
}) {
  let score = 0;

  if (bias !== "NEUTRAL") score += 20;
  if (pullbackOk) score += 20;
  if (breakoutOk) score += 20;
  if (volRatio >= 1.3) score += 15;
  else if (volRatio >= 1.1) score += 8;

  if (rr >= 2) score += 15;
  else if (rr >= 1.5) score += 8;

  if (atrPct >= 0.18 && atrPct <= 0.8) score += 10;

  if (bias === "LONG") {
    if (h1.rsi >= 53 && h1.rsi <= 68) score += 5;
    if (m15.rsi >= 50 && m15.rsi <= 66) score += 5;
  } else if (bias === "SHORT") {
    if (h1.rsi >= 32 && h1.rsi <= 47) score += 5;
    if (m15.rsi >= 34 && m15.rsi <= 50) score += 5;
  }

  return clamp(score, 0, 100);
}

function confidenceLabel(score) {
  if (score >= 80) return "A 级";
  if (score >= 70) return "B+ 级";
  if (score >= 60) return "B 级";
  return "观察级";
}

// =========================
// 讯号核心逻辑 v2
// =========================
function buildSignal(h1Candles, m15Candles, m5Candles) {
  const h1 = analyzeTrend(h1Candles);
  const m15 = analyzeTrend(m15Candles);

  const closes5 = m5Candles.map((c) => c.close);
  const ema20_5 = ema(closes5, 20);
  const ema50_5 = ema(closes5, 50);
  const rsi5 = rsi(closes5, 14);
  const atr5 = atr(m5Candles, 14);
  const { hist: macdHist5 } = macd(closes5);

  const i = m5Candles.length - 1;
  const c = m5Candles[i];
  const prev = m5Candles[i - 1];
  const prev2 = m5Candles[i - 2];

  if (!c || !prev || !prev2) return null;

  const bias = getHtfBias(h1);
  if (bias === "NEUTRAL") return null;

  const mtfConfirm = getMtfConfirmation(m15, bias);
  if (!mtfConfirm) return null;

  const e20 = ema20_5[i];
  const e50 = ema50_5[i];
  const currentRsi = rsi5[i];
  const currentAtr = atr5[i];
  const currentHist = macdHist5[i];
  const prevHist = macdHist5[i - 1];
  const volRatio = volumeRatio(m5Candles, 20, i);

  if (!e20 || !e50 || !currentRsi || !currentAtr) return null;

  const atrPct = (currentAtr / c.close) * 100;

  // 避免超低波动
  if (atrPct < 0.12) return null;

  const rangeHigh = recentSwingHigh(m5Candles, 20, i - 1);
  const rangeLow = recentSwingLow(m5Candles, 20, i - 1);

  // 回踩判断
  const pullbackLong =
    c.low <= e20 * 1.001 &&
    c.close > e20 &&
    c.close > c.open &&
    currentRsi >= 50 &&
    currentRsi <= 68 &&
    currentHist != null &&
    prevHist != null &&
    currentHist >= prevHist;

  const breakoutLong =
    c.close > rangeHigh &&
    c.close > e20 &&
    e20 > e50 &&
    volRatio >= 1.15 &&
    currentRsi >= 55 &&
    currentRsi <= 72;

  const pullbackShort =
    c.high >= e20 * 0.999 &&
    c.close < e20 &&
    c.close < c.open &&
    currentRsi <= 50 &&
    currentRsi >= 32 &&
    currentHist != null &&
    prevHist != null &&
    currentHist <= prevHist;

  const breakoutShort =
    c.close < rangeLow &&
    c.close < e20 &&
    e20 < e50 &&
    volRatio >= 1.15 &&
    currentRsi <= 45 &&
    currentRsi >= 28;

  let direction = null;
  let setupType = null;

  if (bias === "LONG" && e20 > e50) {
    if (pullbackLong) {
      direction = "LONG";
      setupType = "顺势回踩";
    } else if (breakoutLong) {
      direction = "LONG";
      setupType = "顺势突破";
    }
  }

  if (bias === "SHORT" && e20 < e50) {
    if (pullbackShort) {
      direction = "SHORT";
      setupType = "顺势反弹空";
    } else if (breakoutShort) {
      direction = "SHORT";
      setupType = "顺势跌破";
    }
  }

  if (!direction) return null;

  let entryMin, entryMax, stopLoss, tp1, tp2, notChase, support, resistance;

  if (direction === "LONG") {
    entryMin = Math.min(c.close, e20);
    entryMax = Math.max(c.close, e20 * 1.0015);
    stopLoss = Math.min(recentSwingLow(m5Candles, 8), c.low - currentAtr * 0.5);
    const risk = entryMax - stopLoss;
    tp1 = entryMax + risk * 1.2;
    tp2 = entryMax + risk * 2.0;
    notChase = entryMax + currentAtr * 0.45;
    support = recentSwingLow(m5Candles, 20);
    resistance = recentSwingHigh(m5Candles, 20);
  } else {
    entryMin = Math.min(c.close, e20 * 0.9985);
    entryMax = Math.max(c.close, e20);
    stopLoss = Math.max(recentSwingHigh(m5Candles, 8), c.high + currentAtr * 0.5);
    const risk = stopLoss - entryMin;
    tp1 = entryMin - risk * 1.2;
    tp2 = entryMin - risk * 2.0;
    notChase = entryMin - currentAtr * 0.45;
    support = recentSwingLow(m5Candles, 20);
    resistance = recentSwingHigh(m5Candles, 20);
  }

  entryMin = roundToPrice(entryMin);
  entryMax = roundToPrice(entryMax);
  stopLoss = roundToPrice(stopLoss);
  tp1 = roundToPrice(tp1);
  tp2 = roundToPrice(tp2);
  notChase = roundToPrice(notChase);
  support = roundToPrice(support);
  resistance = roundToPrice(resistance);

  const risk = direction === "LONG" ? entryMax - stopLoss : stopLoss - entryMin;
  const reward = direction === "LONG" ? tp2 - entryMax : entryMin - tp2;
  const rr = reward > 0 && risk > 0 ? reward / risk : 0;

  if (risk <= 0 || rr < 1.2) return null;

  const score = scoreSignal({
    bias,
    h1,
    m15,
    m5: { rsi: currentRsi },
    pullbackOk: setupType.includes("回踩") || setupType.includes("反弹"),
    breakoutOk: setupType.includes("突破") || setupType.includes("跌破"),
    volRatio,
    rr,
    atrPct,
  });

  if (score < 60) return null;

  return {
    symbol: SYMBOL,
    candleTime: c.time,
    direction,
    setupType,
    price: c.close,
    entryMin,
    entryMax,
    stopLoss,
    tp1,
    tp2,
    notChase,
    support,
    resistance,
    rr,
    score,
    confidence: confidenceLabel(score),
    h1,
    m15,
    m5: {
      ema20: e20,
      ema50: e50,
      rsi: currentRsi,
      atr: currentAtr,
      volRatio,
    },
  };
}

// =========================
// Telegram
// =========================
async function sendTelegramMessage(text) {
  if (!ENABLE_TELEGRAM || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not enabled / missing config");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await axios.post(
    url,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    { timeout: 15000 }
  );
}

function buildTelegramText(signal) {
  const arrow = signal.direction === "LONG" ? "🟢" : "🔴";
  const trendText = signal.direction === "LONG" ? "偏多" : "偏空";
  const noChaseText =
    signal.direction === "LONG"
      ? `高于 <b>${num(signal.notChase, 1)}</b> 不追`
      : `低于 <b>${num(signal.notChase, 1)}</b> 不追`;

  return [
    `${arrow} <b>BTC 做T讯号 v2</b>`,
    ``,
    `方向：<b>${signal.direction}</b>`,
    `类型：<b>${signal.setupType}</b>`,
    `等级：<b>${signal.confidence}</b>（评分 ${signal.score}/100）`,
    ``,
    `现价：<b>${num(signal.price, 1)}</b>`,
    `入场区：<b>${num(signal.entryMin, 1)} - ${num(signal.entryMax, 1)}</b>`,
    `止损：<b>${num(signal.stopLoss, 1)}</b>`,
    `TP1：<b>${num(signal.tp1, 1)}</b>`,
    `TP2：<b>${num(signal.tp2, 1)}</b>`,
    `盈亏比：<b>${num(signal.rr, 2)}R</b>`,
    ``,
    `📌 明天观察买点/卖点：<b>${num(signal.entryMin, 1)} - ${num(signal.entryMax, 1)}</b>`,
    `🚫 不追价：${noChaseText}`,
    `🧱 关键支撑：<b>${num(signal.support, 1)}</b>`,
    `🪜 关键压力：<b>${num(signal.resistance, 1)}</b>`,
    ``,
    `1H趋势：<b>${trendText}</b>`,
    `15M确认：<b>已通过</b>`,
    `5M RSI：<b>${num(signal.m5.rsi, 1)}</b>`,
    `5M ATR：<b>${num(signal.m5.atr, 1)}</b>`,
    `成交量比：<b>${num(signal.m5.volRatio, 2)}x</b>`,
    ``,
    `<i>策略原则：只做顺势，不追单，先看回踩，再看突破。</i>`,
  ].join("\n");
}

// =========================
// 扫描
// =========================
async function scanMarket(force = false) {
  try {
    const [h1Candles, m15Candles, m5Candles] = await Promise.all([
      fetchBingxKlines("1h", 300),
      fetchBingxKlines("15m", 300),
      fetchBingxKlines("5m", 300),
    ]);

    const last5m = m5Candles[m5Candles.length - 1];
    if (!last5m) {
      return { ok: false, reason: "No latest 5m candle" };
    }

    // 只在新K线或 force 时判断，避免同一根K线狂发
    if (!force && lastScanCandleTime === last5m.time) {
      return {
        ok: true,
        skipped: true,
        reason: "Same candle, skipped",
        candleTime: last5m.time,
      };
    }

    lastScanCandleTime = last5m.time;

    const signal = buildSignal(h1Candles, m15Candles, m5Candles);

    if (!signal) {
      return {
        ok: true,
        hasSignal: false,
        candleTime: last5m.time,
        price: last5m.close,
      };
    }

    const signalKey = `${signal.direction}_${signal.setupType}_${signal.candleTime}_${signal.entryMin}_${signal.entryMax}`;

    if (!force && signalKey === lastSignalKey) {
      return {
        ok: true,
        hasSignal: true,
        duplicated: true,
        signal,
      };
    }

    lastSignalKey = signalKey;

    const text = buildTelegramText(signal);
    await sendTelegramMessage(text);

    return {
      ok: true,
      hasSignal: true,
      sent: true,
      signal,
    };
  } catch (err) {
    console.error("scanMarket error:", err.message);
    return {
      ok: false,
      error: err.message,
    };
  }
}

// =========================
// 定时器
// =========================
async function loopScan() {
  while (true) {
    try {
      const now = new Date();
      const sec = now.getUTCSeconds();

      // 每分钟都检查一次，但只在新5m K线时真正出讯号
      if (sec <= 8) {
        const result = await scanMarket(false);
        console.log("[SCAN]", JSON.stringify(result));
        await sleep(12000);
      } else {
        await sleep(SCAN_INTERVAL_MS);
      }
    } catch (err) {
      console.error("loopScan error:", err.message);
      await sleep(15000);
    }
  }
}

// =========================
// API
// =========================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "BTC Real Trader v2",
    symbol: SYMBOL,
    endpoints: ["/api/health", "/api/scan"],
  });
});

app.get("/api/health", async (req, res) => {
  try {
    const candles = await fetchBingxKlines("5m", 5);
    const last = candles[candles.length - 1];
    res.json({
      ok: true,
      app: "BTC Real Trader v2",
      symbol: SYMBOL,
      price: last?.close || null,
      lastCandleTime: last?.time || null,
      telegramEnabled: ENABLE_TELEGRAM,
      uptimeSec: Math.floor(process.uptime()),
      lastSignalKey,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.get("/api/scan", async (req, res) => {
  const result = await scanMarket(true);
  res.json(result);
});

// =========================
// 启动
// =========================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: /api/health`);
  console.log(`Scan: /api/scan`);
  loopScan();
});


// ✅ 👉 在这里加（很关键）
app.get("/api/test-telegram", async (req, res) => {
  try {
    await sendTelegramMessage("测试成功 🚀 Telegram 已连通");
    res.json({ ok: true, message: "Telegram sent" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});