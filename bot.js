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

// CoinGecko API çağrısı - key her istekte header olarak gönderilir
async function cgGet(path, params = {}) {
  const res = await axios.get(`https://api.coingecko.com/api/v3${path}`, {
    params: { ...params, x_cg_demo_api_key: COINGECKO_API_KEY },
    headers: { Accept: 'application/json' },
    timeout: 15000
  });
  return res.data;
}

// Kapanış fiyatlarından standart sapma bazlı volatilite (TradingView yöntemi)
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

// Binance Futures USDT sembollerini + coin_id'lerini çek
async function getBinanceFuturesSymbols() {
  const data = await cgGet('/derivatives', {});
  const seen = new Set();
  const tickers = [];
  for (const t of data) {
    if (
      t.market === 'Binance (Futures)' &&
      t.symbol?.endsWith('USDT') &&
      t.coin_id &&
      !seen.has(t.coin_id)
    ) {
      seen.add(t.coin_id);
      tickers.push({ symbol: t.symbol, coinId: t.coin_id });
    }
  }
  return tickers;
}

// 7 günlük günlük fiyatlar → volatilite
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
    // 1) Sembol listesi
    console.log('Binance Futures sembolleri çekiliyor...');
    const tickers = await getBinanceFuturesSymbols();
    console.log(`${tickers.length} sembol bulundu`);
    if (tickers.length === 0) throw new Error('Sembol listesi boş');

    // 2) Her coin için volatilite hesapla
    // Demo key: 30 req/dk → 2.1sn aralık
    const results = [];
    for (let i = 0; i < tickers.length; i++) {
      const { symbol, coinId } = tickers[i];
      const vol = await getVolatility(coinId);
      if (vol > 0) results.push({ symbol, volatility: vol });
      await sleep(2100);

      if ((i + 1) % 20 === 0)
        console.log(`${i + 1}/${tickers.length} işlendi, ${results.length} başarılı`);
    }

    console.log(`Tamamlandı. ${results.length} sembol hesaplandı.`);
    if (results.length === 0) throw new Error('Hiçbir volatilite hesaplanamadı');

    // 3) Sırala, Top N
    const sorted = results.sort((a, b) => b.volatility - a.volatility);
    const currentTop = sorted.slice(0, TOP_N).map(r => r.symbol);
    console.log('Top 10:', currentTop);

    // 4) Karşılaştır
    const state = loadState();
    const previousTop = state.topList || [];
    const newEntries = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    // 5) Mesaj gönder
    if (previousTop.length === 0) {
      let msg = `✅ <b>Volatilite Botu Başladı!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      msg += `📡 <i>CoinGecko — Gerçek 7 Günlük Volatilite</i>\n\n`;
      msg += `📊 <b>İlk Top ${TOP_N}:</b>\n`;
      for (let i = 0; i < currentTop.length; i++) {
        const info = sorted.find(r => r.symbol === currentTop[i]);
        msg += `  ${i + 1}. ${currentTop[i]} — %${info.volatility.toFixed(2)}\n`;
      }
      msg += `\nHer 6 saatte bir kontrol edilecek.`;
      await sendTelegram(msg);

    } else if (newEntries.length > 0 || exitedEntries.length > 0) {
      let msg = `🚨 <b>Top ${TOP_N} Listesi Değişti!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      msg += `📡 <i>CoinGecko — Gerçek 7 Günlük Volatilite</i>\n\n`;

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
