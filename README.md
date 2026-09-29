# Crypto Verif

Petit site web statique : on colle l'adresse d'un token **Solana** (mint) ou **Robinhood Chain** (adresse `0x…`) et il estime le risque d'arnaque (rug pull, honeypot…) avec un score de 0 à 100.
La chaîne est détectée automatiquement d'après le format de l'adresse.

## Lancer le site

Aucune installation ni build n'est nécessaire, c'est du HTML/CSS/JS pur.

```bash
npm start
# puis ouvrir http://localhost:8000
```

`npm start` lance un mini serveur Node (`server.js`, sans dépendance) et fonctionne sous Windows, macOS et Linux.
On peut aussi simplement double-cliquer sur `index.html`, ou publier le dossier sur GitHub Pages.
Un lien direct vers une analyse : `index.html?mint=<ADRESSE>`.

## Onglet « Tendances »

L'onglet **🔥 Tendances** (ou `index.html#tendances`) classe les tokens en tendance sur Solana ou Robinhood Chain selon leur **dynamique actuelle**.

> ⚠️ **Ce n'est pas une prédiction.** Personne ne peut savoir quel token va monter. Le classement mesure seulement l'élan du moment, et la plupart des tokens qui s'envolent finissent par rechuter.

1. Les ~40 pools en tendance sont récupérées sur [GeckoTerminal](https://www.geckoterminal.com) (API publique gratuite). Un token n'apparaît qu'une fois, avec sa pool la plus liquide ; SOL, WETH et les stablecoins sont ignorés.
2. Chaque token reçoit un **score de dynamique** de 0 à 100 (50 = neutre), avec les 3 raisons principales affichées :

   | Signal | Effet |
   | --- | --- |
   | Hausse du prix sur 24 h / 6 h / 1 h | jusqu'à +20 / +10 / +10 (baisse : jusqu'à −20 / −10 / −10) |
   | Part de portefeuilles acheteurs (24 h, puis dernière heure) | jusqu'à ±15 et ±10 |
   | Volume de la dernière heure comparé à la moyenne | de −8 à +12 |
   | Volume 24 h comparé à la liquidité | jusqu'à +10 ; −5 si anormal (échanges artificiels ?) ou très faible |
   | Liquidité < 10 k$ / < 50 k$ / ≥ 250 k$ | −25 / −10 / +5 |
   | Pool de moins de 6 h / de plus d'un mois | −15 / +3 |
   | Moins de 50 / plus de 2 000 acheteurs uniques en 24 h | −10 / +5 |

   Le total passe par une courbe progressive (tanh) pour ne pas saturer à 100.
   Un token qui a **déjà** fait plus de +300 % en 24 h (ou +200 % en 6 h) est classé « Surchauffe » et plafonné à 60 : il est plus proche de la chute que du décollage.
3. Le contrat de chaque token est **contrôlé en lot** avec les mêmes règles que l'analyse complète : autorités de mint et de gel (RPC Solana), ou honeypot, taxes et fonctions dangereuses (GoPlus). Les tokens au contrat risqué ou à la liquidité inférieure à 10 k$ sont masqués par défaut.
4. Le bouton **Analyser** lance l'analyse complète du token.

## Version téléphone

`mobile.html` est une version pensée pour le téléphone : gros boutons, bouton « Coller », historique des recherches, partage du résultat, alertes mises en avant.
Les téléphones qui ouvrent `index.html` y sont redirigés automatiquement (`index.html?desktop=1` pour forcer la version ordinateur).

Pour l'ouvrir sur votre téléphone :

- **Même Wi-Fi que le PC** : lancez `npm start` ; la console affiche une adresse du type `http://192.168.x.x:8000/mobile.html` à taper sur le téléphone. Sous Windows, acceptez la demande du pare-feu (réseau privé).
- **Partout** : publiez le dépôt avec GitHub Pages (Settings → Pages → branche), puis ouvrez `https://<utilisateur>.github.io/<dépôt>/mobile.html`. Dans le navigateur du téléphone, « Ajouter à l'écran d'accueil » l'installe comme une appli.

## Sources de données (gratuites, sans clé)

| Chaîne | Source | Ce qu'on en tire |
| --- | --- | --- |
| Solana | RPC Solana (`solana-rpc.publicnode.com` par défaut, modifiable dans « Paramètres ») | autorités de mint et de gel, extensions Token-2022, offre, plus gros détenteurs |
| Solana | [RugCheck](https://api.rugcheck.xyz/swagger/index.html) | liquidité verrouillée, métadonnées modifiables, initiés, alertes, statut « rugged » |
| Robinhood Chain | [GoPlus](https://gopluslabs.io/token-security-api) (chain ID 4663) | honeypot, taxes d'achat/vente, fonctions dangereuses (mint, blacklist, pause, soldes modifiables…), propriétaire, détenteurs, LP verrouillée |
| Robinhood Chain | [Blockscout](https://robinhoodchain.blockscout.com) | contrat vérifié, proxy, offre, nombre et liste des détenteurs (repli si GoPlus ne répond pas) |
| Les deux | [DexScreener](https://docs.dexscreener.com/api/reference) | prix, market cap, liquidité, volume, achats/ventes, âge, site et réseaux sociaux |

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

Pour **Robinhood Chain**, les signaux « contrat » propres à Solana (autorités, Token-2022, RugCheck) sont remplacés par l'analyse GoPlus :

| Signal (Robinhood Chain) | Points |
| --- | --- |
| Honeypot détecté par simulation | +60 |
| Taxe de vente ≥ 50 % / taxes ≥ 10 % / > 5 % | +40 / +20 / +8 |
| Soldes modifiables par le propriétaire | +35 |
| Vente totale impossible | +30 |
| Code source non vérifié | +25 |
| Création de tokens possible | +25 |
| Créateur ayant déjà fait des honeypots | +25 |
| Taxe modifiable / transferts suspendables | +20 |
| Propriétaire caché / propriété récupérable | +20 |
| Contrat modifiable (proxy) / autodestruction / liste noire | +15 |
| Créateur détenant > 5 % (> 20 %) | +6 (+12) |

Les pouvoirs d'administration (mint, pause, taxe, liste noire, soldes) ne comptent que peu (+5) quand la propriété du contrat est renoncée.
Les pools, adresses de burn et contrats sont exclus du calcul de concentration.

Verdict : **0–19** risque faible · **20–44** prudence · **45–69** risque élevé · **70+** très probablement une arnaque.
Les tokens connus (USDC, USDT, wSOL, et ceux de la liste de confiance GoPlus) sont plafonnés à 5, car leurs pouvoirs d'administration sont normaux.

La logique de score se trouve dans [`js/analyze.js`](js/analyze.js).

## Tests

```bash
npm test
```

> ⚠️ Outil indicatif basé sur des heuristiques : ce n'est pas un conseil financier.
