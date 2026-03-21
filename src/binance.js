const BASE_URL = 'https://api.binance.com'

export async function getKlines(symbol = 'BTCUSDT', interval = '5m', limit = 200) {
  const url = `${BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Binance klines error: ${res.status}`)
  }

  const data = await res.json()

  return data.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6])
  }))
}