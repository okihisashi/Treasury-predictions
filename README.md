# Treasury Predictions — Auto-Updater (HYPE + SOL)

Polymarket から HYPE および SOL の予測市場データを取得 → Method B で β を計算 → `predictions/{hype,sol}.json` に書き出し。
GitHub Action で 1 日 1 回自動実行。

## 構成

```
treasury-predictions/
├── scripts/
│   ├── update-hype-beta.js     ← HYPE 取得 & 計算
│   ├── update-sol-beta.js      ← SOL 取得 & 計算
│   ├── smoke-test.js           ← 接続確認テスト
│   └── test-method-b.js        ← 算出ロジックのユニットテスト
├── .github/workflows/
│   └── update-predictions.yml  ← GitHub Action(毎日 00:15 UTC、両方更新)
├── predictions/
│   ├── hype.json               ← 自動生成
│   └── sol.json                ← 自動生成
├── package.json
└── README.md
```

## ローカル動作確認

```bash
npm run smoke           # API 接続テスト
npm test                # Method B 単体テスト
npm run dry-run:hype    # HYPE 計算をテスト(書き込みなし)
npm run dry-run:sol     # SOL 計算をテスト(書き込みなし)
npm run update          # 両方を本番実行(predictions/*.json に書き込み)
```

## デプロイ後の更新方法

GitHub Action が毎日自動実行する。手動実行は **Actions タブ → Update HYPE & SOL β → Run workflow**。

## ダッシュボードへの埋め込み

`treasury_dashboard_revP.html` の冒頭にある `PREDICTIONS` オブジェクトに JSON URL を設定:

```javascript
const PREDICTIONS = {
  hype: 'https://raw.githubusercontent.com/YOUR_USERNAME/treasury-predictions/main/predictions/hype.json',
  sol:  'https://raw.githubusercontent.com/YOUR_USERNAME/treasury-predictions/main/predictions/sol.json'
};
```

ページロード時に両方の β を取得し、それぞれの入力欄に自動投入。

## Method B(両アセット共通)

```
E[price] = Σ (zone_probability × zone_representative)
  ※ 最上位ゾーン (>highest target) は target × 1.10 にキャップ
  ※ 最下位ゾーン (<lowest target) は target × 0.75 にキャップ

β (年率) = (E[price] / current_price - 1) × (12 / months_to_resolution)
  ※ 線形換算(複利でなく保守的)
```

## カスタマイズ

両スクリプトの冒頭定数で挙動を調整できる(`EVENT_SLUG`, `RESOLUTION_DATE`, `UPSIDE_CAP_RATIO`, `DOWNSIDE_CAP_RATIO`)。
