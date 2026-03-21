export function generateSignal(input) {
  const {
    price,
    ema20,
    ema50,
    vwapValue,
    rsiValue,
    volRatio,
    support,
    resistance,
    atrValue,
    trend15m = 'neutral'
  } = input

  let longScore = 0
  let shortScore = 0
  const longReasons = []
  const shortReasons = []

  if (price > ema20) {
    longScore += 1
    longReasons.push('价格站上 EMA20')
  } else {
    shortScore += 1
    shortReasons.push('价格跌破 EMA20')
  }

  if (ema20 > ema50) {
    longScore += 2
    longReasons.push('EMA20 在 EMA50 上方')
  } else {
    shortScore += 2
    shortReasons.push('EMA20 在 EMA50 下方')
  }

  if (price > vwapValue) {
    longScore += 2
    longReasons.push('价格在 VWAP 上方')
  } else {
    shortScore += 2
    shortReasons.push('价格在 VWAP 下方')
  }

  if (rsiValue >= 52 && rsiValue <= 68) {
    longScore += 1
    longReasons.push('RSI 偏强')
  }

  if (rsiValue <= 48 && rsiValue >= 32) {
    shortScore += 1
    shortReasons.push('RSI 偏弱')
  }

  if (rsiValue > 72) {
    shortScore += 1
    shortReasons.push('RSI 过热，防冲高回落')
  }

  if (rsiValue < 28) {
    longScore += 1
    longReasons.push('RSI 过冷，防超跌反弹')
  }

  if (volRatio >= 1.2 && price > vwapValue) {
    longScore += 1
    longReasons.push('成交量配合多头结构')
  }

  if (volRatio >= 1.2 && price < vwapValue) {
    shortScore += 1
    shortReasons.push('成交量配合空头结构')
  }

  if (trend15m === 'long') {
    longScore += 2
    longReasons.push('15m 趋势同向偏多')
  } else if (trend15m === 'short') {
    shortScore += 2
    shortReasons.push('15m 趋势同向偏空')
  }

  const supportGap = price - support
  const resistanceGap = resistance - price

  if (supportGap > 0 && supportGap <= atrValue * 1.2 && price > vwapValue) {
    longScore += 1
    longReasons.push('靠近支撑，适合低吸做T')
  }

  if (resistanceGap > 0 && resistanceGap <= atrValue * 1.2 && price < vwapValue) {
    shortScore += 1
    shortReasons.push('靠近压力，适合高抛做T')
  }

  const bias = longScore - shortScore

  let action = '观望'
  let direction = 'neutral'
  let reasons = ['多空分数接近，等待更明确结构']

  if (bias >= 3) {
    action = '偏多做T'
    direction = 'long'
    reasons = longReasons
  } else if (bias <= -3) {
    action = '偏空做T'
    direction = 'short'
    reasons = shortReasons
  }

  const longEntry = Math.max(support, price - atrValue * 0.3)
  const longStop = Math.min(support - atrValue * 0.4, price - atrValue * 1.0)
  const longTp1 = Math.min(resistance, price + atrValue * 1.2)
  const longTp2 = Math.min(resistance + atrValue * 0.8, price + atrValue * 2.0)

  const shortEntry = Math.min(resistance, price + atrValue * 0.3)
  const shortStop = Math.max(resistance + atrValue * 0.4, price + atrValue * 1.0)
  const shortTp1 = Math.max(support, price - atrValue * 1.2)
  const shortTp2 = Math.max(support - atrValue * 0.8, price - atrValue * 2.0)

  let entry = null
  let stop = null
  let tp1 = null
  let tp2 = null
  let rr = null
  let confidence = '低'
  let executionTip = '观望，等待更清楚的走势'
  let chaseWarning = '暂不判断'

  if (direction === 'long') {
    entry = Number(longEntry.toFixed(2))
    stop = Number(longStop.toFixed(2))
    tp1 = Number(longTp1.toFixed(2))
    tp2 = Number(longTp2.toFixed(2))
    rr = Number(((tp1 - entry) / Math.max(entry - stop, 1)).toFixed(2))

    if (price > entry + atrValue * 0.5) {
      executionTip = '不追价，等回踩 EMA20 或接近入场位再考虑'
      chaseWarning = '当前偏追价区'
    } else if (price >= entry && price <= entry + atrValue * 0.2) {
      executionTip = '可观察小回踩后低吸，分批进场'
      chaseWarning = '接近可执行区'
    } else {
      executionTip = '更接近理想买点，可观察支撑承接后进场'
      chaseWarning = '接近低吸区'
    }
  }

  if (direction === 'short') {
    entry = Number(shortEntry.toFixed(2))
    stop = Number(shortStop.toFixed(2))
    tp1 = Number(shortTp1.toFixed(2))
    tp2 = Number(shortTp2.toFixed(2))
    rr = Number(((entry - tp1) / Math.max(stop - entry, 1)).toFixed(2))

    if (price < entry - atrValue * 0.5) {
      executionTip = '不追空，等反弹靠近入场位再考虑'
      chaseWarning = '当前偏追空区'
    } else if (price <= entry && price >= entry - atrValue * 0.2) {
      executionTip = '可观察反弹无力后高抛，分批进场'
      chaseWarning = '接近可执行区'
    } else {
      executionTip = '更接近理想高抛位，可观察压力反应后进场'
      chaseWarning = '接近高抛区'
    }
  }

  const edge = Math.abs(bias)
  if (edge >= 7) confidence = '高'
  else if (edge >= 4) confidence = '中'

  return {
    action,
    direction,
    confidence,
    reasons,
    entry,
    stop,
    tp1,
    tp2,
    rr,
    longScore,
    shortScore,
    executionTip,
    chaseWarning,
    trend15m
  }
}