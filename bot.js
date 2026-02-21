const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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

// Kapanış fiyatlarından standart sapma bazlı volatilite
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

// Binance Futures sembollerini + coin_id'lerini CoinGecko'dan çek
async function getBinanceFuturesSymbols() {
  const res = await axios.get('https://api.coingecko.com/api/v3/derivatives', {
    headers: { Accept: 'application/json' },
    timeout: 20000
  });

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

// CoinGecko market_chart → 7 günlük günlük fiyatlar → volatilite
// Bu endpoint ücretsiz planda çalışır
async function getVolatilityForCoin(coinId) {
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`,
      {
        params: {
          vs_currency: 'usd',
          days: '7',
          interval: 'daily'   // Günlük kapanışlar
        },
        headers: { Accept: 'application/json' },
        timeout: 10000
      }
    );

    // prices: [[timestamp, price], ...]
    const prices = res.data.prices.map(p => p[1]);
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
    // 1) Sembol listesini çek
    console.log('Binance Futures sembolleri çekiliyor...');
    const tickers = await getBinanceFuturesSymbols();
    console.log(`${tickers.length} sembol bulundu`);

    if (tickers.length === 0) throw new Error('Sembol listesi boş geldi');

    // 2) Her coin için market_chart'tan volatilite hesapla
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < tickers.length; i++) {
      const { symbol, coinId } = tickers[i];
      const vol = await getVolatilityForCoin(coinId);

      if (vol > 0) {
        results.push({ symbol, volatility: vol });
        successCount++;
      } else {
        failCount++;
      }

      // CoinGecko ücretsiz: 30 req/dk → 2 saniyede 1 istek (güvenli)
      await sleep(2100);

      if ((i + 1) % 10 === 0) {
        console.log(`${i + 1}/${tickers.length} — başarılı: ${successCount}, hata: ${failCount}`);
      }
    }

    console.log(`Tamamlandı. ${successCount} sembol işlendi.`);

    if (results.length === 0) throw new Error('Hiçbir sembol için volatilite hesaplanamadı');

    // 3) Sırala, Top N al
    const sorted = results.sort((a, b) => b.volatility - a.volatility);
    const currentTop = sorted.slice(0, TOP_N).map(r => r.symbol);
    console.log('Top 10:', currentTop);

    // 4) Karşılaştır
    const state = loadState();
    const previousTop = state.topList || [];
    const newEntries = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    // 5) Mesaj gönder
    const buildMsg = (title) => {
      let msg = `${title}\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      msg += `📡 <i>CoinGecko 7 Günlük Gerçek Volatilite</i>\n\n`;
      return msg;
    };

    if (previousTop.length === 0) {
      let msg = buildMsg(`✅ <b>Volatilite Botu Başladı!</b>`);
      msg += `📊 <b>İlk Top ${TOP_N}:</b>\n`;
      for (let i = 0; i < currentTop.length; i++) {
        const info = sorted.find(r => r.symbol === currentTop[i]);
        msg += `  ${i + 1}. ${currentTop[i]} — %${info.volatility.toFixed(2)}\n`;
      }
      msg += `\nHer 6 saatte bir kontrol edilecek.`;
      await sendTelegram(msg);

    } else if (newEntries.length > 0 || exitedEntries.length > 0) {
      let msg = buildMsg(`🚨 <b>Top ${TOP_N} Listesi Değişti!</b>`);

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
        for (const sym of exitedEntries) msg += `  ${sym}\n`;
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
