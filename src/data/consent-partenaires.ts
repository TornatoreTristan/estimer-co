import registre from './consent-partenaires.json';

/**
 * Registre du consentement à la transmission d'un lead à un partenaire.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST VERSIONNÉ
 * ---------------------------------------------------------------------------
 * Transmettre les coordonnées d'un prospect à un tiers suppose un
 * consentement « spécifique, éclairé et univoque » (art. 4.11 et 7 du RGPD).
 * Éclairé veut dire, en pratique CNIL, que la personne a vu la LISTE NOMINATIVE
 * des destinataires au moment où elle a coché. Un accord donné devant « Les
 * Bons Biens, Dr House Immo, RITMODiag » ne couvre donc PAS un quatrième
 * partenaire ajouté six mois plus tard.
 *
 * D'où la version : elle identifie un couple (texte affiché, liste de
 * destinataires). Ajouter, retirer ou renommer un partenaire — ou changer une
 * virgule du texte — impose de créer une NOUVELLE version. Les consentements
 * déjà recueillis restent valables pour ce qu'ils couvraient, et pour rien de
 * plus.
 *
 * ---------------------------------------------------------------------------
 * DEUX COPIES, UN SEUL TEXTE
 * ---------------------------------------------------------------------------
 * Le même registre existe côté API (`api/app/lib/partner_consent.ts`), parce
 * que l'image Docker de l'API se construit depuis `./api` et ne peut pas lire
 * ce dossier. La duplication est donc subie, pas choisie — et elle est
 * surveillée : `scripts/test-consent-partenaires.mjs` échoue dès que les deux
 * copies divergent d'un caractère.
 *
 * C'est l'API qui fait foi. La page n'envoie QUE le numéro de version ; le
 * serveur y rattache son propre texte avant de l'écrire dans la preuve. Une
 * console ouverte ne peut donc pas fabriquer un consentement à un texte que
 * personne n'a jamais affiché.
 */

export interface RegistreConsentementPartenaires {
  /** Identifiant du couple (texte, destinataires). Format `AAAA-MM-JJ`. */
  version: string;
  /** Destinataires nommés, dans l'ordre où le texte les cite. */
  partenaires: string[];
  /** Libellé EXACT de la case à cocher. C'est lui qui fait la preuve. */
  texte: string;
}

export const CONSENT_PARTENAIRES: RegistreConsentementPartenaires = registre;
