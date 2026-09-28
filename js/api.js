/*
 * Récupération des données depuis les API publiques (toutes appelables
 * directement depuis le navigateur, sans clé).
 */
(function (root) {
  'use strict';

  const DEFAULT_RPC = 'https://solana-rpc.publicnode.com';
  const TIMEOUT_MS = 15000;

  async function fetchJson(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, options));
      if (!res.ok) throw new Error('HTTP ' + res.status);
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
    if (!account) {
      const err = new Error('Cette adresse n\'existe pas sur Solana mainnet.');
      err.fatal = true;
      throw err;
    }
    if (!account.data || !account.data.parsed || account.data.parsed.type !== 'mint') {
      const err = new Error('Cette adresse n\'est pas un mint de token (c\'est peut-être un portefeuille ou une paire).');
      err.fatal = true;
      throw err;
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

  async function fetchDexScreener(mint) {
    const data = await fetchJson('https://api.dexscreener.com/tokens/v1/solana/' + encodeURIComponent(mint));
    return Array.isArray(data) ? data : (data && data.pairs) || [];
  }

  async function fetchRugCheck(mint) {
    return fetchJson('https://api.rugcheck.xyz/v1/tokens/' + encodeURIComponent(mint) + '/report');
  }

  /**
   * Interroge les trois sources en parallèle. Une source en échec n'empêche
   * pas l'analyse ; seule une erreur « fatale » (adresse invalide) l'arrête.
   */
  async function fetchAll(mint, rpcUrl) {
    const [onchain, dex, rug] = await Promise.allSettled([
      fetchOnChain(mint, rpcUrl),
      fetchDexScreener(mint),
      fetchRugCheck(mint),
    ]);

    if (onchain.status === 'rejected' && onchain.reason && onchain.reason.fatal) {
      throw onchain.reason;
    }

    const status = (r, extra) => (r.status === 'fulfilled' ? Object.assign({ ok: true }, extra) : { ok: false, error: r.reason && r.reason.message });
    return {
      sources: {
        onchain: onchain.status === 'fulfilled' ? onchain.value : null,
        dexPairs: dex.status === 'fulfilled' ? dex.value : null,
        rugcheck: rug.status === 'fulfilled' ? rug.value : null,
      },
      status: {
        onchain: status(onchain, onchain.value && onchain.value.holdersError ? { note: 'détenteurs indisponibles : ' + onchain.value.holdersError } : {}),
        dexscreener: status(dex),
        rugcheck: status(rug),
      },
    };
  }

  root.Api = { fetchAll, DEFAULT_RPC };
})(window);
