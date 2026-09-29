const test = require('node:test');
const assert = require('node:assert');
const { parseGeckoPools, momentumScore, buyerShare, rank, isRisky } = require('../js/momentum.js');
const { buildData, contractRisk } = require('../js/analyze.js');

const HOUR = 3600 * 1000;

function pool(id, token, attrs) {
  return {
    id: 'solana_' + id,
    type: 'pool',
    attributes: Object.assign(
      {
        address: id,
        name: token.symbol + ' / SOL',
        base_token_price_usd: '0.01',
        reserve_in_usd: '300000',
        pool_created_at: new Date(Date.now() - 40 * 24 * HOUR).toISOString(),
        price_change_percentage: { h1: '0', h6: '0', h24: '0' },
        transactions: { h1: { buys: 50, sells: 50, buyers: 40, sellers: 40 }, h24: { buys: 900, sells: 900, buyers: 500, sellers: 500 } },
        volume_usd: { h1: '10000', h24: '240000' },
      },
      attrs
    ),
    relationships: {
      base_token: { data: { id: 'solana_' + token.address, type: 'token' } },
      dex: { data: { id: 'raydium', type: 'dex' } },
    },
  };
}

function tokenInc(t) {
  return { id: 'solana_' + t.address, type: 'token', attributes: { address: t.address, name: t.name, symbol: t.symbol, image_url: t.image || 'missing.png' } };
}

const HOT = { address: 'HotMint1111111111111111111111111111111111111', name: 'Hot', symbol: 'HOT', image: 'https://img/hot.png' };
const DUMP = { address: 'DumpMint111111111111111111111111111111111111', name: 'Dump', symbol: 'DUMP' };
const SOL = { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' };

const response = {
  data: [
    pool('poolHotSmall', HOT, { reserve_in_usd: '20000' }),
    pool('poolHot', HOT, {
      price_change_percentage: { h1: '6', h6: '25', h24: '80' },
      transactions: { h1: { buyers: 120, sellers: 40 }, h24: { buyers: 3000, sellers: 1200 } },
      volume_usd: { h1: '150000', h24: '1200000' },
    }),
    pool('poolDump', DUMP, {
      reserve_in_usd: '6000',
      pool_created_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      price_change_percentage: { h1: '-15', h6: '-40', h24: '-70' },
      transactions: { h1: { buyers: 5, sellers: 30 }, h24: { buyers: 30, sellers: 90 } },
      volume_usd: { h1: '100', h24: '20000' },
    }),
    pool('poolSol', SOL, {}),
  ],
  included: [tokenInc(HOT), tokenInc(DUMP), tokenInc(SOL)],
};

test('parse GeckoTerminal : dédoublonne, ignore SOL, garde la pool la plus liquide', () => {
  const items = parseGeckoPools([response, null]);
  assert.deepStrictEqual(items.map((i) => i.symbol).sort(), ['DUMP', 'HOT']);
  const hot = items.find((i) => i.symbol === 'HOT');
  assert.strictEqual(hot.pool, 'poolHot');
  assert.strictEqual(hot.liquidityUsd, 300000);
  assert.strictEqual(hot.image, 'https://img/hot.png');
  assert.strictEqual(items.find((i) => i.symbol === 'DUMP').image, null, 'missing.png ignoré');
});

test('score de dynamique : un token en forte hausse devance un token qui s\'effondre', () => {
  const items = parseGeckoPools([response]);
  const hot = items.find((i) => i.symbol === 'HOT');
  const dump = items.find((i) => i.symbol === 'DUMP');
  const mh = momentumScore(hot);
  const md = momentumScore(dump);
  assert.ok(mh.score >= 75, 'HOT : ' + JSON.stringify(mh));
  assert.strictEqual(mh.level, 'strong');
  assert.ok(md.score < 45, 'DUMP : ' + JSON.stringify(md));
  assert.ok(mh.reasons.length > 0 && mh.reasons.length <= 3);
  assert.ok(mh.reasons.every((r) => typeof r.text === 'string'));
  assert.ok(Math.abs(buyerShare(hot) - 3000 / 4200) < 1e-9);
});

test('un token qui a déjà fait +300 % est pénalisé', () => {
  const [base] = parseGeckoPools([{ data: [pool('p', HOT, {})], included: [tokenInc(HOT)] }]);
  const calm = momentumScore(base);
  const moon = momentumScore(Object.assign({}, base, { priceChange: { h1: 0, h6: 0, h24: 500 } }));
  assert.ok(moon.score < calm.score);
  assert.ok(moon.reasons.some((r) => !r.good && /retournement/.test(r.text)));
});

test('surchauffe : même avec beaucoup d\'acheteurs, le score est plafonné à 60', () => {
  const [base] = parseGeckoPools([response]);
  const hot = Object.assign({}, base, { priceChange: { h1: 40, h6: 400, h24: 900 } });
  const m = momentumScore(hot);
  assert.strictEqual(m.overheated, true);
  assert.strictEqual(m.level, 'hot');
  assert.ok(m.score <= 60);
});

test('le score ne sature pas : deux bons tokens restent départageables', () => {
  const [base] = parseGeckoPools([response]);
  const strong = momentumScore(Object.assign({}, base, { priceChange: { h1: 10, h6: 30, h24: 60 } }));
  const stronger = momentumScore(Object.assign({}, base, { priceChange: { h1: 10, h6: 30, h24: 150 } }));
  assert.ok(strong.score < 100 && stronger.score < 100);
  assert.ok(stronger.score > strong.score);
});

test('classement : les tokens risqués ou illiquides sont masqués sur demande', () => {
  const items = parseGeckoPools([response]);
  items.forEach((it) => (it.momentum = momentumScore(it)));
  items.find((i) => i.symbol === 'HOT').safety = { status: 'ok', issues: [] };
  items.find((i) => i.symbol === 'DUMP').safety = { status: 'ok', issues: [] };
  assert.ok(isRisky(items.find((i) => i.symbol === 'DUMP')), 'liquidité < 10 k$');
  assert.deepStrictEqual(rank(items, true).map((i) => i.symbol), ['HOT']);
  assert.deepStrictEqual(rank(items, false).map((i) => i.symbol), ['HOT', 'DUMP']);
});

test('contrôle rapide du contrat', () => {
  const mintAccount = (mintAuthority, freezeAuthority) => ({
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    data: { parsed: { type: 'mint', info: { mintAuthority, freezeAuthority, supply: '1000', decimals: 0 } } },
  });
  const safe = contractRisk(buildData(HOT.address, { chain: 'solana', onchain: { mintAccount: mintAccount(null, null) } }));
  assert.strictEqual(safe.status, 'ok');
  const bad = contractRisk(buildData(HOT.address, { chain: 'solana', onchain: { mintAccount: mintAccount(null, 'dev') } }));
  assert.strictEqual(bad.status, 'danger');
  assert.deepStrictEqual(bad.issues, ['Autorité de gel active']);
  const unknown = contractRisk(buildData(HOT.address, { chain: 'solana' }));
  assert.strictEqual(unknown.status, 'unknown');

  const honeypot = contractRisk(buildData('0x' + 'a'.repeat(40), { chain: 'robinhood', goplus: { is_open_source: '1', is_honeypot: '1', owner_address: '' } }));
  assert.strictEqual(honeypot.status, 'danger');
  assert.strictEqual(honeypot.issues[0], 'Honeypot détecté');
});
