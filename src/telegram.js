export async function sendTelegramMessage(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken || !chatId) {
    console.log('Telegram not configured, skip sending.')
    return
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Telegram send failed: ${errText}`)
  }
}

export function buildTelegramText(row) {
  const reasons = row.reasons || []

  return `🚀 BTC 做T提醒

⏰ 时间：${row.created_at}

📊 当前价格：${row.price}
🕒 周期：${row.interval}

📈 建议：${row.action}
📍 方向：${row.direction}
🔥 强度：${row.confidence}

🎯 入场：${row.entry ?? '-'}
🛑 止损：${row.stop ?? '-'}
💰 TP1：${row.tp1 ?? '-'}
💰 TP2：${row.tp2 ?? '-'}
📊 RR：${row.rr ?? '-'}

📌 理由：
- ${reasons.join('\n- ')}

⚠️ 执行重点：
- 不追价
- 等回踩关键位再考虑
- 跌破止损位就撤`
}