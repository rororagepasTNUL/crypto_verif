# Crypto Verif

Petit site web statique : on colle l'adresse **mint** d'un token Solana et il estime le risque d'arnaque (rug pull, honeypot…) avec un score de 0 à 100.

## Lancer le site

Aucune installation ni build n'est nécessaire, c'est du HTML/CSS/JS pur.

```bash
python3 -m http.server 8000   # ou : npm start
# puis ouvrir http://localhost:8000
```

On peut aussi simplement ouvrir `index.html` dans un navigateur, ou le publier sur GitHub Pages.
Un lien direct vers une analyse : `index.html?mint=<ADRESSE>`.

## Sources de données (gratuites, sans clé)

| Source | Ce qu'on en tire |
| --- | --- |
| RPC Solana (`solana-rpc.publicnode.com` par défaut, modifiable dans « Paramètres ») | autorités de mint et de gel, extensions Token-2022, offre, plus gros détenteurs |
| [DexScreener](https://docs.dexscreener.com/api/reference) | prix, market cap, liquidité, volume, achats/ventes, âge, site et réseaux sociaux |
| [RugCheck](https://api.rugcheck.xyz/swagger/index.html) | liquidité verrouillée, métadonnées modifiables, initiés, alertes, statut « rugged » |

Si une source ne répond pas, l'analyse continue avec les autres et la « fiabilité de l'analyse » baisse.

## Critères du score

Chaque signal ajoute des points de risque (plafonné à 100) :

| Signal | Points |
| --- | --- |
| Autorité de mint active (impression infinie) | +30 |
| Autorité de gel active (honeypot) | +25 |
| Token-2022 : délégué permanent / non transférable / taxe ≥ 10 % / hook / gel par défaut / pausable | +10 à +40 |
| Top 10 détenteurs > 50 % (> 30 %), hors pools et contrats | +25 (+12) |
| Un portefeuille > 20 % (> 10 %) | +15 (+7) |
| Aucun marché / liquidité < 1 k$ / < 10 k$ / < 50 k$ | +30 / +25 / +15 / +5 |
| Liquidité < 2 % de la market cap | +10 |
| Liquidité verrouillée < 50 % (< 90 %) | +20 (+8) |
| Des achats mais 0 vente sur 24 h (honeypot) | +40 |
| Moins de 10 % de ventes | +15 |
| Pair créée il y a < 24 h (< 7 j) | +15 (+7) |
| Chute du prix ≥ 80 % (≥ 50 %) sur 24 h | +20 (+10) |
| Ni site ni réseau social | +10 |
| Métadonnées modifiables | +5 |
| Initiés détectés (RugCheck) | +10 |
| Alertes RugCheck | jusqu'à +20 |
| Marqué « rugged » par RugCheck | +60 |
| Token établi (> 6 mois et > 1 M$ de liquidité) | −20 |

Verdict : **0–19** risque faible · **20–44** prudence · **45–69** risque élevé · **70+** très probablement une arnaque.
Les tokens connus (USDC, USDT, wSOL) sont plafonnés à 5, car leurs autorités actives sont normales.

La logique de score se trouve dans [`js/analyze.js`](js/analyze.js).

## Tests

```bash
npm test
```

> ⚠️ Outil indicatif basé sur des heuristiques : ce n'est pas un conseil financier.
