/*
 * Tokens en tendance (données GeckoTerminal) et score de dynamique.
 *
 * Le score mesure l'élan ACTUEL (prix, acheteurs, volume, liquidité) :
 * ce n'est pas une prédiction. Aucune dépendance au DOM (testé sous Node).
 */
(function (root) {
  'use strict';

  const Analyzer = typeof module !== 'undefined' && module.exports ? require('./analyze.js') : root.Analyzer;

  // Tokens « monnaie » qui apparaissent comme base de certaines pools : ce ne sont pas des paris.
  const SKIP_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'USD1', 'PYUSD', 'USDS', 'DAI', 'ETH', 'WETH', 'WBTC', 'CBBTC']);

  function num(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && isFinite(n) ? n : null;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function signed(v, digits) {
    const r = Math.round(v * Math.pow(10, digits || 0)) / Math.pow(10, digits || 0);
    return (r > 0 ? '+' : '') + r.toLocaleString('fr-FR') + ' %';
  }

  /**
   * Transforme une (ou plusieurs) réponse(s) `trending_pools` de GeckoTerminal
   * en une liste de tokens, dédoublonnée (on garde la pool la plus liquide).
   */
  function parseGeckoPools(responses) {
    const tokensById = {};
    const pools = [];
    for (const body of responses) {
      if (!body) continue;
      for (const inc of body.included || []) {
        if (inc.type === 'token') tokensById[inc.id] = inc.attributes || {};
      }
      for (const p of body.data || []) pools.push(p);
    }

    const byToken = new Map();
    for (const p of pools) {
      const a = p.attributes || {};
      const rel = p.relationships || {};
      const baseId = rel.base_token && rel.base_token.data && rel.base_token.data.id;
      if (!baseId) continue;
      const tok = tokensById[baseId] || {};
      const address = tok.address || baseId.slice(baseId.indexOf('_') + 1);
      const symbol = tok.symbol || (a.name || '').split(' / ')[0] || null;
      if (!address || (symbol && SKIP_SYMBOLS.has(symbol.toUpperCase()))) continue;

      const tx = a.transactions || {};
      const pc = a.price_change_percentage || {};
      const vol = a.volume_usd || {};
      const image = tok.image_url && !/missing/.test(tok.image_url) ? Analyzer.safeUrl(tok.image_url) : null;
      const item = {
        address,
        symbol,
        name: tok.name || null,
        image,
        pool: a.address || null,
        poolName: a.name || null,
        dex: rel.dex && rel.dex.data ? rel.dex.data.id : null,
        priceUsd: num(a.base_token_price_usd),
        marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
        liquidityUsd: num(a.reserve_in_usd) || 0,
        createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || null : null,
        priceChange: { h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
        volume: { h1: num(vol.h1), h24: num(vol.h24) },
        tx1h: tx.h1 || {},
        tx24h: tx.h24 || {},
      };

      const key = address.startsWith('0x') ? address.toLowerCase() : address;
      const prev = byToken.get(key);
      if (!prev || item.liquidityUsd > prev.liquidityUsd) byToken.set(key, item);
    }
    return Array.from(byToken.values());
  }

  /** Score de dynamique 0–100 (50 = neutre) et les raisons qui l'expliquent. */
  function momentumScore(t) {
    const parts = [];
    const add = (pts, text) => parts.push({ pts, text });
    const pc = t.priceChange;

    // Un token qui a déjà explosé est plus proche de la chute que du décollage.
    const overheated = (pc.h24 !== null && pc.h24 > 300) || (pc.h6 !== null && pc.h6 > 200);
    if (pc.h24 !== null) {
      if (pc.h24 > 300) add(-20, 'Déjà ' + signed(pc.h24) + ' en 24 h : gros risque de retournement');
      else if (pc.h24 > 0) add(Math.min(20, pc.h24 / 5), 'Prix ' + signed(pc.h24) + ' sur 24 h');
      else add(Math.max(-20, pc.h24 / 2.5), 'Prix ' + signed(pc.h24) + ' sur 24 h');
    }
    if (pc.h6 !== null && pc.h6 > 200) add(-15, 'Déjà ' + signed(pc.h6) + ' en 6 h : mouvement parabolique');
    else if (pc.h6 !== null) add(clamp(pc.h6 / 3, -10, 10), 'Prix ' + signed(pc.h6) + ' sur 6 h');
    if (pc.h1 !== null) add(clamp(pc.h1, -10, 10), 'Prix ' + signed(pc.h1, 1) + ' sur la dernière heure');

    const b24 = num(t.tx24h.buyers) || 0;
    const s24 = num(t.tx24h.sellers) || 0;
    if (b24 + s24 >= 20) {
      const r = b24 / (b24 + s24);
      add(clamp((r - 0.5) * 100, -15, 15), Math.round(r * 100) + ' % des portefeuilles actifs sont acheteurs (24 h)');
    }
    const b1 = num(t.tx1h.buyers) || 0;
    const s1 = num(t.tx1h.sellers) || 0;
    if (b1 + s1 >= 10) {
      const r = b1 / (b1 + s1);
      add(clamp((r - 0.5) * 60, -10, 10), Math.round(r * 100) + ' % d\'acheteurs sur la dernière heure');
    }

    const v24 = t.volume.h24;
    const v1 = t.volume.h1;
    if (v24 && v1 !== null) {
      const acc = (v1 * 24) / v24;
      const x = (Math.round(acc * 10) / 10).toLocaleString('fr-FR');
      add(clamp((acc - 1) * 8, -8, 12), acc >= 1 ? 'Volume de la dernière heure ×' + x + ' la moyenne' : 'Volume en baisse (×' + x + ' la moyenne)');
    }

    const liq = t.liquidityUsd;
    if (liq > 0 && v24) {
      const turnover = v24 / liq;
      if (turnover > 50) add(-5, 'Volume anormal par rapport à la liquidité (échanges artificiels ?)');
      else if (turnover >= 1) add(Math.min(10, turnover), 'Volume 24 h = ×' + Math.round(turnover) + ' la liquidité');
      else if (turnover < 0.2) add(-5, 'Très peu d\'échanges');
    }

    if (liq < 10000) add(-25, 'Liquidité très faible (' + Analyzer.fmtUsd(liq) + ')');
    else if (liq < 50000) add(-10, 'Liquidité faible (' + Analyzer.fmtUsd(liq) + ')');
    else if (liq >= 250000) add(5, 'Liquidité solide (' + Analyzer.fmtUsd(liq) + ')');

    if (t.createdAt) {
      const hours = (Date.now() - t.createdAt) / 3600000;
      if (hours < 6) add(-15, 'Pool créée il y a moins de 6 h');
      else if (hours > 24 * 30) add(3, 'Existe depuis plus d\'un mois');
    }

    if (b24 && b24 < 50) add(-10, 'Moins de 50 acheteurs uniques en 24 h');
    else if (b24 > 2000) add(5, 'Plus de 2 000 acheteurs uniques en 24 h');

    // tanh : le score approche 0 ou 100 sans jamais saturer, pour garder un classement lisible.
    const total = parts.reduce((a, p) => a + p.pts, 0);
    let score = clamp(Math.round(50 + 50 * Math.tanh(total / 60)), 0, 100);
    if (overheated) score = Math.min(score, 60);

    const reasons = parts
      .filter((p) => Math.abs(p.pts) >= 1)
      .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
      .slice(0, 3)
      .map((p) => ({ good: p.pts > 0, text: p.text }));

    let level, label;
    if (overheated) { level = 'hot'; label = 'Surchauffe'; }
    else if (score >= 75) { level = 'strong'; label = 'Forte dynamique'; }
    else if (score >= 60) { level = 'up'; label = 'Dynamique positive'; }
    else if (score >= 45) { level = 'flat'; label = 'Neutre'; }
    else { level = 'down'; label = 'Dynamique faible'; }

    return { score, level, label, reasons, overheated };
  }

  /** Part d'acheteurs uniques sur 24 h, ou null si trop peu de données. */
  function buyerShare(t) {
    const b = num(t.tx24h.buyers) || 0;
    const s = num(t.tx24h.sellers) || 0;
    return b + s >= 20 ? b / (b + s) : null;
  }

  /** Trie par dynamique décroissante et masque (optionnellement) les tokens risqués. */
  function rank(items, hideRisky) {
    return items
      .filter((it) => !hideRisky || !isRisky(it))
      .sort((a, b) => b.momentum.score - a.momentum.score);
  }

  function isRisky(it) {
    return it.liquidityUsd < 10000 || (it.safety && it.safety.status === 'danger');
  }

  const api = { parseGeckoPools, momentumScore, buyerShare, rank, isRisky };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Momentum = api;
})(typeof window !== 'undefined' ? window : globalThis);
