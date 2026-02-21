const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOP_N = 10;                    // Top kaç sembol takip edilsin
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 saat
const STATE_FILE = './state.json';
// ──────────────────────────────────────────────────────────

// Önceki listeyi yükle
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

// Mevcut listeyi kaydet
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Binance Futures - tüm sembollerin 24h ticker verisi
async function getBinanceTickers() {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
  // Sadece USDT çiftleri
  return res.data.filter(t => t.symbol.endsWith('USDT'));
}

// Her sembol için 7 günlük kapanış fiyatları → haftalık volatilite hesapla
async function getWeeklyVolatility(symbol) {
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval: '1d', limit: 8 }
    });
    const closes = res.data.map(k => parseFloat(k[4]));
    if (closes.length < 2) return 0;

    // Günlük log return'lar
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }

    // Standart sapma
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * 100; // Yüzde olarak
  } catch (e) {
    return 0;
  }
}

// Telegram mesajı gönder
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

// Ana kontrol fonksiyonu
async function checkVolatility() {
  console.log(`\n[${new Date().toISOString()}] Volatilite kontrol başladı...`);

  try {
    // 1) Tüm tickerları çek
    const tickers = await getBinanceTickers();
    console.log(`${tickers.length} USDT çifti bulundu`);

    // 2) Her sembol için haftalık volatilite hesapla (paralel, 20'şerli batch)
    const results = [];
    const batchSize = 20;

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (t) => {
          const vol = await getWeeklyVolatility(t.symbol);
          return { symbol: t.symbol, volatility: vol, price: parseFloat(t.lastPrice) };
        })
      );
      results.push(...batchResults);
      // Rate limit için kısa bekleme
      await new Promise(r => setTimeout(r, 200));
    }

    // 3) Volatiliteye göre sırala, Top N al
    const sorted = results
      .filter(r => r.volatility > 0)
      .sort((a, b) => b.volatility - a.volatility);

    const currentTop = sorted.slice(0, TOP_N).map(r => r.symbol);
    console.log('Güncel Top 10:', currentTop);

    // 4) Önceki liste ile karşılaştır
    const state = loadState();
    const previousTop = state.topList || [];

    const newEntries = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    // 5) Değişiklik varsa Telegram'a gönder
    if (newEntries.length > 0 || exitedEntries.length > 0) {
      let msg = `🚨 <b>Volatilite Top ${TOP_N} Listesi Değişti!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n\n`;

      if (newEntries.length > 0) {
        msg += `✅ <b>Listeye Girenler:</b>\n`;
        for (const sym of newEntries) {
          const info = sorted.find(r => r.symbol === sym);
          const rank = currentTop.indexOf(sym) + 1;
          msg += `  #${rank} ${sym} — Volatilite: %${info.volatility.toFixed(2)}\n`;
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

    // İlk çalışmada liste boşsa bilgi ver
    if (previousTop.length === 0) {
      let msg = `✅ <b>Volatilite Botu Başladı!</b>\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n\n`;
      msg += `📊 <b>İlk Top ${TOP_N} Listesi:</b>\n`;
      for (let i = 0; i < currentTop.length; i++) {
        const info = sorted.find(r => r.symbol === currentTop[i]);
        msg += `  ${i + 1}. ${currentTop[i]} — %${info.volatility.toFixed(2)}\n`;
      }
      msg += `\nHer 6 saatte bir kontrol edilecek.`;
      await sendTelegram(msg);
    }

    // 6) State'i güncelle
    saveState({ topList: currentTop, lastCheck: new Date().toISOString() });

  } catch (e) {
    console.error('Hata:', e.message);
    await sendTelegram(`⚠️ Bot hatası: ${e.message}`);
  }
}

// Başlat
(async () => {
  console.log('🤖 Volatilite botu başlıyor...');

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ TELEGRAM_TOKEN ve TELEGRAM_CHAT_ID env değişkenleri eksik!');
    process.exit(1);
  }

  // İlk kontrolü hemen yap
  await checkVolatility();

  // Sonra her 6 saatte bir
  setInterval(checkVolatility, CHECK_INTERVAL_MS);
})();
