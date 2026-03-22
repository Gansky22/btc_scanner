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

  const range = Math.max(resistance - support, 0.01)
  const isTightRange = range < atrValue * 2.2

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

  if (rsiValue >= 53 && rsiValue <= 67) {
    longScore += 1
    longReasons.push('RSI 偏强')
  }

  if (rsiValue <= 47 && rsiValue >= 33) {
    shortScore += 1
    shortReasons.push('RSI 偏弱')
  }

  if (volRatio >= 1.15 && price > vwapValue) {
    longScore += 1
    longReasons.push('成交量配合多头结构')
  }

  if (volRatio >= 1.15 && price < vwapValue) {
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

  if (isTightRange) {
    longScore -= 1
    shortScore -= 1
    longReasons.push('当前偏震荡区')
    shortReasons.push('当前偏震荡区')
  }

  const bias = longScore - shortScore

  let action = '观望'
  let direction = 'neutral'
  let reasons = ['多空分数接近，等待更明确结构']
  let confidence = '低'
  let entry = null
  let stop = null
  let tp1 = null
  let tp2 = null
  let rr = null
  let executionTip = '观望，等待更清楚的走势'
  let chaseWarning = '暂不判断'
  let setupQuality = '低'
  let shouldAvoid = false
  let avoidReason = ''

  if (bias >= 3) {
    action = '偏多做T'
    direction = 'long'
    reasons = longReasons
  } else if (bias <= -3) {
    action = '偏空做T'
    direction = 'short'
    reasons = shortReasons
  }

  const longEntry = Math.max(support, price - atrValue * 0.35)
  const longStop = Math.min(support - atrValue * 0.5, price - atrValue * 1.1)
  const longTp1 = Math.min(resistance, price + atrValue * 1.4)
  const longTp2 = Math.min(resistance + atrValue * 1.2, price + atrValue * 2.6)

  const shortEntry = Math.min(resistance, price + atrValue * 0.35)
  const shortStop = Math.max(resistance + atrValue * 0.5, price + atrValue * 1.1)
  const shortTp1 = Math.max(support, price - atrValue * 1.4)
  const shortTp2 = Math.max(support - atrValue * 1.2, price - atrValue * 2.6)

  if (direction === 'long') {
    entry = Number(longEntry.toFixed(2))
    stop = Number(longStop.toFixed(2))
    tp1 = Number(longTp1.toFixed(2))
    tp2 = Number(longTp2.toFixed(2))

    const risk = Math.max(entry - stop, 1)
    const reward = Math.max(tp2 - entry, 1)
    rr = Number((reward / risk).toFixed(2))

    if (price > entry + atrValue * 0.45) {
      executionTip = '不追价，等回踩 EMA20 或接近入场位再考虑'
      chaseWarning = '当前偏追价区'
    } else if (price >= entry && price <= entry + atrValue * 0.18) {
      executionTip = '可观察小回踩承接后分批进场'
      chaseWarning = '接近可执行区'
    } else {
      executionTip = '更接近理想买点，可观察支撑承接后进场'
      chaseWarning = '接近低吸区'
    }

    if (trend15m !== 'long') {
      shouldAvoid = true
      avoidReason = '5m 多头但 15m 未同向，不做逆势多'
    }

    if (isTightRange) {
      shouldAvoid = true
      avoidReason = '波动区间过窄，容易来回扫损'
    }
  }

  if (direction === 'short') {
    entry = Number(shortEntry.toFixed(2))
    stop = Number(shortStop.toFixed(2))
    tp1 = Number(shortTp1.toFixed(2))
    tp2 = Number(shortTp2.toFixed(2))

    const risk = Math.max(stop - entry, 1)
    const reward = Math.max(entry - tp2, 1)
    rr = Number((reward / risk).toFixed(2))

    if (price < entry - atrValue * 0.45) {
      executionTip = '不追空，等反弹靠近入场位再考虑'
      chaseWarning = '当前偏追空区'
    } else if (price <= entry && price >= entry - atrValue * 0.18) {
      executionTip = '可观察反弹无力后分批进场'
      chaseWarning = '接近可执行区'
    } else {
      executionTip = '更接近理想高抛位，可观察压力反应后进场'
      chaseWarning = '接近高抛区'
    }

    if (trend15m !== 'short') {
      shouldAvoid = true
      avoidReason = '5m 空头但 15m 未同向，不做逆势空'
    }

    if (isTightRange) {
      shouldAvoid = true
      avoidReason = '波动区间过窄，容易来回扫损'
    }
  }

  const edge = Math.abs(bias)
  if (edge >= 7) confidence = '高'
  else if (edge >= 4) confidence = '中'

  if (direction === 'neutral') {
    setupQuality = '低'
  } else if (shouldAvoid) {
    setupQuality = '低'
  } else if ((rr || 0) >= 1.5 && confidence === '高' && volRatio >= 1.0) {
    setupQuality = '高'
  } else if ((rr || 0) >= 1.0 && confidence !== '低') {
    setupQuality = '中'
  } else {
    setupQuality = '低'
  }

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
    trend15m,
    setupQuality,
    shouldAvoid,
    avoidReason
  }
}