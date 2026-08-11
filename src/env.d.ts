interface ImportMetaEnv {
  readonly PUBLIC_EMAILJS_PUBLIC_KEY: string;
  readonly PUBLIC_EMAILJS_SERVICE_ID: string;
  readonly PUBLIC_EMAILJS_TEMPLATE_ID: string;
  readonly PUBLIC_GOOGLE_MAPS_API_KEY: string;
  readonly PUBLIC_CONTACT_EMAIL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
