# GCP 免費額度部署 — 即時監控 + iOS PWA 推播

把 bot 從 GitHub Actions cron(每 10 分鐘)升級為**長駐 WebSocket daemon**,跑在 GCP `e2-micro` 永久免費 VM 上,並透過 **Web Push** 推送通知到 iOS 主畫面 PWA。

## 架構

```
                    Bitfinex WSv2 (public + auth)
                              │
                              ▼
   ┌────────────────────────────────────────────────────┐
   │  GCP e2-micro VM  (us-west1, always-free)          │
   │                                                    │
   │  systemd  bitfinex-bot.service                     │
   │   └─ tsx bot/daemon.ts                             │
   │        ├─ 即時 state (記憶體)                       │
   │        ├─ SSE 推播 /api/stream                      │
   │        └─ Web Push (VAPID)                         │
   │                                                    │
   │  Caddy  → 自動 Let's Encrypt 憑證                   │
   │   <vm-ip>.sslip.io  →  localhost:8080              │
   └────────────────────────────────────────────────────┘
              ▲                              ▲
              │ HTTPS SSE                    │ HTTPS push
              │                              │
         iOS PWA (從 GitHub Pages 載入,加到主畫面)
```

成本:**$0 / 月**(只要不超過 always-free 配額)。

---

## 一、前置作業

