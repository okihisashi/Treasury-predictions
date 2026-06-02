// scripts/smoke-test.js
// Quick connectivity check for Polymarket Gamma API + CoinGecko.
// Run before deploying GitHub Action.
//
//   node scripts/smoke-test.js

const POLYMARKET = 'https://gamma-api.polymarket.com/events?slug=what-price-will-hyperliquid-hit-before-2027';
const COINGECKO  = 'https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd';

async function check(name, url) {
  process.stdout.write(`Checking ${name}... `);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'smoke-test/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    console.log(`OK (${JSON.stringify(data).length} bytes)`);
    return data;
  } catch (e) {
    console.log(`❌ ${e.message}`);
    return null;
  }
}

(async () => {
  const pm = await check('Polymarket', POLYMARKET);
  const cg = await check('CoinGecko',  COINGECKO);

  if (pm && Array.isArray(pm) && pm.length > 0) {
    const event = pm[0];
    console.log(`\nPolymarket event: "${event.title}"`);
    console.log(`Markets: ${event.markets?.length || 0}`);
    (event.markets || []).slice(0, 6).forEach(m => {
      let yes = 'N/A';
      try {
        const arr = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        yes = `${(parseFloat(arr?.[0] || 0) * 100).toFixed(0)}%`;
      } catch (e) {}
      console.log(`  - "${m.question}" Yes=${yes}`);
    });
  }

  if (cg && cg.hyperliquid?.usd) {
    console.log(`\nHYPE spot: $${cg.hyperliquid.usd}`);
  }

  if (pm && cg) {
    console.log('\n✅ All endpoints reachable. Safe to run main updater:');
    console.log('   node scripts/update-hype-beta.js --dry-run');
  } else {
    console.log('\n❌ One or more endpoints failed. Check network / proxy / firewall.');
    process.exit(1);
  }
})();
