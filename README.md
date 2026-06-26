# Price Change

這是一個 GitHub Pages 可用的靜態 HTML 投資總表。

- 入口檔案：`index.html`
- 進入密碼：由前端 hash 驗證
- 資料來源：本機 Portfolio Tracker 在 2026-06-26 匯出的快照
- 股價更新：GitHub Actions 每 5 分鐘更新 `quotes.json`，網頁也會每 5 分鐘自動刷新並保留手動刷新鍵

注意：這是純前端頁面，適合防止一般誤入；若 repo 是公開的，前端密碼不能視為真正機密保護。
