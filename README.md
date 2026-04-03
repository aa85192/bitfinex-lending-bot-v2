# bitfinex-lending-bot-v2

Bitfinex 自動放貸機器人，基於 [taichunmin/bitfinex-lending-bot](https://github.com/taichunmin/bitfinex-lending-bot) 修改而來。

感謝戴均民前輩（[@taichunmin](https://github.com/taichunmin)）的原始專案與 [`@taichunmin/bitfinex`](https://github.com/taichunmin/js-bitfinex) SDK。

---

## 功能

- **自動調整放貸利率**：分析過去 24 小時的 1 分鐘 K 線，對每根 K 線建立利率區間 [low, high]，以成交量乘以線性時間權重（30 分鐘 bucket，最新 1.0 → 最舊 0.5）加權，透過二分搜尋找出目標百分位利率
- **自動設定天數**：依利率高低對應借出天數，利率越高借越久（線性內插）
- **Telegram 狀態訊息**：每次執行 edit 同一則訊息，顯示投資額、已借出、掛單中、每筆出借明細
- **多幣種支援**：單一 workflow 同時管理 USD + UST
- **收益統計報表**：計算每日/七日/三十日年化報酬率，部署至 GitHub Pages，支援 Google Sheets 匯入

---

## 事前準備

### Bitfinex API Key

前往 Bitfinex → Account → API Keys，建立一組 API Key，需開啟以下權限：

| 分類 | 項目 |
|---|---|
| Account Info | Get account fee information |
| Account History | Get historical balances entries and trade information |
| Orders | Get orders and statuses |
| Margin Trading | Get position and margin info |
| Margin Funding | Get funding statuses and info |
| Margin Funding | Offer, cancel and close funding |
| Wallets | Get wallet balances and addresses |
| Wallets | Transfer between your wallets |
| Settings | Read account settings |
| Settings | **Write account settings** |

### Telegram Bot

1. 向 [@BotFather](https://t.me/BotFather) 申請 Bot，取得 `TELEGRAM_TOKEN`
2. 取得你的 `TELEGRAM_CHAT_ID`（可向 [@userinfobot](https://t.me/userinfobot) 查詢）

---

## Fork 後需修改的地方

### 1. `.github/workflows/taichunmin-auto-renew-3.yml`

| 項目 | 說明 |
|---|---|
| `github.repository_owner == 'aa85192'` | 改為你的 GitHub 帳號 |
| `environment: aa85192` | 改為你建立的 Environment 名稱 |
| `INPUT_AUTO_RENEW_3` | 調整各幣種的 rank、rateMin、rateMax、period |

**INPUT_AUTO_RENEW_3 參數說明：**

| 參數 | 說明 |
|---|---|
| `amount` | 每筆最小放貸金額，`0` = 不限制 |
| `rank` | 目標成交量百分位，`0.6` = 找出「有 60% 加權成交量發生在此利率以下」的定價點 |
| `rateMin` | 最低可接受日利率，`0.0001` = APR 3.65% |
| `rateMax` | 最高可接受日利率，`0.01` = APR 365% |
| `period` | 利率對應天數表，格式為 `天數: 門檻日利率` |

### 2. `bin/funding-statistics-1.ts`

第 47 行，將 `aa85192` 改為你的 GitHub 帳號：

```ts
db: getenv('INPUT_DB', `https://你的帳號.github.io/bitfinex-lending-bot-v2/funding-statistics-1/db.json`),
```

### 3. `package.json`

```json
"repository": "git@github.com:你的帳號/bitfinex-lending-bot-v2.git"
```

---

## GitHub 設定

### Repository Secrets

前往 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret 名稱 | 說明 |
|---|---|
| `BITFINEX_API_KEY` | Bitfinex API Key |
| `BITFINEX_API_SECRET` | Bitfinex API Secret |
| `TELEGRAM_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 你的 Telegram Chat ID |

### Environments

前往 `Settings → Environments → New environment`，建立與 workflow 中 `environment:` 相同名稱的環境（預設 `aa85192`，改為你的帳號）。

### GitHub Pages

前往 `Settings → Pages → Build and deployment`，將 Source 設為 **GitHub Actions**。

---

## 定價算法說明

`funding-auto-renew-3` 採用以下流程決定放貸利率：

1. **取得 K 線資料**：抓取過去 24 小時的 1 分鐘 Funding Candles（借款期間 2～30 天）
2. **建立利率區間**：每根 K 線取 `[min(OHLC), max(OHLC)]` 作為該分鐘的利率範圍，假設成交量在此區間內均勻分布
3. **計算時間權重**：以 30 分鐘為一個 bucket，同一 bucket 內的 K 線共享相同時間權重；權重從最新 bucket 的 `1.0` 線性衰減至 24 小時前的 `0.5`，確保近期市場動態有更大影響力，但歷史資料不被完全忽略
4. **二分搜尋定價**：找出使「累積加權成交量 / 總加權成交量 = rank」的利率，即加權體積分布的第 `rank` 百分位
5. **夾住範圍**：將結果限制在 `rateMin` ～ `rateMax` 之間後套用為自動出借利率

**不使用 FRR**：Flash Return Rate 因自我強化機制導致系統性偏高，本程式不參考。

---

## Workflows

| Workflow | 觸發時機 | 說明 |
|---|---|---|
| `GitHub Pages` | 每天 UTC 00:45–03:45、push | 計算收益統計，部署至 GitHub Pages |
| `taichunmin auto-renew-3: fUSD + fUST` | 每 10 分鐘 | 自動調整 USD + UST 放貸利率，更新 Telegram 狀態訊息 |

> `taichunmin auto-renew-2` 系列 workflow 已由 v3 取代，可停用。

---

## Google Sheets 匯入

```
=IMPORTDATA("https://你的帳號.github.io/bitfinex-lending-bot-v2/funding-statistics-1/USD.csv?t=1")
```

---

## 相關連結

- [taichunmin/bitfinex-lending-bot](https://github.com/taichunmin/bitfinex-lending-bot)（原始專案）
- [放貸機器人介紹](https://evestment.weebly.com/marginbotintro.html)
- [Bitfinex 放貸教學影片](https://www.youtube.com/watch?v=OL0cZabjl3U)
