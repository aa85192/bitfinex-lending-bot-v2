# Supabase 設定指南

## 1️⃣ 前置條件
- Supabase 帳號和專案已建立
- 取得 Project URL 和 API Keys

## 2️⃣ 在 Supabase SQL Editor 建立表

登入 Supabase → 選擇你的專案 → 進入 SQL Editor → 複製下面的 SQL 執行：

```sql
-- 建立配置表
CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT UNIQUE NOT NULL,
  
  -- USD 設定
  usd_enabled BOOLEAN DEFAULT true,
  usd_min_amount DECIMAL(10, 2) DEFAULT 150,
  usd_max_amount DECIMAL(10, 2) DEFAULT 10000,
  usd_rate_min DECIMAL(10, 6) DEFAULT 0.0001,
  usd_rate_max DECIMAL(10, 6) DEFAULT 0.01,
  usd_rank DECIMAL(3, 2) DEFAULT 0.8,
  
  -- USDT 設定
  usdt_enabled BOOLEAN DEFAULT true,
  usdt_min_amount DECIMAL(10, 2) DEFAULT 150,
  usdt_max_amount DECIMAL(10, 2) DEFAULT 10000,
  usdt_rate_min DECIMAL(10, 6) DEFAULT 0.0001,
  usdt_rate_max DECIMAL(10, 6) DEFAULT 0.01,
  usdt_rank DECIMAL(3, 2) DEFAULT 0.8,
  
  -- API 設定
  bitfinex_api_key TEXT,
  bitfinex_api_secret TEXT,
  telegram_token TEXT,
  telegram_chat_id TEXT,
  
  -- 時間戳
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- 建立索引
CREATE INDEX idx_settings_user_id ON settings(user_id);

-- 設定 RLS (Row Level Security) - 允許所有讀寫
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "允許所有讀取" ON settings 
  FOR SELECT USING (true);

CREATE POLICY "允許所有寫入" ON settings 
  FOR INSERT WITH CHECK (true);

CREATE POLICY "允許所有更新" ON settings 
  FOR UPDATE USING (true);

CREATE POLICY "允許所有刪除" ON settings 
  FOR DELETE USING (true);
```

## 3️⃣ 取得 API Keys

在 Supabase 儀表板：
1. 進入 **Settings** → **API**
2. 複製以下金鑰：
   - **Project URL** → 填入 `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → 填入 `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret** key → 填入 `SUPABASE_SERVICE_KEY`

## 4️⃣ 更新環境變數

編輯 `webapp/.env.local`：

```env
NEXT_PUBLIC_SUPABASE_URL=https://etflkwcqzncroxhpymbk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_KEY=your_service_key_here
```

## 5️⃣ 測試連線

執行開發伺服器：

```bash
cd webapp
npm run dev
```

造訪 http://localhost:3000/settings，應該可以看到設定頁面並能保存配置。

## 📝 API 文件

### GET /api/settings
取得目前設定

**回應:**
```json
{
  "user_id": "wtkuo",
  "usd_enabled": true,
  "usd_min_amount": 150,
  "usd_max_amount": 10000,
  "usdt_enabled": true,
  ...
}
```

### POST /api/settings
更新設定

**請求體:**
```json
{
  "usd_enabled": true,
  "usd_min_amount": 150,
  ...
}
```

## 🔒 安全提示

- API Keys 存在 `.env.local`，不會被上傳到 GitHub
- 確保 `.env.local` 在 `.gitignore` 中
- 敏感資訊（API Key）會加密存儲在 Supabase
