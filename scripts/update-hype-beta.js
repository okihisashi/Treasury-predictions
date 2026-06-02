// scripts/update-hype-beta.js
// Fetches HYPE Polymarket event + CoinGecko spot price,
// computes β (Method B), writes to predictions/hype.json
//
// Run locally:  node scripts/update-hype-beta.js
// Run in CI:    automatic via .github/workflows/update-predictions.yml

import fs from 'fs/promises';
import path from 'path';

// ====================== Config ======================
const POLYMARKET_API    = 'https://gamma-api.polymarket.com';
const EVENT_SLUG        = 'what-price-will-hyperliquid-hit-before-2027';
const COINGECKO_API     = 'https://api.coingecko.com/api/v3';
const HYPE_COINGECKO_ID = 'hyperliquid';
const RESOLUTION_DATE   = new Date('2027-01-01T00:00:00Z');

// Method B caps
const UPSIDE_CAP_RATIO   = 1.10;  // top zone rep   = highest target × 1.10
const DOWNSIDE_CAP_RATIO = 0.75;  // bottom zone rep = lowest target × 0.75

// ====================== Helpers ======================
async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'treasury-dashboard/1.0' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

function extractTargetPrice(question) {
  // "Will Hyperliquid hit $100 before 2027?" → 100
  const match = question.match(/\$([0-9.]+)/);
  return match ? parseFloat(match[1]) : null;
}

function extractDirection(question) {
  const lower = question.toLowerCase();
  // Down keywords: dip, fall, drop, decline, below, under, crash, sink, plunge, plummet, low
  // (confirmed real Polymarket text: "Will Hyperliquid dip to $16 by December 31, 2026?")
  if (/\b(dip|fall|drop|decline|below|under|crash|sink|plunge|plummet|low)\b/.test(lower)) {
    return 'down';
  }
  // Default up: hit, reach, exceed, above, surge
  return 'up';
}

function parseProbability(market) {
  // Polymarket returns outcomePrices in multiple possible forms:
  //   string: '["0.58","0.42"]'
  //   array:  ["0.58", "0.42"]  (already parsed by some SDKs)
  //   array of numbers: [0.58, 0.42]
  // Convention: [yes_price, no_price] -- both should sum to ~1.0
  try {
    let prices = market.outcomePrices;
    if (typeof prices === 'string') {
      prices = JSON.parse(prices);
    }
    if (Array.isArray(prices) && prices.length >= 1) {
      const yes = parseFloat(prices[0]);
      if (!isNaN(yes) && yes >= 0 && yes <= 1) return yes;
    }
  } catch (e) {
    console.warn(`  parseProbability: outcomePrices parse failed for "${market.question}": ${e.message}`);
  }
  // Fallback: lastTradePrice (sometimes available, sometimes not)
  if (market.lastTradePrice != null) {
    const v = parseFloat(market.lastTradePrice);
    if (!isNaN(v)) return v;
  }
  // Fallback: midpoint of best bid / best ask
  if (market.bestBid != null && market.bestAsk != null) {
    const b = parseFloat(market.bestBid);
    const a = parseFloat(market.bestAsk);
    if (!isNaN(b) && !isNaN(a)) return (b + a) / 2;
  }
  console.warn(`  parseProbability: no price found for "${market.question}", returning 0`);
  return 0;
}

// ====================== Fetchers ======================
async function getHypeSpotPrice() {
  const url = `${COINGECKO_API}/simple/price?ids=${HYPE_COINGECKO_ID}&vs_currencies=usd`;
  const data = await fetchJSON(url);
  const price = data?.[HYPE_COINGECKO_ID]?.usd;
  if (!price) throw new Error('Could not fetch HYPE spot from CoinGecko');
  return price;
}

// ====================== Method B β ======================
function computeBetaMethodB(markets, currentPrice, monthsToResolution) {
  // ups sorted descending (100, 80), downs sorted ascending (16, 20)
  const ups = markets.filter(m => m.direction === 'up')
    .sort((a, b) => b.target_price - a.target_price);
  const downs = markets.filter(m => m.direction === 'down')
    .sort((a, b) => a.target_price - b.target_price);

  const zones = [];

  // Top zone (above highest up target) — CAPPED
  if (ups.length > 0) {
    zones.push({
      range: `>$${ups[0].target_price}`,
      probability: ups[0].yes_probability,
      representative: ups[0].target_price * UPSIDE_CAP_RATIO,
      note: `cap × ${UPSIDE_CAP_RATIO}`
    });
    // Between up targets
    for (let i = 1; i < ups.length; i++) {
      zones.push({
        range: `$${ups[i].target_price}-$${ups[i-1].target_price}`,
        probability: Math.max(0, ups[i].yes_probability - ups[i-1].yes_probability),
        representative: (ups[i].target_price + ups[i-1].target_price) / 2,
        note: 'midpoint'
      });
    }
  }

  // Middle (status quo) zone
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

  // Between down targets
  if (downs.length > 0) {
    for (let i = downs.length - 1; i > 0; i--) {
      zones.push({
        range: `$${downs[i-1].target_price}-$${downs[i].target_price}`,
        probability: Math.max(0, downs[i].yes_probability - downs[i-1].yes_probability),
        representative: (downs[i-1].target_price + downs[i].target_price) / 2,
        note: 'midpoint'
      });
    }
    // Bottom zone (below lowest down target) — CAPPED
    zones.push({
      range: `<$${downs[0].target_price}`,
      probability: downs[0].yes_probability,
      representative: downs[0].target_price * DOWNSIDE_CAP_RATIO,
      note: `cap × ${DOWNSIDE_CAP_RATIO}`
    });
  }

  const expectedPrice = zones.reduce((s, z) => s + z.probability * z.representative, 0);
  const periodReturn  = (expectedPrice / currentPrice) - 1;
  const betaAnnualized = periodReturn * (12 / monthsToResolution);  // linear scaling

  return { zones, expectedPrice, periodReturn, betaAnnualized };
}

function monthsBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
}

// ====================== Main ======================
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const debugJson = args.includes('--debug-json');

  console.log('============================================');
  console.log('HYPE β Updater (Method B)');
  if (dryRun) console.log('🧪 DRY RUN: predictions/hype.json will NOT be written');
  if (debugJson) console.log('🔬 DEBUG: raw Polymarket response will be dumped');
  console.log('============================================\n');

  console.log(`Fetching Polymarket event: ${EVENT_SLUG}`);
  const url = `${POLYMARKET_API}/events?slug=${EVENT_SLUG}`;
  const rawData = await fetchJSON(url);
  if (debugJson) {
    await fs.mkdir('predictions', { recursive: true });
    await fs.writeFile('predictions/_debug_polymarket_raw.json', JSON.stringify(rawData, null, 2));
    console.log('  → wrote predictions/_debug_polymarket_raw.json');
  }
  if (!Array.isArray(rawData) || rawData.length === 0) {
    throw new Error(`No event found for slug "${EVENT_SLUG}". Got: ${JSON.stringify(rawData).slice(0, 200)}`);
  }
  const event = rawData[0];
  const event_title = event.title;
  console.log(`  Event title: ${event_title}`);
  console.log(`  Event has ${(event.markets || []).length} markets total\n`);

  const markets = (event.markets || [])
    .map(m => {
      const direction = extractDirection(m.question);
      const target_price = extractTargetPrice(m.question);
      const yes_probability = parseProbability(m);
      return {
        question: m.question,
        slug: m.slug,
        yes_probability,
        volume: parseFloat(m.volume || m.volume24hr || 0),
        end_date: m.endDate,
        target_price,
        direction,
        active: m.active,
        closed: m.closed
      };
    });

  console.log('  All parsed markets:');
  markets.forEach(m => {
    const arrow = m.direction === 'up' ? '↑' : '↓';
    const status = m.closed ? ' [CLOSED]' : (m.active === false ? ' [INACTIVE]' : '');
    console.log(
      `    ${arrow} target=$${m.target_price ?? '?'}  ` +
      `prob=${(m.yes_probability * 100).toFixed(1)}%  ` +
      `vol=$${Math.round(m.volume).toLocaleString()}${status}  ` +
      `q="${m.question}"`
    );
  });

  // Filter to active markets with valid target prices
  const validMarkets = markets.filter(m =>
    m.target_price !== null &&
    m.yes_probability > 0 &&
    !m.closed
  );
  console.log(`\n  ${validMarkets.length} valid markets for β calculation`);
  if (validMarkets.length === 0) {
    throw new Error('No valid markets found. Check the debug JSON.');
  }

  console.log('\nFetching HYPE spot price (CoinGecko)...');
  const currentPrice = await getHypeSpotPrice();
  console.log(`  Spot: $${currentPrice}`);

  const now = new Date();
  const monthsToResolution = monthsBetween(RESOLUTION_DATE, now);
  console.log(`  Months to ${RESOLUTION_DATE.toISOString().slice(0,10)}: ${monthsToResolution.toFixed(2)}`);

  console.log('\nComputing β (Method B)...');
  const result = computeBetaMethodB(validMarkets, currentPrice, monthsToResolution);

  console.log('\n  Zone decomposition:');
  result.zones.forEach(z => {
    console.log(
      `    ${z.range.padEnd(14)}  ` +
      `prob ${(z.probability * 100).toFixed(1).padStart(5)}%  ` +
      `rep $${z.representative.toFixed(2).padStart(7)}  (${z.note})`
    );
  });
  console.log(`\n  E[price]:        $${result.expectedPrice.toFixed(2)}`);
  console.log(`  Period return:  ${(result.periodReturn * 100).toFixed(1)}%`);
  console.log(`  β (annualized): ${(result.betaAnnualized * 100).toFixed(1)}%`);

  const output = {
    updated_at: now.toISOString(),
    asset: 'HYPE',
    method: 'B (probability-weighted, capped extremes)',
    method_parameters: {
      upside_cap_ratio: UPSIDE_CAP_RATIO,
      downside_cap_ratio: DOWNSIDE_CAP_RATIO,
      scaling: 'linear'
    },
    source: {
      polymarket_event_slug: EVENT_SLUG,
      polymarket_event_title: event_title,
      coingecko_id: HYPE_COINGECKO_ID
    },
    current_price_usd: currentPrice,
    resolution_date: RESOLUTION_DATE.toISOString(),
    months_to_resolution: parseFloat(monthsToResolution.toFixed(2)),
    raw_markets: validMarkets,
    zones: result.zones.map(z => ({
      range: z.range,
      probability: parseFloat(z.probability.toFixed(4)),
      representative_usd: parseFloat(z.representative.toFixed(2)),
      note: z.note
    })),
    expected_price_usd: parseFloat(result.expectedPrice.toFixed(2)),
    period_return_pct: parseFloat((result.periodReturn * 100).toFixed(2)),
    beta_annualized_pct: parseFloat((result.betaAnnualized * 100).toFixed(2))
  };

  if (dryRun) {
    console.log('\n🧪 DRY RUN -- output that would be written:');
    console.log(JSON.stringify(output, null, 2));
  } else {
    const outPath = 'predictions/hype.json';
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(output, null, 2));
    console.log(`\n✓ Written: ${outPath}`);
  }
  console.log('============================================');
}

main().catch(err => {
  console.error('\n❌ ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
