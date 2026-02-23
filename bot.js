const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOP_N = 10;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 gün
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

// Standart sapma bazlı volatilite
function calcVolatility(closes) {
  if (closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0)
      returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

// Grid hesabı: toplam aralığı %1-%2'lik grid sayısına böl
function calcGrid(low, high) {
  const totalRange = ((high - low) / low) * 100; // toplam % aralık
  const minGrids = Math.ceil(totalRange / 2); // max %2'lik grid
  const maxGrids = Math.ceil(totalRange / 1); // min %1'lik grid
  const gridSize1 = totalRange / maxGrids;
  const gridSize2 = totalRange / minGrids;
  return {
    low,
    high,
    totalRange: totalRange.toFixed(2),
    minGrids,
    maxGrids,
    gridSize1: gridSize1.toFixed(2),
    gridSize2: gridSize2.toFixed(2)
  };
}

// Binance Futures - tüm USDT perpetual semboller
async function getBinanceSymbols() {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', {
    timeout: 15000
  });
  return res.data.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
    .map(s => s.symbol);
}

// 7 günlük kapanışlardan volatilite + 10 günlük high/low
async function getSymbolData(symbol) {
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval: '1d', limit: 10 },
      timeout: 10000
    });

    const candles = res.data;
    if (candles.length < 2) return null;

    // Volatilite için kapanışlar
    const closes = candles.map(k => parseFloat(k[4]));
    const volatility = calcVolatility(closes);

    // 10 günlük high/low (high=index2, low=index3)
    const highs = candles.map(k => parseFloat(k[2]));
    const lows = candles.map(k => parseFloat(k[3]));
    const high10 = Math.max(...highs);
    const low10 = Math.min(...lows);

    return { symbol, volatility, high10, low10 };
  } catch (e) {
    return null;
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

// Grid detay mesajı oluştur
function buildGridDetail(symbol, rank, volatility, high10, low10) {
  const grid = calcGrid(low10, high10);
  let msg = `\n<b>${rank}. ${symbol}</b> — Volatilite: %${volatility.toFixed(2)}\n`;
  msg += `   📈 10G Yüksek: <code>${high10}</code>\n`;
  msg += `   📉 10G Düşük:  <code>${low10}</code>\n`;
  msg += `   📊 Toplam Aralık: %${grid.totalRange}\n`;
  msg += `   🔲 Grid Sayısı: ${grid.minGrids}–${grid.maxGrids} grid\n`;
  msg += `   ↔️ Grid Aralığı: %${grid.gridSize2}–%${grid.gridSize1}\n`;
  return msg;
}

async function checkVolatility() {
  console.log(`\n[${new Date().toISOString()}] Kontrol başladı...`);

  try {
    // 1) Sembolleri çek
    console.log('Binance Futures sembolleri çekiliyor...');
    const symbols = await getBinanceSymbols();
    console.log(`${symbols.length} sembol bulundu`);

    // 2) Her sembol için veri çek (15'erli batch)
    const results = [];
    const batchSize = 15;

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(sym => getSymbolData(sym)));
      results.push(...batchResults.filter(r => r && r.volatility > 0));
      await sleep(300);

      if (i % 60 === 0 && i > 0)
        console.log(`${i}/${symbols.length} işlendi...`);
    }

    console.log(`${results.length} sembol hesaplandı`);
    if (results.length === 0) throw new Error('Hiçbir veri hesaplanamadı');

    // 3) Sırala, Top N
    const sorted = results.sort((a, b) => b.volatility - a.volatility);
    const topResults = sorted.slice(0, TOP_N);
    const currentTop = topResults.map(r => r.symbol);
    console.log('Top 10:', currentTop);

    // 4) Karşılaştır
    const state = loadState();
    const previousTop = state.topList || [];
    const newEntries = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    // 5) Mesaj gönder
    const buildFullList = (title) => {
      let msg = `${title}\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      msg += `📡 <i>Binance Futures — Gerçek 7 Günlük Volatilite</i>\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      for (let i = 0; i < topResults.length; i++) {
        const r = topResults[i];
        msg += buildGridDetail(r.symbol, i + 1, r.volatility, r.high10, r.low10);
      }
      return msg;
    };

    if (previousTop.length === 0) {
      const msg = buildFullList(`✅ <b>Volatilite Botu Başladı!</b>`);
      await sendTelegram(msg);

    } else if (newEntries.length > 0 || exitedEntries.length > 0) {
      // Değişim özeti
      let summary = `🚨 <b>Top ${TOP_N} Listesi Değişti!</b>\n`;
      summary += `📅 ${new Date().toLocaleString('tr-TR')}\n\n`;

      if (newEntries.length > 0) {
        summary += `✅ <b>Listeye Girenler:</b>\n`;
        for (const sym of newEntries) {
          const info = topResults.find(r => r.symbol === sym);
          summary += `  #${currentTop.indexOf(sym) + 1} ${sym} — %${info.volatility.toFixed(2)}\n`;
        }
      }
      if (exitedEntries.length > 0) {
        summary += `\n❌ <b>Listeden Çıkanlar:</b>\n`;
        for (const sym of exitedEntries) summary += `  ${sym}\n`;
      }
      await sendTelegram(summary);

      // Tam liste + grid detayları ayrı mesaj olarak
      const detail = buildFullList(`📊 <b>Güncel Top ${TOP_N} — Grid Detayları</b>`);
      await sendTelegram(detail);

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
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Eksik env: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID');
    process.exit(1);
  }
  await checkVolatility();
  setInterval(checkVolatility, CHECK_INTERVAL_MS);
})();
