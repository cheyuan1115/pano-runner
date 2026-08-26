# pano-runner 虛擬跑步機

自架的**虛擬跑步系統**:自己抓街景全景圖磚、用自己的 WebGL 管線算圖——不用地圖 SDK、不用 iframe——變成一趟可以用語音、腳步聲或 VR 頭盔控制的第一人稱跑步。

[![Buy Me a Coffee](https://img.shields.io/badge/☕_請我喝咖啡-支持這個專案-FFDD00?style=for-the-badge)](https://buymeacoffee.com/ericchen1115)

![櫻花 demo](docs/demo.gif)

*大阪造幣局櫻花隧道,2012 年 4 月歷史街景——內建時光機軌道之一。*

## 為什麼要自己算圖

消費者版街景把你關在 90° 的視窗裡。自己抓原始圖磚、自己投影,牆就全拆了:任意視野、無接縫超廣角、三螢幕 210° 環繞、WebXR 立體、自訂轉場——同一份資料全部做得到。

這是個人研究專案,使用前請先讀〈資料來源與合理使用〉。

## 功能

- **自製 WebGL 算圖**——圖磚 → 球面 → 直線透視/圓柱/混合 Panini 投影。200°+ 連續超廣角(垂直線不彎),或傳統 3/5/7 片牆。
- **像跑步的移動**——速度來自滑桿、麥克風聽跑步機腳步聲(步頻偵測)、VR 手擺、頭部起伏、或搖桿前推。
- **語音操控**(中英文自動切換)——左轉/右轉/回頭/「跑到凱旋門」/「介紹」/結束跑步;英文模式聽 turn left / describe / run to…。
- **內建導遊**——附近景點來自維基資料(含照片),Google 語音朗讀+同步字幕。
- **AI 即時導遊**——沒有景點資料的地方,一聲「介紹」把眼前畫面+GPS 事實包傳給 Gemini 即席生成防瞎說的導覽;等待期間畫面沿原路**倒帶**,開播時剛好回到你發問的位置。
- **WebXR**——Quest 級頭盔完整立體渲染,頭盔內小地圖、字幕、搖桿轉向與前進。Quest 1 實機磨出來的。
- **多螢幕**——同機用 BroadcastChannel,跨機用 SSE:側機瀏覽器打 `/left`、`/right` 就接上,零設定。插值緩衝讓 Wi-Fi 側屏跟本機一樣順。
- **時光機**——鎖定月份(四月櫻花、十一月紅葉、二月雪景)自動切歷史街景;精選「軌道」整條重播同一年代。
- 每趟跑步可匯出 **GPX**。

![三片畫面](docs/screenshot-panels.png)

## 快速開始

```bash
node server.mjs
# 開 http://localhost:8877 → 地圖點起跑點 → 開始跑
```

需求:Node 20+、Chrome。不用 build、零相依套件。

選配(缺了也能跑,只是少功能):

| 功能 | 設定 |
|---|---|
| Google 語音導覽 | `~/.keys/mapskey`(開通 Text-to-Speech 的 Google Cloud 金鑰) |
| Gemini AI 導遊 | `~/.keys/geminikey` |
| 維基禮貌標頭 | 環境變數 `PANO_CONTACT=你的email`(Wikimedia 政策要求) |
| VR | 頭盔瀏覽器開伺服器印出的 `https://<區網IP>:8878`(`cert/` 放自簽憑證) |

## 資料來源與合理使用

- **街景影像**是免金鑰走 Google 公開圖磚端點抓的,**不在任何 Google 授權範圍內**。本專案僅供個人研究實驗,**請勿公開部署或商業使用**。需要合法基礎請改用官方 Maps JavaScript API,或改接開放授權影像(Mapillary、KartaView)。
- **景點資料**來自 Wikidata/維基百科(CC BY-SA,介面有標示出處),照片來自 Wikimedia Commons,地圖磚來自 OpenStreetMap/CARTO。
- **TTS 與 Gemini** 用你自己的金鑰、自己的額度。

使用本程式碼的方式由你自行負責。

## 支持

如果這個專案讓你的跑步機不再無聊:[請我喝杯咖啡 ☕](https://buymeacoffee.com/ericchen1115)

## 授權

程式碼 MIT(上述資料來源各依其原授權)。
