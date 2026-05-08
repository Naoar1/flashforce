# FlashForce

全台科技執法・固定測速・機動測速地圖。手繪風 icon、即時可視化、靜態部署。

## 技術棧

- Next.js (App Router) + 靜態匯出 (`output: "export"`)
- Tailwind CSS
- Leaflet + OpenStreetMap (免 API key)
- Leaflet.markercluster (大量 marker 自動分群)
- 部署：Cloudflare Pages
- 自動更新：GitHub Actions cron (每週一次)

## 開發

```bash
npm install
npm run scrape        # 抓取最新測速資料 → public/data/data.json
npm run dev           # http://localhost:3000
npm run build         # 產出靜態檔案到 ./out
```

## 資料來源

| 類別 | 來源 | 授權 |
|---|---|---|
| 固定式測速 | [政府資料開放平台 — 全國固定式測速執法設置點 (警政署)](https://data.gov.tw/dataset/7320) | 政府資料開放授權條款 v1 |
| 科技執法 | 各縣市警察局公開資訊 (Phase 2 加入) | 各機關自訂 |
| 機動測速 | 各縣市警察局公告 (Phase 2 加入) | 各機關自訂 |

每筆資料保留：
- `sourceUpdatedAt` — 資料來源最後更新日
- `fetchedAt` — FlashForce 抓取時間

兩個時間都會顯示在地圖底部。

## 階段規劃

- **Phase 1 (本提交)** — 專案 scaffold、固定測速資料、基本 Leaflet 地圖、手繪 icon、篩選器、資料時間/免責聲明
- **Phase 2** — 科技執法、機動測速資料；PWA；地名搜尋；定位到附近
- **Phase 3** — GitHub Actions 週更 cron + Cloudflare Pages 部署
- **Phase 4 (待討論)** — 即時定位 + 接近告警 (push notification + vibration)

## 免責

資料僅供參考，實際取締請依現場標示與員警指揮為準。
