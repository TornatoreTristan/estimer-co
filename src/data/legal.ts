/**
 * Identité de l'éditeur et de ses prestataires, partagée par
 * `/mentions-legales/` et `/politique-de-confidentialite/`.
 *
 * Un seul fichier, parce que les deux pages désignent la MÊME personne sous
 * deux qualités différentes (éditeur au sens de la LCEN, responsable du
 * traitement au sens du RGPD) : dupliquer l'adresse e-mail ou le téléphone,
 * c'est garantir qu'un jour l'une des deux pages restera en arrière.
 *
 * Champs `null` = information non fournie à ce jour. Les pages les rendent
 * CONDITIONNELLEMENT : renseigner la valeur ici suffit à faire apparaître la
 * ligne, et rien n'affiche jamais un gabarit à trous au visiteur.
 */

export interface Editeur {
  /** Nom sous lequel le site est exploité (marque). */
  marque: string;
  /** Personne physique responsable — éditeur et directeur de la publication. */
  responsable: string;
  email: string;
  /** Forme lisible, telle qu'affichée. */
  telephone: string;
  /** Forme `tel:` (E.164), pour le lien cliquable. */
  telephoneLien: string;
  /**
   * Champs d'identification professionnelle. Obligatoires dès lors que le site
   * est exploité par un professionnel (art. 6-III LCEN et art. L.111-1 du code
   * de la consommation) : forme juridique, capital, siège, SIREN/RCS, TVA
   * intracommunautaire, et, pour un service B2C, le médiateur de la
   * consommation. Laissés à `null` tant qu'ils n'ont pas été communiqués.
   */
  formeJuridique: string | null;
  capital: string | null;
  adresse: string | null;
  siren: string | null;
  rcs: string | null;
  tvaIntracom: string | null;
  mediateur: { nom: string; url: string; adresse: string | null } | null;
}

export const EDITEUR: Editeur = {
  marque: "Estimer mon bien",
  responsable: "Tristan TORNATORE",
  email: "tristan@estimer.co",
  telephone: "06 31 49 63 05",
  telephoneLien: "+33631496305",
  formeJuridique: null,
  capital: null,
  adresse: null,
  siren: null,
  rcs: null,
  tvaIntracom: null,
  mediateur: null,
};

/** Hébergeur du site (front statique). */
export const HEBERGEUR = {
  nom: "Infomaniak Network SA",
  adresse: "Rue Eugène-Marziano 25, 1227 Les Acacias (Genève), Suisse",
  url: "https://www.infomaniak.com",
} as const;

/** Studio auteur de la conception et de la réalisation du site. */
export const REALISATION = {
  nom: "SPINES STUDIO",
} as const;

/**
 * Sources de données publiques exploitées par l'estimation.
 * Reprises de `specs/estimation-donnees-reelles.md` §1.2 et §8.2 — la
 * paternité est une obligation ferme de la Licence Ouverte Etalab 2.0.
 */
export const SOURCES_DONNEES = [
  {
    nom: "DVF — Demandes de valeurs foncières géolocalisées",
    editeur: "DGFiP / Etalab",
    role: "Prix de transaction réels servant de socle au calcul.",
    licence: "Licence Ouverte Etalab 2.0",
    url: "https://files.data.gouv.fr/geo-dvf/",
  },
  {
    nom: "BAN — Base Adresse Nationale",
    editeur: "DINUM / IGN",
    role: "Géocodage de l'adresse saisie et rattachement à la commune INSEE.",
    licence: "Licence Ouverte",
    url: "https://adresse.data.gouv.fr",
  },
  {
    nom: "Indice Insee-Notaires des prix des logements anciens",
    editeur: "Insee",
    role: "Actualisation des transactions passées à la valeur du marché courant.",
    licence: "Licence Ouverte",
    url: "https://www.insee.fr",
  },
  {
    nom: "Observatoire DPE",
    editeur: "ADEME",
    role: "Données de performance énergétique du parc de logements.",
    licence: "Licence Ouverte Etalab 2.0",
    url: "https://data.ademe.fr",
  },
  {
    nom: "Code officiel géographique et populations légales",
    editeur: "Insee",
    role: "Référentiel des communes, départements et régions.",
    licence: "Licence Ouverte",
    url: "https://www.insee.fr",
  },
] as const;
