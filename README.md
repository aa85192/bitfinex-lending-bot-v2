# Bitfinex 自動放貸機器人 v2
感謝[戴均民](https://github.com/taichunmin) 前輩無私地分享

Bitfinex 自動放貸機器人，自動調整放貸利率並生成收益統計報表。

基於 [taichunmin/bitfinex-lending-bot](https://github.com/taichunmin/bitfinex-lending-bot) 修改而來。

---

## 主要功能

- 自動調整放貸利率（支援多幣種）
- 根據利率自動設定借出天數
- Telegram 即時狀態提醒
- 收益統計報表（部署至 GitHub Pages）
- 即時狀態儀表板

---

## 快速開始

### 1. 準備 Bitfinex API Key

在 Bitfinex 後台建立 API Key，需要以下權限：
- Margin Funding: 讀取與操作
- Wallets: 讀取與轉帳
- Account Settings: 讀寫

### 2. 準備 Telegram Bot

向 [@BotFather](https://t.me/BotFather) 申請 Bot，取得 Token

### 3. Fork & 設置

1. Fork 本專案
2. 修改 `.github/workflows/wtkuo-auto-renew-3.yml`（改為你的帳號和參數設定）
3. 在 Repository Secrets 中設置：
   - `BITFINEX_API_KEY`
   - `BITFINEX_API_SECRET`
   - `TELEGRAM_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. 在 `Settings → Environments` 建立同名環境
5. 在 `Settings → Pages` 設置 GitHub Actions 部署

---

## 相關連結

- [原始專案](https://github.com/taichunmin/bitfinex-lending-bot)
- [Bitfinex 放貸教學](https://www.youtube.com/watch?v=OL0cZabjl3U)
