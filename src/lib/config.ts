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
  // ATTENTION — cette valeur ne pilote plus rien.
  //
  // La mesure d'audience passe désormais par Google Tag Manager, et son
  // interrupteur est `PUBLIC_GTM_CONTAINER_ID`, lu par `src/lib/analytics.ts`.
  // GA4 est configuré comme une balise DANS le conteneur, pas depuis le code :
  // renseigner l'identifiant ci-dessous ne charge donc aucun script et
  // n'affiche aucun bandeau. Il n'est conservé que pour rester disponible au
  // code client qui voudrait le lire.
  ANALYTICS: {
    GA4_MEASUREMENT_ID: import.meta.env.PUBLIC_GA4_MEASUREMENT_ID,
  },
  // API d'estimation (service AdonisJS séparé, cf.
  // specs/estimation-donnees-reelles.md §2.3).
  //
  // BASE_URL vide -> `estimation-api.js` ne tente aucun appel réseau et
  // renvoie immédiatement un échec, ce qui déclenche le repli ci-dessous.
  //
  // FALLBACK : 'static' (défaut, DÉCISION CLIENT) -> quand l'API est
  // injoignable (réseau, timeout, 5xx, 429), l'estimation est calculée par
  // `calculerEstimation()` et la page affiche un bandeau permanent
  // « Estimation indicative » SANS aucune mention de DVF ni de la DGFiP.
  // 'none' -> mode « estimation différée » du §2.4 : aucun prix affiché.
  // Un `undefined` disparaît du JSON injecté par ClientConfig.astro : la
  // valeur par défaut est donc appliquée ici, à la source.
  API: {
    BASE_URL: import.meta.env.PUBLIC_API_URL || '',
    FALLBACK: import.meta.env.PUBLIC_ESTIMATION_FALLBACK || 'static',
  },
} as const;