1. 一個 GCP 專案,啟用 **billing**(免費額度仍要綁卡)
2. 在本機安裝 [gcloud CLI](https://cloud.google.com/sdk/docs/install) 並登入:
   ```bash
   gcloud auth login
   gcloud config set project <YOUR_PROJECT_ID>
   ```
3. 一支 iPhone(iOS **16.4+**, Web Push 必須)

> 為什麼選 **e2-micro / us-west1**? Always-free 條款限定 `us-west1`、`us-central1`、`us-east1` 三個區域。`us-west1` 對 Bitfinex 邊緣 CDN 的 RTT 通常最短。

---

## 二、一鍵部署(從本機執行)

```bash
git clone https://github.com/aa85192/bitfinex-lending-bot-v2.git
cd bitfinex-lending-bot-v2
git checkout claude/gcloud-realtime-monitoring-eval-EW1aX
bash infra/scripts/gcp-create-vm.sh
```

腳本會:

1. 啟用必要的 GCP API(Compute、Secret Manager)
2. 互動式建立 Secret Manager secrets(會 prompt 你輸入 Bitfinex API key / secret)
3. 建立最小權限 service account
4. 開 firewall(80 + 443)
5. 建立 e2-micro VM,startup script 自動跑 `install.sh`
6. 印出 API URL(`https://<ip>.sslip.io`)和操作說明

首次開機 + Let's Encrypt 憑證簽發約需 3-5 分鐘。

### 觀察 VM 啟動進度

```bash
gcloud compute ssh lending-bot-vm --zone=us-west1-a \
  --command='sudo tail -f /var/log/lending-bot-startup.log'
```

### 驗證 bot 正常

```bash
curl https://<vm-ip>.sslip.io/api/health
# 預期: {"ok":true,"wsPublic":true,"wsAuth":true,"lastEventAt":...}
```

---

## 三、設定 iPhone PWA + 推播

1. iPhone 用 Safari 打開原本的 webapp:
   `https://aa85192.github.io/bitfinex-lending-bot-v2/`
2. 點「分享」→「加入主畫面」(加入後**從主畫面開啟,不是 Safari**)
3. 進入後右上角點「**連線到 Bot**」
4. 填入:
   - API URL: `https://<vm-ip>.sslip.io`
   - Viewer Token: install.sh 印出的那組(或你存在 Secret Manager `viewer-token` 的值)
5. 點「**測試連線**」確認綠色 ✓,點「儲存並使用」
6. 回主畫面,右上角點「**啟用通知**」→ Safari 跳出允許推播
7. 點「測試」確認收到一則「Bot 測試通知」

**完成 ✓** Dashboard 現在透過 SSE 秒級更新,事件會直接推播到鎖屏。

---

## 四、推播觸發事件

daemon 預設會在這些情況推播:

| 事件 | 觸發條件 | Cooldown |
|---|---|---|
| `credit.opened` | 自己的 funding offer 成交為新 credit | 0(每筆都推) |
| `credit.closed` | 借款人還款,credit 關閉 | 0 |
| `market.large_trade` | 公開市場成交量 ≥ `LARGE_TRADE_MIN_AMOUNT` 且利率 ≥ `RATE_ALERT_THRESHOLD` | 30 秒 |
| `market.rate_spike` | FRR 變動 ≥ 20% | 60 秒 |
| `bot.unhealthy` | WS 失聯超過 30 秒 | 5 分鐘 |
| `bot.recovered` | WS 恢復 | 0 |

調整門檻:編輯 VM 上的 `/opt/bitfinex-lending-bot/.env`:
```ini
LARGE_TRADE_MIN_AMOUNT=50000
RATE_ALERT_THRESHOLD=0.0006
```
然後 `sudo systemctl restart bitfinex-bot`。

---

## 五、Secret Manager 操作

### 更新 Bitfinex API key

```bash
echo -n "NEW_KEY" | gcloud secrets versions add bitfinex-api-key --data-file=-
gcloud compute ssh lending-bot-vm --zone=us-west1-a \
  --command='sudo bash /opt/bitfinex-lending-bot/infra/scripts/install.sh'
```
(install.sh 會自動從 Secret Manager 抓最新版並重新啟動 bot)

### 查看所有 secrets
```bash
gcloud secrets list
```

---

## 六、運維指令

```bash
# 服務狀態
sudo systemctl status bitfinex-bot

# 即時 log
sudo journalctl -u bitfinex-bot -f

# Caddy(HTTPS 反向代理)log
sudo journalctl -u caddy -f
sudo tail -f /var/log/caddy/access.log

# 重啟
sudo systemctl restart bitfinex-bot

# 拉最新版 code + 重啟
sudo bash /opt/bitfinex-lending-bot/infra/scripts/update.sh

# 看推播訂閱數
curl -s https://<ip>.sslip.io/api/health | jq
ls -la /opt/bitfinex-lending-bot/data/push-subscriptions.json
```

---

## 七、啟用反應式交易 (Phase 4)

daemon 內建 reactive engine,跟 cron 共用同一份策略邏輯(`bot/strategy/rateCalculator.ts`)。
**預設關閉**,需手動啟用。三段式漸進:

### Step 1: 編輯策略設定
```bash
sudo nano /opt/bitfinex-lending-bot/strategy.yaml
```
跟 GitHub Actions 的 `INPUT_AUTO_RENEW_3` 同格式,直接複製過來即可。

### Step 2: 切到 dry_run,觀察 48 小時
```bash
sudo nano /opt/bitfinex-lending-bot/.env
# 改 STRATEGY_MODE=dry_run
sudo systemctl restart bitfinex-bot
```
觀察 log:
```bash
sudo journalctl -u bitfinex-bot -f | grep -i "dry_run\|engine"
```
每次 WS 事件(成交、ticker、自己 wallet/credit/offer 變動)會 debounce 1.5 秒後觸發決策計算。
log 會印「DRY_RUN would apply」搭配預期下單參數;**不會呼叫 REST**。
也會收到 `strategy.dry_run` 推播(每分鐘 cooldown,避免洗版)。

對照同時間 cron 的下單行為,若一致 → 進 Step 3。

### Step 3: 切到 live,停掉 cron
```bash
sudo nano /opt/bitfinex-lending-bot/.env
# 改 STRATEGY_MODE=live
sudo systemctl restart bitfinex-bot
```
然後到 GitHub repo:Actions → "WTKuo auto-renew-3: fUSD + fUST" → Disable workflow。

### Safety guards(全部可在 .env 調)
| 變數 | 預設 | 作用 |
|---|---|---|
| `STRATEGY_WARMUP_MS` | 60000 | 啟動 / WS 斷線重連後,60 秒內不下單(等狀態暖機) |
| `STRATEGY_MIN_INTERVAL_MS` | 30000 | 同一幣別每 30 秒最多 1 次下單 |
| `STRATEGY_MIN_RATE_CHANGE_PCT` | 1 | 利率變動 < 1% 不動(避免抖動造成的小幅頻繁改單) |
| `STRATEGY_DAILY_BUDGET` | 200 | 每幣別每 24h 最多 200 次寫入(超過 hard stop) |
| `STRATEGY_DEBOUNCE_MS` | 1500 | WS 事件爆量時的 debounce 視窗 |

任一 guard 阻擋時:
- log 印 `engine skip: <reason>`
- 推 `strategy.skipped` 事件(5 分鐘 cooldown)
- SSE 推給 dashboard

### 退役舊 cron
- daemon (live) + cron 同時跑會**搶下單**(兩者都會 cancelAll + applyAutoFunding)
- 切到 live 之後必須 disable workflow:`.github/workflows/wtkuo-auto-renew-3.yml`
- 緊急 fallback:把 STRATEGY_MODE 改回 `off`,re-enable workflow,bot 變回 cron 模式

### 保留不動的部分
- **`bin/funding-statistics-1.ts` + GitHub Pages**:歷史圖表來源,daemon 不重複做
- **Telegram secrets**:已改成沒設定就 no-op,移除/留著都可以
- **`bin/funding-auto-renew-3.ts` 檔案**:不刪除,作為 daemon 死掉時的緊急 fallback

---

## 八、Always-Free 配額守則

| 資源 | 配額 | 本架構使用 |
|---|---|---|
| e2-micro VM | 1 個,us-west/central/east 三選一 | 1 個 ✓ |
| 30 GB 標準磁碟 | 1 個 e2-micro 包含 | 30 GB ✓ |
| 1 GB egress / 月 | 不含中/澳 | 預估 < 100 MB |
| Secret Manager | 6 active secrets, 10k accesses / 月 | 4 secrets ✓ |
| Cloud Logging | 50 GB / 月 ingest | 充足 |

**注意事項**:
- 不要保留靜態 IP(沒附 VM 會收費),動態 IP 配 `sslip.io` 就好,IP 換了重跑 install.sh 即可
- 不要開 Cloud NAT / Load Balancer(不在 free tier)
- VM 必須在 us-west1 / us-central1 / us-east1
- 千萬不要升級成 e2-small 或開第二台

---

## 九、疑難排解

### iPhone 啟用通知按鈕沒反應 / 灰色
- 確認 iOS ≥ 16.4
- 確認從**主畫面**(不是 Safari)打開
- Safari 設定 → 進階 → 實驗功能 → 確認 "Push API" 已開

### `https://<ip>.sslip.io` 顯示憑證錯誤
- 等 1-2 分鐘給 Caddy 簽憑證,看 `sudo journalctl -u caddy -f`
- 如卡住,確認 firewall 允許 80 + 443:`gcloud compute firewall-rules list`

### `/api/health` 回 `wsAuth: false`
- API key 權限不足,確認有 **Margin Funding (read+write)** + **Wallets (read)**
- 看 daemon log: `sudo journalctl -u bitfinex-bot -n 100`

### VM 掛了怎麼辦
- 短期:GH Actions 每 10 分鐘的 cron 仍會跑(自動降級)
- 重啟:`gcloud compute instances reset lending-bot-vm --zone=us-west1-a`
- 重裝:在新 VM 上跑一次 install.sh,因為 .env 重新生成,push 訂閱會失效(用戶需重新訂閱)
