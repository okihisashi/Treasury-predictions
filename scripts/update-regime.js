// Regime (冬/夏) detector — writes predictions/regime.json
// 6 indicators, each returns { winter: true/false } or ok:false if fetch failed.
// Confidence = winterCount / validCount.

// ===== Manual-update constants (check quarterly) =====
const MSTR_BTC_HOLDINGS = 843706;      // 2026-06-01 8-K
const MSTR_SHARES_OUTSTANDING = 300e6; // approx A+B shares; update from latest 10-Q/8-K
// =====================================================

const UA = { headers: { 'User-Agent': 'treasury-regime-bot' } };

async function j(url, opts = {}) {
  const r = await fetch(url, { ...UA, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// 1) BTC price vs 200D MA (CoinGecko)
async function indMa200() {
  const d = await j('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=200&interval=daily');
  const closes = d.prices.map(p => p[1]);
  const ma = closes.reduce((a, b) => a + b, 0) / closes.length;
  const price = closes[closes.length - 1];
  return {
    id: 'ma200', name: 'BTC vs 200日MA',
    value: `$${Math.round(price).toLocaleString()} vs MA $${Math.round(ma).toLocaleString()}`,
    winter: price < ma, ok: true
  };
}

// 2) Fear & Greed (Alternative.me)
async function indFng() {
  const d = await j('https://api.alternative.me/fng/?limit=1');
  const v = parseInt(d.data[0].value, 10);
  return { id: 'fng', name: 'Fear & Greed', value: `${v} (${d.data[0].value_classification})`, winter: v < 30, ok: true };
}

// 3) BTC Funding Rate (OKX perp; Binance blocks US runners)
async function indFunding() {
  const d = await j('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP');
  const rate = parseFloat(d.data[0].fundingRate); // per 8h, e.g. 0.0001 = 0.01%
  return {
    id: 'funding', name: 'BTC Funding Rate',
    value: `${(rate * 100).toFixed(4)}% / 8h`,
    winter: rate < 0.0001, ok: true
  };
}

// 4) MSTR mNAV = market cap / (BTC holdings × BTC price)
async function indMnav() {
  const [mstr, btc] = await Promise.all([
    j('https://query1.finance.yahoo.com/v8/finance/chart/MSTR?interval=1d&range=1d'),
    j('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')
  ]);
  const px = mstr.chart.result[0].meta.regularMarketPrice;
  const mcap = px * MSTR_SHARES_OUTSTANDING;
  const nav = MSTR_BTC_HOLDINGS * btc.bitcoin.usd;
  const mnav = mcap / nav;
  return { id: 'mnav', name: 'MSTR mNAV', value: `${mnav.toFixed(2)}x`, winter: mnav < 1.5, ok: true };
}

// 5) Stablecoin total mcap vs 30 days ago (DefiLlama)
async function indStable() {
  const d = await j('https://stablecoins.llama.fi/stablecoincharts/all');
  const arr = d.map(x => x.totalCirculatingUSD?.peggedUSD ?? 0).filter(v => v > 0);
  const now = arr[arr.length - 1];
  const prev = arr[Math.max(0, arr.length - 31)];
  const chg = (now / prev - 1) * 100;
  return {
    id: 'stable', name: 'Stablecoin 時価総額',
    value: `$${(now / 1e9).toFixed(0)}B (30d ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`,
    winter: chg < 0, ok: true
  };
}

// 6) BTC ETF net flows — Farside scrape (best effort, fragile)
async function indEtf() {
  const r = await fetch('https://farside.co.uk/btc/', UA);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  // Grab "Total" column numbers from last rows; fallback heuristic
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const totals = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
    if (cells.length > 3 && /^\(?-?[\d,.]+\)?$/.test(cells[cells.length - 1] || '')) {
      let t = cells[cells.length - 1].replace(/,/g, '');
      const neg = /^\(.*\)$/.test(t);
      t = parseFloat(t.replace(/[()]/g, ''));
      if (!isNaN(t)) totals.push(neg ? -t : t);
    }
  }
  if (totals.length < 5) throw new Error('parse failed');
  const last5 = totals.slice(-5);
  const avg = last5.reduce((a, b) => a + b, 0) / 5;
  return {
    id: 'etf', name: 'ETF 純フロー(5日平均)',
    value: `${avg >= 0 ? '+' : ''}$${avg.toFixed(0)}M/日`,
    winter: avg < 0, ok: true
  };
}

async function main() {
  const fns = [indMa200, indFng, indFunding, indMnav, indStable, indEtf];
  const indicators = [];
  for (const fn of fns) {
    try {
      indicators.push(await fn());
    } catch (e) {
      const stubNames = { indMa200: ['ma200', 'BTC vs 200日MA'], indFng: ['fng', 'Fear & Greed'], indFunding: ['funding', 'BTC Funding Rate'], indMnav: ['mnav', 'MSTR mNAV'], indStable: ['stable', 'Stablecoin 時価総額'], indEtf: ['etf', 'ETF 純フロー(5日平均)'] };
      const [id, name] = stubNames[fn.name];
      indicators.push({ id, name, value: `取得失敗 (${e.message.slice(0, 60)})`, winter: null, ok: false });
      console.warn(`${name}: ${e.message}`);
    }
  }

  const valid = indicators.filter(i => i.ok);
  const winterCount = valid.filter(i => i.winter).length;
  const validCount = valid.length;
  const confidence = validCount ? Math.round(winterCount / validCount * 100) : null;

  // Regime mapping (scaled to valid count via ratio of the 6-indicator design)
  // winter>=4 → 冬 / ==3 → 夏L1 / 1-2 → 夏L2 / 0 → 夏L3   (basis: 6 valid)
  const scaled = validCount ? winterCount * 6 / validCount : 6;
  let regime, recommended;
  if (scaled >= 4)      { regime = '冬';   recommended = '冬:オンチェーン15% / Slash4% / Apyx81%'; }
  else if (scaled >= 3) { regime = '夏L1'; recommended = '夏L1:オンチェーン50% / Slash4% / Apyx46%'; }
  else if (scaled >= 1) { regime = '夏L2'; recommended = '夏L2:オンチェーン65% / Slash4% / Apyx31%'; }
  else                  { regime = '夏L3'; recommended = '夏L3:オンチェーン80% / Slash4% / Apyx16%'; }

  const out = {
    updated_at: new Date().toISOString(),
    indicators,
    winter_count: winterCount,
    valid_count: validCount,
    confidence_pct: confidence,
    regime, recommended
  };

  const fs = await import('fs');
  fs.mkdirSync('predictions', { recursive: true });
  fs.writeFileSync('predictions/regime.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
