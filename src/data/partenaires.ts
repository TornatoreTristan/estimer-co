/** Les partenaires affichés sur /partenaires, dans l'ordre d'origine. */
export interface Partenaire {
  /**
   * Chemin du fichier logo servi depuis `public/` (ex. `/logos/ritmodiag.svg`).
   * À ne renseigner que pour les partenaires dont on a l'accord d'usage de
   * marque — voir specs/logos-partenaires.md.
   */
  logo?: string;
  /** Repli affiché dans la pastille quand aucun `logo` n'est fourni. */
  logoTexte: string;
  name: string;
  description: string;
  url: string;
  /** Met la carte en avant sur /partenaires (filet orange + badge). */
  featured?: boolean;
}

export const partenaires: Partenaire[] = [
  {
    logo: "/logos/les-bons-biens.svg",
    logoTexte: "Les Bons Biens",
    name: "Les Bons Biens",
    description:
      "Agence immobilière nouvelle génération. Accompagnement sur mesure pour l'achat et la vente de votre bien immobilier.",
    url: "https://lesbonsbiens.com/",
    featured: true,
  },
  {
    logo: "/logos/dr-house-immo.png",
    logoTexte: "Dr House Immo",
    name: "Dr House Immo",
    description:
      "Réseau d'agences immobilières innovant avec une approche digitale. Isabelle Louise, conseillère à Colleville-Montgomery (14), vous accompagne de l'estimation à la signature.",
    url: "https://www.drhouse-immo.com/conseiller-immobilier/colleville-montgomery-14880/isabelle-louise",
    featured: true,
  },
  {
    logo: "/logos/ritmodiag.svg",
    logoTexte: "RITMODiag",
    name: "RITMODiag",
    description:
      "Expert en diagnostic immobilier (DPE, amiante, plomb, électricité, gaz). Des diagnostics précis et rapides pour tous vos biens immobiliers.",
    url: "https://www.ritmodiag.com",
  },
];
