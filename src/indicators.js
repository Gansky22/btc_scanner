export function sma(values, period) {
  if (values.length < period) return null
  const slice = values.slice(-period)
  const sum = slice.reduce((a, b) => a + b, 0)
  return sum / period
}

export function ema(values, period) {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k)
  }

  return result
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null

  let gains = 0
  let losses = 0

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) gains += diff
    else losses += Math.abs(diff)
  }

  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null
  const trs = []

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high
    const l = candles[i].low
    const pc = candles[i - 1].close
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
    trs.push(tr)
  }

  return sma(trs, period)
}

export function vwap(candles) {
  let pv = 0
  let vol = 0

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3
    pv += typical * c.volume
    vol += c.volume
  }

  return vol === 0 ? null : pv / vol
}

export function averageVolume(candles, period = 20) {
  if (candles.length < period) return null
  const arr = candles.slice(-period).map((c) => c.volume)
  return sma(arr, period)
}