const test = require('node:test');
const assert = require('node:assert');
const { buildData, analyze, detectChain, SYSTEM_PROGRAM } = require('../js/analyze.js');

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

/* --- Robinhood Chain ---------------------------------------------------- */

const EVM = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const POOL = '0x1111111111111111111111111111111111111111';

function evmPair(overrides = {}) {
  // DexScreener renvoie les adresses avec une casse différente de celle saisie.
  return pair(Object.assign({ pairAddress: POOL, baseToken: { address: EVM.toLowerCase(), name: 'Hood Moon', symbol: 'HMOON' } }, overrides));
}

function goplus(overrides = {}) {
  return Object.assign(
    {
      token_name: 'Hood Moon',
      token_symbol: 'HMOON',
      is_open_source: '1',
      is_proxy: '0',
      is_mintable: '0',
      owner_address: '0x0000000000000000000000000000000000000000',
      is_honeypot: '0',
      buy_tax: '0',
      sell_tax: '0',
      holder_count: '4321',
      holders: [
        { address: POOL, is_contract: 1, percent: '0.40', is_locked: 0 },
        { address: '0x000000000000000000000000000000000000dEaD', is_contract: 0, percent: '0.20', is_locked: 0 },
        { address: '0x2222222222222222222222222222222222222222', is_contract: 0, percent: '0.04', is_locked: 0 },
        { address: '0x3333333333333333333333333333333333333333', is_contract: 0, percent: '0.03', is_locked: 0 },
      ],
      lp_holders: [{ address: '0x000000000000000000000000000000000000dead', percent: '0.99', is_locked: 0 }],
    },
    overrides
  );
}

test('détection de la chaîne selon le format d\'adresse', () => {
  assert.strictEqual(detectChain(EVM), 'robinhood');
  assert.strictEqual(detectChain('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), 'solana');
  assert.strictEqual(detectChain('0x123'), null);
  assert.strictEqual(detectChain('pas une adresse'), null);
});

test('Robinhood : token sain', () => {
  const data = buildData(EVM, { chain: 'robinhood', goplus: goplus(), dexPairs: [evmPair()] });
  assert.strictEqual(data.chain, 'robinhood');
  assert.ok(data.market, 'la paire doit être trouvée malgré la casse différente');
  assert.strictEqual(data.holderCount, 4321);
  assert.ok(data.holders[0].isProgram && data.holders[1].label === 'Brûlé', 'pool et burn exclus');
  const r = analyze(data);
  assert.strictEqual(r.level, 'low', JSON.stringify(r.checks, null, 2));
  assert.ok(r.checks.find((c) => c.id === 'lp-lock' && c.status === 'ok'));
  assert.ok(r.checks.find((c) => c.id === 'evm-owner' && c.status === 'ok'));
});

test('Robinhood : honeypot avec propriétaire actif', () => {
  const data = buildData(EVM, {
    chain: 'robinhood',
    goplus: goplus({
      is_honeypot: '1',
      sell_tax: '0.99',
      is_mintable: '1',
      is_open_source: '0',
      owner_address: '0x4444444444444444444444444444444444444444',
      lp_holders: [{ address: '0x4444444444444444444444444444444444444444', percent: '1', is_locked: 0 }],
    }),
    dexPairs: [evmPair({ pairCreatedAt: Date.now() - 3 * HOUR })],
  });
  const r = analyze(data);
  assert.strictEqual(r.level, 'scam');
  const ids = r.checks.map((c) => c.id);
  for (const id of ['evm-honeypot', 'evm-tax', 'evm-mint', 'evm-verified', 'lp-lock', 'evm-owner']) {
    assert.ok(ids.includes(id), 'check manquant : ' + id);
  }
  assert.strictEqual(r.checks.find((c) => c.id === 'evm-mint').status, 'danger');
});

test('Robinhood : pouvoirs du contrat atténués si la propriété est renoncée', () => {
  const data = buildData(EVM, { chain: 'robinhood', goplus: goplus({ is_mintable: '1', transfer_pausable: '1' }), dexPairs: [evmPair()] });
  const r = analyze(data);
  assert.strictEqual(r.checks.find((c) => c.id === 'evm-mint').status, 'warn');
  assert.strictEqual(r.checks.find((c) => c.id === 'evm-pausable').points, 5);
});

test('Robinhood : sans GoPlus, repli sur Blockscout', () => {
  const data = buildData(EVM, {
    chain: 'robinhood',
    goplus: null,
    bsToken: { name: 'Hood Moon', symbol: 'HMOON', decimals: '18', total_supply: '1000000000000000000000', holders_count: '12' },
    bsHolders: { items: [
      { address: { hash: POOL, is_contract: true }, value: '500000000000000000000' },
      { address: { hash: '0x2222222222222222222222222222222222222222', is_contract: false }, value: '300000000000000000000' },
    ] },
    bsAddress: { is_contract: true, is_verified: false, implementations: [{ address: '0x5555555555555555555555555555555555555555' }] },
    dexPairs: null,
  });
  assert.strictEqual(data.token.supply, 1000);
  assert.strictEqual(data.holderCount, 12);
  assert.strictEqual(Math.round(data.holders[1].pct), 30);
  const r = analyze(data);
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.strictEqual(byId['evm-verified'].status, 'danger');
  assert.strictEqual(byId['evm-security'].status, 'unknown');
  assert.strictEqual(byId['evm-proxy'].status, 'warn');
  assert.strictEqual(byId['top1'].status, 'danger');
  assert.strictEqual(byId['liquidity'].status, 'danger');
});
