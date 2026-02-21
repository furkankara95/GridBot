const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOP_N = 10;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 saat
const STATE_FILE = './state.json';
// ──────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { topList: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Standart sapma bazlı gerçek volatilite hesabı
function calcVolatility(closes) {
  if (closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

// CoinGecko rate limit için bekle
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// CoinGecko'dan Binance Futures sembollerini çek
async function getBinanceFuturesSymbols() {
  const res = await axios.get('https://api.coingecko.com/api/v3/derivatives', {
    headers: { Accept: 'application/json' },
    timeout: 15000
  });

  // Binance Futures, USDT çiftleri, tekrar etmeyenler
  const seen = new Set();
  const tickers = [];
  for (const t of res.data) {
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

// CoinGecko OHLC endpoint → 7 günlük kapanış → gerçek volatilite
async function getVolatilityForCoin(coinId) {
  try {
    // days=7 → günlük OHLC verir (her gün 1 mum)
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`,
      {
        params: { vs_currency: 'usd', days: '7' },
        headers: { Accept: 'application/json' },
        timeout: 10000
      }
    );

    // Her satır: [timestamp, open, high, low, close]
    const closes = res.data.map(c => c[4]);
    return calcVolatility(closes);
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
    // 1) Binance Futures sembollerini + coin ID'lerini çek
    console.log('Semboller çekiliyor...');
    const tickers = await getBinanceFuturesSymbols();
    console.log(`${tickers.length} sembol bulundu`);

    // 2) Her coin için OHLC'den gerçek volatilite hesapla
    // CoinGecko rate limit: ~30 req/dakika → 400ms aralıkla gönder
    const results = [];
    for (let i = 0; i < tickers.length; i++) {
      const { symbol, coinId } = tickers[i];
      const vol = await getVolatilityForCoin(coinId);
      if (vol > 0) results.push({ symbol, volatility: vol });

      // Her 30 istekte 2 saniye bekle (rate limit)
      if ((i + 1) % 30 === 0) {
        console.log(`${i + 1}/${tickers.length} işlendi, bekleniyor...`);
        await sleep(2000);
      } else {
        await sleep(400);
      }
    }

    console.log(`${results.length} sembol için volatilite hesaplandı`);

    // 3) Sırala, Top N al
    const sorted = results.sort((a, b) => b.volatility - a.volatility);
    const currentTop = sorted.slice(0, TOP_N).map(r => r.symbol);
    console.log('Top 10:', currentTop);

    // 4) Önceki liste ile karşılaştır
    const state = loadState();
    const previousTop = state.topList || [];
    const newEntries = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    // 5) Değişiklik varsa Telegram'a gönder
    if (newEntries.length > 0 || exitedEntries.length > 0) {
      let msg = `🚨 <b>Volatilite Top ${TOP_N} Listesi Değişti!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      msg += `📡 <i>Kaynak: CoinGecko OHLC — Gerçek Haftalık Volatilite</i>\n\n`;

      if (newEntries.length > 0) {
        msg += `✅ <b>Listeye Girenler:</b>\n`;
        for (const sym of newEntries) {
          const info = sorted.find(r => r.symbol === sym);
          const rank = currentTop.indexOf(sym) + 1;
          msg += `  #${rank} ${sym} — %${info.volatility.toFixed(2)}\n`;
        }
      }

      if (exitedEntries.length > 0) {
        msg += `\n❌ <b>Listeden Çıkanlar:</b>\n`;
        for (const sym of exitedEntries) {
          msg += `  ${sym}\n`;
        }
      }

      msg += `\n📊 <b>Güncel Top ${TOP_N}:</b>\n`;
      for (let i = 0; i < currentTop.length; i++) {
        const info = sorted.find(r => r.symbol === currentTop[i]);
        msg += `  ${i + 1}. ${currentTop[i]} — %${info.volatility.toFixed(2)}\n`;
      }

      await sendTelegram(msg);
    } else {
      console.log('Liste değişmedi, mesaj gönderilmedi');
    }

    // İlk çalışmada başlangıç mesajı
    if (previousTop.length === 0) {
      let msg = `✅ <b>Volatilite Botu Başladı!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      msg += `📡 <i>CoinGecko OHLC — Gerçek Haftalık Volatilite</i>\n\n`;
      msg += `📊 <b>İlk Top ${TOP_N}:</b>\n`;
      for (let i = 0; i < currentTop.length; i++) {
        const info = sorted.find(r => r.symbol === currentTop[i]);
        msg += `  ${i + 1}. ${currentTop[i]} — %${info.volatility.toFixed(2)}\n`;
      }
      msg += `\nHer 6 saatte bir kontrol edilecek.`;
      await sendTelegram(msg);
    }

    saveState({ topList: currentTop, lastCheck: new Date().toISOString() });

  } catch (e) {
    console.error('Kritik hata:', e.message);
    await sendTelegram(`⚠️ Bot hatası: ${e.message}`);
  }
}

(async () => {
  console.log('🤖 Volatilite botu başlıyor...');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Env değişkenleri eksik!');
    process.exit(1);
  }
  await checkVolatility();
  setInterval(checkVolatility, CHECK_INTERVAL_MS);
})();
