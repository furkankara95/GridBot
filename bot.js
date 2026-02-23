const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOP_N = 10;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 gün
const STATE_FILE = './state.json';
const BACKTEST_CAPITAL = 1000;
const COMMISSION = 0.00025; // %0.025
// ──────────────────────────────────────────────────────────

// 4 backtest periyodu - hepsi 1h mumlarla
const PERIODS = [
  { label: '1 Günlük',  hours: 24  },
  { label: '3 Günlük',  hours: 72  },
  { label: '5 Günlük',  hours: 120 },
  { label: '10 Günlük', hours: 240 },
];

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

// Standart sapma bazlı volatilite (günlük mumlardan)
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

// Grid hesabı
function calcGrid(low, high) {
  const totalRange = ((high - low) / low) * 100;
  const maxGrids = Math.ceil(totalRange / 1); // %1 aralık = max grid
  return { low, high, totalRange, maxGrids };
}

// Grid Bot Backtest (Pine Script mantığı - 1h mumlarla)
function runBacktest(candles, lowerBound, upperBound, gridQty) {
  if (candles.length === 0 || gridQty < 2) return null;

  const gridWidth = (upperBound - lowerBound) / (gridQty - 1);
  const gridLines = [];
  for (let i = 0; i < gridQty; i++) {
    gridLines.push(lowerBound + gridWidth * i);
  }

  const qtyPerGrid = BACKTEST_CAPITAL / (gridQty - 1);
  const orderArr   = new Array(gridQty).fill(false);
  const orderQty   = new Array(gridQty).fill(0);
  const orderPrice = new Array(gridQty).fill(0);

  let netProfit  = 0;
  let totalFee   = 0;
  let tradeCount = 0;

  for (const candle of candles) {
    const close = parseFloat(candle[4]);
    if (close <= 0) continue;

    for (let i = 0; i < gridLines.length; i++) {
      // AL
      if (close < gridLines[i] && !orderArr[i] && i < gridLines.length - 1) {
        const qty = qtyPerGrid / close;
        const fee = qty * close * COMMISSION;
        orderArr[i]   = true;
        orderQty[i]   = qty;
        orderPrice[i] = close;
        totalFee += fee;
      }
      // SAT
      if (close > gridLines[i] && i !== 0 && orderArr[i - 1]) {
        const buyQty   = orderQty[i - 1];
        const buyPrice = orderPrice[i - 1];
        const sellFee  = buyQty * close * COMMISSION;
        const buyFee   = buyQty * buyPrice * COMMISSION;
        netProfit += buyQty * (close - buyPrice) - sellFee - buyFee;
        totalFee  += sellFee;
        tradeCount++;
        orderArr[i - 1]   = false;
        orderQty[i - 1]   = 0;
        orderPrice[i - 1] = 0;
      }
    }
  }

  // Unrealized P&L
  const lastClose = parseFloat(candles[candles.length - 1][4]);
  let openProfit = 0;
  for (let i = 0; i < gridLines.length; i++) {
    if (orderArr[i]) {
      openProfit += orderQty[i] * (lastClose - orderPrice[i]);
    }
  }

  const totalProfit = netProfit + openProfit;
  const profitPct   = (totalProfit / BACKTEST_CAPITAL) * 100;

  return {
    netProfit:    netProfit.toFixed(2),
    openProfit:   openProfit.toFixed(2),
    totalProfit:  totalProfit.toFixed(2),
    profitPct:    profitPct.toFixed(2),
    finalBalance: (BACKTEST_CAPITAL + totalProfit).toFixed(2),
    totalFee:     totalFee.toFixed(2),
    tradeCount,
  };
}

// Binance - 1h mumları çek (limit: saat sayısı)
async function get1hCandles(symbol, hours) {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol, interval: '1h', limit: hours },
    timeout: 10000
  });
  return res.data;
}

// Binance - günlük mumlar (volatilite için)
async function getDailyCandles(symbol) {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol, interval: '1d', limit: 10 },
    timeout: 10000
  });
  return res.data;
}

// Binance Futures sembolleri
async function getBinanceSymbols() {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', {
    timeout: 15000
  });
  return res.data.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
    .map(s => s.symbol);
}

