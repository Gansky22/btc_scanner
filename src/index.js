import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getKlines } from './binance.js'
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
const SYMBOL = process.env.BINANCE_SYMBOL || 'BTCUSDT'
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

async function scanAndStore() {
  const candles5m = await getKlines(SYMBOL, INTERVAL, 200)
  const closes5m = candles5m.map((c) => c.close)
  const latest5m = candles5m[candles5m.length - 1]

  const candles15m = await getKlines(SYMBOL, '15m', 200)
  const closes15m = candles15m.map((c) => c.close)
  const latest15m = candles15m[candles15m.length - 1]

  const ema20 = ema(closes5m, 20)
  const ema50 = ema(closes5m, 50)
  const rsiValue = rsi(closes5m, 14)
  const atrValue = atr(candles5m, 14)
  const vwapValue = vwap(candles5m.slice(-50))
  const avgVol = averageVolume(candles5m.slice(0, -1), 20)
  const volRatio = avgVol ? latest5m.volume / avgVol : 1
  const { support, resistance } = calculateSupportResistance(candles5m)

  const ema20_15m = ema(closes15m, 20)
  const ema50_15m = ema(closes15m, 50)
  const trend15m = getTrendDirection(latest15m.close, ema20_15m, ema50_15m)

  const signal = generateSignal({
    price: latest5m.close,
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
    symbol: SYMBOL,
    interval: INTERVAL,
    price: Number(latest5m.close.toFixed(2)),
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
      `追价判断：${signal.chaseWarning}`
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
    const hasGoodRR = Number(saved.rr || 0) >= 1.2
    const hasEnoughVolume = Number(saved.volume_ratio || 0) >= 1.0

    if (!isHighConfidence) {
      console.log('Skip push: confidence not high')
    } else if (!hasGoodRR) {
      console.log('Skip push: RR too low')
    } else if (!hasEnoughVolume) {
      console.log('Skip push: volume too low')
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

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, symbol: SYMBOL, interval: INTERVAL })
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
    res.status(500).json({ ok: false, error: error.message })
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