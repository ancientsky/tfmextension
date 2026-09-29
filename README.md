# TimesFM 趨勢預測 Chrome Extension

在網頁上的 Highcharts 趨勢圖旁邊加一顆「📈 預測」按鈕，按下去就把圖表資料送給
Google **TimesFM 3.0**（零樣本時間序列基礎模型），並把預測中位數與 10% / 90% 分位數
直接疊回原圖。第一個支援的網站是疾管署 NIDSS（<https://nidss.cdc.gov.tw/Home/Index?op=2>）。

```
extension/   Manifest V3 擴充功能（純 JS，不需要 build）
space/       FastAPI 預測服務；可本機執行，也可原封不動部署到 Hugging Face Space（Docker SDK）
```

## 架構

```
NIDSS 頁面 (Highcharts 11)
 ├─ content/bridge.js + adapters/highcharts.js   (world: MAIN)  讀 Highcharts.charts、addSeries 畫預測
 └─ content/ui.js                               (isolated)     每張圖的按鈕與狀態，postMessage ↔ bridge
        │ chrome.runtime.sendMessage
 background.js (service worker)  ── fetch ──▶  space/app.py  (GET /health, POST /forecast)
                                                └─ TimesFM3Evaluator，啟動時載入一次
```

## 1. 啟動預測服務

### 本機（開發用）

```bash
cd space
pip install -r requirements.txt        # 已裝好 timesfm[torch] 的環境可略過
DEVICE=cpu uvicorn app:app --port 7860 # 第一次會下載 1.3 GB 權重到 ~/.cache/huggingface
curl -s localhost:7860/health
```

> GTX 10 系列以前的顯卡不被新版 PyTorch 的 CUDA kernel 支援，會回 `no kernel image is available`；
> 直接設 `DEVICE=cpu` 即可，52 點 × 7 條序列的預測在 CPU 上約 0.2 秒。

### Hugging Face Space（免費 CPU Basic 即可）

1. 到 <https://huggingface.co/new-space>，SDK 選 **Docker**，硬體 **CPU basic**。
2. 把 `space/` 內的四個檔案（`app.py`、`Dockerfile`、`requirements.txt`、`README.md`）推到該 Space repo。
3. Settings → Variables and secrets：新增 secret `API_KEY`（自訂一段亂數）。
4. Build 完成後測試：

   ```bash
   curl -s https://<user>-<space>.hf.space/health
   ```

5. 48 小時沒人用 Space 會休眠；下一次請求會自動喚醒，但要重新下載權重（1 ~ 3 分鐘）。
   擴充功能會顯示「服務喚醒中」並自動重試最多 3 分鐘。

## 2. 安裝擴充功能

1. 開 `chrome://extensions`，打開右上角「開發人員模式」。
2. 「載入未封裝項目」→ 選 `extension/` 資料夾。
3. 點工具列的擴充功能圖示（或右鍵 → 選項）設定：
   * **API 網址**：`http://localhost:7860` 或 `https://<user>-<space>.hf.space`
   * **API Key**：與 Space 的 `API_KEY` secret 相同（本機沒設就留空）
   * **預測步數**：週資料建議 4 ~ 12
   * **忽略最後 N 個觀測點**：監測資料最後幾週通報常未完整，可略過再預測
4. 開啟 NIDSS 頁面，每張圖的標題列右側會出現「預測」按鈕；預測完成後多出「還原」鈕，摘要面板會顯示在圖的下方。
5. 介面語言會跟著網頁走：NIDSS 英文版（網址含 `/en/`）自動用英文，中文版用中文。其他網站依序看 `<html lang>`、網址中的語言代碼、頁面文字的中文字比例，最後才是瀏覽器語言。設定頁的「介面語言」可強制固定為中文或英文。

## 預測前的自動處理

每張圖按下「📈 預測」時，擴充功能會先整理資料，並在圖下方的摘要面板列出處理過的項目：

| 情況 | 處理 |
|---|---|
| X 軸是年週（`YYYYWW`）、年月（`YYYYMM`）、日期或年 | 先判斷標籤種類：六位數標籤只要有後兩碼大於 12 就是年週，否則依 X 軸標題（年週 / 年月、Year-Week / Year-Month）或標籤數量判斷。再以今天為基準，**未來期間的預填 0 / null 全部略過**，**進行中的本週或本月也排除**，例如「已排除尚未結束的月份 202609」「已略過 202610 起的未來預填區段」。疫情週採週日起始、含 1 月 4 日的週為第 1 週，與 NIDSS 一致 |
| 虛線且數值固定、或名稱含「閾值 / 警戒 / 基準 / threshold / baseline」的序列 | 視為參考線，不送去預測，也不畫預測線 |
| 資料少於 32 點、或比同圖其他序列早超過 4 期就沒有資料的序列 | 略過（例如變異株圖裡早已消失的株別） |
| 選項頁「忽略最後 N 個觀測點」 | 在上述處理之後再多去掉 N 點 |

摘要面板每條序列顯示：最後觀測值、下一期中位數與 10% ~ 90% 區間、第 N 期預測、預測峰值，以及相對最後觀測值的趨勢（上升 / 下降 / 持平，以 ±5% 為界）。

## 3. 支援其他網站

* `manifest.json` 的兩組 `content_scripts.matches` 目前只列 `https://nidss.cdc.gov.tw/*`，
  要用在其他 Highcharts 網站時把網址樣式加進去（或改成 `<all_urls>`）。
* 其他圖表函式庫（ECharts、Chart.js、Plotly）需要在 `extension/content/adapters/` 新增 adapter，
  實作 `detect / list / extract / apply / revert` 五個函式並註冊到 `window.__tfmAdapters`。
* X 軸類別標籤的延伸規則在 `extension/lib/epiweek.js`：支援 `YYYYWW` 年週、日期、年月、年、數字。

## 授權注意

TimesFM 3.0 的**權重**採 *TimesFM Non-Commercial License v1.0*，只能非商業、非正式營運使用。
若要商用，把 Space 的 `MODEL_ID` 改成 `google/timesfm-2.5-200m-pytorch`（Apache-2.0）即可，API 不用改。
