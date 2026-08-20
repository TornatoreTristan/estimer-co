// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import sitemap from '@astrojs/sitemap';

// Garde-fou de déploiement (specs/estimation-donnees-reelles.md, Annexe B.5).
//
// Le client a tranché pour un repli qui affiche quand même un prix quand l'API
// d'estimation est injoignable (Annexe B.2). La conséquence non voulue est que
// `PUBLIC_API_URL` vide n'est PAS une panne visible : `requestEstimation` sort
// en `no-config` sans même tenter d'appel réseau, et 100 % des visiteurs
// reçoivent un prix issu de l'ancienne table de 35 villes — exactement la
// dégradation silencieuse que toute cette refonte visait à supprimer.
//
// On fait donc échouer le build plutôt que de déployer un site muet sur son
// propre mode dégradé. Un repli doit être un incident, jamais un état par
// défaut. Le dev (`astro dev`) et une construction explicitement marquée
// `ESTIMATION_ALLOW_NO_API=1` restent libres de s'en passer.
// `loadEnv` est indispensable ici : au moment où Astro évalue ce fichier, il n'a
// pas encore chargé `.env` dans `process.env`. Lire `process.env` seul ferait
// échouer tout build local alors que la variable est bien renseignée — le
// garde-fou punirait le développeur au lieu de protéger la production.
if (process.argv.includes('build')) {
  const env = { ...loadEnv('production', process.cwd(), ''), ...process.env };
  if (!env.ESTIMATION_ALLOW_NO_API && !(env.PUBLIC_API_URL || '').trim()) {
    throw new Error(
      "PUBLIC_API_URL est vide : le site serait déployé en repli statique permanent,\n" +
        "sans aucun signal côté exploitation (cf. Annexe B.5 de la spec).\n" +
        "Renseignez PUBLIC_API_URL (ex. https://api.estimer.co), ou construisez avec\n" +
        "ESTIMATION_ALLOW_NO_API=1 si l'absence d'API est délibérée (démo hors ligne)."
    );
  }
}

export default defineConfig({
  site: 'https://estimer.co',
  // Stratégie d'URL — cohérente avec l'hébergement GitHub Pages.
  // `build.format: 'directory'` écrit `dist/contact/index.html` ; GitHub Pages
  // ne sert ce fichier que sur `/contact/` et renvoie une 301 vers cette forme
  // quand on demande `/contact`. Le seul moyen d'éviter ce saut de redirection
  // sur chaque lien interne est donc d'écrire ces liens AVEC la barre finale,
  // et `trailingSlash: 'always'` fait échouer le dev-server sur toute URL qui
  // l'oublierait — le comportement est donc identique en dev et en prod, et une
  // régression se voit tout de suite. Le lien canonical du BaseLayout hérite de
  // la même forme (`Astro.url.pathname` se termine par `/`).
  // `build.format: 'file'` réglerait aussi le problème mais entrerait en
  // collision avec les redirections `*.html` ci-dessous (`/contact.html` serait
  // à la fois la sortie de la page `contact` et la source d'une redirection).
  trailingSlash: 'always',
  build: { format: 'directory' },
  // `sitemap.xml` généré au build. L'intégration ne connaît que les fichiers
  // réellement générés dans `dist/` : une page non générée (statut brouillon,
  // filtrée dans les routes du Lot 2/3) n'y figure jamais — pas de filtre
  // supplémentaire à faire ici, la garantie vient de l'absence de route.
  // `/pdf-preview/` est un outil de travail interne (aperçu du rapport PDF) :
  // il est généré comme les autres pages mais n'a rien à faire dans le sitemap.
  integrations: [sitemap({ filter: (page) => !page.includes('/pdf-preview/') })],
  // Port figé : la clé Google Maps est restreinte par référent HTTP, l'origine
  // de dev doit donc rester stable pour correspondre à l'autorisation déclarée
  // dans la console Google Cloud.
  server: { port: 4322, host: false },
  // `strictPort` évite un repli silencieux sur un autre port, qui redonnerait
  // une RefererNotAllowedMapError. Il vit ici et non dans `server` ci-dessus :
  // `astro.server` n'expose pas cette clé (Astro 7), c'est une option du
  // serveur de dev Vite, qu'Astro transmet tel quel.
  vite: { server: { strictPort: true } },
  // Les anciennes URLs du site statique restent valides.
  // `/index.html` est absent volontairement : il entrerait en collision avec
  // le fichier généré pour `/`. À traiter côté hébergeur si nécessaire.
  redirects: {
    '/Tom1.html': '/estimation/',
    '/map.html': '/carte/',
    '/partenaire.html': '/partenaires/',
    '/contact.html': '/contact/',
    '/rapport.html': '/rapport/',
  },
});
