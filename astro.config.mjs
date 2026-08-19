// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

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
  integrations: [sitemap()],
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
