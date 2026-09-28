const test = require('node:test');
const assert = require('node:assert');
const { buildData, analyze, SYSTEM_PROGRAM } = require('../js/analyze.js');

const MINT = 'ScamXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HOUR = 3600 * 1000;

function onchain({ mintAuthority = null, freezeAuthority = null, holders = [], extensions, owner = TOKEN_PROGRAM } = {}) {
  const supply = 1000000;
  const info = { mintAuthority, freezeAuthority, supply: String(supply), decimals: 0, isInitialized: true };
  if (extensions) info.extensions = extensions;
  const largestAccounts = holders.map((h, i) => ({ address: 'acct' + i, amount: String(h.amount) }));
  const tokenAccountOwners = {};
  const ownerPrograms = {};
  holders.forEach((h, i) => {
    tokenAccountOwners['acct' + i] = h.owner;
    ownerPrograms[h.owner] = h.program === undefined ? SYSTEM_PROGRAM : h.program;
  });
  return {
    mintAccount: { owner, data: { parsed: { type: 'mint', info } } },
    largestAccounts,
    tokenAccountOwners,
    ownerPrograms,
  };
}

function pair(overrides = {}) {
  return Object.assign(
    {
      chainId: 'solana',
      dexId: 'raydium',
      url: 'https://dexscreener.com/solana/pool1',
      pairAddress: 'pool1',
      baseToken: { address: MINT, name: 'Test', symbol: 'TST' },
      quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      priceUsd: '0.01',
      txns: { h24: { buys: 500, sells: 450 } },
      volume: { h24: 200000 },
      priceChange: { h24: 5 },
      liquidity: { usd: 250000 },
      fdv: 3000000,
      marketCap: 3000000,
      pairCreatedAt: Date.now() - 400 * 24 * HOUR,
      info: { imageUrl: 'https://img/x.png', websites: [{ url: 'https://test.xyz' }], socials: [{ type: 'twitter', url: 'https://x.com/test' }] },
    },
    overrides
  );
}

test('token sain : risque faible', () => {
  const data = buildData(MINT, {
    onchain: onchain({
      holders: [
        { owner: 'raydiumAuth', amount: 300000, program: null }, // PDA → pool
        { owner: 'w1', amount: 40000 },
        { owner: 'w2', amount: 30000 },
        { owner: 'w3', amount: 20000 },
      ],
    }),
    dexPairs: [pair()],
    rugcheck: { tokenMeta: { mutable: false }, risks: [], markets: [{ lp: { lpLockedPct: 100, quoteUSD: 1, baseUSD: 1 } }] },
  });
  const r = analyze(data);
  assert.strictEqual(r.level, 'low', JSON.stringify(r.checks, null, 2));
  assert.ok(data.holders[0].isProgram, 'la pool doit être exclue');
  assert.strictEqual(r.confidence, 'élevée');
});

test('rug pull typique : arnaque', () => {
  const data = buildData(MINT, {
    onchain: onchain({
      mintAuthority: 'dev',
      freezeAuthority: 'dev',
      holders: [
        { owner: 'dev', amount: 600000 },
        { owner: 'w2', amount: 100000 },
      ],
    }),
    dexPairs: [pair({ liquidity: { usd: 800 }, pairCreatedAt: Date.now() - 2 * HOUR, txns: { h24: { buys: 120, sells: 0 } }, info: {} })],
    rugcheck: null,
  });
  const r = analyze(data);
  assert.strictEqual(r.level, 'scam');
  assert.strictEqual(r.score, 100);
  const ids = r.checks.map((c) => c.id);
  for (const id of ['mint-auth', 'freeze-auth', 'top10', 'top1', 'liquidity', 'sells', 'age', 'socials']) {
    assert.ok(ids.includes(id), 'check manquant : ' + id);
  }
  assert.strictEqual(r.checks[0].status, 'danger');
});

test('extensions Token-2022 dangereuses', () => {
  const data = buildData(MINT, {
    onchain: onchain({
      owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      extensions: [
        { extension: 'permanentDelegate', state: { delegate: 'evil' } },
        { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 2500 } } },
      ],
    }),
    dexPairs: [pair()],
    rugcheck: null,
  });
  assert.strictEqual(data.token.program, 'token-2022');
  const r = analyze(data);
  const ids = r.checks.map((c) => c.id);
  assert.ok(ids.includes('ext-delegate'));
  assert.ok(ids.includes('ext-fee'));
  assert.ok(r.score >= 45);
});

test('sources manquantes : fallback RugCheck et checks inconnus', () => {
  const data = buildData(MINT, {
    onchain: null,
    dexPairs: null,
    rugcheck: {
      token: { mintAuthority: null, freezeAuthority: null, decimals: 6 },
      tokenMeta: { name: 'Rc', symbol: 'RC', mutable: true },
      topHolders: [{ address: 'a', owner: 'pool', pct: 40 }, { address: 'b', owner: 'w', pct: 5 }],
      knownAccounts: { pool: { name: 'Raydium', type: 'AMM' } },
      risks: [{ name: 'Low Liquidity', level: 'danger' }],
      rugged: false,
    },
  });
  assert.strictEqual(data.token.name, 'Rc');
  assert.strictEqual(data.holders[0].isProgram, true);
  const r = analyze(data);
  assert.ok(r.checks.find((c) => c.id === 'liquidity' && c.status === 'danger'));
  assert.ok(r.checks.find((c) => c.id === 'mint-auth' && c.status === 'ok'));
});

test('token vérifié (USDC) : score plafonné', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const data = buildData(usdc, {
    onchain: onchain({ mintAuthority: 'circle', freezeAuthority: 'circle' }),
    dexPairs: [pair({ baseToken: { address: usdc, name: 'USD Coin', symbol: 'USDC' }, liquidity: { usd: 5e7 } })],
    rugcheck: null,
  });
  const r = analyze(data);
  assert.ok(r.score <= 5);
  assert.strictEqual(r.level, 'low');
});

test('les URL non http(s) sont ignorées', () => {
  const data = buildData(MINT, {
    onchain: null,
    dexPairs: [pair({ info: { websites: [{ url: 'javascript:alert(1)' }], socials: [], imageUrl: 'javascript:x' } })],
    rugcheck: null,
  });
  assert.strictEqual(data.market.websites.length, 0);
  assert.strictEqual(data.market.imageUrl, null);
});
