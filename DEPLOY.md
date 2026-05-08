# FlashForce 部署指引

## 一次性設定（首次部署）

### 1. 建立 GitHub repo 並推上 code

```bash
cd ~/Documents/speed
git init
git add .
git commit -m "init: FlashForce phase 1-3"
gh repo create flashforce --public --source=. --push
```

> 沒裝 `gh`：先到 GitHub 手動建 repo，然後 `git remote add origin <url>` + `git push -u origin main`。

### 2. Cloudflare Pages — 連 GitHub repo

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左側選單 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 選你的 GitHub 帳號 → 授權 → 選 `flashforce` repo
4. 設定 build：
   - **Framework preset**：`Next.js (Static HTML Export)`
   - **Build command**：`npm run build`
   - **Build output directory**：`out`
   - **Root directory**：留空
   - **Node version (環境變數)**：`NODE_VERSION = 22`
5. **Save and Deploy**

每次 `git push` 到 `main` 都會觸發自動 build + 部署。第一次部署完約 1–2 分鐘。

### 3. 自訂網域（可選）

CF Pages → 你的專案 → **Custom domains** → **Set up a custom domain** → 輸入 domain。
DNS 在 CF 管理會自動接好；不在 CF 的話會顯示要加哪些記錄。HTTPS 證書 CF 自動發。

---

## 自動更新流程（GitHub Actions）

兩個 workflow 已經寫好：

### `.github/workflows/scrape.yml`（每週日台灣時間 04:00 跑）
- 跑 `npm run scrape:all`
- 比對 `public/data/data.json` 有變化才 commit
- commit 後自動 push → 觸發 CF Pages 重新 build

> 預設用 `GITHUB_TOKEN`，不需要額外 secrets。

### `.github/workflows/build-check.yml`（每次 push/PR）
- 跑 `npm run build` 確保不會壞
- 把 `out/` 上傳成 artifact 方便檢查

### 手動觸發抓資料

GitHub repo → **Actions** → 選 `Weekly data scrape` → **Run workflow**。

---

## 本機開發

```bash
npm install
npm run scrape:all     # 抓所有資料來源 → public/data/data.json
npm run dev            # http://localhost:3000
npm run build          # → out/
npx serve out          # 預覽 production build
```

---

## PWA 注意

Service Worker 只在 production build (`npm run build`) 才會註冊（`NODE_ENV=production`）。本機跑 `npm run dev` 不會註冊 SW，避免快取干擾開發。

---

## 加入新資料來源

### 加新縣市的 科技執法
編輯 `scripts/scrape-tech.ts`，加一個 fetcher，回傳 `EnforcementPoint[]`。

### 加新縣市的 機動測速
編輯 `scripts/scrape-mobile.ts`，在 `SOURCES` 陣列加一筆 `{ county, url, fetcher }`。

加完後跑 `npm run scrape:all` 看輸出，commit + push 即可。

---

## 故障排除

| 症狀 | 解法 |
|---|---|
| CF Pages build 失敗，找不到 Node 22 | Settings → Environment variables 加 `NODE_VERSION=22` |
| `data.json` 抓回來是空的 | 來源網站可能改了 API；對照 `scripts/scrape*.ts` 的 URL |
| Action 跑失敗：`refusing to allow a GitHub App to create or update workflow` | repo Settings → Actions → General → Workflow permissions → 勾「Read and write permissions」|
| 地圖 marker 沒出現 | 開瀏覽器 DevTools 看 `/data/data.json` 是不是 200 + 有內容 |
