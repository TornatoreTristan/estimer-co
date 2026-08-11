// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://estimer.co',
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
