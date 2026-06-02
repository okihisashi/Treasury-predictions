// scripts/test-method-b.js
// Verifies computeBetaMethodB algorithm using known mock data
// (matches the screenshot the user provided)
//
// Run: node scripts/test-method-b.js

import { strict as assert } from 'assert';

// Replicate the algorithm inline (importing would require export refactoring)
const UPSIDE_CAP_RATIO   = 1.10;
const DOWNSIDE_CAP_RATIO = 0.75;

function computeBetaMethodB(markets, currentPrice, monthsToResolution) {
  const ups = markets.filter(m => m.direction === 'up')
    .sort((a, b) => b.target_price - a.target_price);
  const downs = markets.filter(m => m.direction === 'down')
    .sort((a, b) => a.target_price - b.target_price);

  const zones = [];

  if (ups.length > 0) {
    zones.push({
      range: `>$${ups[0].target_price}`,
      probability: ups[0].yes_probability,
      representative: ups[0].target_price * UPSIDE_CAP_RATIO,
      note: `cap × ${UPSIDE_CAP_RATIO}`
    });
    for (let i = 1; i < ups.length; i++) {
      zones.push({
        range: `$${ups[i].target_price}-$${ups[i-1].target_price}`,
        probability: Math.max(0, ups[i].yes_probability - ups[i-1].yes_probability),
        representative: (ups[i].target_price + ups[i-1].target_price) / 2,
        note: 'midpoint'
      });
    }
  }

  const lowestUpProb     = ups.length   > 0 ? ups[ups.length - 1].yes_probability     : 0;
  const highestDownProb  = downs.length > 0 ? downs[downs.length - 1].yes_probability : 0;
  const middleProb       = Math.max(0, 1 - lowestUpProb - highestDownProb);
  const middleLowerBound = downs.length > 0 ? downs[downs.length - 1].target_price : currentPrice * 0.5;
  const middleUpperBound = ups.length   > 0 ? ups[ups.length - 1].target_price     : currentPrice * 2;

  zones.push({
    range: `$${middleLowerBound}-$${middleUpperBound}`,
    probability: middleProb,
    representative: (middleLowerBound + middleUpperBound) / 2,
    note: 'midpoint (status quo zone)'
  });

  if (downs.length > 0) {
    for (let i = downs.length - 1; i > 0; i--) {
      zones.push({
        range: `$${downs[i-1].target_price}-$${downs[i].target_price}`,
        probability: Math.max(0, downs[i].yes_probability - downs[i-1].yes_probability),
        representative: (downs[i-1].target_price + downs[i].target_price) / 2,
        note: 'midpoint'
      });
    }
    zones.push({
      range: `<$${downs[0].target_price}`,
      probability: downs[0].yes_probability,
      representative: downs[0].target_price * DOWNSIDE_CAP_RATIO,
      note: `cap × ${DOWNSIDE_CAP_RATIO}`
    });
  }

  const expectedPrice = zones.reduce((s, z) => s + z.probability * z.representative, 0);
  const periodReturn  = (expectedPrice / currentPrice) - 1;
  const betaAnnualized = periodReturn * (12 / monthsToResolution);

  return { zones, expectedPrice, periodReturn, betaAnnualized };
}

// ============= Test ============================
console.log('Test: HYPE from user screenshot');
console.log('  ↑$100 @ 58%, ↑$80 @ 83%, ↓$20 @ 15%, ↓$16 @ 9%');
console.log('  Spot $40, 7 months to resolution');
console.log('  Expected: E[price] ≈ $89.46, β ≈ +212%\n');

const markets = [
  { question: 'Will Hyperliquid reach $100 by December 31, 2026?', target_price: 100, yes_probability: 0.58, direction: 'up' },
  { question: 'Will Hyperliquid reach $80 by December 31, 2026?',  target_price: 80,  yes_probability: 0.83, direction: 'up' },
  { question: 'Will Hyperliquid dip to $20 by December 31, 2026?', target_price: 20,  yes_probability: 0.15, direction: 'down' },
  { question: 'Will Hyperliquid dip to $16 by December 31, 2026?', target_price: 16,  yes_probability: 0.09, direction: 'down' }
];

const result = computeBetaMethodB(markets, 40, 7);

console.log('  Zone decomposition:');
result.zones.forEach(z => {
  console.log(`    ${z.range.padEnd(12)} prob ${(z.probability*100).toFixed(1).padStart(5)}%  rep $${z.representative.toFixed(2).padStart(7)}  (${z.note})`);
});
console.log(`\n  E[price]:  $${result.expectedPrice.toFixed(2)}`);
console.log(`  Period:    ${(result.periodReturn * 100).toFixed(1)}%`);
console.log(`  β (year):  ${(result.betaAnnualized * 100).toFixed(1)}%`);

// Assertions
const totalProb = result.zones.reduce((s, z) => s + z.probability, 0);
assert.ok(Math.abs(totalProb - 1.0) < 0.0001, `Probabilities should sum to 1.0, got ${totalProb}`);
console.log(`\n✓ Probabilities sum to ${totalProb.toFixed(4)}`);

assert.ok(Math.abs(result.expectedPrice - 89.46) < 0.01, `E[price] should be ~89.46, got ${result.expectedPrice}`);
console.log(`✓ E[price] within tolerance`);

assert.ok(Math.abs(result.betaAnnualized * 100 - 212) < 1, `β should be ~212%, got ${result.betaAnnualized * 100}`);
console.log(`✓ β within tolerance`);

console.log('\n✅ All assertions passed.');
