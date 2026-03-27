# bitfinex-lending-bot-v2

Bitfinex 自動放貸機器人，基於 [taichunmin/bitfinex-lending-bot](https://github.com/taichunmin/bitfinex-lending-bot) 修改而來。

感謝戴均民前輩（[@taichunmin](https://github.com/taichunmin)）的原始專案與 [`@taichunmin/bitfinex`](https://github.com/taichunmin/js-bitfinex) SDK。

---

## 功能

- **自動調整放貸利率**：分析過去 24 小時的成交量分布，以二分搜尋法找出最佳利率
- **自動設定天數**：依利率高低對應借出天數，利率越高借越久（線性內插）
- **Telegram 狀態訊息**：每次執行 edit 同一則訊息，顯示投資額、已借出、掛單中、每筆出借明細
- **多幣種支援**：單一 workflow 同時管理 USD + UST
- **收益統計報表**：計算每日/七日/三十日年化報酬率，部署至 GitHub Pages，支援 Google Sheets 匯入

---

## 事前準備

### Bitfinex API Key

前往 Bitfinex → Account → API Keys，建立一組 API Key，需開啟以下權限：

| 分類 | 權限 |
|---|---|
| Account History | Read |
| Orders | Read |
| Margin Funding | Read、Write |
| Wallets | Read |
| Settings | Read、**Write** |

> Settings Write 用於在 Bitfinex 儲存 Telegram msgId，讓 bot 每次 edit 同一則訊息而非新增。

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
| `rank` | 目標成交量百分位，`0.8` = 取市場前 80% 的利率 |
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
