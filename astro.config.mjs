// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://estimer.co',
  // `sitemap.xml` généré au build. L'intégration ne connaît que les fichiers
  // réellement générés dans `dist/` : une page non générée (statut brouillon,
  // filtrée dans les routes du Lot 2/3) n'y figure jamais — pas de filtre
  // supplémentaire à faire ici, la garantie vient de l'absence de route.
  integrations: [sitemap()],
  // Port figé : la clé Google Maps est restreinte par référent HTTP, l'origine
  // de dev doit donc rester stable pour correspondre à l'autorisation déclarée
  // dans la console Google Cloud. `strictPort` évite un repli silencieux sur un
  // autre port, qui redonnerait une RefererNotAllowedMapError.
  server: { port: 4322, host: false, strictPort: true },
  // Les anciennes URLs du site statique restent valides.
  // `/index.html` est absent volontairement : il entrerait en collision avec
  // le fichier généré pour `/`. À traiter côté hébergeur si nécessaire.
  redirects: {
    '/Tom1.html': '/estimation',
    '/map.html': '/carte',
    '/partenaire.html': '/partenaires',
    '/contact.html': '/contact',
    '/rapport.html': '/rapport',
  },
});
