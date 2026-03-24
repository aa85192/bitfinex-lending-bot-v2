# bitfinex-lending-bot-v2

Bitfinex 自動放貸機器人，基於 [taichunmin/bitfinex-lending-bot](https://github.com/taichunmin/bitfinex-lending-bot) 修改而來。

感謝戴均民前輩（[@taichunmin](https://github.com/taichunmin)）的原始專案與 [`@taichunmin/bitfinex`](https://github.com/taichunmin/js-bitfinex) SDK，本專案建立在他的工作成果之上。

---

## 功能

- **自動調整放貸利率**：分析過去 24 小時的成交量分布，以二分搜尋法找出最佳利率
- **自動設定天數**：依利率高低對應借出天數，利率越高借越久
- **Telegram 通知**：每次執行更新同一則訊息，顯示目前狀態（投資額、已借出、掛單中、每筆明細）
- **收益統計報表**：計算每日/七日/三十日年化報酬率，部署至 GitHub Pages，支援 Google Sheets 匯入

---

## 需要修改的地方

### 1. `bin/funding-statistics-1.ts`

第 47 行，將 `aa85192` 改為你的 GitHub 帳號：

```ts
db: getenv('INPUT_DB', `https://你的帳號.github.io/bitfinex-lending-bot-v2/funding-statistics-1/db.json`),
```

### 2. `.github/workflows/taichunmin-usd-1.yml`

| 項目 | 說明 |
|---|---|
| `if: github.repository_owner == 'aa85192'` | 改為你的 GitHub 帳號，避免 fork 後誤觸發 |
| `environment: aa85192` | 改為你自己建立的 Environment 名稱 |
| `INPUT_CURRENCY` | 放貸幣種（`USD` 或 `UST`） |
| `INPUT_RANK` | 目標成交量百分位，`0.8` = 取市場前 80% 的利率 |
| `INPUT_RATE_MIN` | 最低可接受利率（日利率，`0.0001` = APR 3.65%） |
| `INPUT_RATE_MAX` | 最高可接受利率（日利率，`0.01` = APR 365%） |
| `INPUT_PERIOD` | 利率對應天數表（利率越高，借出越多天） |

### 3. `.github/workflows/taichunmin-usdt-1.yml`

同上，幣種改為 `UST`。

### 4. `package.json`

```json
"repository": "git@github.com:你的帳號/bitfinex-lending-bot-v2.git"
```

---

## GitHub 設定

### Repository Secrets

前往 `Settings → Secrets and variables → Actions → New repository secret`，新增以下四個：

| Secret 名稱 | 說明 |
|---|---|
| `BITFINEX_API_KEY` | Bitfinex API Key（需開啟 Funding 讀寫權限） |
| `BITFINEX_API_SECRET` | Bitfinex API Secret |
| `TELEGRAM_TOKEN` | Telegram Bot Token（向 [@BotFather](https://t.me/BotFather) 申請） |
| `TELEGRAM_CHAT_ID` | 你的 Telegram Chat ID |

### Environments

前往 `Settings → Environments → New environment`，建立與 workflow 中 `environment:` 相同名稱的環境（預設為 `aa85192`，改為你的帳號名稱）。

### GitHub Pages

前往 `Settings → Pages → Build and deployment`，將 Source 設為 **GitHub Actions**。

---

## Workflows

| Workflow | 觸發時機 | 說明 |
|---|---|---|
| `GitHub Pages` | 每天 UTC 00:45–03:45，push | 計算收益統計，發 Telegram 日報，部署至 GitHub Pages |
| `taichunmin auto-renew-2: fUSD` | 每 10 分鐘 | 自動調整 USD 放貸利率 |
| `taichunmin auto-renew-2: fUST` | 每 10 分鐘 | 自動調整 UST 放貸利率 |

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
