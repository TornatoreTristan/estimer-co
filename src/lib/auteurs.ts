/**
 * Auteurs des articles du blog.
 *
 * Le frontmatter d'un article ne porte que l'identifiant (`auteur:
 * tristan-tornatore`) : nom, fonction et biographie vivent ici, une seule
 * fois, pour rester identiques sur tous les articles (en-tête, encadré
 * « À propos de l'auteur » et JSON-LD `Person`, qui nourrit l'E-E-A-T).
 *
 * Module pur, sans import Astro : `src/content.config.ts` en tire l'enum du
 * champ `auteur`, et les tests l'importent directement.
 */

export type TypeLien = 'linkedin' | 'x' | 'site' | 'email';

export interface LienAuteur {
  type: TypeLien;
  /** URL absolue, ou `mailto:` pour l'email. */
  url: string;
  /** Texte visible à côté de l'icône. */
  texte: string;
  /** Nom accessible complet du lien. */
  libelle: string;
}

export interface Auteur {
  id: string;
  nom: string;
  fonction: string;
  bio: string;
  /** Chemin sous `public/`, carré, au moins 240 px de côté. */
  photo?: string;
  /** Affichées à la place de la photo quand la fiche n'en a pas. */
  initiales: string;
  liens: readonly LienAuteur[];
}

export const AUTEURS = {
  'tristan-tornatore': {
    id: 'tristan-tornatore',
    nom: 'Tristan TORNATORE',
    fonction: "Cofondateur d'Estimer.co",
    bio:
      "Passionné par l'immobilier, j'ai acheté mon premier investissement locatif à 25 ans et participé " +
      'au développement de la franchise RITMODiag pour la réalisation des diagnostics immobiliers dans le ' +
      "cadre de vente ou location d'appartement. Plus récemment, j'ai également entrepris dans " +
      "l'optimisation de biens immobiliers dans une entreprise de rénovation et de travaux d'entretien.",
    photo: '/auteurs/tristan-tornatore.webp',
    initiales: 'TT',
    liens: [
      {
        type: 'linkedin',
        url: 'https://www.linkedin.com/in/tristan-digital-freelance/',
        texte: 'LinkedIn',
        libelle: 'Profil LinkedIn de Tristan TORNATORE',
      },
      { type: 'x', url: 'https://x.com/TristanDev_', texte: 'X', libelle: 'Profil X de Tristan TORNATORE' },
      { type: 'site', url: 'https://ritmodiag.com', texte: 'ritmodiag.com', libelle: 'ritmodiag.com, site de RITMODiag' },
      {
        type: 'email',
        url: 'mailto:tristan@estimer.co',
        texte: 'tristan@estimer.co',
        libelle: 'Écrire à Tristan TORNATORE : tristan@estimer.co',
      },
    ],
  },
} as const satisfies Record<string, Auteur>;

export type AuteurId = keyof typeof AUTEURS;

export const AUTEUR_IDS = Object.keys(AUTEURS) as [AuteurId, ...AuteurId[]];

export const AUTEUR_PAR_DEFAUT: AuteurId = 'tristan-tornatore';

/**
 * Profils à déclarer en `sameAs` dans le JSON-LD : uniquement ceux qui
 * désignent la personne elle-même (pas un site d'entreprise ni un email).
 */
export function getProfilsSociaux(auteur: Auteur): string[] {
  return auteur.liens.filter((lien) => lien.type === 'linkedin' || lien.type === 'x').map((lien) => lien.url);
}

export function getAuteur(id: AuteurId): Auteur {
  return AUTEURS[id];
}
