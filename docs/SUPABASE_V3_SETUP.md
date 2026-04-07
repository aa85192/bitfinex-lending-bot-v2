# Supabase v3 設定指南（含驗證安全）

## 🔐 安全特性

- ✅ 只允許已登入用戶訪問設定
- ✅ API Keys 存放在 GitHub Secrets（不在 Supabase）
- ✅ 用戶認證通過 Supabase Auth
- ✅ RLS 策略限制未認證用戶

---

## 第一步：在 Supabase 啟用 Auth

1. 進入 Supabase Dashboard
2. 選擇你的專案
3. 進入 **Authentication** → **Providers**
4. 確保 **Email** provider 已啟用

---

## 第二步：建立 Settings 表

在 Supabase SQL Editor 執行此 SQL：

```sql
-- 建立 settings 表（不含敏感信息）
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
  
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- 建立索引
CREATE INDEX idx_settings_user_id ON settings(user_id);

-- 啟用 RLS
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- RLS 策略：只有認證用戶才能存取
CREATE POLICY "authenticated_users_only" ON settings
  FOR ALL
  USING (auth.role() = 'authenticated');
```

---

## 第三步：設定 Supabase 環境變數

在 GitHub Secrets 添加：

```
SUPABASE_URL = https://etflkwcqzncroxhpymbk.supabase.co
SUPABASE_ANON_KEY = 你的_anon_public_key
```

在 Supabase Dashboard → Settings → API 找到這些值。

---

## 第四步：在網頁中使用

### 註冊新帳號
1. 進入 `/settings` 頁面
2. 選擇「前往註冊」
3. 輸入 email 和密碼
4. 檢查信箱並驗證（Supabase 會發驗證信）
5. 返回登入

### 登入並修改設定
1. 進入 `/settings` 頁面
2. 輸入 email 和密碼
3. 點擊登入
4. 修改放貸配置並保存

---

## 🛡️ 安全檢查清單

- [ ] Supabase Auth 已啟用
- [ ] settings 表已建立
- [ ] RLS 策略設為 `auth.role() = 'authenticated'`
- [ ] SUPABASE_ANON_KEY 已添加到 GitHub Secrets
- [ ] API Keys（Bitfinex/Telegram）存放在 GitHub Secrets，不在 Supabase

---

## 🔑 API Keys 存放位置

| 項目 | 儲存位置 | 用途 |
|------|---------|------|
| Bitfinex API Key/Secret | GitHub Secrets | 自動化腳本讀取 |
| Telegram Token/Chat ID | GitHub Secrets | 自動化腳本讀取 |
| Supabase URL | GitHub Secrets | 網頁載入 |
| Supabase Anon Key | GitHub Secrets | 網頁載入 |

---

## 📋 GitHub Secrets 需要的值

```
BITFINEX_API_KEY
BITFINEX_API_SECRET
TELEGRAM_TOKEN
TELEGRAM_CHAT_ID
SUPABASE_URL
SUPABASE_ANON_KEY
```

---

## 🧪 測試

1. **測試認證**
   - 進入 `/settings`
   - 嘗試註冊新帳號
   - 確認驗證信已發送

2. **測試 RLS**
   - 開啟瀏覽器開發者工具（F12）
   - 在 Console 中執行：
   ```javascript
   const supabaseUrl = 'https://etflkwcqzncroxhpymbk.supabase.co'
   const anonKey = 'your_anon_key'
   
   const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js')
   const supabase = createClient(supabaseUrl, anonKey)
   const { data, error } = await supabase.from('settings').select('*')
   
   // 應該會報 401 錯誤（未認證）
   console.log(error)
   ```

3. **測試登入後訪問**
   - 登入後重複上面的測試
   - 應該能成功讀取資料

---

## 📚 更多文檔

- [Supabase Auth 文檔](https://supabase.com/docs/guides/auth)
- [Supabase RLS 指南](https://supabase.com/docs/guides/auth/row-level-security)
