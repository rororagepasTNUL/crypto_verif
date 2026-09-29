/*
 * Normalisation des données brutes (Solana : RPC, DexScreener, RugCheck ;
 * Robinhood Chain : GoPlus, Blockscout, DexScreener) et calcul du score de risque. Aucune dépendance au DOM : ce fichier
 * est aussi chargé par les tests Node.
 */
(function (root) {
  'use strict';

  const SYSTEM_PROGRAM = '11111111111111111111111111111111';
  const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

  // Autorités de pools bien connues (comptes qui détiennent la liquidité, pas des humains).
  const KNOWN_POOL_OWNERS = {
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium AMM',
    'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL': 'Raydium CPMM',
  };

  // Tokens établis dont les autorités actives sont connues et assumées.
  const VERIFIED_TOKENS = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC (Circle)',
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT (Tether)',
    So11111111111111111111111111111111111111112: 'Wrapped SOL',
  };

  const BURN_ADDRESSES = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
  ]);

  const DAY_MS = 24 * 60 * 60 * 1000;

  /** 'solana' pour une adresse base58, 'robinhood' pour une adresse 0x, sinon null. */
  function detectChain(address) {
    const a = (address || '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'robinhood';
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'solana';
    return null;
  }

  // Les adresses EVM ne sont pas sensibles à la casse, contrairement aux adresses Solana.
  function addrKey(a) {
    return typeof a === 'string' && a.startsWith('0x') ? a.toLowerCase() : a;
  }

  function sameAddr(a, b) {
    return !!a && !!b && addrKey(a) === addrKey(b);
  }

  // Les drapeaux GoPlus valent "1" / "0" (ou sont absents quand c'est inconnu).
  function flag(v) {
    if (v === '1' || v === 1) return true;
    if (v === '0' || v === 0) return false;
    return undefined;
  }

  function num(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && isFinite(n) ? n : null;
  }

  function sum(arr, fn) {
    return arr.reduce((acc, x) => acc + (num(fn(x)) || 0), 0);
  }

  /* ------------------------------------------------------------------ */
  /* Normalisation                                                       */
  /* ------------------------------------------------------------------ */

  function normalizeOnChain(onchain) {
    if (!onchain || !onchain.mintAccount) return null;
    const acc = onchain.mintAccount;
    const info = acc.data && acc.data.parsed && acc.data.parsed.info;
    if (!info) return null;
    return {
      program: acc.owner === TOKEN_2022_PROGRAM ? 'token-2022' : 'spl-token',
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      decimals: info.decimals,
      rawSupply: num(info.supply),
      extensions: Array.isArray(info.extensions) ? info.extensions : [],
    };
  }

  function holdersFromOnChain(onchain, rawSupply, poolAddresses) {
    if (!onchain || !Array.isArray(onchain.largestAccounts) || !rawSupply) return null;
    const owners = onchain.tokenAccountOwners || {};
    const ownerPrograms = onchain.ownerPrograms || {};
    return onchain.largestAccounts
      .filter((a) => num(a.amount) > 0)
      .map((a) => {
        const owner = owners[a.address] || null;
        const ownerProgram = owner ? ownerPrograms[owner] : undefined;
        let label = null;
        if (owner && KNOWN_POOL_OWNERS[owner]) label = KNOWN_POOL_OWNERS[owner];
        else if (poolAddresses.has(a.address) || (owner && poolAddresses.has(owner))) label = 'Pool de liquidité';
        // Un « propriétaire » qui n'est pas un compte système (PDA inexistant ou compte
        // appartenant à un programme) est un contrat : pool, bonding curve, locker…
        else if (owner && ownerProgram !== undefined && ownerProgram !== SYSTEM_PROGRAM) label = 'Contrat / programme';
        return {
          address: owner || a.address,
          tokenAccount: a.address,
          pct: (num(a.amount) / rawSupply) * 100,
          isProgram: label !== null,
          label,
        };
      });
  }

  function holdersFromRugCheck(rc, poolAddresses) {
    if (!rc || !Array.isArray(rc.topHolders) || rc.topHolders.length === 0) return null;
    const known = rc.knownAccounts || {};
    return rc.topHolders.map((h) => {
      const owner = h.owner || h.address;
      const k = known[owner] || known[h.address];
      let label = null;
      if (k && /amm|locker|pool/i.test(k.type || '')) label = k.name || 'Pool de liquidité';
      else if (KNOWN_POOL_OWNERS[owner]) label = KNOWN_POOL_OWNERS[owner];
      else if (poolAddresses.has(owner) || poolAddresses.has(h.address)) label = 'Pool de liquidité';
      return {
        address: owner,
        tokenAccount: h.address,
        pct: num(h.pct) || 0,
        isProgram: label !== null,
        label,
        insider: !!h.insider,
      };
    });
  }

  function safeUrl(u) {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  function normalizeMarket(pairs, mint) {
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    const isBase = (p) => p.baseToken && sameAddr(p.baseToken.address, mint);
    const relevant = pairs.filter((p) => isBase(p) || (p.quoteToken && sameAddr(p.quoteToken.address, mint)));
    if (relevant.length === 0) return null;
    const basePairs = relevant.filter(isBase);
    const pool = basePairs.length ? basePairs : relevant;
    const byLiq = pool.slice().sort((a, b) => (num(b.liquidity && b.liquidity.usd) || 0) - (num(a.liquidity && a.liquidity.usd) || 0));
    const main = byLiq[0];

    const created = relevant.map((p) => num(p.pairCreatedAt)).filter((x) => x);
    const websites = [];
    const socials = [];
    for (const p of relevant) {
      const info = p.info || {};
      for (const w of info.websites || []) {
        const href = safeUrl(w.url);
        if (href && !websites.some((x) => x.url === href)) websites.push({ label: w.label || 'Site web', url: href });
      }
      for (const s of info.socials || []) {
        const href = safeUrl(s.url);
        if (href && !socials.some((x) => x.url === href)) socials.push({ type: s.type || 'social', url: href });
      }
    }
    const imageUrl = relevant.map((p) => p.info && safeUrl(p.info.imageUrl)).find((x) => x) || null;
    const txns = (p, key) => (p.txns && p.txns.h24 && p.txns.h24[key]) || 0;

    return {
      pairCount: relevant.length,
      mainPair: {
        dex: main.dexId,
        url: safeUrl(main.url),
        address: main.pairAddress,
        quote: isBase(main) ? main.quoteToken && main.quoteToken.symbol : main.baseToken && main.baseToken.symbol,
      },
      pairAddresses: relevant.map((p) => p.pairAddress).filter(Boolean),
      name: isBase(main) ? main.baseToken.name : main.quoteToken && main.quoteToken.name,
      symbol: isBase(main) ? main.baseToken.symbol : main.quoteToken && main.quoteToken.symbol,
      imageUrl,
      priceUsd: basePairs.length ? num(main.priceUsd) : null,
      marketCap: basePairs.length ? num(main.marketCap) || num(main.fdv) : null,
      fdv: basePairs.length ? num(main.fdv) : null,
      liquidityUsd: sum(relevant, (p) => p.liquidity && p.liquidity.usd),
      volume24h: sum(pool, (p) => p.volume && p.volume.h24),
      buys24h: sum(pool, (p) => txns(p, 'buys')),
      sells24h: sum(pool, (p) => txns(p, 'sells')),
      priceChange24h: basePairs.length ? num(main.priceChange && main.priceChange.h24) : null,
      pairCreatedAt: created.length ? Math.min.apply(null, created) : null,
      websites,
      socials,
    };
  }

  function normalizeRugCheck(rc) {
    if (!rc || typeof rc !== 'object') return null;
    const markets = Array.isArray(rc.markets) ? rc.markets : [];
    const lpMarkets = markets.filter((m) => m.lp && num(m.lp.lpLockedPct) !== null);
    let lpLockedPct = null;
    if (lpMarkets.length) {
      // Pourcentage verrouillé du marché le plus liquide.
      const best = lpMarkets.slice().sort((a, b) => (num(b.lp.quoteUSD) || 0) + (num(b.lp.baseUSD) || 0) - ((num(a.lp.quoteUSD) || 0) + (num(a.lp.baseUSD) || 0)))[0];
      lpLockedPct = num(best.lp.lpLockedPct);
    }
    return {
      score: num(rc.score_normalised) !== null ? num(rc.score_normalised) : num(rc.score),
      risks: Array.isArray(rc.risks) ? rc.risks : [],
      rugged: !!rc.rugged,
      lpLockedPct,
      totalHolders: num(rc.totalHolders),
      mutableMetadata: rc.tokenMeta ? rc.tokenMeta.mutable : undefined,
      insidersDetected: num(rc.graphInsidersDetected) || 0,
      creator: rc.creator || null,
      name: rc.tokenMeta && rc.tokenMeta.name,
      symbol: rc.tokenMeta && rc.tokenMeta.symbol,
      image: rc.fileMeta && safeUrl(rc.fileMeta.image),
      token: rc.token || null,
    };
  }

  /**
   * Fusionne les sources en un seul objet. Pour Solana, `sources` = { onchain, dexPairs, rugcheck } ;
   * pour Robinhood Chain, voir buildEvmData. Chaque clé peut être null si la source a échoué.
   */
  function buildData(mint, sources) {
    if (sources.chain === 'robinhood') return buildEvmData(mint, sources);
    const chain = normalizeOnChain(sources.onchain);
    const market = normalizeMarket(sources.dexPairs, mint);
    const rc = normalizeRugCheck(sources.rugcheck);
    const poolAddresses = new Set(market ? market.pairAddresses : []);

    const token = {
      mint,
      name: (market && market.name) || (rc && rc.name) || null,
      symbol: (market && market.symbol) || (rc && rc.symbol) || null,
      image: (market && market.imageUrl) || (rc && rc.image) || null,
      program: chain ? chain.program : null,
      mintAuthority: chain ? chain.mintAuthority : rc && rc.token ? rc.token.mintAuthority || null : undefined,
      freezeAuthority: chain ? chain.freezeAuthority : rc && rc.token ? rc.token.freezeAuthority || null : undefined,
      extensions: chain ? chain.extensions : null,
      decimals: chain ? chain.decimals : rc && rc.token ? rc.token.decimals : null,
      supply: chain && chain.rawSupply !== null ? chain.rawSupply / Math.pow(10, chain.decimals || 0) : null,
    };

    const holders =
      (chain && holdersFromOnChain(sources.onchain, chain.rawSupply, poolAddresses)) ||
      holdersFromRugCheck(sources.rugcheck, poolAddresses);

    return {
      mint,
      chain: 'solana',
      token,
      market,
      rugcheck: rc,
      holders,
      holderCount: rc ? rc.totalHolders : null,
      verifiedName: VERIFIED_TOKENS[mint] || null,
    };
  }

  /* --- Robinhood Chain (EVM) ------------------------------------------ */

  function evmHolderLabel(address, isContract, pools, extra) {
    const key = addrKey(address);
    if (BURN_ADDRESSES.has(key)) return 'Brûlé';
    if (pools.has(key)) return 'Pool de liquidité';
    if (extra && extra.locked) return 'Verrouillé' + (extra.tag ? ' (' + extra.tag + ')' : '');
    if (isContract) return (extra && extra.tag) || 'Contrat / pool';
    return null;
  }

  function holdersFromGoPlus(gp, pools) {
    if (!gp || !Array.isArray(gp.holders) || gp.holders.length === 0) return null;
    return gp.holders.map((h) => {
      const label = evmHolderLabel(h.address, flag(h.is_contract), pools, { locked: flag(h.is_locked), tag: h.tag });
      return { address: h.address, pct: (num(h.percent) || 0) * 100, isProgram: label !== null, label };
    });
  }

  function holdersFromBlockscout(bh, rawSupply, pools) {
    if (!bh || !Array.isArray(bh.items) || bh.items.length === 0 || !rawSupply) return null;
    return bh.items.map((h) => {
      const a = h.address || {};
      const label = evmHolderLabel(a.hash, a.is_contract, pools, { tag: a.name });
      return { address: a.hash, pct: (num(h.value) / rawSupply) * 100, isProgram: label !== null, label };
    });
  }

  /**
   * `sources` = { chain: 'robinhood', goplus, bsToken, bsHolders, bsAddress, dexPairs }
   * (goplus = l'entrée du token dans la réponse GoPlus, les bs* = réponses Blockscout v2).
   */
  function buildEvmData(address, sources) {
    const market = normalizeMarket(sources.dexPairs, address);
    const gp = sources.goplus || null;
    const bt = sources.bsToken || null;
    const ba = sources.bsAddress || null;
    const pools = new Set((market ? market.pairAddresses : []).map(addrKey));

    const decimals = bt ? num(bt.decimals) : null;
    const rawSupply = bt ? num(bt.total_supply) : null;
    const token = {
      mint: address,
      name: (market && market.name) || (bt && bt.name) || (gp && gp.token_name) || null,
      symbol: (market && market.symbol) || (bt && bt.symbol) || (gp && gp.token_symbol) || null,
      image: (market && market.imageUrl) || (bt && safeUrl(bt.icon_url)) || null,
      program: 'erc-20',
      decimals,
      supply: rawSupply !== null && decimals !== null ? rawSupply / Math.pow(10, decimals) : gp ? num(gp.total_supply) : null,
    };

    const holders = holdersFromGoPlus(gp, pools) || holdersFromBlockscout(sources.bsHolders, rawSupply, pools);

    let verified = gp ? flag(gp.is_open_source) : undefined;
    if (verified === undefined && ba && typeof ba.is_verified === 'boolean') verified = ba.is_verified;
    let proxy = gp ? flag(gp.is_proxy) : undefined;
    if (proxy === undefined && ba && Array.isArray(ba.implementations)) proxy = ba.implementations.length > 0;

    const holderCount = (gp && num(gp.holder_count)) || (bt && (num(bt.holders_count) || num(bt.holders))) || null;

    return {
      mint: address,
      chain: 'robinhood',
      token,
      market,
      rugcheck: null,
      holders,
      holderCount,
      evm: {
        goplus: gp,
        verified,
        proxy,
        owner: gp ? gp.owner_address : undefined,
        creator: (gp && gp.creator_address) || (ba && ba.creator_address_hash) || null,
      },
      verifiedName: gp && flag(gp.trust_list) ? (token.name || 'Token') + ' (liste de confiance GoPlus)' : null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Analyse                                                             */
  /* ------------------------------------------------------------------ */

  function fmtPct(v) {
    return (Math.round(v * 10) / 10).toLocaleString('fr-FR') + ' %';
  }

  function fmtUsd(v) {
    if (v === null || v === undefined) return '—';
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'USD',
      notation: v >= 10000 ? 'compact' : 'standard',
      maximumFractionDigits: v >= 1 ? 2 : 8,
    }).format(v);
  }

  function extensionChecks(ext) {
    const out = [];
    const find = (name) => ext.find((e) => e.extension === name);

    const delegate = find('permanentDelegate');
    if (delegate && delegate.state && delegate.state.delegate) {
      out.push({ id: 'ext-delegate', category: 'Contrat', label: 'Délégué permanent', status: 'danger', points: 35,
        detail: 'Une adresse peut transférer ou brûler les tokens de N\'IMPORTE QUEL portefeuille, sans permission.' });
    }
    const nonTransferable = find('nonTransferable');
    if (nonTransferable) {
      out.push({ id: 'ext-nontransferable', category: 'Contrat', label: 'Token non transférable', status: 'danger', points: 40,
        detail: 'Le token ne peut pas être transféré : impossible de le revendre.' });
    }
    const fee = find('transferFeeConfig');
    if (fee && fee.state) {
      const cfg = fee.state.newerTransferFee || fee.state.olderTransferFee || {};
      const bps = num(cfg.transferFeeBasisPoints) || 0;
      if (bps > 0) {
        const pct = bps / 100;
        const bad = pct >= 10;
        out.push({ id: 'ext-fee', category: 'Contrat', label: 'Taxe de transfert', status: bad ? 'danger' : 'warn', points: bad ? 25 : 10,
          detail: 'Chaque transfert est taxé de ' + fmtPct(pct) + (fee.state.transferFeeConfigAuthority ? ', et la taxe peut encore être modifiée.' : '.') });
      }
    }
    const hook = find('transferHook');
    if (hook && hook.state && hook.state.programId) {
      out.push({ id: 'ext-hook', category: 'Contrat', label: 'Transfer hook', status: 'warn', points: 15,
        detail: 'Un programme externe est exécuté à chaque transfert ; il peut bloquer les ventes.' });
    }
    const das = find('defaultAccountState');
    if (das && das.state && /frozen/i.test(das.state.accountState || '')) {
      out.push({ id: 'ext-frozen', category: 'Contrat', label: 'Comptes gelés par défaut', status: 'danger', points: 25,
        detail: 'Les nouveaux détenteurs sont gelés par défaut jusqu\'à ce que l\'émetteur les débloque.' });
    }
    const pausable = find('pausableConfig') || find('pausable');
    if (pausable) {
      out.push({ id: 'ext-pausable', category: 'Contrat', label: 'Token « pausable »', status: 'danger', points: 20,
        detail: 'L\'émetteur peut suspendre tous les transferts à tout moment.' });
    }
    return out;
  }

  function evmContractChecks(evm, add) {
    const gp = evm.goplus;
    const is = (key) => gp && flag(gp[key]) === true;
    const owner = evm.owner;
    const noOwner = owner === '' || (typeof owner === 'string' && BURN_ADDRESSES.has(addrKey(owner)));
    const ownerActive = typeof owner === 'string' && !noOwner;
    // Un pouvoir n'est dangereux que si quelqu'un peut encore l'exercer.
    const ownerNote = ownerActive ? '' : ' (propriété renoncée : risque réduit)';

    if (evm.verified === true) {
      add({ id: 'evm-verified', category: 'Contrat', label: 'Code source vérifié', status: 'ok',
        detail: 'Le code du contrat est public et vérifié sur l\'explorateur.' });
    } else if (evm.verified === false) {
      add({ id: 'evm-verified', category: 'Contrat', label: 'Code source non vérifié', status: 'danger', points: 25,
        detail: 'Le code du contrat est caché : impossible de savoir ce qu\'il fait vraiment.' });
    } else {
      add({ id: 'evm-verified', category: 'Contrat', label: 'Code source', status: 'unknown', detail: 'Donnée indisponible.' });
    }

    if (!gp) {
      add({ id: 'evm-security', category: 'Contrat', label: 'Analyse de sécurité GoPlus', status: 'unknown',
        detail: 'GoPlus n\'a pas répondu : honeypot, taxes et fonctions dangereuses non vérifiés.' });
      if (evm.proxy === true) {
        add({ id: 'evm-proxy', category: 'Contrat', label: 'Contrat modifiable (proxy)', status: 'warn', points: 15,
          detail: 'Le code du contrat peut être remplacé par son propriétaire à tout moment.' });
      }
      return;
    }

    if (is('is_honeypot')) {
      add({ id: 'evm-honeypot', category: 'Contrat', label: 'Honeypot détecté', status: 'danger', points: 60,
        detail: 'La simulation GoPlus montre qu\'il est impossible de revendre ce token.' });
    }
    if (is('cannot_sell_all')) {
      add({ id: 'evm-sell-all', category: 'Contrat', label: 'Vente totale impossible', status: 'danger', points: 30,
        detail: 'Le contrat empêche de revendre la totalité de ses tokens.' });
    }
    if (is('honeypot_with_same_creator')) {
      add({ id: 'evm-creator-honeypot', category: 'Contrat', label: 'Créateur déjà impliqué dans un honeypot', status: 'danger', points: 25,
        detail: 'Ce créateur a déjà déployé des honeypots.', address: evm.creator });
    }

    const sellTax = num(gp.sell_tax);
    const buyTax = num(gp.buy_tax);
    if (sellTax !== null || buyTax !== null) {
      const worst = Math.max(sellTax || 0, buyTax || 0);
      const detail = 'Taxe à l\'achat : ' + fmtPct((buyTax || 0) * 100) + ' · à la vente : ' + fmtPct((sellTax || 0) * 100) + '.';
      if ((sellTax || 0) >= 0.5) {
        add({ id: 'evm-tax', category: 'Contrat', label: 'Taxe de vente abusive', status: 'danger', points: 40, detail: detail + ' Revendre fait perdre l\'essentiel de la mise.' });
      } else if (worst >= 0.1) {
        add({ id: 'evm-tax', category: 'Contrat', label: 'Taxes élevées', status: 'danger', points: 20, detail });
      } else if (worst > 0.05) {
        add({ id: 'evm-tax', category: 'Contrat', label: 'Taxes notables', status: 'warn', points: 8, detail });
      } else {
        add({ id: 'evm-tax', category: 'Contrat', label: 'Taxes faibles ou nulles', status: 'ok', detail });
      }
    }
    if (is('slippage_modifiable') || is('personal_slippage_modifiable')) {
      add({ id: 'evm-tax-mod', category: 'Contrat', label: 'Taxe modifiable', status: ownerActive ? 'danger' : 'warn', points: ownerActive ? 20 : 5,
        detail: 'Le propriétaire peut augmenter la taxe (jusqu\'à 100 %, ce qui bloque les ventes)' + ownerNote + '.' });
    }
    if (is('cannot_buy')) {
      add({ id: 'evm-cannot-buy', category: 'Contrat', label: 'Achat impossible', status: 'warn', points: 10,
        detail: 'Le token ne peut pas être acheté normalement.' });
    }

    if (is('is_mintable')) {
      add({ id: 'evm-mint', category: 'Contrat', label: 'Création de tokens possible', status: ownerActive ? 'danger' : 'warn', points: ownerActive ? 25 : 5,
        detail: 'Le contrat permet d\'imprimer de nouveaux tokens et de diluer les détenteurs' + ownerNote + '.' });
    } else if (flag(gp.is_mintable) === false) {
      add({ id: 'evm-mint', category: 'Contrat', label: 'Offre fixe', status: 'ok', detail: 'Aucune fonction ne permet de créer de nouveaux tokens.' });
    }
    if (is('owner_change_balance')) {
      add({ id: 'evm-balance', category: 'Contrat', label: 'Soldes modifiables', status: ownerActive ? 'danger' : 'warn', points: ownerActive ? 35 : 5,
        detail: 'Le propriétaire peut modifier le solde de n\'importe quel portefeuille' + ownerNote + '.' });
    }
    if (is('hidden_owner')) {
      add({ id: 'evm-hidden-owner', category: 'Contrat', label: 'Propriétaire caché', status: 'danger', points: 20,
        detail: 'Le contrat garde un propriétaire caché, même si la propriété semble renoncée.' });
    }
    if (is('can_take_back_ownership')) {
      add({ id: 'evm-take-back', category: 'Contrat', label: 'Propriété récupérable', status: 'danger', points: 20,
        detail: 'Le créateur peut reprendre le contrôle du contrat après y avoir renoncé.' });
    }
    if (is('transfer_pausable')) {
      add({ id: 'evm-pausable', category: 'Contrat', label: 'Transferts suspendables', status: ownerActive ? 'danger' : 'warn', points: ownerActive ? 20 : 5,
        detail: 'Le propriétaire peut bloquer tous les transferts' + ownerNote + '.' });
    }
    if (is('is_blacklisted')) {
      add({ id: 'evm-blacklist', category: 'Contrat', label: 'Liste noire', status: 'warn', points: ownerActive ? 15 : 5,
        detail: 'Le contrat peut interdire à certaines adresses de vendre' + ownerNote + '.' });
    }
    if (is('selfdestruct')) {
      add({ id: 'evm-selfdestruct', category: 'Contrat', label: 'Autodestruction', status: 'warn', points: 15,
        detail: 'Le contrat peut être détruit, rendant les tokens inutilisables.' });
    }
    if (is('external_call')) {
      add({ id: 'evm-external', category: 'Contrat', label: 'Appels externes', status: 'warn', points: 5,
        detail: 'Le contrat appelle d\'autres contrats lors des transferts, ce qui peut changer son comportement.' });
    }
    if (is('trading_cooldown')) {
      add({ id: 'evm-cooldown', category: 'Contrat', label: 'Délai entre transactions', status: 'warn', points: 5,
        detail: 'Le contrat impose une attente entre deux transactions.' });
    }
    if (is('is_proxy') || (flag(gp.is_proxy) === undefined && evm.proxy === true)) {
      add({ id: 'evm-proxy', category: 'Contrat', label: 'Contrat modifiable (proxy)', status: 'warn', points: 15,
        detail: 'Le code du contrat peut être remplacé par son propriétaire à tout moment.' });
    }

    if (ownerActive) {
      add({ id: 'evm-owner', category: 'Contrat', label: 'Propriétaire actif', status: 'info',
        detail: 'Le contrat a toujours un propriétaire qui peut utiliser ses fonctions d\'administration.', address: owner });
    } else if (noOwner) {
      add({ id: 'evm-owner', category: 'Contrat', label: 'Propriété renoncée', status: 'ok',
        detail: 'Plus personne ne contrôle les fonctions d\'administration du contrat.' });
    }

    const creatorPct = num(gp.creator_percent);
    if (creatorPct !== null && creatorPct > 0.05) {
      add({ id: 'evm-creator-pct', category: 'Détenteurs', label: 'Le créateur garde des tokens', status: 'warn', points: creatorPct > 0.2 ? 12 : 6,
        detail: 'Le portefeuille du créateur détient ' + fmtPct(creatorPct * 100) + ' de l\'offre.', address: evm.creator });
    }
  }

  function solanaContractChecks(t, rc, add) {
    if (t.mintAuthority === undefined) {
      add({ id: 'mint-auth', category: 'Contrat', label: 'Autorité de mint', status: 'unknown', detail: 'Donnée indisponible.' });
    } else if (t.mintAuthority) {
      add({ id: 'mint-auth', category: 'Contrat', label: 'Autorité de mint active', status: 'danger', points: 30,
        detail: 'Le créateur peut imprimer de nouveaux tokens à l\'infini et diluer les détenteurs.', address: t.mintAuthority });
    } else {
      add({ id: 'mint-auth', category: 'Contrat', label: 'Autorité de mint révoquée', status: 'ok',
        detail: 'L\'offre est fixe : personne ne peut créer de nouveaux tokens.' });
    }

    if (t.freezeAuthority === undefined) {
      add({ id: 'freeze-auth', category: 'Contrat', label: 'Autorité de gel', status: 'unknown', detail: 'Donnée indisponible.' });
    } else if (t.freezeAuthority) {
      add({ id: 'freeze-auth', category: 'Contrat', label: 'Autorité de gel active', status: 'danger', points: 25,
        detail: 'Le créateur peut geler votre portefeuille et vous empêcher de vendre (honeypot).', address: t.freezeAuthority });
    } else {
      add({ id: 'freeze-auth', category: 'Contrat', label: 'Autorité de gel révoquée', status: 'ok',
        detail: 'Personne ne peut geler les tokens des détenteurs.' });
    }

    if (t.program === 'token-2022' && t.extensions) {
      const extChecks = extensionChecks(t.extensions);
      extChecks.forEach(add);
      if (extChecks.length === 0) {
        add({ id: 'ext', category: 'Contrat', label: 'Extensions Token-2022', status: 'ok',
          detail: 'Token-2022 sans extension dangereuse détectée.' });
      }
    }

    if (rc && rc.mutableMetadata === true) {
      add({ id: 'meta', category: 'Contrat', label: 'Métadonnées modifiables', status: 'warn', points: 5,
        detail: 'Le nom, le symbole et le logo peuvent être changés après coup.' });
    } else if (rc && rc.mutableMetadata === false) {
      add({ id: 'meta', category: 'Contrat', label: 'Métadonnées figées', status: 'ok',
        detail: 'Le nom et le logo ne peuvent plus être modifiés.' });
    }
  }

  /** Part de la liquidité (LP) brûlée ou verrouillée, d'après les détenteurs de LP GoPlus. */
  function evmLpLockedPct(gp) {
    if (!gp || !Array.isArray(gp.lp_holders) || gp.lp_holders.length === 0) return null;
    return gp.lp_holders.reduce((acc, h) => {
      const locked = flag(h.is_locked) === true || BURN_ADDRESSES.has(addrKey(h.address));
      return acc + (locked ? (num(h.percent) || 0) * 100 : 0);
    }, 0);
  }

  function analyze(data) {
    const checks = [];
    const add = (c) => checks.push(Object.assign({ points: 0 }, c));
    const t = data.token;
    const m = data.market;
    const rc = data.rugcheck;

    /* --- Contrat ------------------------------------------------------ */
    if (data.chain === 'robinhood') evmContractChecks(data.evm, add);
    else solanaContractChecks(t, rc, add);

    /* --- Détenteurs --------------------------------------------------- */
    if (data.holders && data.holders.length) {
      const humans = data.holders.filter((h) => !h.isProgram);
      const top10 = humans.slice(0, 10).reduce((a, h) => a + h.pct, 0);
      const top1 = humans.length ? humans[0].pct : 0;
      const excluded = data.holders.length - humans.length;
      const note = excluded ? ' (hors ' + excluded + ' pool' + (excluded > 1 ? 's' : '') + '/contrat' + (excluded > 1 ? 's' : '') + ')' : '';

      if (top10 > 50) {
        add({ id: 'top10', category: 'Détenteurs', label: 'Offre très concentrée', status: 'danger', points: 25,
          detail: 'Les 10 plus gros portefeuilles détiennent ' + fmtPct(top10) + note + '. Ils peuvent faire s\'effondrer le prix.' });
      } else if (top10 > 30) {
        add({ id: 'top10', category: 'Détenteurs', label: 'Offre assez concentrée', status: 'warn', points: 12,
          detail: 'Les 10 plus gros portefeuilles détiennent ' + fmtPct(top10) + note + '.' });
      } else {
        add({ id: 'top10', category: 'Détenteurs', label: 'Offre bien répartie', status: 'ok',
          detail: 'Les 10 plus gros portefeuilles détiennent ' + fmtPct(top10) + note + '.' });
      }

      if (top1 > 20) {
        add({ id: 'top1', category: 'Détenteurs', label: 'Une baleine domine', status: 'danger', points: 15,
          detail: 'Un seul portefeuille détient ' + fmtPct(top1) + ' de l\'offre.' });
      } else if (top1 > 10) {
        add({ id: 'top1', category: 'Détenteurs', label: 'Gros détenteur', status: 'warn', points: 7,
          detail: 'Le plus gros portefeuille détient ' + fmtPct(top1) + ' de l\'offre.' });
      }
    } else {
      add({ id: 'top10', category: 'Détenteurs', label: 'Répartition des détenteurs', status: 'unknown', detail: 'Donnée indisponible.' });
    }

    if (rc && rc.insidersDetected > 0) {
      add({ id: 'insiders', category: 'Détenteurs', label: 'Réseau d\'initiés détecté', status: 'warn', points: 10,
        detail: rc.insidersDetected + ' portefeuille(s) liés entre eux ont été détectés (souvent le créateur qui répartit ses tokens).' });
    }

    /* --- Marché ------------------------------------------------------- */
    if (!m) {
      add({ id: 'liquidity', category: 'Marché', label: 'Aucun marché trouvé', status: 'danger', points: 30,
        detail: 'Aucune paire d\'échange n\'a été trouvée : il est peut-être impossible de revendre ce token.' });
    } else {
      const liq = m.liquidityUsd || 0;
      if (liq < 1000) {
        add({ id: 'liquidity', category: 'Marché', label: 'Liquidité quasi nulle', status: 'danger', points: 25,
          detail: 'Seulement ' + fmtUsd(liq) + ' de liquidité : la moindre vente fait chuter le prix.' });
      } else if (liq < 10000) {
        add({ id: 'liquidity', category: 'Marché', label: 'Liquidité faible', status: 'warn', points: 15,
          detail: fmtUsd(liq) + ' de liquidité.' });
      } else if (liq < 50000) {
        add({ id: 'liquidity', category: 'Marché', label: 'Liquidité modeste', status: 'warn', points: 5,
          detail: fmtUsd(liq) + ' de liquidité.' });
      } else {
        add({ id: 'liquidity', category: 'Marché', label: 'Liquidité correcte', status: 'ok',
          detail: fmtUsd(liq) + ' de liquidité sur ' + m.pairCount + ' paire' + (m.pairCount > 1 ? 's' : '') + '.' });
      }

      if (m.marketCap && liq > 0 && liq / m.marketCap < 0.02) {
        add({ id: 'liq-ratio', category: 'Marché', label: 'Market cap gonflée', status: 'warn', points: 10,
          detail: 'La liquidité ne représente que ' + fmtPct((liq / m.marketCap) * 100) + ' de la market cap : la valorisation affichée est irréaliste.' });
      }

      if (m.pairCreatedAt) {
        const ageDays = (Date.now() - m.pairCreatedAt) / DAY_MS;
        if (ageDays < 1) {
          add({ id: 'age', category: 'Marché', label: 'Token très récent', status: 'warn', points: 15,
            detail: 'Premier marché créé il y a moins de 24 h. La majorité des rug pulls ont lieu dans les premiers jours.' });
        } else if (ageDays < 7) {
          add({ id: 'age', category: 'Marché', label: 'Token récent', status: 'warn', points: 7,
            detail: 'Premier marché créé il y a ' + Math.floor(ageDays) + ' jours.' });
        } else {
          add({ id: 'age', category: 'Marché', label: 'Token ancien', status: 'ok',
            detail: 'Premier marché créé il y a ' + Math.floor(ageDays) + ' jours.' });
        }
      }

      const buys = m.buys24h;
      const sells = m.sells24h;
      if (buys + sells > 0) {
        if (buys >= 20 && sells === 0) {
          add({ id: 'sells', category: 'Marché', label: 'Personne ne vend', status: 'danger', points: 40,
            detail: buys + ' achats et 0 vente sur 24 h : signe classique de honeypot (la vente est bloquée).' });
        } else if (buys + sells >= 50 && sells / (buys + sells) < 0.1) {
          add({ id: 'sells', category: 'Marché', label: 'Très peu de ventes', status: 'warn', points: 15,
            detail: buys + ' achats pour seulement ' + sells + ' ventes sur 24 h.' });
        } else {
          add({ id: 'sells', category: 'Marché', label: 'Achats et ventes normaux', status: 'ok',
            detail: buys + ' achats / ' + sells + ' ventes sur 24 h.' });
        }
      }

      if (m.priceChange24h !== null && m.priceChange24h <= -80) {
        add({ id: 'crash', category: 'Marché', label: 'Effondrement du prix', status: 'danger', points: 20,
          detail: 'Le prix a perdu ' + fmtPct(-m.priceChange24h) + ' en 24 h : rug pull possiblement déjà en cours.' });
      } else if (m.priceChange24h !== null && m.priceChange24h <= -50) {
        add({ id: 'crash', category: 'Marché', label: 'Forte chute du prix', status: 'warn', points: 10,
          detail: 'Le prix a perdu ' + fmtPct(-m.priceChange24h) + ' en 24 h.' });
      }

      if (m.websites.length === 0 && m.socials.length === 0) {
        add({ id: 'socials', category: 'Projet', label: 'Aucun site ni réseau social', status: 'warn', points: 10,
          detail: 'Aucune présence en ligne déclarée : projet anonyme.' });
      } else {
        add({ id: 'socials', category: 'Projet', label: 'Présence en ligne', status: 'ok',
          detail: [m.websites.length && m.websites.length + ' site(s)', m.socials.length && m.socials.length + ' réseau(x) social(aux)'].filter(Boolean).join(', ') + ' déclaré(s). Vérifiez qu\'ils sont authentiques.' });
      }
    }

    /* --- Liquidité verrouillée & RugCheck ----------------------------- */
    const lpLockedPct = data.chain === 'robinhood' ? evmLpLockedPct(data.evm.goplus) : rc ? rc.lpLockedPct : null;
    if (lpLockedPct !== null) {
      if (lpLockedPct < 50) {
        add({ id: 'lp-lock', category: 'Marché', label: 'Liquidité non verrouillée', status: 'danger', points: 20,
          detail: 'Seulement ' + fmtPct(lpLockedPct) + ' de la liquidité est verrouillée/brûlée : le créateur peut la retirer à tout moment.' });
      } else if (lpLockedPct < 90) {
        add({ id: 'lp-lock', category: 'Marché', label: 'Liquidité partiellement verrouillée', status: 'warn', points: 8,
          detail: fmtPct(lpLockedPct) + ' de la liquidité est verrouillée/brûlée.' });
      } else {
        add({ id: 'lp-lock', category: 'Marché', label: 'Liquidité verrouillée', status: 'ok',
          detail: fmtPct(lpLockedPct) + ' de la liquidité est verrouillée ou brûlée.' });
      }
    }

    if (rc && rc.rugged) {
      add({ id: 'rugged', category: 'RugCheck', label: 'Signalé comme « rugged »', status: 'danger', points: 60,
        detail: 'RugCheck a déjà classé ce token comme une arnaque avérée.' });
    }
    if (rc && rc.risks.length) {
      const dangers = rc.risks.filter((r) => r.level === 'danger');
      const warns = rc.risks.filter((r) => r.level === 'warn');
      const points = Math.min(20, dangers.length * 6 + warns.length * 2);
      add({ id: 'rugcheck', category: 'RugCheck', label: 'Alertes RugCheck', status: dangers.length ? 'danger' : warns.length ? 'warn' : 'info', points,
        detail: rc.risks.map((r) => r.name).join(' · ') });
    } else if (rc) {
      add({ id: 'rugcheck', category: 'RugCheck', label: 'Aucune alerte RugCheck', status: 'ok', detail: 'RugCheck ne signale aucun risque.' });
    }

    /* --- Ajustements -------------------------------------------------- */
    const matureAge = m && m.pairCreatedAt && (Date.now() - m.pairCreatedAt) / DAY_MS > 180;
    if (matureAge && m.liquidityUsd > 1000000) {
      add({ id: 'mature', category: 'Projet', label: 'Token établi', status: 'ok', points: -20,
        detail: 'Plus de 6 mois d\'existence et plus d\'1 M$ de liquidité : les arnaques survivent rarement aussi longtemps.' });
    }

    let score = checks.reduce((a, c) => a + c.points, 0);
    if (data.verifiedName) {
      add({ id: 'verified', category: 'Projet', label: 'Token reconnu : ' + data.verifiedName, status: 'ok',
        detail: 'Émetteur connu ; ses pouvoirs d\'administration sont normaux pour ce type d\'actif.' });
      score = Math.min(score, 5);
    }
    score = Math.max(0, Math.min(100, Math.round(score)));

    const known = checks.filter((c) => c.status !== 'unknown').length;
    const confidence = known >= 8 ? 'élevée' : known >= 5 ? 'moyenne' : 'faible';

    let level, verdict, summary;
    if (score >= 70) {
      level = 'scam';
      verdict = 'Très probablement une arnaque';
      summary = 'Plusieurs signaux majeurs d\'arnaque. N\'achetez pas.';
    } else if (score >= 45) {
      level = 'high';
      verdict = 'Risque élevé';
      summary = 'Des signaux sérieux ; forte probabilité de perte.';
    } else if (score >= 20) {
      level = 'medium';
      verdict = 'Prudence';
      summary = 'Quelques points d\'attention. Ne misez que ce que vous pouvez perdre.';
    } else {
      level = 'low';
      verdict = 'Risque faible';
      summary = 'Aucun signal majeur détecté. Cela ne garantit pas que le projet est fiable.';
    }

    const order = { danger: 0, warn: 1, unknown: 2, info: 3, ok: 4 };
    checks.sort((a, b) => order[a.status] - order[b.status] || b.points - a.points);

    return { score, level, verdict, summary, confidence, checks };
  }

  const api = { buildData, analyze, detectChain, fmtUsd, fmtPct, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analyzer = api;
})(typeof window !== 'undefined' ? window : globalThis);
