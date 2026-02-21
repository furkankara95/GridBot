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
  } catch (e) {
    console.error('State yüklenemedi:', e.message);
  }
  return { topList: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// CoinGecko - Binance Futures tickers (Binance'in aksine engel yok)
async function getDerivativesTickers() {
  const res = await axios.get(
    'https://api.coingecko.com/api/v3/derivatives',
    { headers: { 'Accept': 'application/json' } }
  );

  // Sadece Binance Futures + USDT çiftleri
  return res.data.filter(t =>
    t.market === 'Binance (Futures)' &&
    t.symbol &&
    t.symbol.endsWith('USDT') &&
    t.price_percentage_change_24h !== null
  );
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
  console.log(`\n[${new Date().toISOString()}] Volatilite kontrol başladı...`);

  try {
    console.log('CoinGecko derivatives verisi çekiliyor...');
    const tickers = await getDerivativesTickers();
    console.log(`${tickers.length} Binance Futures USDT çifti bulundu`);

    if (tickers.length === 0) throw new Error('Hiç ticker bulunamadı');

    // 24h % değişimin mutlak değeri = volatilite proxy
    const enriched = tickers.map(t => ({
      symbol: t.symbol,
      volatility: Math.abs(parseFloat(t.price_percentage_change_24h) || 0),
      price: parseFloat(t.last_price || 0)
    })).filter(t => t.volatility > 0);

    // Volatiliteye göre sırala
    const sorted = enriched.sort((a, b) => b.volatility - a.volatility);
    const currentTop = sorted.slice(0, TOP_N).map(r => r.symbol);
    console.log('Güncel Top 10:', currentTop);

    const state = loadState();
    const previousTop = state.topList || [];

    const newEntries = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    if (newEntries.length > 0 || exitedEntries.length > 0) {
      let msg = `🚨 <b>Volatilite Top ${TOP_N} Listesi Değişti!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n\n`;

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
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n\n`;
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
    console.error('Hata:', e.message);
    await sendTelegram(`⚠️ Bot hatası: ${e.message}`);
  }
}

(async () => {
  console.log('🤖 Volatilite botu başlıyor...');

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ TELEGRAM_TOKEN ve TELEGRAM_CHAT_ID env değişkenleri eksik!');
    process.exit(1);
  }

  await checkVolatility();
  setInterval(checkVolatility, CHECK_INTERVAL_MS);
})();
