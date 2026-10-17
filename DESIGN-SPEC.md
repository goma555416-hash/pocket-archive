# Pocket Archive — 視覺設計規格 v0.5（目前選定）

## 確認與範圍
- **品牌名稱**：Pocket Archive（英文為主）。GitHub 儲存庫名稱可繼續使用 `pocket-archive`。
- **視覺方向**：A · Minimal & Modern；安靜、明確的資訊層級、乾淨、低裝飾。
- **主配色**：B · Butter Yellow × Periwinkle（奶油黃 × 長春花藍），柔和對比；允許少量淡紫霧感。
- **App Icon**：先採用 **A3**，實心書籤（不是描邊）、中心單一符號、微妙漸層底色、少立體感。使用者明確表示 icon 不再調整。
- **主要平台**：iPhone / iOS Safari、iOS 主畫面 Web App；Windows 瀏覽器。不要安排 Android 專用工作。
- **用語**：品牌英文、功能繁體中文，編輯感＋清楚的檔案系統＋適量私人收藏感；仍可在體驗測試後微調區塊名稱。

## 參考色票（非強制把所有元件都染上色）
| Role | Hex | Notes |
| --- | --- | --- |
| Butter Yellow | `#FFF2C9` | 亮色局部與漸層 |
| Periwinkle | `#CBD7EF` | 柔和藍紫、底色與卡片 |
| Lavender Mist | `#F0E5FF` | 輕微霧感，不獨立成主色 |
| Canvas | `#FBFAF7` | 介面底色 |
| Text | `#29344B` | 主要文字 |
| Accessible action | `#52669A` | 主要按鈕/連結，避免淡色上白字對比不足 |

## 目前已套用到原型
- `theme.css`：配色覆蓋層，保持 MVP 現有 layout 與互動，不是全新 UI 重構。
- `icons/icon.svg`：**可編輯 SVG 原始設計**，`icon-180.png`（Apple touch）、`icon-192.png`、`icon-512.png`、`icon-1024.png`；實心書籤與柔和漸層。
- `index.html`：品牌角標更新、Apple touch icon 設定與主題樣式載入。
- `manifest.webmanifest`、`sw.js`：PWA 配色與新版資產快取。

## 設計約束
1. 先確保 iPhone 小畫面可讀、主操作易觸、深色文字易辨，不要因淡彩犧牲對比。
2. 無需做立體紙片、檔案盒、厚重陰影、玻璃擬態等複雜象徵。
3. 表單、排序與備份功能應保持清楚；視覺調整不得造成資料遺失。
4. 跨裝置同步、圖片附件和 AI 整理屬於未來功能，視覺素材不得暗示它們已完成。
5. 圖示採用極簡概念重製，不是直接提取 AI 參考板中的點陣圖。

## 待驗收
- 真正的 iPhone Safari 主畫面安裝及 Icon 尺寸 / 裁切。
- Windows 瀏覽器與 iPhone 實機的色彩觀感、文字對比與長期使用舒適度。
