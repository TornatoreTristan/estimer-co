interface ImportMetaEnv {
  readonly PUBLIC_EMAILJS_PUBLIC_KEY: string;
  readonly PUBLIC_EMAILJS_SERVICE_ID: string;
  readonly PUBLIC_EMAILJS_TEMPLATE_ID: string;
  readonly PUBLIC_GOOGLE_MAPS_API_KEY: string;
  readonly PUBLIC_CONTACT_EMAIL: string;
  readonly PUBLIC_GA4_MEASUREMENT_ID: string;
  readonly PUBLIC_GTM_CONTAINER_ID: string;
  readonly PUBLIC_GTM_SERVER_URL: string;
  readonly PUBLIC_API_URL: string;
  readonly PUBLIC_ESTIMATION_FALLBACK: string;
}

/**
 * `window.dataLayer` : file d'attente de Google Tag Manager, alimentée par le
 * socle inline de `Analytics.astro` puis par `ConsentBanner.astro`. Déclarée
 * ici parce que les deux y écrivent depuis des contextes différents (script
 * classique et module bundlé) et doivent viser le même objet.
 */
interface Window {
  dataLayer: unknown[];
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
