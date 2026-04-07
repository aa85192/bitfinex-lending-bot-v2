# 📋 Supabase 部署檢查清單

## ✅ 已完成
- [x] 建立 Supabase 客戶端
- [x] 建立 API Routes (`/api/settings`)
- [x] 建立設定頁面 UI (`/settings`)
- [x] 更新導航欄
- [x] 安裝依賴 (@supabase/supabase-js)
- [x] 確認 `.gitignore` 配置

## ⏳ 需要手動完成

### 1️⃣ 在 Supabase 建立表（必做）
進入 Supabase SQL Editor 執行此 SQL：

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

-- 設定 RLS
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_read" ON settings FOR SELECT USING (true);
CREATE POLICY "allow_all_insert" ON settings FOR INSERT WITH CHECK (true);
CREATE POLICY "allow_all_update" ON settings FOR UPDATE USING (true);
CREATE POLICY "allow_all_delete" ON settings FOR DELETE USING (true);
```

### 2️⃣ 配置環境變數（必做）
編輯 `webapp/.env.local`：

```env
NEXT_PUBLIC_SUPABASE_URL=https://etflkwcqzncroxhpymbk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=你的_anon_key
SUPABASE_SERVICE_KEY=你的_service_role_key
```

**獲取金鑰方式：**
1. 進入 Supabase 儀表板
2. 點擊 Settings → API
3. 複製 `Project URL` 和相應的金鑰

### 3️⃣ 測試（可選）
```bash
cd webapp
npm run dev
# 造訪 http://localhost:3000/settings
```

## 🎯 功能說明

### Web UI 設定頁面 (`/settings`)
- 📊 USD/USDT 開關和配置
- 💰 最小/最大金額設定
- 💹 利率範圍設定
- 📈 排名百分位設定
- 🔑 API 金鑰存儲

### API Routes
- `GET /api/settings` - 取得設定
- `POST /api/settings` - 更新設定

## 🔐 安全特性
- ✅ API Keys 存在 `.env.local`（不會上傳 GitHub）
- ✅ 數據存儲在 Supabase（加密）
- ✅ RLS (Row Level Security) 已啟用
- ✅ 敏感信息不會在代碼中硬編碼

## 📱 下一步（可選）

### 更新自動化腳本讀取配置
修改 `bin/funding-auto-renew-3.ts` 從 Supabase 讀取設定：

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

async function getConfig() {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .eq('user_id', 'wtkuo')
    .single()

  if (error) throw error
  return data
}
```

## 📚 相關文檔
- [SUPABASE_SETUP.md](./docs/SUPABASE_SETUP.md) - 詳細設定指南
- [Supabase 官方文檔](https://supabase.com/docs)
