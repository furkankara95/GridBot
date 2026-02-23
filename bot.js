const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOP_N = 10;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 gün
const STATE_FILE = './state.json';
const BACKTEST_CAPITAL = 1000;
const COMMISSION = 0.00025;
// ──────────────────────────────────────────────────────────

const PERIODS = [
  { label: '1G',  hours: 24  },
  { label: '3G',  hours: 72  },
  { label: '5G',  hours: 120 },
  { label: '10G', hours: 240 },
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

// Grid sayısı: toplam aralığı %1'e böl
function calcGridQty(low, high) {
  const totalRange = ((high - low) / low) * 100;
  return { totalRange, gridQty: Math.ceil(totalRange / 1) };
}

// Backtest - sabit low/high, değişen 1h mum dilimi
function runBacktest(candles, lowerBound, upperBound, gridQty) {
  if (candles.length === 0 || gridQty < 2) return null;

  const gridWidth  = (upperBound - lowerBound) / (gridQty - 1);
  const gridLines  = Array.from({ length: gridQty }, (_, i) => lowerBound + gridWidth * i);
  const qtyPerGrid = BACKTEST_CAPITAL / (gridQty - 1);
  const orderArr   = new Array(gridQty).fill(false);
  const orderQty   = new Array(gridQty).fill(0);
  const orderPrice = new Array(gridQty).fill(0);

  let netProfit = 0, totalFee = 0, tradeCount = 0;

  for (const candle of candles) {
    const close = parseFloat(candle[4]);
    if (close <= 0) continue;

    for (let i = 0; i < gridLines.length; i++) {
      if (close < gridLines[i] && !orderArr[i] && i < gridLines.length - 1) {
        const qty = qtyPerGrid / close;
        orderArr[i] = true; orderQty[i] = qty; orderPrice[i] = close;
        totalFee += qty * close * COMMISSION;
      }
      if (close > gridLines[i] && i !== 0 && orderArr[i - 1]) {
        const bQty = orderQty[i - 1], bPrice = orderPrice[i - 1];
        netProfit += bQty * (close - bPrice) - bQty * close * COMMISSION - bQty * bPrice * COMMISSION;
        totalFee  += bQty * close * COMMISSION;
        tradeCount++;
        orderArr[i-1] = false; orderQty[i-1] = 0; orderPrice[i-1] = 0;
      }
    }
  }

  const lastClose  = parseFloat(candles[candles.length - 1][4]);
  const openProfit = gridLines.reduce((sum, _, i) =>
    orderArr[i] ? sum + orderQty[i] * (lastClose - orderPrice[i]) : sum, 0);

  const total    = netProfit + openProfit;
  const pct      = (total / BACKTEST_CAPITAL) * 100;

  return {
    profit:  total.toFixed(2),
    pct:     pct.toFixed(2),
    balance: (BACKTEST_CAPITAL + total).toFixed(2),
    trades:  tradeCount,
    fee:     totalFee.toFixed(2),
  };
}

async function getBinanceSymbols() {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', { timeout: 15000 });
  return res.data.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
    .map(s => s.symbol);
}

async function getSymbolData(symbol) {
  try {
    // Günlük mumlar → volatilite
    const daily = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval: '1d', limit: 10 }, timeout: 10000
    });
    if (daily.data.length < 2) return null;
    const volatility = calcVolatility(daily.data.map(k => parseFloat(k[4])));

    // 10G high/low (günlük) — tüm backtestler için SABİT
    const high10 = Math.max(...daily.data.map(k => parseFloat(k[2])));
    const low10  = Math.min(...daily.data.map(k => parseFloat(k[3])));
    const { totalRange, gridQty } = calcGridQty(low10, high10);

    // 1h mumlar (240 saat = 10 gün, hepsini kapsıyor)
    const hourly = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval: '1h', limit: 240 }, timeout: 10000
    });
    const candles1h = hourly.data;

    // 4 periyot için backtest — hepsi aynı low10/high10 ile
    const backtests = PERIODS.map(p => ({
      label: p.label,
      bt:    runBacktest(candles1h.slice(-p.hours), low10, high10, gridQty)
    }));

    return { symbol, volatility, high10, low10, totalRange, gridQty, backtests };
  } catch (e) {
    return null;
  }
}

