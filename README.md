# estimer.co — portage Astro 7

Copie du site https://estimer.co reconstruite en [Astro](https://astro.build) 7.2
(sortie 100 % statique, aucun framework UI).

## Démarrage

```bash
npm install
cp .env.example .env   # puis renseigner les clés
npm run dev            # http://localhost:4321
npm run build          # génère dist/
npm run preview        # sert dist/
npm run check          # diagnostics TypeScript / Astro
```

## Structure

```
src/
  layouts/BaseLayout.astro     coquille HTML, <head>, header + footer
  components/
    Header.astro               nav ; l'onglet actif est déduit de l'URL
    Footer.astro
    ClientConfig.astro         déclare le global CONFIG (ex-config.js)
    RawScript.astro            insère un script classique non bundlé
  pages/
    index.astro                ex-index.html
    estimation.astro           ex-Tom1.html
    carte.astro                ex-map.html
    partenaires.astro          ex-partenaire.html
    contact.astro              ex-contact.html
    rapport.astro              ex-rapport.html
  data/
    prix.ts                    13 régions + 101 départements (prix au m²)
    partenaires.ts             30 partenaires
  scripts/                     JS client repris tel quel du site d'origine
  styles/global.css            reset, container, header, footer
  lib/config.ts                lit les variables PUBLIC_* d'environnement
```

## Routes

Les URLs sont passées en URLs propres. Les anciennes adresses `.html` sont
redirigées (voir `astro.config.mjs`).

| Ancienne          | Nouvelle       |
| ----------------- | -------------- |
| `index.html`      | `/`            |
| `Tom1.html`       | `/estimation`  |
| `map.html`        | `/carte`       |
| `partenaire.html` | `/partenaires` |
| `contact.html`    | `/contact`     |
| `rapport.html`    | `/rapport`     |

`/index.html` n'est pas redirigé : la redirection entrerait en collision avec le
fichier généré pour `/`. À traiter côté hébergeur si l'URL est utilisée.

## Configuration

`config.js` était servi publiquement à la racine du site. Il est remplacé par des
variables d'environnement `PUBLIC_*` (voir `.env.example`), et `.env` est ignoré
par git.

Ces valeurs restent visibles dans le HTML livré : EmailJS et Google Maps
s'exécutent dans le navigateur, il n'y a pas moyen de les cacher côté client.
La seule protection possible pour la clé Google est une **restriction par
référent HTTP** dans la console Google Cloud. La clé actuellement en ligne a été
exposée publiquement — la faire tourner est recommandé.

## Choix de portage

- **CSS** — les règles communes aux six pages (reset, `.container`, header,
  footer) sont dans `src/styles/global.css`. Le reste est repris page par page
  dans un bloc `<style is:global>`, à l'identique de l'original.
- **Scripts client** — le code d'origine s'appuie sur des fonctions globales
  (callback `initAutocomplete` de Google Maps, `initMap`, `onclick="downloadPDF()"`).
  Il est donc conservé en script classique non bundlé (`RawScript`) plutôt que
  converti en module, pour éviter d'avoir à le réécrire. Seule la page `/carte`,
  qui n'a pas cette contrainte, utilise un script Astro bundlé et typé.
- **Données** — les listes répétitives (régions, départements, partenaires) sont
  extraites du HTML dans `src/data/` et rendues par boucle.

## Écarts assumés avec l'original

- Le pied de page de `map.html` affichait « Tous droits reserves. » là où les
  cinq autres pages affichaient « Tous droits réservés. ». Le composant `Footer`
  unifie sur la version accentuée.
- Les séparateurs de milliers des listes de prix utilisent l'espace fine
  insécable produite par `toLocaleString('fr-FR')` (comme le faisait déjà le JS
  d'origine), au lieu de l'espace simple codée en dur dans le HTML statique.

Le texte visible des six pages est par ailleurs identique à celui du site source
(vérifié par comparaison automatisée mot à mot).
