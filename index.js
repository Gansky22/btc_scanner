import 'dotenv/onfig'
import express from 'express'
import cors from 'cors'
import { ema, rsi, atr, vwap, averageVolume } from './indicators.js'
import { generateSignal } from './signal.js'
import {
  getLatestSignal,
  getTradeLogs,
  insertTradeLog,
  getLatestPushByDirection,
  insertPushHistory
} from './supabase.js'
import { buildTelegramText, sendTelegramMessage } from './telegram.js'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 8080
const INTERVAL = process.env.BINANCE_INTERVAL || '5m'
const SCAN_COOLDOWN_MINUTES = Number(process.env.SCAN_COOLDOWN_MINUTES || 15)

function toKLTimeString(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}

function calculateSupportResistance(candles) {
  const recent = candles.slice(-20)
  const support = Math.min(...recent.map((c) => c.low))
  const resistance = Math.max(...recent.map((c) => c.high))
  return { support, resistance }
}

function getTrendDirection(price, ema20Value, ema50Value) {
  if (price > ema20Value && ema20Value > ema50Value) return 'long'
  if (price < ema20Value && ema20Value < ema50Value) return 'short'
  return 'neutral'
}

function mapBingxInterval(interval = '5m') {
  const map = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '4h': '4h'
  }
  return map[interval] || '5m'
}

async function getBingXKlines(symbol = 'BTC-USDT', interval = '5m', limit = 200) {
  const mapped = mapBingxInterval(interval)
  const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${mapped}&limit=${limit}`

  const res = await fetch(url)
  const json = await res.json()

  if (!json?.data || !Array.isArray(json.data)) {
    throw new Error(`BingX klines error: ${JSON.stringify(json)}`)
  }

  return json.data.map((k) => ({
    openTime: Number(k.time || k.openTime || 0),
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    volume: Number(k.volume),
    closeTime: Number(k.time || k.closeTime || 0)
  }))
}

async function getBingXPrice(symbol = 'BTC-USDT') {
  const url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}`
  const res = await fetch(url)
  const json = await res.json()

  const price =
    json?.data?.lastPrice ??
    json?.data?.price ??
    json?.data?.ticker?.lastPrice

  if (!price) {
    throw new Error(`BingX ticker error: ${JSON.stringify(json)}`)
  }

  return Number(price)
}

async function scanAndStore() {
  const symbol = 'BTC-USDT'

  const candles5m = await getBingXKlines(symbol, INTERVAL, 200)
  const closes5m = candles5m.map((c) => c.close)

  const candles15m = await getBingXKlines(symbol, '15m', 200)
  const closes15m = candles15m.map((c) => c.close)
  const latest15m = candles15m[candles15m.length - 1]

  const price = await getBingXPrice(symbol)

  const ema20 = ema(closes5m, 20)
  const ema50 = ema(closes5m, 50)
  const rsiValue = rsi(closes5m, 14)
  const atrValue = atr(candles5m, 14)
  const vwapValue = vwap(candles5m.slice(-50))
  const avgVol = averageVolume(candles5m.slice(0, -1), 20)
  const latestVolume = candles5m[candles5m.length - 1]?.volume || 0
  const volRatio = avgVol ? latestVolume / avgVol : 1
  const { support, resistance } = calculateSupportResistance(candles5m)

  const ema20_15m = ema(closes15m, 20)
  const ema50_15m = ema(closes15m, 50)
  const trend15m = getTrendDirection(latest15m.close, ema20_15m, ema50_15m)

  const signal = generateSignal({
    price,
    ema20,
    ema50,
    vwapValue,
    rsiValue,
    volRatio,
    support,
    resistance,
    atrValue,
    trend15m
  })

  const payload = {
    symbol: 'BTCUSDT',
    interval: INTERVAL,
    price: Number(price.toFixed(2)),
    ema20: Number((ema20 || 0).toFixed(2)),
    ema50: Number((ema50 || 0).toFixed(2)),
    vwap: Number((vwapValue || 0).toFixed(2)),
    rsi: Number((rsiValue || 0).toFixed(2)),
    atr: Number((atrValue || 0).toFixed(2)),
    volume_ratio: Number(volRatio.toFixed(2)),
    support: Number(support.toFixed(2)),
    resistance: Number(resistance.toFixed(2)),
    action: signal.action,
    direction: signal.direction,
    confidence: signal.confidence,
    reasons: [
      ...signal.reasons,
      `15m 趋势：${signal.trend15m}`,
      `执行建议：${signal.executionTip}`,
      `追价判断：${signal.chaseWarning}`,
      `Setup质量：${signal.setupQuality}`
    ],
    entry: signal.entry,
    stop: signal.stop,
    tp1: signal.tp1,
    tp2: signal.tp2,
    rr: signal.rr,
    long_score: signal.longScore,
    short_score: signal.shortScore,
    created_at: toKLTimeString(new Date())
  }

  const saved = await insertTradeLog(payload)

  if (saved.direction !== 'neutral') {
    const isHighConfidence = saved.confidence === '高'
    const hasGoodRR = Number(saved.rr || 0) >= 1.0
    const hasEnoughVolume = Number(saved.volume_ratio || 0) >= 1.0
    const setupQualityHigh = signal.setupQuality === '高'
    const shouldAvoid = signal.shouldAvoid === true

    if (!isHighConfidence) {
      console.log('Skip push: confidence not high')
    } else if (!hasGoodRR) {
      console.log('Skip push: RR too low')
    } else if (!hasEnoughVolume) {
      console.log('Skip push: volume too low')
    } else if (!setupQualityHigh) {
      console.log('Skip push: setup quality not high')
    } else if (shouldAvoid) {
      console.log(`Skip push: avoid setup - ${signal.avoidReason}`)
    } else {
      const latestPush = await getLatestPushByDirection(saved.direction)
      let shouldPush = true

      if (latestPush?.created_at) {
        const last = new Date(
          latestPush.created_at.replace(' ', 'T') + '+08:00'
        ).getTime()
        const now = Date.now()
        const diffMin = (now - last) / 1000 / 60

        if (diffMin < SCAN_COOLDOWN_MINUTES) {
          shouldPush = false
        }
      }

      if (shouldPush) {
        await sendTelegramMessage(buildTelegramText(saved))

        await insertPushHistory({
          direction: saved.direction,
          action: saved.action,
          trade_log_id: saved.id,
          created_at: toKLTimeString(new Date())
        })
      } else {
        console.log('Skip push: cooldown active')
      }
    }
  } else {
    console.log('Skip push: neutral signal')
  }

  return saved
}

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'BTC scanner is running' })
})

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, symbol: 'BTCUSDT', interval: INTERVAL })
})

app.get('/api/latest-signal', async (_req, res) => {
  try {
    const data = await getLatestSignal()
    res.json({ ok: true, data })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/trade-logs', async (_req, res) => {
  try {
    const data = await getTradeLogs(100)
    res.json({ ok: true, data })
  } catch (error) {
    res.status(500).json({ ok: false, data })
  }
})

app.post('/api/run-scan', async (_req, res) => {
  try {
    const data = await scanAndStore()
    res.json({ ok: true, data })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/run-scan', async (_req, res) => {
  try {
    const data = await scanAndStore()
    res.json({ ok: true, data })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`BTC worker running on port ${PORT}`)
})