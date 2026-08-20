import type { ImageMetadata } from 'astro';

import appartementAjaccio from '../assets/biens/appartement-ajaccio.jpg';
import maisonAnnecy from '../assets/biens/maison-annecy.jpg';
import maisonCesson from '../assets/biens/maison-cesson.jpg';
import maisonColmar from '../assets/biens/maison-colmar.jpg';
import maisonNormande from '../assets/biens/maison-normande.jpg';

/**
 * Un bien affiché dans le carrousel de la page d'accueil.
 *
 * ATTENTION — aucune de ces estimations n'est réelle : ce sont des exemples
 * d'illustration, au même titre que le graphique et les jauges DPE de la
 * section « La solution ». Ils sont simplement écrits de façon cohérente
 * (montant = surface × prix au m², DPE plausible pour le type de bâti, volume
 * de ventes cohérent avec la taille de la commune) pour qu'un lecteur attentif
 * ne les prenne pas en défaut, et la section porte une mention explicite. Ne
 * pas les présenter comme des ventes réalisées.
 */
export interface BienVitrine {
  photo: ImageMetadata;
  /** Décrit la photo pour les lecteurs d'écran, pas le bien. */
  alt: string;
  /** « Maison », « Appartement »… affiché en pastille sur la photo. */
  type: string;
  /** Commune et département, ex. « Ajaccio (2A) ». */
  lieu: string;
  /** Titre court du bien, une ligne. */
  titre: string;
  surface: number;
  pieces: number;
  /** Lettre du diagnostic de performance énergétique. */
  dpe: string;
  /** Estimation moyenne, en euros. */
  montant: number;
  /** Prix au m² retenu — vaut toujours `montant / surface` arrondi. */
  prixM2: number;
  /** Nombre de ventes comparables retenues sur les 12 derniers mois. */
  ventes: number;
  /**
   * Évolution du prix au m² du secteur sur 12 mois, en pourcentage.
   * Négative quand le marché local recule.
   */
  evolution: number;
}

export const biensVitrine: BienVitrine[] = [
  {
    photo: maisonCesson,
    alt: "Maison contemporaine à toiture bois entourée d'une pelouse et d'une allée pavée",
    type: 'Maison',
    lieu: 'Cesson-Sévigné (35)',
    titre: 'Maison récente avec terrain clos',
    surface: 148,
    pieces: 6,
    dpe: 'A',
    montant: 481000,
    prixM2: 3250,
    ventes: 142,
    evolution: 1.8,
  },
  {
    photo: appartementAjaccio,
    alt: 'Immeuble méditerranéen aux façades ocre avec balcons, sous un ciel bleu',
    type: 'Appartement',
    lieu: 'Ajaccio (2A)',
    titre: 'Trois pièces avec balcon, vue dégagée',
    surface: 68,
    pieces: 3,
    dpe: 'D',
    montant: 312000,
    prixM2: 4588,
    ventes: 386,
    evolution: 3.2,
  },
  {
    photo: maisonAnnecy,
    alt: 'Maison à pignon bois avec véranda vitrée ouverte sur un grand jardin',
    type: 'Maison',
    lieu: 'Annecy (74)',
    titre: 'Maison familiale avec véranda',
    surface: 184,
    pieces: 7,
    dpe: 'B',
    montant: 626000,
    prixM2: 3402,
    ventes: 97,
    evolution: 2.6,
  },
  {
    photo: maisonNormande,
    alt: 'Maison normande à colombages et toit d’ardoise, devant un jardin fleuri',
    type: 'Maison',
    lieu: 'Pont-l’Évêque (14)',
    titre: 'Maison à colombages de centre-bourg',
    surface: 96,
    pieces: 4,
    dpe: 'E',
    montant: 298000,
    prixM2: 3104,
    ventes: 64,
    evolution: -1.4,
  },
  {
    photo: maisonColmar,
    alt: 'Maison blanche à double garage, allée pavée et haies taillées',
    type: 'Maison',
    lieu: 'Colmar (68)',
    titre: 'Maison avec double garage et dépendance',
    surface: 165,
    pieces: 6,
    dpe: 'C',
    montant: 478000,
    prixM2: 2897,
    ventes: 211,
    evolution: 0.9,
  },
];
