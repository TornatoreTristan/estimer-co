/** Les 30 partenaires affichés sur /partenaires, dans l'ordre d'origine. */
export interface Partenaire {
  /** Texte affiché dans la pastille de logo. */
  logo: string;
  name: string;
  description: string;
  url: string;
}

export const partenaires: Partenaire[] = [
  {
    logo: "Ritmodiag",
    name: "Ritmodiag",
    description:
      "Expert en diagnostic immobilier (DPE, amiante, plomb, électricité, gaz). Des diagnostics précis et rapides pour tous vos biens immobiliers.",
    url: "https://www.ritmodiag.com",
  },
  {
    logo: "Century 21",
    name: "Century 21",
    description:
      "Leader mondial de l'immobilier avec plus de 1000 agences en France. Expertise reconnue en transaction et gestion locative.",
    url: "https://www.century21.fr",
  },
  {
    logo: "Orpi",
    name: "Orpi",
    description:
      "Premier réseau d'agences immobilières en France avec plus de 1350 agences. Spécialiste de la transaction et de la gestion.",
    url: "https://www.orpi.com",
  },
  {
    logo: "Guy Hoquet",
    name: "Guy Hoquet",
    description:
      "Réseau d'agences immobilières de proximité présent partout en France. Plus de 500 agences pour vous accompagner.",
    url: "https://www.guy-hoquet.com",
  },
  {
    logo: "Laforêt",
    name: "Laforêt",
    description:
      "Réseau de 700 agences immobilières indépendantes. Expertise locale et accompagnement personnalisé dans tous vos projets.",
    url: "https://www.laforet.com",
  },
  {
    logo: "ERA",
    name: "ERA Immobilier",
    description:
      "Réseau international présent en France avec plus de 280 agences. Innovation et proximité pour vos projets immobiliers.",
    url: "https://www.era-immobilier.fr",
  },
  {
    logo: "Foncia",
    name: "Foncia",
    description:
      "Leader de l'administration de biens avec plus de 600 agences. Gestion locative, syndic et transaction immobilière.",
    url: "https://www.foncia.com",
  },
  {
    logo: "Citya",
    name: "Citya Immobilier",
    description:
      "Réseau indépendant de 230 agences en France. Spécialiste de la gestion locative et de l'administration de biens.",
    url: "https://www.citya.com",
  },
  {
    logo: "Square Habitat",
    name: "Square Habitat",
    description:
      "Réseau d'agences immobilières du Crédit Agricole avec 450 agences. Confiance et expertise bancaire au service de l'immobilier.",
    url: "https://www.squarehabitat.fr",
  },
  {
    logo: "Nexity",
    name: "Nexity",
    description:
      "Leader français de l'immobilier neuf et de la promotion. Expert en investissement locatif et programmes neufs.",
    url: "https://www.nexity.fr",
  },
  {
    logo: "Safti",
    name: "Safti",
    description:
      "Réseau de conseillers immobiliers indépendants avec plus de 5000 agents. Modèle innovant et digital de l'immobilier.",
    url: "https://www.safti.fr",
  },
  {
    logo: "Capifrance",
    name: "Capifrance",
    description:
      "Réseau de 3000 conseillers immobiliers indépendants. Approche personnalisée et accompagnement sur mesure.",
    url: "https://www.capifrance.fr",
  },
  {
    logo: "Olisto",
    name: "Olisto",
    description:
      "Réseau de courtiers en crédit immobilier et assurance. Accompagnement expert pour optimiser votre financement immobilier.",
    url: "https://www.olisto.fr",
  },
  {
    logo: "IAD",
    name: "IAD France",
    description:
      "Premier réseau européen de mandataires immobiliers avec plus de 19 000 conseillers en France. Modèle digital et innovant.",
    url: "https://www.iadfrance.fr",
  },
  {
    logo: "Keller Williams",
    name: "Keller Williams",
    description:
      "Leader mondial de l'immobilier présent en France avec plus de 180 agences. Formation d'excellence et outils technologiques innovants.",
    url: "https://www.kwfrance.fr",
  },
  {
    logo: "Proprioo",
    name: "Proprioo",
    description:
      "Réseau de 1000 conseillers immobiliers indépendants. Honoraires attractifs et accompagnement personnalisé pour vos projets.",
    url: "https://www.proprioo.fr",
  },
  {
    logo: "Arthurimmo",
    name: "Arthurimmo",
    description:
      "Réseau de 200 agences immobilières indépendantes. Expertise locale et service de qualité dans toute la France.",
    url: "https://www.arthurimmo.com",
  },
  {
    logo: "Stéphane Plaza Immobilier",
    name: "Stéphane Plaza Immobilier",
    description:
      "Réseau dynamique de 350 agences en France. Expertise et convivialité au service de vos projets immobiliers.",
    url: "https://www.stephaneplazaimmobilier.com",
  },
  {
    logo: "Optimhome",
    name: "Optimhome",
    description:
      "Réseau de 3500 conseillers immobiliers indépendants. Solution digitale innovante et accompagnement de proximité.",
    url: "https://www.optimhome.com",
  },
  {
    logo: "Crédit Agricole",
    name: "Crédit Agricole",
    description:
      "Leader bancaire français avec expertise en financement immobilier. Solutions de prêt adaptées à tous vos projets.",
    url: "https://www.credit-agricole.fr",
  },
  {
    logo: "BNP Paribas",
    name: "BNP Paribas",
    description:
      "Banque de référence pour le financement immobilier. Accompagnement personnalisé et taux compétitifs.",
    url: "https://www.bnpparibas.fr",
  },
  {
    logo: "Société Générale",
    name: "Société Générale",
    description:
      "Solutions de crédit immobilier sur mesure. Expertise bancaire et accompagnement dans tous vos projets.",
    url: "https://www.societegenerale.fr",
  },
  {
    logo: "Caisse d'Épargne",
    name: "Caisse d'Épargne",
    description:
      "Banque régionale spécialisée en financement immobilier. Proximité et solutions adaptées à votre situation.",
    url: "https://www.caisse-epargne.fr",
  },
  {
    logo: "LCL",
    name: "LCL",
    description:
      "Banque de proximité avec expertise en crédit immobilier. Accompagnement personnalisé de votre projet d'acquisition.",
    url: "https://www.lcl.fr",
  },
  {
    logo: "Notaires de France",
    name: "Notaires de France",
    description:
      "Réseau officiel des notaires français. Sécurité juridique et accompagnement expert dans vos transactions immobilières.",
    url: "https://www.notaires.fr",
  },
  {
    logo: "Chambre des Notaires",
    name: "Chambre des Notaires de Paris",
    description:
      "Institution représentant 600 offices notariaux à Paris. Expertise juridique et sécurisation de vos actes immobiliers.",
    url: "https://www.paris.notaires.fr",
  },
  {
    logo: "Crédit Mutuel",
    name: "Crédit Mutuel",
    description:
      "Banque mutualiste avec solutions de financement immobilier compétitives. Conseil personnalisé et taux attractifs.",
    url: "https://www.creditmutuel.fr",
  },
  {
    logo: "CIC",
    name: "CIC",
    description:
      "Banque de proximité spécialisée en prêt immobilier. Accompagnement expert de votre projet d'achat ou investissement.",
    url: "https://www.cic.fr",
  },
  {
    logo: "Boursorama",
    name: "Boursorama Banque",
    description:
      "Banque en ligne leader avec offres de crédit immobilier 100% digitales. Taux compétitifs et process simplifié.",
    url: "https://www.boursorama-banque.com",
  },
  {
    logo: "Dr House Immo",
    name: "Dr House Immo",
    description:
      "Réseau d'agences immobilières innovant avec une approche digitale. Expertise en transaction et accompagnement personnalisé.",
    url: "https://www.drhouseimmo.com",
  },
];
