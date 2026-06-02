# Treasury Predictions — Auto-Updater

Polymarket から HYPE 予測市場データを取得 → Method B で β を計算 → `predictions/hype.json` に書き出し。
GitHub Action で 1 日 1 回自動実行。

## 構成

```
treasury-predictions/
├── scripts/
│   ├── update-hype-beta.js     ← 本体(取得 & 計算)
│   ├── smoke-test.js           ← 接続確認テスト
│   └── test-method-b.js        ← 算出ロジックのユニットテスト
├── .github/workflows/
│   └── update-predictions.yml  ← GitHub Action(毎日 00:15 UTC)
├── predictions/
│   └── hype.json               ← 自動生成
├── package.json
└── README.md
```

---

## 完全セットアップ手順(順番通りに実行)

### Step 1 — ローカル動作確認(GitHub に push する前)

Node 20+ がインストール済みであること(`node -v` で確認)。
このディレクトリで:

```bash
# (1) 接続テスト
npm run smoke
# → Polymarket と CoinGecko が両方 OK か確認

# (2) アルゴリズムの単体テスト
npm test
# → Method B が想定通り動くか(モックデータで検証)

# (3) 本番 fetch ロジックをドライラン(ファイル書き込みなし)
npm run dry-run
# → 実際の API レスポンスから β を計算、出力だけ確認

# (4) raw レスポンスもダンプ
npm run debug
# → predictions/_debug_polymarket_raw.json に生 JSON 保存(構造確認用)
```

**ここまですべて成功する** = ロジックも疎通も OK。Step 2 へ。

### Step 2 — GitHub リポジトリ作成

1. https://github.com/new で **public** リポジトリを作成
   - 名前例: `treasury-predictions`
   - private だと外部から JSON を fetch できないので必ず public

2. ローカルから push:
```bash
cd treasury-predictions
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/treasury-predictions.git
git push -u origin main
```

### Step 3 — GitHub Actions の権限設定

リポジトリページ → **Settings** → **Actions** → **General**:
- **Actions permissions**: `Allow all actions and reusable workflows`
- **Workflow permissions**: `Read and write permissions` ← 必須
- → Save

### Step 4 — 手動で初回実行(動作確認)

リポジトリの **Actions** タブを開く → 左サイドバーから `Update HYPE β from Polymarket` を選択 → 右上の **Run workflow** ボタン → main ブランチを選んで実行

1〜2 分で完了 → `predictions/hype.json` が自動コミットされている

### Step 5 — JSON URL を取得

リポジトリの `predictions/hype.json` を開く → **Raw** ボタンの URL をコピー。
形式は以下のどちらか:

**Option A: GitHub raw**(更新が速く反映、CORS OK)
```
https://raw.githubusercontent.com/<USER>/treasury-predictions/main/predictions/hype.json
```

**Option B: jsDelivr CDN**(高速 / 12時間キャッシュ)
```
https://cdn.jsdelivr.net/gh/<USER>/treasury-predictions@main/predictions/hype.json
```

### Step 6 — ダッシュボードに設定

`treasury_dashboard_revM.html` をテキストエディタで開く → 検索で `const PREDICTIONS_URL` を探す → URL を埋め込む:

```javascript
const PREDICTIONS_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/treasury-predictions/main/predictions/hype.json';
```

保存してブラウザで開き直すと、ページロード時に自動で β が更新される。
編集パネル右上の「↻ β 自動更新」ボタンで手動更新も可能。

---

## Method B の算出方式

```
E[price] = Σ (zone_probability × zone_representative)
  ※ 最上位ゾーン (>highest target) は target × 1.10 にキャップ(上方裾を保守化)
  ※ 最下位ゾーン (<lowest target) は target × 0.75 にキャップ(下方裾を対称的に控えめ)

β (年率) = (E[price] / current_price - 1) × (12 / months_to_resolution)
  ※ 線形換算(複利でなく保守的)
```

### 検証済み出力例(2026年5月時点・スクショ準拠)

```
入力:
  ↑$100 @ 58%, ↑$80 @ 83%, ↓$20 @ 15%, ↓$16 @ 9%
  Spot: $40, Months to resolution: 7

ゾーン分解:
  >$100         prob 58.0%  rep $110.00  (cap × 1.10)
  $80-$100      prob 25.0%  rep $ 90.00  (midpoint)
  $20-$80       prob  2.0%  rep $ 50.00  (status quo)
  $16-$20       prob  6.0%  rep $ 18.00  (midpoint)
  <$16          prob  9.0%  rep $ 12.00  (cap × 0.75)

E[price]: $89.46
Period return: +123.7%
β (annualized): +212.0%
```

---

## カスタマイズ

`scripts/update-hype-beta.js` の冒頭定数:

| 定数 | 既定値 | 意味 |
|------|--------|------|
| `EVENT_SLUG` | `what-price-will-hyperliquid-hit-before-2027` | Polymarket のイベントスラッグ |
| `RESOLUTION_DATE` | `2027-01-01T00:00:00Z` | 残月数計算の基準日 |
| `HYPE_COINGECKO_ID` | `hyperliquid` | CoinGecko の通貨 ID |
| `UPSIDE_CAP_RATIO` | `1.10` | 上方ゾーン代表値の係数(↑10%) |
| `DOWNSIDE_CAP_RATIO` | `0.75` | 下方ゾーン代表値の係数(↓25%) |

イベントが終了して 2028 用のイベントに切り替わったら、`EVENT_SLUG` と `RESOLUTION_DATE` を更新するだけ。

---

## トラブルシュート

| 症状 | 対処 |
|------|------|
| `npm run smoke` で Polymarket がエラー | 一時的に API down、再試行 |
| `npm run smoke` で CoinGecko がエラー | レート制限の可能性、数分待って再試行 |
| direction 判定が外れている | `npm run debug` で raw JSON を見て、direction キーワードを `extractDirection()` に追加 |
| Action 失敗 `permission denied` | Settings → Actions → Workflow permissions = Read and write |
| ダッシュボードに β が反映しない | DevTools console でエラー確認。raw URL に直接アクセスして JSON が見えるか |
| jsDelivr が古いまま | `?v=${Date.now()}` を URL 末尾につける(キャッシュバスト) |
