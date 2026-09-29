(function () {
  'use strict';

  const RPC_KEY = 'crypto-verif:rpc';

  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const input = $('mint');
  const rpcInput = $('rpc');
  const submit = $('submit');
  const errorBox = $('error');
  const loading = $('loading');
  const result = $('result');

  const STATUS_ICON = { ok: '✓', warn: '!', danger: '✕', info: 'i', unknown: '?' };

  const { esc, short, fmtNum, fmtAge, fmtPrice, fmtChange, chainName, explorer, tokenLinks } = Fmt;

  /* ------------------------------------------------------------------ */

  function loadRpc() {
    let v = null;
    try { v = localStorage.getItem(RPC_KEY); } catch (e) { /* stockage indisponible */ }
    rpcInput.value = v || Api.DEFAULT_RPC;
  }

  rpcInput.addEventListener('change', () => {
    const v = rpcInput.value.trim();
    try {
      if (!v || v === Api.DEFAULT_RPC) localStorage.removeItem(RPC_KEY);
      else localStorage.setItem(RPC_KEY, v);
    } catch (e) { /* stockage indisponible */ }
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }

  async function run(mint) {
    errorBox.hidden = true;
    result.hidden = true;

    const chain = Analyzer.detectChain(mint);
    if (!chain) {
      showError('Adresse invalide : collez un mint Solana (32 à 44 caractères) ou une adresse de token Robinhood Chain (0x suivi de 40 caractères).');
      return;
    }

    const url = new URL(location.href);
    url.searchParams.set('mint', mint);
    history.replaceState(null, '', url);

    loading.hidden = false;
    submit.disabled = true;
    try {
      const { sources, status, hasData } = await Api.fetchAll(mint, chain, rpcInput.value.trim() || Api.DEFAULT_RPC);
      if (!hasData) {
        throw new Error('Aucune source de données n\'a répondu pour cette adresse sur ' + chainName(chain) + '. Vérifiez l\'adresse ou votre connexion.');
      }
      const data = Analyzer.buildData(mint, sources);
      const report = Analyzer.analyze(data);
      render(data, report, status);
    } catch (e) {
      showError(e.message || 'Erreur inattendue.');
    } finally {
      loading.hidden = true;
      submit.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */

  function render(data, report, status) {
    const t = data.token;
    const m = data.market;
    const title = t.name ? esc(t.name) + (t.symbol ? ' <span class="symbol">$' + esc(t.symbol) + '</span>' : '') : 'Token inconnu';
    const avatar = t.image
      ? '<img class="avatar" src="' + esc(t.image) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">'
      : '<div class="avatar placeholder">' + esc((t.symbol || '?').slice(0, 2)) + '</div>';

    const links = [];
    if (m && m.mainPair.url) links.push('<a href="' + esc(m.mainPair.url) + '" target="_blank" rel="noopener">DexScreener</a>');
    tokenLinks(data.chain, data.mint).forEach(([label, href]) =>
      links.push('<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + '</a>'));
    if (m) {
      m.websites.forEach((w) => links.push('<a href="' + esc(w.url) + '" target="_blank" rel="noopener nofollow">' + esc(w.label) + '</a>'));
      m.socials.forEach((s) => links.push('<a href="' + esc(s.url) + '" target="_blank" rel="noopener nofollow">' + esc(s.type) + '</a>'));
    }

    const stats = [
      ['Prix', m ? fmtPrice(m.priceUsd) : '—'],
      ['Market cap', m ? Analyzer.fmtUsd(m.marketCap) : '—'],
      ['Liquidité', m ? Analyzer.fmtUsd(m.liquidityUsd) : '—'],
      ['Volume 24 h', m ? Analyzer.fmtUsd(m.volume24h) : '—'],
      ['Variation 24 h', m ? fmtChange(m.priceChange24h) : '—'],
      ['Âge', m ? fmtAge(m.pairCreatedAt) : '—'],
      ['Détenteurs', data.holderCount ? fmtNum(data.holderCount) : '—'],
      ['Offre totale', fmtNum(t.supply)],
    ];

    const checks = report.checks.map((c) => `
      <li class="check ${c.status}">
        <span class="icon" aria-hidden="true">${STATUS_ICON[c.status]}</span>
        <div>
          <div class="check-title">${esc(c.label)} <span class="tag">${esc(c.category)}</span></div>
          <div class="check-detail">${esc(c.detail)}${c.address ? ' <a href="' + esc(explorer(data.chain, c.address)) + '" target="_blank" rel="noopener" class="mono">' + esc(short(c.address)) + '</a>' : ''}</div>
        </div>
        ${c.points ? '<span class="points">' + (c.points > 0 ? '+' : '') + c.points + '</span>' : ''}
      </li>`).join('');

    let holders = '';
    if (data.holders && data.holders.length) {
      const max = Math.max.apply(null, data.holders.map((h) => h.pct));
      holders = `
        <div class="card">
          <h3>Plus gros détenteurs</h3>
          <ol class="holders">
            ${data.holders.slice(0, 15).map((h) => `
              <li class="${h.isProgram ? 'program' : ''}">
                <a class="mono" href="${esc(explorer(data.chain, h.address))}" target="_blank" rel="noopener">${esc(short(h.address))}</a>
                <span class="holder-label">${h.label ? esc(h.label) : h.insider ? 'initié' : ''}</span>
                <span class="bar"><span style="width:${Math.max(1, (h.pct / max) * 100).toFixed(1)}%"></span></span>
                <span class="pct">${esc(Analyzer.fmtPct(h.pct))}</span>
              </li>`).join('')}
          </ol>
          <p class="hint">Les pools et contrats (en gris) sont exclus du calcul de concentration.</p>
        </div>`;
    }

    const sourceRow = (s) =>
      '<li class="' + (s.ok ? 'ok' : 'ko') + '">' + esc(s.name) + ' : ' + (s.ok ? 'OK' + (s.note ? ' (' + esc(s.note) + ')' : '') : 'indisponible' + (s.error ? ' (' + esc(s.error) + ')' : '')) + '</li>';

    result.innerHTML = `
      <div class="card verdict ${report.level}">
        <div class="gauge" style="--score:${report.score}">
          <div class="gauge-inner"><span class="score">${report.score}</span><span class="max">/100</span></div>
        </div>
        <div class="verdict-text">
          <div class="verdict-label">${esc(report.verdict)}</div>
          <p>${esc(report.summary)}</p>
          <p class="confidence">Fiabilité de l'analyse : <strong>${esc(report.confidence)}</strong></p>
        </div>
      </div>

      <div class="card token">
        ${avatar}
        <div class="token-info">
          <h2>${title} <span class="chain-badge ${esc(data.chain)}">${esc(chainName(data.chain))}</span></h2>
          <div class="mono mint">${esc(data.mint)}</div>
          <div class="links">${links.join('')}</div>
        </div>
      </div>

      <div class="stats">
        ${stats.map(([k, v]) => '<div class="stat"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>').join('')}
      </div>

      <div class="card">
        <h3>Vérifications</h3>
        <ul class="checks">${checks}</ul>
      </div>

      ${holders}

      <details class="card sources">
        <summary>Sources de données</summary>
        <ul>${status.map(sourceRow).join('')}</ul>
      </details>`;
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------------ */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(input.value.trim());
  });

  document.querySelectorAll('[data-mint]').forEach((b) =>
    b.addEventListener('click', () => {
      input.value = b.dataset.mint;
      run(b.dataset.mint);
    })
  );

  /* --- Onglets -------------------------------------------------------- */

  const trending = TrendingView.create($('view-trending'), {
    getRpc: () => rpcInput.value.trim() || Api.DEFAULT_RPC,
    onAnalyze: (address) => {
      showView('check');
      input.value = address;
      run(address);
    },
  });

  function showView(view) {
    document.querySelectorAll('.tabs [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    $('view-check').hidden = view !== 'check';
    $('view-trending').hidden = view !== 'trending';
    const url = new URL(location.href);
    url.hash = view === 'trending' ? 'tendances' : '';
    history.replaceState(null, '', url);
    if (view === 'trending') trending.show();
  }

  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  loadRpc();
  const initial = new URLSearchParams(location.search).get('mint');
  if (initial) {
    input.value = initial;
    run(initial.trim());
  } else if (location.hash === '#tendances') {
    showView('trending');
  }
})();
