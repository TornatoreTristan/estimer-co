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
  styles/global.css            design system : tokens, reset, composants, header, footer
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

## Contenu CMS (Pages CMS) — Lot 0

Voir `specs/cms-seo-tracking.md` pour le cadrage complet. Fondations posées au
Lot 0 :

- `src/content.config.ts` — 4 collections (`regions`, `departements`,
  `partenaires`, `pages`), schémas Zod. Les fichiers Markdown vivent dans
  `src/content/<collection>/<slug>.md` (frontmatter YAML + corps Markdown).
  Les schémas ne valident que la *forme* des champs ; les règles "obligatoire
  si publié" sont documentées en tête de fichier et vivent dans
  `scripts/validate-content.mjs`, pas dans Zod (voir ce fichier pour le détail
  de la décision).
- `.pages.yml` — configuration de l'app hébergée [Pages CMS](https://pagescms.org),
  connectée en écriture directe sur ce repo GitHub (accès restreint aux
  collaborateurs ayant les droits d'écriture). Chaque sauvegarde y crée un
  commit sur `main`, ce qui déclenche le redéploiement Coolify (voir
  « Déploiement » plus bas) et donc la mise en ligne de l'édition.
- `scripts/migrate-legacy-data.mjs` — migration one-off, déjà exécutée, qui a
  généré les 144 fichiers (13 régions + 101 départements + 30 partenaires)
  depuis `src/data/prix.ts` / `src/data/partenaires.ts`, toutes en
  `statut: brouillon`. Rejouable sans écraser un contenu déjà édité (voir
  `--force`/`--dry-run` en tête du script). `src/data/prix.ts` et
  `src/data/partenaires.ts` restent en place tant que `carte.astro` et
  `partenaires.astro` ne consomment pas encore les collections (migration de
  ces pages prévue aux lots suivants).
- `scripts/validate-content.mjs` — garde-fou exécuté en CI avant `astro build`
  (gates de publication, unicité de slug, slugs réservés, intégrité de
  `regionParente`). Un brouillon incomplet ne bloque jamais le build ; seule
  une entrée `statut: publie` incomplète le fait.

## Déploiement

Le site est construit par le `Dockerfile` (Astro puis nginx) et déployé par
**Coolify**, sur webhook de push `main` — même mécanisme que l'API du dossier
`api/`, avec un service distinct. C'est ce webhook, et lui seul, qui met
estimer.co à jour.

Les variables `PUBLIC_*` (voir `.env.example`) se règlent donc dans
**l'environnement de build du service Coolify**, et non dans les réglages
GitHub. Deux d'entre elles ont des conséquences visibles si on les oublie :

- `PUBLIC_API_URL` — vide, le build échoue volontairement (`astro.config.mjs`)
  plutôt que de livrer un site en repli statique permanent.
- `PUBLIC_GTM_CONTAINER_ID` — vide, le site ne charge aucun script Google,
  n'affiche aucun bandeau de consentement, et la politique de confidentialité
  indique qu'aucun traceur n'est actif. C'est un état cohérent, pas une panne
  (voir `src/lib/analytics.ts`).

> **Ni GitHub Pages, ni GitHub Actions ne publient ce site.** Le workflow
> `deploy.yml` l'a prétendu un temps sans jamais y parvenir — Pages n'ayant
> jamais été activé sur le repo. Il a été converti en CI (`site.yml`) : il
> vérifie, il ne déploie pas.

## Intégration continue

`.github/workflows/site.yml` s'exécute sur les PR et sur `main` : installation,
`node scripts/validate-content.mjs`, `npm test`, puis `astro build`. Aucun
secret n'est nécessaire — le build de vérification n'est jamais publié.

`.github/workflows/api.yml` couvre le dossier `api/` de façon indépendante.

## Choix de portage

- **CSS** — `src/styles/global.css` porte le design system complet : tokens
  (couleurs, typographie, rayons, rythme des sections), reset, et les classes
  partagées (`.btn`, `.card`, `.section`, `.grid`, `.eyebrow`, `.input`,
  header, footer). Chaque page n'ajoute que ses styles propres, dans un bloc
  `<style>` **scopé**. Deux exceptions en `<style is:global>` : `/carte` et
  `/rapport`, dont une partie du contenu est injectée à l'exécution par les
  scripts client — les styles scopés ne s'appliqueraient pas à ce HTML.
- **Charte** — inspirée de Fygr/Okimia : fond beige, texte aubergine
  (`#1d0c1b`), orange (`#ff6e34`) comme unique accent, typographie Geist et
  Geist Mono (Google Fonts). **Aucun rayon ni ombre portée** : tout est à angle
  droit, la profondeur ne vient que des aplats et des filets de 1 px. Il n'y a
  donc volontairement pas de tokens `--radius-*` / `--shadow-*` dans
  `global.css`, et le focus des champs passe par un `outline`, pas par un
  `box-shadow`. Le PDF généré (`src/scripts/rapport-report.js`) suit la même
  règle : aplats, rectangles droits, ni ombre ni dégradé.
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