const fmt = (n) => n < 0.001 ? n.toFixed(6) : n < 0.1 ? n.toFixed(5) : n < 1 ? n.toFixed(4) : n.toFixed(3);

function buildCoinMessage(rank, d) {
  const gridPerUsdt = (BACKTEST_CAPITAL / (d.gridQty - 1)).toFixed(2);

  let msg = `<b>${rank}. ${d.symbol}</b>  Vlt: %${d.volatility.toFixed(2)}\n`;
  msg += `📈 <code>${fmt(d.high10)}</code>  📉 <code>${fmt(d.low10)}</code>  Aralık: %${d.totalRange.toFixed(1)}\n`;
  msg += `Grid: ${d.gridQty} adet  |  Grid başı: ${gridPerUsdt} USDT\n`;
  msg += `\n`;

  for (const { label, bt } of d.backtests) {
    if (!bt) { msg += `${label}: veri yok\n`; continue; }
    const sign = parseFloat(bt.profit) >= 0 ? '✅' : '❌';
    msg += `${sign} <b>${label}</b>  ${bt.profit > 0 ? '+' : ''}${bt.profit}$ (%${bt.pct})  ${bt.trades} işlem\n`;
  }

  return msg;
}

async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML'
    });
  } catch (e) {
    console.error('Telegram hatası:', e.message);
  }
}

async function checkVolatility() {
  console.log(`\n[${new Date().toISOString()}] Kontrol başladı...`);
  try {
    const symbols = await getBinanceSymbols();
    console.log(`${symbols.length} sembol`);

    const results = [];
    for (let i = 0; i < symbols.length; i += 10) {
      const batch = await Promise.all(symbols.slice(i, i + 10).map(getSymbolData));
      results.push(...batch.filter(r => r && r.volatility > 0));
      await sleep(500);
      if (i % 50 === 0 && i > 0) console.log(`${i}/${symbols.length}...`);
    }

    const sorted     = results.sort((a, b) => b.volatility - a.volatility);
    const topResults = sorted.slice(0, TOP_N);
    const currentTop = topResults.map(r => r.symbol);
    console.log('Top 10:', currentTop);

    const state         = loadState();
    const previousTop   = state.topList || [];
    const newEntries    = currentTop.filter(s => !previousTop.includes(s));
    const exitedEntries = previousTop.filter(s => !currentTop.includes(s));

    const sendReport = async (title) => {
      // Tek mesajda özet + tüm coinler
      let msg = `${title}\n`;
      msg += `📅 ${new Date().toLocaleString('tr-TR')} | $${BACKTEST_CAPITAL} | Low/High: 10G sabit\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (let i = 0; i < topResults.length; i++) {
        msg += buildCoinMessage(i + 1, topResults[i]);
        msg += '\n';
      }
      // Telegram 4096 karakter limiti — uzunsa böl
      if (msg.length <= 4096) {
        await sendTelegram(msg);
      } else {
        // Başlık + her coin ayrı mesaj
        let header = `${title}\n📅 ${new Date().toLocaleString('tr-TR')}\n━━━━━━━━━━━━━━━━━━━━\n`;
        header += topResults.map((r, i) => `${i+1}. ${r.symbol} — %${r.volatility.toFixed(2)}`).join('\n');
        await sendTelegram(header);
        await sleep(400);
        for (let i = 0; i < topResults.length; i++) {
          await sendTelegram(buildCoinMessage(i + 1, topResults[i]));
          await sleep(300);
        }
      }
    };

    if (previousTop.length === 0) {
      await sendReport(`✅ <b>Volatilite Botu Başladı!</b>`);
    } else if (newEntries.length > 0 || exitedEntries.length > 0) {
      let change = `🚨 <b>Top ${TOP_N} Değişti!</b>  📅 ${new Date().toLocaleString('tr-TR')}\n\n`;
      if (newEntries.length > 0) {
        change += `✅ Girenler: `;
        change += newEntries.map(s => {
          const info = topResults.find(r => r.symbol === s);
          return `${s} %${info.volatility.toFixed(2)}`;
        }).join(', ') + '\n';
      }
      if (exitedEntries.length > 0) {
        change += `❌ Çıkanlar: ${exitedEntries.join(', ')}\n`;
      }
      await sendTelegram(change);
      await sleep(400);
      await sendReport(`📊 <b>Güncel Top ${TOP_N}</b>`);
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
