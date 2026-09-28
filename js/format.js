/* Helpers d'affichage partagés par la version ordinateur et la version mobile. */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function short(addr) {
    return addr && addr.length > 12 ? addr.slice(0, 4) + '…' + addr.slice(-4) : addr;
  }

  function fmtNum(v) {
    if (v === null || v === undefined) return '—';
    return new Intl.NumberFormat('fr-FR', { notation: v >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(v);
  }

  function fmtAge(ts) {
    if (!ts) return '—';
    const h = (Date.now() - ts) / 3600000;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min';
    if (h < 48) return Math.round(h) + ' h';
    const d = h / 24;
    if (d < 60) return Math.round(d) + ' jours';
    if (d < 730) return Math.round(d / 30) + ' mois';
    return (Math.round((d / 365) * 10) / 10).toLocaleString('fr-FR') + ' ans';
  }

  function fmtPrice(v) {
    if (v === null || v === undefined) return '—';
    if (v >= 1) return root.Analyzer.fmtUsd(v);
    return '$' + v.toPrecision(4).replace(/\.?0+$/, '');
  }

  function fmtChange(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v.toLocaleString('fr-FR') + ' %';
  }

  function solscan(addr) {
    return 'https://solscan.io/account/' + encodeURIComponent(addr);
  }

  root.Fmt = { esc, short, fmtNum, fmtAge, fmtPrice, fmtChange, solscan };
})(window);
