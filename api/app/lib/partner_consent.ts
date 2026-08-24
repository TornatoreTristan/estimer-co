/**
 * Registre du consentement à la transmission d'un lead à un partenaire —
 * **copie faisant foi**.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE FRONT N'ENVOIE QU'UN NUMÉRO DE VERSION. LE TEXTE VIENT D'ICI.
 * ══════════════════════════════════════════════════════════════════════════
 * Une preuve de consentement dont le texte est fourni par le navigateur ne
 * prouve rien : la console permet de poster n'importe quelle chaîne, y compris
 * un libellé que personne n'a jamais vu. La page envoie donc `{ granted,
 * version }` et rien d'autre ; le serveur rattache le texte et la liste de
 * destinataires que CETTE version désigne, puis écrit l'ensemble dans
 * `partner_consents`.
 *
 * Conséquence directe : une version inconnue ne produit AUCUNE preuve. Elle ne
 * fait pas échouer la demande pour autant — le prospect a rempli un formulaire
 * d'estimation valide, et le lui refuser au motif d'une case facultative
 * serait absurde. Le lead part, la preuve n'est pas écrite, et l'e-mail interne
 * porte la mention « accord annoncé, NON PROUVÉ » : ce lead-là ne se transmet
 * pas.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUAND CRÉER UNE VERSION
 * ══════════════════════════════════════════════════════════════════════════
 * Dès que change l'une des deux choses que la personne avait sous les yeux :
 * le texte, ou la liste nominative des destinataires. Un partenaire ajouté à
 * la liste n'hérite JAMAIS des consentements donnés avant son arrivée — c'est
 * précisément ce que la version rend impossible.
 *
 * Une version retirée (`retired: true`) reste dans le registre : elle sert à
 * relire les preuves déjà écrites. Elle n'accepte simplement plus de nouvelle
 * écriture.
 *
 * Le miroir de ce fichier vit dans `src/data/consent-partenaires.json` (la
 * page doit afficher le texte, et l'image Docker de l'API se construit depuis
 * `./api` — elle ne peut pas lire ce dossier). `scripts/test-consent-partenaires.mjs`
 * échoue au premier caractère de divergence.
 */

export interface PartnerConsentVersion {
  /** Identifiant du couple (texte, destinataires). Format `AAAA-MM-JJ`. */
  version: string
  /** Destinataires nommés, dans l'ordre où le texte les cite. */
  partenaires: string[]
  /** Libellé EXACT affiché à côté de la case. C'est lui qui fait la preuve. */
  texte: string
  /** `true` : lisible pour l'audit, refusé en écriture. */
  retired?: boolean
}

/*
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Le tableau délimité par REGISTRE-DEBUT / REGISTRE-FIN est extrait    │
 * │ TEL QUEL et évalué par `scripts/test-consent-partenaires.mjs`, qui   │
 * │ le compare à `src/data/consent-partenaires.json`. N'y écrire que du  │
 * │ JavaScript littéral : ni type, ni `as const`, ni appel de fonction — │
 * │ l'annotation de type vit sur la ligne du `const`, hors des balises.  │
 * └──────────────────────────────────────────────────────────────────────┘
 */
const REGISTRE: PartnerConsentVersion[] = /* REGISTRE-DEBUT */ [
  {
    version: '2026-08-24',
    partenaires: ['Les Bons Biens', 'Dr House Immo', 'RITMODiag'],
    texte:
      "J'accepte qu'Estimer mon bien transmette mon nom, mon adresse e-mail et mon numéro de téléphone, ainsi que les caractéristiques du bien que je viens de décrire, à ses partenaires professionnels — Les Bons Biens, Dr House Immo et RITMODiag — afin qu'ils me contactent, y compris par téléphone, au sujet de mon projet immobilier. Je peux retirer cet accord à tout moment en écrivant à tristan@estimer.co.",
  },
] /* REGISTRE-FIN */

/** Version en vigueur : la dernière déclarée non retirée. */
export const CURRENT_PARTNER_CONSENT_VERSION: string = REGISTRE.filter(
  (entry) => !entry.retired
).at(-1)!.version

/**
 * Résout une version reçue du front.
 *
 * `null` couvre les deux cas où l'on ignore ce qui a été présenté, et ils se
 * traitent pareil (aucune preuve écrite, lead marqué non transmissible) :
 * version inconnue — donc texte inconnu — et version retirée — donc texte que
 * l'on a cessé d'afficher.
 */
export function resolvePartnerConsent(
  version: string | null | undefined
): PartnerConsentVersion | null {
  if (!version) {
    return null
  }
  const entry = REGISTRE.find((candidate) => candidate.version === version)
  if (!entry || entry.retired) {
    return null
  }
  return entry
}
