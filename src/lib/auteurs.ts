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

export interface Auteur {
  id: string;
  nom: string;
  fonction: string;
  bio: string;
  /** Chemin sous `public/`, carré, au moins 240 px de côté. */
  photo?: string;
  /** Affichées à la place de la photo quand la fiche n'en a pas. */
  initiales: string;
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
  },
} as const satisfies Record<string, Auteur>;

export type AuteurId = keyof typeof AUTEURS;

export const AUTEUR_IDS = Object.keys(AUTEURS) as [AuteurId, ...AuteurId[]];

export const AUTEUR_PAR_DEFAUT: AuteurId = 'tristan-tornatore';

export function getAuteur(id: AuteurId): Auteur {
  return AUTEURS[id];
}
