/* Vue « Tendances » partagée par la version ordinateur et la version mobile. */
(function (root) {
  'use strict';

  const { esc, fmtAge, fmtPrice, chainName } = Fmt;
  const SAFETY = {
    ok: ['✓', 'Contrat sain'],
    warn: ['!', 'À surveiller'],
    danger: ['✕', 'Risqué'],
    unknown: ['?', 'Non vérifié'],
  };

  function pct(v) {
    if (v === null || v === undefined) return '—';
    const r = Math.round(v * 10) / 10;
    return (r > 0 ? '+' : '') + r.toLocaleString('fr-FR') + ' %';
  }

  function trendClass(v) {
    return v === null || v === undefined ? '' : v >= 0 ? 'pos' : 'neg';
  }

  /**
   * Monte la vue dans `el`. `opts.getRpc()` renvoie l'URL RPC Solana,
   * `opts.onAnalyze(address)` lance l'analyse complète d'un token.
   */
  function create(el, opts) {
    const state = { chain: 'solana', items: [], loadedChain: null, loading: false, hideRisky: true, updatedAt: null, req: 0 };

    el.innerHTML = `
      <div class="trend-disclaimer">
        <strong>Ceci n'est pas une prédiction.</strong> Ce classement mesure la dynamique <em>actuelle</em>
        (prix, acheteurs, volume, liquidité) des tokens en tendance. La plupart des tokens qui s'envolent
        finissent par rechuter : n'investissez que ce que vous pouvez perdre.
      </div>
      <div class="trend-controls">
        <div class="seg" role="group" aria-label="Chaîne">
          <button type="button" data-chain="solana" aria-pressed="true">Solana</button>
          <button type="button" data-chain="robinhood" aria-pressed="false">Robinhood Chain</button>
        </div>
        <label class="toggle"><input type="checkbox" class="hide-risky" checked> Masquer les tokens risqués</label>
        <button type="button" class="refresh">↻ Actualiser</button>
      </div>
      <p class="trend-status" aria-live="polite"></p>
      <ol class="trend-list"></ol>`;

    const statusEl = el.querySelector('.trend-status');
    const listEl = el.querySelector('.trend-list');
    const refreshBtn = el.querySelector('.refresh');

    async function load() {
      // Chaque chargement a un numéro : seul le plus récent a le droit d'afficher son résultat.
      const req = ++state.req;
      const chain = state.chain;
      state.loading = true;
      refreshBtn.disabled = true;
      listEl.innerHTML = '';
      statusEl.textContent = 'Chargement des tokens en tendance sur ' + chainName(chain) + '…';
      try {
        const pages = await Api.fetchTrending(chain);
        const items = Momentum.parseGeckoPools(pages);
        items.forEach((it) => (it.momentum = Momentum.momentumScore(it)));
        if (req !== state.req) return;
        statusEl.textContent = items.length + ' tokens trouvés, vérification des contrats…';

        let safety = {};
        try {
          safety = await Api.fetchQuickSafety(chain, items.map((it) => it.address), opts.getRpc());
        } catch (e) {
          // Sans contrôle, les tokens restent « Non vérifié ».
        }
        items.forEach((it) => {
          const src = safety[it.address];
          it.safety = src ? Analyzer.contractRisk(Analyzer.buildData(it.address, src)) : { status: 'unknown', issues: [] };
        });

        if (req !== state.req) return; // un chargement plus récent a été lancé entre-temps
        state.items = items;
        state.loadedChain = chain;
        state.updatedAt = new Date();
        render();
      } catch (e) {
        if (req === state.req) statusEl.textContent = 'Impossible de charger les tendances : ' + (e.message || 'erreur inconnue') + '.';
      } finally {
        if (req === state.req) {
          state.loading = false;
          refreshBtn.disabled = false;
        }
      }
    }

    function render() {
      const ranked = Momentum.rank(state.items, state.hideRisky);
      const hidden = state.items.length - ranked.length;
      const time = state.updatedAt ? state.updatedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
      statusEl.textContent =
        ranked.length + ' tokens classés sur ' + chainName(state.chain) + ' · mis à jour à ' + time +
        (hidden ? ' · ' + hidden + ' token' + (hidden > 1 ? 's' : '') + ' risqué' + (hidden > 1 ? 's' : '') + ' masqué' + (hidden > 1 ? 's' : '') : '');

      if (!ranked.length) {
        listEl.innerHTML = '<li class="trend-empty">Aucun token à afficher. Décochez « Masquer les tokens risqués » pour tout voir.</li>';
        return;
      }

      listEl.innerHTML = ranked.map((it, i) => {
        const m = it.momentum;
        const s = SAFETY[it.safety.status];
        const buyers = Momentum.buyerShare(it);
        const safetyTitle = it.safety.issues.length ? it.safety.issues.join(' · ') : s[1];
        // Le logo recouvre les initiales ; s'il ne charge pas, les initiales restent (la grille ne bouge pas).
        const avatar = '<div class="trend-avatar placeholder">' + esc((it.symbol || '?').slice(0, 2)) +
          (it.image ? '<img src="' + esc(it.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
          '</div>';
        return `
          <li class="trend-card ${Momentum.isRisky(it) ? 'risky' : ''}">
            <div class="trend-rank">${i + 1}</div>
            ${avatar}
            <div class="trend-main">
              <div class="trend-title">
                <strong>${esc(it.symbol ? '$' + it.symbol : '?')}</strong>
                <span class="trend-name">${esc(it.name || '')}</span>
                <span class="safety ${it.safety.status}" title="${esc(safetyTitle)}">${s[0]} ${esc(it.safety.status === 'danger' && it.safety.issues[0] ? it.safety.issues[0] : s[1])}</span>
              </div>
              <div class="trend-metrics">
                <span>${esc(fmtPrice(it.priceUsd))}</span>
                <span class="${trendClass(it.priceChange.h1)}">1 h ${esc(pct(it.priceChange.h1))}</span>
                <span class="${trendClass(it.priceChange.h24)}">24 h ${esc(pct(it.priceChange.h24))}</span>
                <span>Liq. ${esc(Analyzer.fmtUsd(it.liquidityUsd))}</span>
                <span>Vol. ${esc(Analyzer.fmtUsd(it.volume.h24))}</span>
                ${buyers !== null ? '<span>' + Math.round(buyers * 100) + ' % acheteurs</span>' : ''}
                <span>${esc(fmtAge(it.createdAt))}</span>
              </div>
              <ul class="trend-reasons">
                ${m.reasons.map((r) => '<li class="' + (r.good ? 'up' : 'down') + '">' + esc(r.text) + '</li>').join('')}
              </ul>
            </div>
            <div class="trend-side">
              <div class="trend-score ${m.level}" title="${esc(m.label)}"><span>${m.score}</span><small>${esc(m.label)}</small></div>
              <button type="button" class="trend-analyze" data-address="${esc(it.address)}">Analyser</button>
            </div>
          </li>`;
      }).join('');
    }

    el.querySelectorAll('[data-chain]').forEach((b) =>
      b.addEventListener('click', () => {
        if (state.chain === b.dataset.chain) return;
        state.chain = b.dataset.chain;
        el.querySelectorAll('[data-chain]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        load();
      })
    );
    el.querySelector('.hide-risky').addEventListener('change', (e) => {
      state.hideRisky = e.target.checked;
      if (state.loadedChain === state.chain) render();
    });
    refreshBtn.addEventListener('click', load);
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('.trend-analyze');
      if (b) opts.onAnalyze(b.dataset.address);
    });

    return {
      /** À appeler quand la vue devient visible : charge la première fois. */
      show() {
        if (state.loadedChain !== state.chain && !state.loading) load();
      },
    };
  }

  root.TrendingView = { create };
})(window);
