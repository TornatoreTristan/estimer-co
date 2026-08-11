/**
 * Remplace l'ancien `config.js` chargé en <script src>. Les valeurs sont
 * injectées dans les pages via `define:vars`, sous le même nom `CONFIG`, pour
 * que le code client d'origine fonctionne sans modification.
 */
export const CONFIG = {
  EMAILJS: {
    PUBLIC_KEY: import.meta.env.PUBLIC_EMAILJS_PUBLIC_KEY,
    SERVICE_ID: import.meta.env.PUBLIC_EMAILJS_SERVICE_ID,
    TEMPLATE_ID: import.meta.env.PUBLIC_EMAILJS_TEMPLATE_ID,
  },
  GOOGLE: {
    API_KEY: import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY,
  },
  EMAIL: {
    TO: import.meta.env.PUBLIC_CONTACT_EMAIL,
  },
} as const;
