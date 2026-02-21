# 🤖 Binance Volatilite Telegram Botu

Binance Futures'da haftalık volatiliteye göre Top 10 listesini takip eder.
Listeye yeni sembol girdiğinde veya çıktığında Telegram'dan anlık bildirim gönderir.

---

## 📋 Kurulum Adımları

### 1. Telegram Bot Oluştur

1. Telegram'da **@BotFather**'a git
2. `/newbot` yaz
3. Bot adı gir (örn: `Volatilite Takip`)
4. Username gir (örn: `volatilite_takip_bot`)
5. Sana verilen **TOKEN'ı** kopyala → `TELEGRAM_TOKEN`

### 2. Chat ID Al

1. Botuna Telegram'dan bir mesaj at (herhangi bir şey)
2. Tarayıcıda şu URL'yi aç:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. `"chat":{"id":XXXXXXX}` kısmındaki sayıyı kopyala → `TELEGRAM_CHAT_ID`

---

### 3. Railway'e Deploy Et

1. **GitHub repo oluştur** (bu klasörü yükle)
   ```bash
   git init
   git add .
   git commit -m "initial"
   git remote add origin https://github.com/KULLANICI/volatility-bot.git
   git push -u origin main
   ```

2. **Railway.app'e git** → [railway.app](https://railway.app)

3. **New Project** → **Deploy from GitHub repo** → repoyu seç

4. **Variables** sekmesine git, şunları ekle:
   | Key | Value |
   |-----|-------|
   | `TELEGRAM_TOKEN` | BotFather'dan aldığın token |
   | `TELEGRAM_CHAT_ID` | Chat ID'n |

5. Deploy otomatik başlar ✅

---

## 📱 Nasıl Çalışır?

- Her **6 saatte bir** Binance Futures'daki tüm USDT çiftlerinin haftalık volatilitesini hesaplar
- **Standart sapma** bazlı gerçek volatilite (TradingView ile aynı yöntem)
- Top 10 liste değişirse **anında Telegram mesajı** gönderir

### Örnek Mesaj:
```
🚨 Volatilite Top 10 Listesi Değişti!
📅 15.02.2025 12:00

✅ Listeye Girenler:
  #3 MYXUSDT — Volatilite: %11.83
  #7 SPACEUSDT — Volatilite: %8.42

❌ Listeden Çıkanlar:
  SIREUSDT
  INITUSDT

📊 Güncel Top 10:
  1. AZTECUSDT — %12.50
  2. ESPUSDT — %11.95
  ...
```

---

## ⚙️ Ayarlar (bot.js)

```js
const TOP_N = 10;                         // Top kaç sembol (değiştirilebilir)
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;  // Kontrol sıklığı (ms)
```

---

## 🔧 Sorun Giderme

**Bot mesaj atmıyor:**
- BotFather'dan aldığın token'ı doğrula
- Bota en az 1 mesaj attığından emin ol (Chat ID için)
- Railway → Logs sekmesinden hata mesajını kontrol et

**Rate limit hatası:**
- Binance API rate limit'e takılıyorsa `bot.js` içindeki `batchSize`'ı 10'a düşür
