const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const TOP_N = 10;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = './state.json';
// ──────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return { topList: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function cgGet(path, params = {}) {
  const res = await axios.get(`https://api.coingecko.com/api/v3${path}`, {
    params: { ...params, x_cg_demo_api_key: COINGECKO_API_KEY },
    headers: { Accept: 'application/json' },
    timeout: 15000
  });
  return res.data;
}

function calcVolatility(prices) {
  if (prices.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0)
      returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

async function getBinanceFuturesSymbols() {
  const data = await cgGet('/derivatives');

  // DEBUG: İlk 3 kaydı ve tüm unique market isimlerini logla
  console.log('DEBUG - Toplam derivatives:', data.length);
  if (data.length > 0) {
    console.log('DEBUG - İlk kayıt:', JSON.stringify(data[0]));
    const markets = [...new Set(data.map(t => t.market))];
    console.log('DEBUG - Tüm market isimleri:', JSON.stringify(markets));
  }

  // Binance içeren tüm market isimlerini bul (büyük/küçük harf fark etmez)
  const seen = new Set();
  const tickers = [];
  for (const t of data) {
    const market = (t.market || '').toLowerCase();
    if (
      market.includes('binance') &&
      market.includes('future') &&
      t.symbol?.endsWith('USDT') &&
      t.coin_id &&
      !seen.has(t.coin_id)
    ) {
      seen.add(t.coin_id);
      tickers.push({ symbol: t.symbol, coinId: t.coin_id });
    }
  }

  // Eğer hâlâ boşsa sadece binance içerenleri dene
  if (tickers.length === 0) {
    console.log('DEBUG - Futures bulunamadı, sadece binance filtreleniyor...');
    for (const t of data) {
      const market = (t.market || '').toLowerCase();
      if (
        market.includes('binance') &&
        t.symbol?.endsWith('USDT') &&
        t.coin_id &&
        !seen.has(t.coin_id)
      ) {
        seen.add(t.coin_id);
        tickers.push({ symbol: t.symbol, coinId: t.coin_id });
      }
    }
  }

  return tickers;
}

async function getVolatility(coinId) {
  try {
    const data = await cgGet(`/coins/${coinId}/market_chart`, {
      vs_currency: 'usd',
      days: '7',
      interval: 'daily'
    });
    const prices = data.prices.map(p => p[1]);
    return calcVolatility(prices);
  } catch (e) {
    return 0;
  }
}

async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('Telegram mesajı gönderildi');
  } catch (e) {
    console.error('Telegram hatası:', e.message);
  }
}

async function checkVolatility() {
  console.log(`\n[${new Date().toISOString()}] Kontrol başladı...`);

  try {
    console.log('Binance Futures sembolleri çekiliyor...');
    const tickers = await getBinanceFuturesSymbols();
    console.log(`${tickers.length} sembol bulundu`);
    if (tickers.length === 0) throw new Error('Sembol listesi boş - logları kontrol et');

    const results = [];
    for (let i = 0; i < tickers.length; i++) {
      const { symbol, coinId } = tickers[i];
      const vol = await getVolatility(coinId);
      if (vol > 0) results.push({ symbol, volatility: vol });
      await sleep(2100);
      if ((i + 1) % 20 === 0)
        console.log(`${i + 1}/${tickers.length} işlendi, ${results.length} başarılı`);
    }

    console.log(`Tamamlandı. ${results.length} sembol.`);
    if (results.length === 0) throw new Error('Volatilite hesaplanamadı');

    const sorted = results.sort((a, b) => b.volatility - a.volatility);
    const currentTop = sorted.slice(0, TOP_N).map(r => r.symbol);
    console.log('Top 10:', currentTop);

    const state = loadState();
    const previousTop = state.topList || [];
    const newEntries = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    if (previousTop.length === 0) {
      let msg = `✅ <b>Volatilite Botu Başladı!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      msg += `📡 <i>Gerçek 7 Günlük Volatilite</i>\n\n`;
      msg += `📊 <b>İlk Top ${TOP_N}:</b>\n`;
      for (let i = 0; i < currentTop.length; i++) {
        const info = sorted.find(r => r.symbol === currentTop[i]);
        msg += `  ${i + 1}. ${currentTop[i]} — %${info.volatility.toFixed(2)}\n`;
      }
      msg += `\nHer 6 saatte bir kontrol edilecek.`;
      await sendTelegram(msg);

    } else if (newEntries.length > 0 || exitedEntries.length > 0) {
      let msg = `🚨 <b>Top ${TOP_N} Listesi Değişti!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n\n`;
      if (newEntries.length > 0) {
        msg += `✅ <b>Listeye Girenler:</b>\n`;
        for (const sym of newEntries) {
          const info = sorted.find(r => r.symbol === sym);
          msg += `  #${currentTop.indexOf(sym) + 1} ${sym} — %${info.volatility.toFixed(2)}\n`;
        }
      }
      if (exitedEntries.length > 0) {
        msg += `\n❌ <b>Listeden Çıkanlar:</b>\n`;
        for (const sym of exitedEntries) msg += `  ${sym}\n`;
      }
      msg += `\n📊 <b>Güncel Top ${TOP_N}:</b>\n`;
      for (let i = 0; i < currentTop.length; i++) {
        const info = sorted.find(r => r.symbol === currentTop[i]);
        msg += `  ${i + 1}. ${currentTop[i]} — %${info.volatility.toFixed(2)}\n`;
      }
      await sendTelegram(msg);
    } else {
      console.log('Liste değişmedi');
    }

    saveState({ topList: currentTop, lastCheck: new Date().toISOString() });

  } catch (e) {
    console.error('Kritik hata:', e.message);
    await sendTelegram(`⚠️ Bot hatası: ${e.message}`);
  }
}

(async () => {
  console.log('🤖 Volatilite botu başlıyor...');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !COINGECKO_API_KEY) {
    console.error('❌ Eksik env: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, COINGECKO_API_KEY');
    process.exit(1);
  }
  await checkVolatility();
  setInterval(checkVolatility, CHECK_INTERVAL_MS);
})();