// Her sembol için tüm veriyi çek
async function getSymbolData(symbol) {
  try {
    // Volatilite için günlük mumlar
    const dailyCandles = await getDailyCandles(symbol);
    if (dailyCandles.length < 2) return null;

    const closes    = dailyCandles.map(k => parseFloat(k[4]));
    const volatility = calcVolatility(closes);

    // 10G high/low (günlük)
    const highs  = dailyCandles.map(k => parseFloat(k[2]));
    const lows   = dailyCandles.map(k => parseFloat(k[3]));
    const high10 = Math.max(...highs);
    const low10  = Math.min(...lows);

    // 4 periyot için 1h mumları çek (en uzun olan 240h, hepsini kapsıyor)
    const candles1h = await get1hCandles(symbol, 240);

    // Her periyot için high/low ve candle dilimi
    const periods = PERIODS.map(p => {
      const slice    = candles1h.slice(-p.hours);
      const pHighs   = slice.map(k => parseFloat(k[2]));
      const pLows    = slice.map(k => parseFloat(k[3]));
      const pHigh    = Math.max(...pHighs);
      const pLow     = Math.min(...pLows);
      const grid     = calcGrid(pLow, pHigh);
      const bt       = runBacktest(slice, pLow, pHigh, grid.maxGrids);
      return { ...p, pHigh, pLow, grid, bt, candles: slice };
    });

    return { symbol, volatility, high10, low10, periods };
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
  } catch (e) {
    console.error('Telegram hatası:', e.message);
  }
}

// Fiyat formatlayıcı
const fmt = (n) => n < 0.001 ? n.toFixed(6) : n < 0.1 ? n.toFixed(5) : n < 1 ? n.toFixed(4) : n.toFixed(3);

function buildCoinMessage(rank, data) {
  const { symbol, volatility, periods } = data;

  let msg = `<b>${rank}. ${symbol}</b> — Volatilite: %${volatility.toFixed(2)}\n`;
  msg += `━━━━━━━━━━━━━━━━━\n`;

  for (const p of periods) {
    const { label, pHigh, pLow, grid, bt } = p;
    const profitEmoji = bt && parseFloat(bt.totalProfit) >= 0 ? '✅' : '❌';
    const gridPerGrid = (BACKTEST_CAPITAL / (grid.maxGrids - 1)).toFixed(2);

    msg += `\n📆 <b>${label} (1H)</b>\n`;
    msg += `   📈 Yüksek: <code>${fmt(pHigh)}</code>  📉 Düşük: <code>${fmt(pLow)}</code>\n`;
    msg += `   Aralık: %${grid.totalRange.toFixed(2)} | Grid: ${grid.maxGrids} | Grid/USDT: ${gridPerGrid}\n`;
    if (bt) {
      msg += `   ${profitEmoji} Kâr: ${bt.totalProfit} USDT (%${bt.profitPct}) | ${bt.tradeCount} işlem\n`;
      msg += `   💰 Son Bakiye: ${bt.finalBalance} USDT | Komisyon: ${bt.totalFee} USDT\n`;
    }
  }

  return msg;
}

async function checkVolatility() {
  console.log(`\n[${new Date().toISOString()}] Kontrol başladı...`);

  try {
    console.log('Binance Futures sembolleri çekiliyor...');
    const symbols = await getBinanceSymbols();
    console.log(`${symbols.length} sembol bulundu`);

    const results = [];
    const batchSize = 10; // 1h veri de çektiğimiz için batch küçüldü

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(sym => getSymbolData(sym)));
      results.push(...batchResults.filter(r => r && r.volatility > 0));
      await sleep(500);
      if (i % 50 === 0 && i > 0)
        console.log(`${i}/${symbols.length} işlendi...`);
    }

    console.log(`${results.length} sembol hesaplandı`);
    if (results.length === 0) throw new Error('Hiçbir veri hesaplanamadı');

    const sorted     = results.sort((a, b) => b.volatility - a.volatility);
    const topResults = sorted.slice(0, TOP_N);
    const currentTop = topResults.map(r => r.symbol);
    console.log('Top 10:', currentTop);

    const state       = loadState();
    const previousTop = state.topList || [];
    const newEntries  = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    const sendFullReport = async (title) => {
      // Özet
      let header = `${title}\n`;
      header += `📅 ${new Date().toLocaleString('tr-TR')}\n`;
      header += `📡 <i>Binance Futures | 7G Volatilite | Backtest $${BACKTEST_CAPITAL} (1H mumlar)</i>\n`;
      header += `━━━━━━━━━━━━━━━━━━━━\n`;
      header += topResults.map((r, i) => `${i + 1}. ${r.symbol} — %${r.volatility.toFixed(2)}`).join('\n');
      await sendTelegram(header);
      await sleep(500);

      // Her coin detayı
      for (let i = 0; i < topResults.length; i++) {
        await sendTelegram(buildCoinMessage(i + 1, topResults[i]));
        await sleep(400);
      }
    };

    if (previousTop.length === 0) {
      await sendFullReport(`✅ <b>Volatilite Botu Başladı!</b>`);

    } else if (newEntries.length > 0 || exitedEntries.length > 0) {
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
      await sleep(500);
      await sendFullReport(`📊 <b>Güncel Top ${TOP_N} — Detaylar</b>`);

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
