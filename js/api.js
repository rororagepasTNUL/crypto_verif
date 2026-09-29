/*
 * Récupération des données depuis les API publiques (toutes appelables
 * directement depuis le navigateur, sans clé).
 */
(function (root) {
  'use strict';

  const DEFAULT_RPC = 'https://solana-rpc.publicnode.com';
  const ROBINHOOD_CHAIN_ID = 4663;
  const BLOCKSCOUT_API = 'https://robinhoodchain.blockscout.com/api/v2';
  const TIMEOUT_MS = 15000;

  function fatal(message) {
    const err = new Error(message);
    err.fatal = true;
    return err;
  }

  async function fetchJson(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, options));
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('délai dépassé');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc(url, method, params) {
    const body = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (body.error) throw new Error(body.error.message || 'erreur RPC');
    return body.result;
  }

  /** Données on-chain : compte mint + plus gros détenteurs et leurs propriétaires. */
  async function fetchOnChain(mint, rpcUrl) {
    const url = rpcUrl || DEFAULT_RPC;
    const info = await rpc(url, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const account = info && info.value;
    if (!account) throw fatal('Cette adresse n\'existe pas sur Solana mainnet.');
    if (!account.data || !account.data.parsed || account.data.parsed.type !== 'mint') {
      throw fatal('Cette adresse n\'est pas un mint de token (c\'est peut-être un portefeuille ou une paire).');
    }

    const result = { mintAccount: account, largestAccounts: null, tokenAccountOwners: {}, ownerPrograms: {} };
    try {
      const largest = await rpc(url, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
      result.largestAccounts = (largest && largest.value) || [];

      const addrs = result.largestAccounts.map((a) => a.address);
      if (addrs.length) {
        const accs = await rpc(url, 'getMultipleAccounts', [addrs, { encoding: 'jsonParsed' }]);
        (accs.value || []).forEach((a, i) => {
          const owner = a && a.data && a.data.parsed && a.data.parsed.info && a.data.parsed.info.owner;
          if (owner) result.tokenAccountOwners[addrs[i]] = owner;
        });

        const owners = Array.from(new Set(Object.values(result.tokenAccountOwners)));
        if (owners.length) {
          const ownerAccs = await rpc(url, 'getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
          (ownerAccs.value || []).forEach((a, i) => {
            // null = PDA sans compte (autorité de programme), sinon le programme propriétaire.
            result.ownerPrograms[owners[i]] = a ? a.owner : null;
          });
        }
      }
    } catch (e) {
      // Certains RPC publics limitent getTokenLargestAccounts : on continue sans.
      result.holdersError = e.message;
    }
    return result;
  }

  /** `chainId` au format DexScreener : 'solana' ou 'robinhood'. */
  async function fetchDexScreener(chainId, address) {
    const data = await fetchJson('https://api.dexscreener.com/tokens/v1/' + chainId + '/' + encodeURIComponent(address));
    return Array.isArray(data) ? data : (data && data.pairs) || [];
  }

  async function fetchRugCheck(mint) {
    return fetchJson('https://api.rugcheck.xyz/v1/tokens/' + encodeURIComponent(mint) + '/report');
  }

  /** Analyse de sécurité GoPlus (honeypot, taxes, fonctions dangereuses…) pour un token Robinhood Chain. */
  async function fetchGoPlus(address) {
    const body = await fetchJson('https://api.gopluslabs.io/api/v1/token_security/' + ROBINHOOD_CHAIN_ID + '?contract_addresses=' + encodeURIComponent(address));
    if (!body || body.code !== 1) throw new Error((body && body.message) || 'réponse GoPlus invalide');
    const result = body.result || {};
    const entry = result[address.toLowerCase()] || Object.values(result)[0];
    if (!entry || Object.keys(entry).length === 0) throw new Error('token inconnu de GoPlus');
    return entry;
  }

  const settled = (r) => (r.status === 'fulfilled' ? r.value : null);
  const statusRow = (name, r, note) =>
    r.status === 'fulfilled' ? { name, ok: true, note: note || null } : { name, ok: false, error: r.reason && r.reason.message };

  async function fetchSolana(mint, rpcUrl) {
    const [onchain, dex, rug] = await Promise.allSettled([
      fetchOnChain(mint, rpcUrl),
      fetchDexScreener('solana', mint),
      fetchRugCheck(mint),
    ]);

    if (onchain.status === 'rejected' && onchain.reason && onchain.reason.fatal) {
      throw onchain.reason;
    }

    const dexPairs = settled(dex);
    return {
      hasData: !!(settled(onchain) || (dexPairs && dexPairs.length) || settled(rug)),
      sources: { chain: 'solana', onchain: settled(onchain), dexPairs, rugcheck: settled(rug) },
      status: [
        statusRow('RPC Solana (on-chain)', onchain, onchain.value && onchain.value.holdersError ? 'détenteurs indisponibles : ' + onchain.value.holdersError : null),
        statusRow('DexScreener (marché)', dex),
        statusRow('RugCheck', rug),
      ],
    };
  }

  async function fetchRobinhood(address) {
    const bs = BLOCKSCOUT_API + '/';
    const a = encodeURIComponent(address);
    const [gp, tok, holders, addr, dex] = await Promise.allSettled([
      fetchGoPlus(address),
      fetchJson(bs + 'tokens/' + a),
      fetchJson(bs + 'tokens/' + a + '/holders'),
      fetchJson(bs + 'addresses/' + a),
      fetchDexScreener('robinhood', address),
    ]);

    // Blockscout sait dire si l'adresse est un portefeuille ou un contrat qui n'est pas un token.
    if (tok.status === 'rejected' && tok.reason && tok.reason.status === 404) {
      if (addr.status === 'fulfilled' && addr.value && addr.value.is_contract === false) {
        throw fatal('Cette adresse est un portefeuille, pas un token.');
      }
      if (addr.status === 'fulfilled' && addr.value && addr.value.is_contract) {
        throw fatal('Ce contrat n\'est pas un token ERC-20 (c\'est peut-être une paire ou un autre contrat).');
      }
      if (addr.status === 'rejected' && addr.reason && addr.reason.status === 404 && gp.status === 'rejected') {
        throw fatal('Adresse inconnue sur Robinhood Chain.');
      }
    }

    const dexPairs = settled(dex);
    return {
      hasData: !!(settled(gp) || settled(tok) || (dexPairs && dexPairs.length)),
      sources: {
        chain: 'robinhood',
        goplus: settled(gp),
        bsToken: settled(tok),
        bsHolders: settled(holders),
        bsAddress: settled(addr),
        dexPairs,
      },
      status: [
        statusRow('GoPlus (sécurité du contrat)', gp),
        statusRow('Blockscout (explorateur)', tok, holders.status === 'rejected' ? 'détenteurs indisponibles' : null),
        statusRow('DexScreener (marché)', dex),
      ],
    };
  }

  /**
   * Interroge toutes les sources de la chaîne en parallèle. Une source en échec
   * n'empêche pas l'analyse ; seule une erreur « fatale » (adresse invalide) l'arrête.
   */
  async function fetchAll(address, chain, rpcUrl) {
    return chain === 'robinhood' ? fetchRobinhood(address) : fetchSolana(address, rpcUrl);
  }

  root.Api = { fetchAll, DEFAULT_RPC };
})(window);
