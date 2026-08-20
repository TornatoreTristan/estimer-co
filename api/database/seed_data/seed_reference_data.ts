import type { Database } from '@adonisjs/lucid/database'
import { ALL_COEFFICIENTS, DEPARTMENT_REFERENCES } from '#database/seed_data/reference_data'

/**
 * Écriture des référentiels de calcul en base — §3.6, §3.9.
 *
 * Extrait du seeder Lucid pour être appelable **aussi** depuis les tests
 * fonctionnels : le moteur de valorisation lit ses coefficients en base, un
 * test d'endpoint doit donc pouvoir garantir leur présence sans dépendre de
 * l'exécution préalable de `node ace db:seed`.
 *
 * Idempotent (`ON CONFLICT … DO UPDATE`) : rejouer le seeder ne duplique
 * rien et remet les valeurs de spécification en place si quelqu'un les a
 * modifiées à la main sans en tracer la source.
 */
export async function seedReferenceData(db: Database): Promise<void> {
  for (const coefficient of ALL_COEFFICIENTS) {
    await db.rawQuery(
      `INSERT INTO coefficients_reference
         (cle, type_bien, valeur, source_label, source_url, date_source, actif, note)
       VALUES (:cle, :typeBien, :valeur, :sourceLabel, :sourceUrl, :dateSource, true, :note)
       ON CONFLICT (cle, type_bien, coalesce(densite_min, -1), coalesce(densite_max, -1))
         WHERE actif
       DO UPDATE SET
         valeur = EXCLUDED.valeur,
         source_label = EXCLUDED.source_label,
         source_url = EXCLUDED.source_url,
         date_source = EXCLUDED.date_source,
         note = EXCLUDED.note,
         updated_at = now()`,
      {
        cle: coefficient.cle,
        typeBien: coefficient.typeBien,
        valeur: coefficient.valeur,
        sourceLabel: coefficient.sourceLabel,
        sourceUrl: coefficient.sourceUrl,
        dateSource: coefficient.dateSource,
        note: coefficient.note,
      }
    )
  }

  for (const reference of DEPARTMENT_REFERENCES) {
    await db.rawQuery(
      `INSERT INTO references_departementales
         (code_departement, type_bien, prix_m2, source_label, source_url, date_source, note)
       VALUES (:codeDepartement, :typeBien, :prixM2, :sourceLabel, :sourceUrl, :dateSource, :note)
       ON CONFLICT (code_departement, type_bien)
       DO UPDATE SET
         prix_m2 = EXCLUDED.prix_m2,
         source_label = EXCLUDED.source_label,
         source_url = EXCLUDED.source_url,
         date_source = EXCLUDED.date_source,
         note = EXCLUDED.note,
         updated_at = now()`,
      {
        codeDepartement: reference.codeDepartement,
        typeBien: reference.typeBien,
        prixM2: reference.prixM2,
        sourceLabel: reference.sourceLabel,
        sourceUrl: reference.sourceUrl,
        dateSource: reference.dateSource,
        note: reference.note,
      }
    )
  }
}
