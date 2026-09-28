(function () {
  'use strict';

  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const RPC_KEY = 'crypto-verif:rpc';
  const RECENT_KEY = 'crypto-verif:recent';
  const STATUS_ICON = { ok: '✓', warn: '!', danger: '✕', info: 'i', unknown: '?' };
  const { esc, short, fmtNum, fmtAge, fmtPrice, fmtChange, solscan } = Fmt;

  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const input = $('mint');
  const clearBtn = $('clear');
  const pasteBtn = $('paste');
  const submit = $('submit');
  const rpcInput = $('rpc');
  const errorBox = $('error');
  const loading = $('loading');
  const result = $('result');
  const toast = $('toast');

  /* --- Stockage local (facultatif) ------------------------------------ */

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* stockage indisponible */ }
    return null;
  }

  function getRecent() {
    try { return JSON.parse(store(RECENT_KEY)) || []; } catch (e) { return []; }
  }

  function addRecent(mint, symbol) {
    const list = getRecent().filter((r) => r.mint !== mint);
    list.unshift({ mint, symbol: symbol || null });
    store(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
    renderRecent();
  }

  function renderRecent() {
    const list = getRecent();
    $('recent-wrap').hidden = list.length === 0;
    $('recent').innerHTML = list
      .map((r) => '<button type="button" class="chip" data-mint="' + esc(r.mint) + '">' + esc(r.symbol ? '$' + r.symbol : short(r.mint)) + '</button>')
      .join('');
  }

  /* --- Petits utilitaires UI ------------------------------------------ */

  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2200);
  }

  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(msg || 'Copié');
    } catch (e) {
      showToast('Copie impossible sur ce navigateur');
    }
  }

  function syncClear() {
    clearBtn.hidden = input.value.length === 0;
  }

  function vibrate(level) {
    if (navigator.vibrate && (level === 'scam' || level === 'high')) navigator.vibrate([60, 40, 60]);
  }

  /* --- Analyse -------------------------------------------------------- */

  async function run(raw) {
    const mint = (raw || '').trim();
    errorBox.hidden = true;
    result.hidden = true;
    input.blur();

    if (!BASE58.test(mint)) {
      errorBox.textContent = 'Adresse invalide : une adresse mint Solana fait 32 à 44 caractères en base58.';
      errorBox.hidden = false;
      return;
    }

    const url = new URL(location.href);
    url.searchParams.set('mint', mint);
    history.replaceState(null, '', url);

    loading.hidden = false;
    submit.disabled = true;
    loading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const { sources, status } = await Api.fetchAll(mint, rpcInput.value.trim() || Api.DEFAULT_RPC);
      if (!sources.onchain && !(sources.dexPairs && sources.dexPairs.length) && !sources.rugcheck) {
        throw new Error('Aucune source de données n\'a répondu. Vérifiez l\'adresse, votre connexion ou l\'URL RPC.');
      }
      const data = Analyzer.buildData(mint, sources);
      const report = Analyzer.analyze(data);
      render(data, report, status);
      addRecent(mint, data.token.symbol);
      vibrate(report.level);
    } catch (e) {
      errorBox.textContent = e.message || 'Erreur inattendue.';
      errorBox.hidden = false;
    } finally {
      loading.hidden = true;
      submit.disabled = false;
    }
  }

  /* --- Rendu ---------------------------------------------------------- */

  function checkItem(c) {
    return `
      <li class="check ${c.status}">
        <span class="icon" aria-hidden="true">${STATUS_ICON[c.status]}</span>
        <div class="check-body">
          <div class="check-title">${esc(c.label)}${c.points ? '<span class="points">' + (c.points > 0 ? '+' : '') + c.points + '</span>' : ''}</div>
          <div class="check-detail">${esc(c.detail)}${c.address ? ' <a href="' + esc(solscan(c.address)) + '" target="_blank" rel="noopener" class="mono">' + esc(short(c.address)) + '</a>' : ''}</div>
        </div>
      </li>`;
  }

  function render(data, report, status) {
    const t = data.token;
    const m = data.market;

    const alerts = report.checks.filter((c) => c.status === 'danger' || c.status === 'warn');
    const others = report.checks.filter((c) => c.status !== 'danger' && c.status !== 'warn');

    const avatar = t.image
      ? '<img class="avatar" src="' + esc(t.image) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">'
      : '<div class="avatar placeholder">' + esc((t.symbol || '?').slice(0, 2)) + '</div>';

    const links = [];
    if (m && m.mainPair.url) links.push(['DexScreener', m.mainPair.url]);
    links.push(['RugCheck', 'https://rugcheck.xyz/tokens/' + encodeURIComponent(data.mint)]);
    links.push(['Solscan', 'https://solscan.io/token/' + encodeURIComponent(data.mint)]);
    if (m) {
      m.websites.forEach((w) => links.push(['🌐 ' + w.label, w.url]));
      m.socials.forEach((s) => links.push([s.type, s.url]));
    }

    const stats = [
      ['Prix', m ? fmtPrice(m.priceUsd) : '—'],
      ['Market cap', m ? Analyzer.fmtUsd(m.marketCap) : '—'],
      ['Liquidité', m ? Analyzer.fmtUsd(m.liquidityUsd) : '—'],
      ['Volume 24 h', m ? Analyzer.fmtUsd(m.volume24h) : '—'],
      ['Variation 24 h', m ? fmtChange(m.priceChange24h) : '—'],
      ['Âge', m ? fmtAge(m.pairCreatedAt) : '—'],
      ['Détenteurs', data.rugcheck && data.rugcheck.totalHolders ? fmtNum(data.rugcheck.totalHolders) : '—'],
      ['Offre', fmtNum(t.supply)],
    ];

    let holders = '';
    if (data.holders && data.holders.length) {
      const max = Math.max.apply(null, data.holders.map((h) => h.pct));
      holders = `
        <details class="card">
          <summary>Plus gros détenteurs</summary>
          <ol class="holders">
            ${data.holders.slice(0, 10).map((h) => `
              <li class="${h.isProgram ? 'program' : ''}">
                <div class="holder-row">
                  <a class="mono" href="${esc(solscan(h.address))}" target="_blank" rel="noopener">${esc(short(h.address))}</a>
                  ${h.label ? '<span class="holder-label">' + esc(h.label) + '</span>' : h.insider ? '<span class="holder-label">initié</span>' : ''}
                  <span class="pct">${esc(Analyzer.fmtPct(h.pct))}</span>
                </div>
                <span class="bar"><span style="width:${Math.max(1, (h.pct / max) * 100).toFixed(1)}%"></span></span>
              </li>`).join('')}
          </ol>
          <p class="hint">Les pools et contrats (en gris) sont exclus du calcul de concentration.</p>
        </details>`;
    }

    const sourceRow = (name, s) =>
      '<li class="' + (s.ok ? 'ok' : 'ko') + '">' + esc(name) + ' : ' + (s.ok ? 'OK' + (s.note ? ' (' + esc(s.note) + ')' : '') : 'indisponible' + (s.error ? ' (' + esc(s.error) + ')' : '')) + '</li>';

    result.innerHTML = `
      <div class="verdict ${report.level}">
        <div class="gauge" style="--score:${report.score}">
          <div class="gauge-inner"><span class="score">${report.score}</span><span class="max">/100</span></div>
        </div>
        <div class="verdict-label">${esc(report.verdict)}</div>
        <p class="verdict-summary">${esc(report.summary)}</p>
        <p class="confidence">Fiabilité : <strong>${esc(report.confidence)}</strong></p>
      </div>

      <div class="card token">
        ${avatar}
        <div class="token-info">
          <div class="token-name">${t.name ? esc(t.name) : 'Token inconnu'}</div>
          <div class="token-sub">${t.symbol ? '$' + esc(t.symbol) + ' · ' : ''}<span class="mono">${esc(short(data.mint))}</span></div>
        </div>
        <button type="button" class="icon-btn" data-copy="${esc(data.mint)}" aria-label="Copier l'adresse">⧉</button>
      </div>

      <div class="stats">
        ${stats.map(([k, v]) => '<div class="stat"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>').join('')}
      </div>

      ${alerts.length ? `
      <div class="card">
        <h3>⚠️ Alertes <span class="count">${alerts.length}</span></h3>
        <ul class="checks">${alerts.map(checkItem).join('')}</ul>
      </div>` : ''}

      ${others.length ? `
      <details class="card" ${alerts.length ? '' : 'open'}>
        <summary>✓ Autres vérifications <span class="count">${others.length}</span></summary>
        <ul class="checks">${others.map(checkItem).join('')}</ul>
      </details>` : ''}

      ${holders}

      <div class="links">
        ${links.map(([label, href]) => '<a class="link-chip" href="' + esc(href) + '" target="_blank" rel="noopener nofollow">' + esc(label) + '</a>').join('')}
      </div>

      <details class="card sources">
        <summary>Sources de données</summary>
        <ul>
          ${sourceRow('RPC Solana', status.onchain)}
          ${sourceRow('DexScreener', status.dexscreener)}
          ${sourceRow('RugCheck', status.rugcheck)}
        </ul>
      </details>

      <div class="bottom-bar">
        <button type="button" class="btn secondary" id="share">↗ Partager</button>
        <button type="button" class="btn primary" id="again">Nouvelle analyse</button>
      </div>`;

    result.hidden = false;
    result.querySelector('[data-copy]').addEventListener('click', (e) => copy(e.currentTarget.dataset.copy, 'Adresse copiée'));
    $('again').addEventListener('click', newSearch);
    $('share').addEventListener('click', () => share(t, report));
    requestAnimationFrame(() => result.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function share(t, report) {
    const url = location.href;
    const text = (t.symbol ? '$' + t.symbol + ' : ' : '') + report.verdict + ' (' + report.score + '/100) — Crypto Verif';
    if (navigator.share) {
      try { await navigator.share({ title: 'Crypto Verif', text, url }); } catch (e) { /* partage annulé */ }
    } else {
      copy(url, 'Lien copié');
    }
  }

  function newSearch() {
    result.hidden = true;
    errorBox.hidden = true;
    input.value = '';
    syncClear();
    const url = new URL(location.href);
    url.searchParams.delete('mint');
    history.replaceState(null, '', url);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    input.focus();
  }

  /* --- Événements ----------------------------------------------------- */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(input.value);
  });

  input.addEventListener('input', syncClear);
  clearBtn.addEventListener('click', () => {
    input.value = '';
    syncClear();
    input.focus();
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return showToast('Presse-papiers vide');
      input.value = text;
      syncClear();
      run(text);
    } catch (e) {
      // Lecture refusée (navigateur ou page non sécurisée) : on laisse coller à la main.
      input.focus();
      showToast('Appui long dans le champ → Coller');
    }
  });

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-mint]');
    if (!chip) return;
    input.value = chip.dataset.mint;
    syncClear();
    run(chip.dataset.mint);
  });

  $('home').addEventListener('click', newSearch);

  rpcInput.value = store(RPC_KEY) || Api.DEFAULT_RPC;
  rpcInput.addEventListener('change', () => {
    const v = rpcInput.value.trim();
    store(RPC_KEY, !v || v === Api.DEFAULT_RPC ? null : v);
  });

  // Garde le mint en passant à la version ordinateur.
  const initial = new URLSearchParams(location.search).get('mint');
  $('desktop-link').addEventListener('click', (e) => {
    const m = new URLSearchParams(location.search).get('mint');
    if (m) e.currentTarget.href = 'index.html?desktop=1&mint=' + encodeURIComponent(m);
  });

  renderRecent();
  if (initial) {
    input.value = initial;
    syncClear();
    run(initial);
  }
})();
