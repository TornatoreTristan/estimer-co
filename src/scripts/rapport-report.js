// ============================================================================
// RAPPORT — rendu de `lastEstimation` sur /rapport (Lot 3)
// ============================================================================
//
// Script classique injecté par `RawScript.astro`, après `pdf-report.js`
// (helpers `formatPrice`, `capitalizeWords`…), `rapport-map.js` et
// `estimation-api.js` (bouton « Relancer le calcul »).
//
// RÈGLE STRUCTURANTE (US-11) : tout ce qui est nouveau est DÉFENSIF. Un
// `lastEstimation` déjà présent dans le navigateur d'un visiteur — écrit par
// la version précédente du site, donc sans `confidence`, `comparables`,
// `method`, `dataSource` ni `estimationStatus` — doit s'afficher sans la
// moindre erreur JS : les blocs concernés restent simplement masqués. Les
// quatre clés historiques (`prixM2`, `estimationMin`, `estimationMax`,
// `estimationMoyenne`) sont, elles, lues exactement comme avant.
//
// RÈGLE D'HONNÊTETÉ (§8.4) : aucun indicateur non sourçable n'est affiché. Le
// délai de vente moyen, la marge de négociation et le « prix maisons = prix
// au m² × 0,85 » qui figuraient ici étaient inventés — ils sont supprimés, et
// pas remplacés par d'autres valeurs inventées. Le bloc « marché local » ne
// montre plus que ce qui provient réellement de la réponse de l'API.

// ============================================================================
// MESURE — c'est ICI que la conversion est comptée, pas au clic « Envoyer »
// ============================================================================
//
// `finalizeSubmit()` (estimation-ui.js) enchaîne de façon synchrone : envoi du
// lead, persistance, puis `window.location.href = "/rapport/"`. Un événement
// poussé juste avant cette ligne serait une COURSE avec la navigation — Google
// Tag Manager peut n'avoir pas encore instancié ses balises quand le navigateur
// commence à quitter la page. On perdrait une part non mesurable des
// conversions, et c'est le pire des défauts : invisible, il fausse le coût par
// conversion de toutes les campagnes sans jamais lever d'alerte.
//
// `/rapport/` est la vraie page de confirmation du parcours. La conversion y est
// donc émise au chargement, en relisant le `lead_id` inscrit dans
// `lastEstimation` au moment de la soumission.
//
// CE QUI OBLIGE À DÉDUPLIQUER : cette page est réatteignable de quatre façons —
// rechargement, retour arrière depuis le bfcache (cf. estimation-ui.js, §
// « Retour arrière depuis /rapport/ »), bouton « Relancer le calcul » plus bas,
// et simple revisite d'un ancien visiteur dont le `lastEstimation` traîne encore
// dans le navigateur. Sans verrou, chacune compterait une conversion de plus.
//
// @param {object} donnees        `lastEstimation` complet
// @param {object|null} estimation son bloc `estimation`, éventuellement absent
// @param {string|null} statut     'ok' | 'static-fallback' | 'deferred'
function mesurerRapport(donnees, estimation, statut) {
  // Aucun conteneur de tags configuré : `tracking.js` n'est pas injecté.
  if (typeof embTrack !== "function") return;

  const leadId = donnees.lead_id || "";

  embTrack("report_view", { lead_id: leadId, estimation_status: statut });

  // Parcours antérieur au lot T1 : le rapport s'affiche, mais il n'y a aucune
  // conversion à rattacher — mieux vaut ne rien compter que compter à tort.
  if (!leadId) return;

  const cleVerrou = "emb.lead." + leadId + ".tracked";
  let dejaCompte = false;
  try {
    dejaCompte = localStorage.getItem(cleVerrou) === "1";
  } catch (erreur) {
    // Stockage indisponible (Safari en navigation privée) : le verrou local
    // saute, mais `lead_id` part en `transaction_id` de la conversion. C'est
    // Google Ads qui dédoublonne alors, et c'est précisément pour ce cas que
    // l'action de conversion est réglée sur « une seule » (plan §7.1).
    dejaCompte = false;
  }
  if (dejaCompte) return;

  const valeurBien =
    estimation && isFinite(estimation.estimationMoyenne) && estimation.estimationMoyenne > 0
      ? Math.round(estimation.estimationMoyenne)
      : undefined;

  embTrack("generate_lead", {
    lead_id: leadId,
    lead_type: "estimation",
    value: embLeadValue(donnees.isOwner, donnees.wantToSell, valeurBien),
    currency: "EUR",
    lead_quality: embLeadQuality(donnees.isOwner, donnees.wantToSell),
    property_type: donnees.propertyType,
    surface_bucket: embSurfaceBucket(donnees.surface),
    rooms: donnees.rooms,
    dpe: donnees.dpe,
    postal_code: donnees.postalCode,
    departement_code: embDepartement(donnees.postalCode),
    estimation_value: valeurBien,
    estimation_status: statut,
    is_owner: donnees.isOwner,
    want_to_sell: donnees.wantToSell,
  });

  // Après la poussée, jamais avant : si l'écriture échouait d'abord, on
  // perdrait la conversion pour de bon plutôt que d'en risquer une en double.
  try {
    localStorage.setItem(cleVerrou, "1");
  } catch (erreur) {
    /* voir plus haut : le dédoublonnage retombe sur `transaction_id` */
  }
}

// Récupérer les données depuis localStorage
      const lastEstimation = JSON.parse(localStorage.getItem("lastEstimation"));

      /**
       * Échappement HTML des valeurs injectées par `innerHTML`. Les libellés de
       * voie et de commune viennent de la base DVF, l'adresse vient de
       * l'utilisateur : rien de tout cela n'est du HTML de confiance.
       */
      function escapeHtml(value) {
        return String(value === undefined || value === null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      /** Élément par id, ou `null`. Évite un `document.getElementById` partout. */
      function el(id) {
        return document.getElementById(id);
      }

      /** Pourcentage français : 0.145 -> « 14,5 % » (une décimale, sans zéro inutile). */
      function formatPercent(ratio) {
        const value = Math.round(Number(ratio) * 1000) / 10;
        return String(value).replace(".", ",") + " %";
      }

      /** Coefficient multiplicatif : 1.03 -> « +3 % », 0.88 -> « −12 % », 1 -> « neutre ». */
      function formatCoefficient(coefficient) {
        const value = Number(coefficient);
        if (!isFinite(value)) return "—";
        const delta = Math.round((value - 1) * 1000) / 10;
        if (delta === 0) return "neutre (×1,00)";
        const sign = delta > 0 ? "+" : "−";
        return (
          sign +
          String(Math.abs(delta)).replace(".", ",") +
          " % (×" +
          value.toFixed(2).replace(".", ",") +
          ")"
        );
      }

      /** « 2025-03 » -> « mars 2025 ». Renvoie la chaîne d'origine si illisible. */
      const REPORT_MONTHS = [
        "janvier", "février", "mars", "avril", "mai", "juin",
        "juillet", "août", "septembre", "octobre", "novembre", "décembre",
      ];

      function formatMonth(value) {
        const match = /^(\d{4})-(\d{2})/.exec(String(value || ""));
        if (!match) return String(value || "—");
        const monthIndex = Number(match[2]) - 1;
        const label = REPORT_MONTHS[monthIndex];
        return label ? label + " " + match[1] : String(value);
      }

      /** Distance arrondie déjà côté API ; on ne fait que l'habiller. */
      function formatDistance(metres) {
        const value = Number(metres);
        if (!isFinite(value)) return "—";
        return value >= 1000
          ? String(Math.round(value / 100) / 10).replace(".", ",") + " km"
          : Math.round(value) + " m";
      }

      /** Libellé lisible du niveau géographique retenu (§3.2). */
      function describeLevel(method) {
        if (!method) return "";
        switch (method.level) {
          case "radius":
            return method.radiusM
              ? "Ventes situées dans un rayon de " + formatDistance(method.radiusM)
              : "Ventes du voisinage immédiat";
          case "commune":
            return "Ventes de votre commune";
          case "epci":
            return "Ventes de votre intercommunalité";
          case "departement":
            return "Ventes de votre département";
          case "region":
            return "Ventes de votre région";
          case "national":
            return "Références nationales, à défaut de ventes comparables plus proches";
          case "departement-reference":
            return "Références départementales (hors base DVF)";
          default:
            return "";
        }
      }

      if (!lastEstimation) {
        // Barre finale obligatoire : `trailingSlash: 'always'` (astro.config.mjs).
        window.location.href = "/estimation/";
      } else {
        // Les nouvelles clés peuvent toutes manquer (localStorage d'une version
        // antérieure) : chaque accès en aval passe par ces variables, jamais
        // par une chaîne de propriétés supposée présente.
        const estimation = lastEstimation.estimation || null;
        const estimationStatus = lastEstimation.estimationStatus || null;
        const confidence = estimation ? estimation.confidence : null;
        const display = estimation ? estimation.display : null;
        const method = estimation ? estimation.method : null;
        const dataSource = estimation ? estimation.dataSource : null;
        const range = estimation ? estimation.range : null;
        const comparables =
          estimation && Array.isArray(estimation.comparables) ? estimation.comparables : [];
        const isStaticFallback = estimationStatus === "static-fallback";
        const isDeferred = estimationStatus === "deferred" || !estimation;

        mesurerRapport(lastEstimation, estimation, estimationStatus);

        // Remplir les détails de la propriété
        const propertyDetails = document.getElementById("propertyDetails");

        // Construire le HTML des détails. TOUTES les valeurs interpolées ici
        // proviennent de `localStorage` (donc, à l'origine, d'une saisie
        // utilisateur) : elles passent sans exception par `escapeHtml`.
        let detailsHTML = `
                <div class="detail-item">
                    <div class="detail-label">Type de bien</div>
                    <div class="detail-value">${escapeHtml(
                      capitalizeFirst(lastEstimation.propertyType)
                    )}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Surface habitable</div>
                    <div class="detail-value">${escapeHtml(lastEstimation.surface)} m²</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Nombre de pièces</div>
                    <div class="detail-value">${escapeHtml(lastEstimation.rooms)} pièce${
          lastEstimation.rooms > 1 ? "s" : ""
        }</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">DPE</div>
                    <div class="detail-value">${
                      lastEstimation.dpe === "unknown"
                        ? "Non renseigné"
                        : "Classe " + escapeHtml(lastEstimation.dpe)
                    }</div>
                </div>`;

        // Ajouter les infos terrain si c'est une maison
        if (
          lastEstimation.propertyType === "maison" &&
          lastEstimation.hasTerrain
        ) {
          detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Terrain</div>
                    <div class="detail-value">${
                      lastEstimation.hasTerrain === "yes" ? "Oui" : "Non"
                    }</div>
                </div>`;

          if (
            lastEstimation.hasTerrain === "yes" &&
            lastEstimation.terrainSize
          ) {
            detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Surface du terrain</div>
                    <div class="detail-value">${escapeHtml(lastEstimation.terrainSize)} m²</div>
                </div>`;
          }
        }

        // Précisions facultatives de l'étape 3 : affichées uniquement si
        // renseignées (elles n'existent pas sur un ancien `lastEstimation`).
        const OPTIONAL_LABELS = {
          floor: { label: "Étage", values: null },
          hasElevator: {
            label: "Ascenseur",
            values: { yes: "Oui", no: "Non", unknown: "Ne sait pas" },
          },
          outdoor: {
            label: "Extérieur",
            values: {
              none: "Aucun",
              balcony: "Balcon",
              terrace: "Terrasse",
              garden: "Jardin privatif",
            },
          },
          condition: {
            label: "État général",
            values: {
              "to-renovate": "À rénover",
              fair: "Correct",
              good: "Bon",
              new: "Refait à neuf",
            },
          },
        };

        Object.keys(OPTIONAL_LABELS).forEach(function (key) {
          const raw = lastEstimation[key];
          if (raw === undefined || raw === null || String(raw) === "") return;
          const spec = OPTIONAL_LABELS[key];
          const value = spec.values ? spec.values[raw] || raw : raw;
          detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">${escapeHtml(spec.label)}</div>
                    <div class="detail-value">${escapeHtml(value)}</div>
                </div>`;
        });

        // Adresse, code postal et ville viennent d'une saisie utilisateur
        // relayée par `localStorage` : ils passent par `escapeHtml` comme
        // toutes les autres valeurs injectées en `innerHTML` ici. L'exposition
        // se limite au propre navigateur du visiteur, mais une exception au
        // milieu de champs échappés est exactement ce qui finit par être
        // recopié ailleurs.
        detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Adresse</div>
                    <div class="detail-value">${escapeHtml(lastEstimation.address)}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Ville</div>
                    <div class="detail-value">${escapeHtml(
                      lastEstimation.postalCode
                    )} ${escapeHtml(capitalizeWords(lastEstimation.city))}</div>
                </div>`;

        // Ajouter la situation du demandeur
        if (lastEstimation.isOwner) {
          const isOwnerText = lastEstimation.isOwner === "yes" ? "Oui" : "Non";
          detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Propriétaire</div>
                    <div class="detail-value">${isOwnerText}</div>
                </div>`;
        }

        if (lastEstimation.wantToSell) {
          let wantToSellText = "Non";
          if (lastEstimation.wantToSell === "yes") wantToSellText = "Oui";
          else if (lastEstimation.wantToSell === "maybe")
            wantToSellText = "Peut-être";

          detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Projet de vente</div>
                    <div class="detail-value">${wantToSellText}</div>
                </div>`;
        }

        propertyDetails.innerHTML = detailsHTML;

        // ------------------------------------------------------------------
        // Bloc prix. Contrat historique inchangé : quatre `textContent`, mêmes
        // ids, mêmes clés. L'amplitude affichée dessous vient de
        // `range.halfWidthPct` — le ±10 % fixe a disparu (§3.7).
        // ------------------------------------------------------------------
        if (estimation) {
          document.getElementById("estimationMoyenne").textContent = formatPrice(
            estimation.estimationMoyenne
          );
          document.getElementById("estimationMin").textContent = formatPrice(
            estimation.estimationMin
          );
          document.getElementById("estimationMax").textContent = formatPrice(
            estimation.estimationMax
          );
          document.getElementById("prixM2").textContent =
            formatPrice(estimation.prixM2) + "/m²";
        } else {
          // Mode différé : aucun prix inventé n'est affiché.
          ["estimationMoyenne", "estimationMin", "estimationMax", "prixM2"].forEach(
            function (id) {
              const node = el(id);
              if (node) node.textContent = "—";
            }
          );
        }

        // Valeur centrale masquée / atténuée : c'est l'API qui décide (§3.8),
        // le front n'applique jamais son propre seuil.
        const priceBoxEl = el("priceBox");
        if (priceBoxEl) {
          if (isDeferred || (display && display.showCentralValue === false)) {
            priceBoxEl.setAttribute("data-central", "hidden");
          } else if (confidence && confidence.label === "low") {
            priceBoxEl.setAttribute("data-central", "muted");
          }
        }

        const rangeNoteEl = el("rangeNote");
        if (rangeNoteEl && range && typeof range.halfWidthPct === "number") {
          const count = method && method.comparablesCount ? method.comparablesCount : 0;
          rangeNoteEl.textContent =
            "Amplitude de ± " +
            formatPercent(range.halfWidthPct) +
            (range.basis === "iqr" && count
              ? ", calculée à partir de la dispersion de " +
                count +
                " vente" +
                (count > 1 ? "s" : "") +
                " réelle" +
                (count > 1 ? "s" : "") +
                " de votre secteur."
              : ".");
          rangeNoteEl.hidden = false;
        } else if (rangeNoteEl && isStaticFallback) {
          rangeNoteEl.textContent =
            "Fourchette indicative : elle ne reflète aucune dispersion observée sur votre secteur.";
          rangeNoteEl.hidden = false;
        }

        // ------------------------------------------------------------------
        // Bandeaux d'état (§7.2 point 7)
        // ------------------------------------------------------------------
        const bannerEl = el("estimationStatusBanner");
        const banners = [];

        if (isStaticFallback) {
          // DÉCISION CLIENT : le prix est affiché quand même, mais jamais sous
          // une mention DVF/DGFiP — ce chiffre ne vient pas de ces données.
          banners.push(
            '<p class="report-banner__title">Estimation indicative</p>' +
              "<p>Nos données de transactions n'ont pas pu être consultées : ce montant " +
              "provient d'un calcul de repli interne, fondé sur des moyennes, et non sur " +
              "les ventes réelles enregistrées autour de votre bien. Sa précision est " +
              "nettement réduite.</p>" +
              '<button type="button" class="btn btn--dark" id="retryEstimationBtn">' +
              "Relancer le calcul</button>" +
              '<p class="report-banner__retry" id="retryEstimationStatus" hidden></p>'
          );
        }

        if (isDeferred) {
          banners.push(
            '<p class="report-banner__title">Estimation en cours de préparation</p>' +
              "<p>Nous n'avons pas pu calculer votre estimation en direct. Un conseiller " +
              "vous l'adresse sous 24 h ouvrées.</p>" +
              '<a class="btn btn--dark" href="/contact/">Être rappelé par un expert</a>'
          );
        }

        if (dataSource && dataSource.dataCoverage === "no-dvf") {
          banners.push(
            '<p class="report-banner__title">Territoire relevant du Livre foncier</p>' +
              "<p>Les départements du Bas-Rhin, du Haut-Rhin, de la Moselle et de Mayotte " +
              "relèvent du régime du Livre foncier : leurs transactions ne figurent pas dans " +
              "la base publique DVF de la DGFiP. Cette estimation repose sur des références " +
              "départementales et non sur des transactions comparables. Sa précision est " +
              "nettement réduite ; nous vous recommandons une évaluation sur place.</p>" +
              '<a class="btn btn--dark" href="/contact/">Être rappelé par un expert</a>'
          );
        }

        if (confidence && confidence.label === "insufficient" && !isDeferred) {
          banners.push(
            '<p class="report-banner__title">Données insuffisantes sur ce secteur</p>' +
              "<p>Nous ne disposons pas d'assez de ventes comparables pour avancer une " +
              "valeur centrale défendable. Seule une fourchette large est présentée.</p>" +
              '<a class="btn btn--dark" href="/contact/">Être rappelé par un expert</a>'
          );
        } else if (confidence && confidence.label === "low") {
          banners.push(
            '<p class="report-banner__title">Peu de transactions comparables</p>' +
              "<p>Le secteur compte peu de ventes réellement comparables à votre bien : la " +
              "fourchette prime sur la valeur centrale. Une visite sur place est " +
              "recommandée.</p>" +
              '<a class="btn btn--dark" href="/contact/">Être rappelé par un expert</a>'
          );
        }

        if (bannerEl && banners.length) {
          bannerEl.innerHTML = banners.join('<hr class="report-banner__sep">');
          bannerEl.hidden = false;
        }

        // ------------------------------------------------------------------
        // Avertissements fournis par l'API — affichés tels quels (§5.3
        // `display.warnings` : messages prêts à afficher, en français).
        // ------------------------------------------------------------------
        const warningsEl = el("estimationWarnings");
        if (
          warningsEl &&
          display &&
          Array.isArray(display.warnings) &&
          display.warnings.length
        ) {
          warningsEl.innerHTML =
            '<ul class="warning-list">' +
            display.warnings
              .map(function (warning) {
                return "<li>" + escapeHtml(warning) + "</li>";
              })
              .join("") +
            "</ul>";
          warningsEl.hidden = false;
        }

        // ------------------------------------------------------------------
        // Bandeau source, permanent (§8.1). Le texte vient TOUJOURS de la
        // réponse de l'API : écrit en dur, il se périmerait silencieusement à
        // chaque nouveau millésime DVF.
        //
        // En mode `static-fallback`, il n'y a pas de `dataSource` — et il ne
        // doit surtout pas y en avoir : le chiffre affiché ne provient ni de
        // DVF ni de la DGFiP.
        // ------------------------------------------------------------------
        const sourceEl = el("dataSourceBanner");
        if (sourceEl && dataSource && !isStaticFallback) {
          let sourceHTML = "";
          if (dataSource.attributionFr) {
            sourceHTML += "<p>" + escapeHtml(dataSource.attributionFr) + "</p>";
          }
          if (dataSource.disclaimerFr) {
            sourceHTML += "<p>" + escapeHtml(dataSource.disclaimerFr) + "</p>";
          }
          if (sourceHTML) {
            sourceEl.innerHTML = sourceHTML;
            sourceEl.hidden = false;
          }
        } else if (sourceEl && isStaticFallback) {
          sourceEl.innerHTML =
            "<p>Estimation indicative produite hors base de transactions. " +
            "Elle ne constitue ni une expertise immobilière, ni un avis de valeur " +
            "engageant. Aucune donnée publique de transaction n'a été mobilisée pour " +
            "la produire.</p>";
          sourceEl.hidden = false;
        }

        // ------------------------------------------------------------------
        // Jauge de confiance (§7.2 point 2). Aucune animation de remplissage :
        // la largeur est posée d'emblée, `prefers-reduced-motion` est donc
        // respecté par construction.
        // ------------------------------------------------------------------
        const confidenceCardEl = el("confidenceCard");
        const confidenceContentEl = el("confidenceContent");

        /** Plafond d'affichage du mode dégradé : une convention, pas une mesure. */
        const STATIC_FALLBACK_CONFIDENCE = 30;

        function renderConfidenceGauge(score, level, labelFr, note, breakdown) {
          const clamped = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
          let html =
            '<div class="confidence-head">' +
            '<span class="confidence-label">' +
            escapeHtml(labelFr) +
            "</span>" +
            '<span class="confidence-score">' +
            clamped +
            " / 100</span>" +
            "</div>" +
            '<div class="confidence-gauge" role="img" aria-label="Indice de confiance : ' +
            clamped +
            ' sur 100, ' +
            escapeHtml(labelFr) +
            '">' +
            '<span class="confidence-gauge__fill" data-level="' +
            escapeHtml(level) +
            '" style="width:' +
            clamped +
            '%"></span>' +
            "</div>" +
            '<div class="confidence-scale"><span>0</span><span>50</span><span>100</span></div>';

          if (note) html += "<p>" + escapeHtml(note) + "</p>";

          if (breakdown) {
            html +=
              '<details class="report-details">' +
              "<summary>Comment est-elle calculée ?</summary>" +
              "<p>L'indice additionne quatre composantes, puis retranche les pénalités " +
              "liées aux informations manquantes ou à un bien atypique.</p>" +
              '<dl class="breakdown-list">' +
              '<div><dt>Nombre de ventes comparables (sur 40)</dt><dd>' +
              formatBreakdownValue(breakdown.count) +
              "</dd></div>" +
              '<div><dt>Proximité géographique (sur 25)</dt><dd>' +
              formatBreakdownValue(breakdown.proximity) +
              "</dd></div>" +
              '<div><dt>Fraîcheur des transactions (sur 15)</dt><dd>' +
              formatBreakdownValue(breakdown.freshness) +
              "</dd></div>" +
              '<div><dt>Homogénéité des prix observés (sur 20)</dt><dd>' +
              formatBreakdownValue(breakdown.dispersion) +
              "</dd></div>" +
              '<div><dt>Pénalités</dt><dd>' +
              (Number(breakdown.penalties) > 0 ? "−" : "") +
              formatBreakdownValue(breakdown.penalties) +
              "</dd></div>" +
              "</dl>" +
              "</details>";
          }

          return html;
        }

        function formatBreakdownValue(value) {
          const number = Number(value);
          if (!isFinite(number)) return "—";
          return String(Math.round(number * 10) / 10).replace(".", ",") + " pts";
        }

        if (confidenceCardEl && confidenceContentEl) {
          if (confidence && typeof confidence.score === "number" && !isStaticFallback) {
            confidenceContentEl.innerHTML = renderConfidenceGauge(
              confidence.score,
              confidence.label || "medium",
              (display && display.confidenceLabelFr) || "Indice de confiance",
              confidence.label === "medium"
                ? "La fourchette reflète la dispersion observée sur votre secteur."
                : "",
              confidence.breakdown || null
            );
            confidenceCardEl.hidden = false;
          } else if (isStaticFallback) {
            // Confiance plafonnée et explicitement libellée « indicatif » : on
            // n'affiche pas un score qui n'a pas été mesuré.
            confidenceContentEl.innerHTML = renderConfidenceGauge(
              STATIC_FALLBACK_CONFIDENCE,
              "insufficient",
              "Indicatif",
              "Aucune transaction comparable n'a pu être analysée : cet indice est plafonné " +
                "par convention et ne mesure pas la fiabilité réelle du montant affiché.",
              null
            );
            confidenceCardEl.hidden = false;
          }
        }

        // ------------------------------------------------------------------
        // Transactions comparables (§7.2 point 3) — 5 plus proches.
        //
        // US-6 / §8.2 : le titre « Ventes réelles enregistrées par la DGFiP »
        // ne doit apparaître QUE si le chiffre vient effectivement de ventes
        // DVF. En `method.kind === 'reference-table'` (territoires du Livre
        // foncier : Bas-Rhin, Haut-Rhin, Moselle, Mayotte), il n'y a par
        // construction aucune transaction — `comparables` est vide et le
        // niveau vaut « Références départementales (hors base DVF) ». Afficher
        // ce titre au-dessus d'un état vide laissait croire que la DGFiP
        // cautionne le montant : la carte entière est donc masquée, le bandeau
        // « Territoire relevant du Livre foncier » (plus haut) portant seul
        // l'explication.
        // ------------------------------------------------------------------
        const comparablesCardEl = el("comparablesCard");
        const comparablesContentEl = el("comparablesContent");
        const comparablesTitleEl = el("comparablesTitle");
        const isReferenceTable = !!method && method.kind === "reference-table";

        if (
          comparablesCardEl &&
          comparablesContentEl &&
          method &&
          !isStaticFallback &&
          !isReferenceTable
        ) {
          if (comparablesTitleEl) {
            comparablesTitleEl.textContent = "Ventes réelles enregistrées par la DGFiP";
          }

          if (comparables.length) {
            const rows = comparables
              .slice(0, 5)
              .map(function (item) {
                return (
                  "<tr>" +
                  "<td>" +
                  escapeHtml(capitalizeWords(item.street || "")) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(formatDistance(item.distanceM)) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(formatMonth(item.date)) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(capitalizeFirst(item.propertyType || "")) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(String(item.surface)) +
                  " m²</td>" +
                  "<td>" +
                  escapeHtml(formatPrice(item.pricePerSqm)) +
                  "/m²</td>" +
                  "</tr>"
                );
              })
              .join("");

            comparablesContentEl.innerHTML =
              '<div class="comparables-table-wrap">' +
              '<table class="comparables-table">' +
              "<caption>Les " +
              Math.min(5, comparables.length) +
              " ventes les plus proches parmi les " +
              (method.comparablesCount || comparables.length) +
              " analysées. Numéros de voie et jours exacts volontairement omis.</caption>" +
              "<thead><tr><th>Voie</th><th>Distance</th><th>Date</th><th>Type</th>" +
              "<th>Surface</th><th>Prix au m²</th></tr></thead>" +
              "<tbody>" +
              rows +
              "</tbody></table></div>";
          } else {
            const levelText = describeLevel(method);
            comparablesContentEl.innerHTML =
              '<p class="empty-state">Aucune vente comparable n\'a pu être affichée pour ce ' +
              "bien. " +
              (levelText
                ? "L'estimation s'appuie sur le niveau géographique suivant : " +
                  escapeHtml(levelText.toLowerCase()) +
                  "."
                : "L'estimation s'appuie sur des références plus larges que votre voisinage " +
                  "immédiat.") +
              "</p>";
          }
          comparablesCardEl.hidden = false;
        }

        // ------------------------------------------------------------------
        // Méthodologie (§7.2 point 4) — repliée par défaut, chaque coefficient
        // avec son origine.
        // ------------------------------------------------------------------
        const methodologyCardEl = el("methodologyCard");
        const methodologyContentEl = el("methodologyContent");

        if (methodologyCardEl && methodologyContentEl && method && !isStaticFallback) {
          const coefficients = method.coefficients || {};
          const coefficientRows = [
            {
              key: "surface",
              label: "Surface du bien",
              value: coefficients.surface,
              origin: "Dégressivité du prix au m² selon l'écart à la surface médiane des ventes retenues.",
            },
            {
              key: "floor",
              label: "Étage et ascenseur",
              value: coefficients.floor,
              origin: "Coefficients de référence en base, appliqués aux appartements uniquement.",
            },
            {
              key: "outdoor",
              label: "Extérieur",
              value: coefficients.outdoor,
              origin: "Coefficients de référence en base (balcon, terrasse, jardin privatif).",
            },
            {
              key: "condition",
              label: "État général",
              value: coefficients.condition,
              origin: "Coefficients de référence en base (à rénover, correct, bon, refait à neuf).",
            },
            {
              key: "dpe",
              label: "Diagnostic énergétique",
              value: coefficients.dpe,
              origin:
                "Coefficients de valeur verte de référence, différenciés appartement / maison.",
            },
          ];

          // `method.coefficientSources` (à venir côté API) : chaque coefficient
          // porte alors sa propre origine — dont la mention honnête « valeur
          // provisoire de la spécification produit, à calibrer au Lot 5 », qui
          // n'atteignait jamais l'écran tant que ces libellés étaient écrits en
          // dur ici. Lecture DÉFENSIVE : le champ peut être absent (backend
          // livré après ce front, ou `lastEstimation` d'une version
          // antérieure), auquel cas on retombe sur les libellés ci-dessus.
          const coefficientSourceByKey = {};
          if (Array.isArray(method.coefficientSources)) {
            method.coefficientSources.forEach(function (source) {
              if (source && source.key) coefficientSourceByKey[source.key] = source;
            });
          }

          /** Origine affichée pour un coefficient : celle de l'API si fournie. */
          function coefficientOriginHTML(row) {
            const source = coefficientSourceByKey[row.key];
            if (!source || !source.sourceLabel) return escapeHtml(row.origin);

            let html = escapeHtml(source.sourceLabel);
            if (source.dateSource) {
              html += " (" + escapeHtml(source.dateSource) + ")";
            }
            // Lien seulement si l'URL est bien http(s) : on ne relaie pas un
            // `javascript:` venu d'une réponse malformée.
            if (source.sourceUrl && /^https?:\/\//i.test(String(source.sourceUrl))) {
              html =
                '<a href="' +
                escapeHtml(source.sourceUrl) +
                '" target="_blank" rel="noopener noreferrer">' +
                html +
                "</a>";
            }
            return html;
          }

          /** Libellé affiché : celui de l'API si fourni, sinon celui d'origine. */
          function coefficientLabel(row) {
            const source = coefficientSourceByKey[row.key];
            return source && source.label ? source.label : row.label;
          }

          let methodologyHTML =
            "<p>" +
            escapeHtml(
              describeLevel(method) ||
                "Estimation fondée sur des ventes comparables sélectionnées autour de votre bien."
            ) +
            (method.windowMonths
              ? ", sur les " + method.windowMonths + " derniers mois"
              : "") +
            (method.surfaceTolerancePct
              ? ", avec une tolérance de surface de ± " + method.surfaceTolerancePct + " %"
              : "") +
            ".</p>";

          methodologyHTML +=
            '<dl class="breakdown-list">' +
            "<div><dt>Transactions analysées</dt><dd>" +
            (method.comparablesCount || 0) +
            "</dd></div>" +
            (method.medianPriceM2Raw
              ? "<div><dt>Prix médian observé (avant ajustements)</dt><dd>" +
                escapeHtml(formatPrice(method.medianPriceM2Raw)) +
                "/m²</dd></div>"
              : "") +
            // L'ajustement temporel n'est affiché que si un trimestre d'indice
            // INSEE-Notaires a réellement servi au calcul (`dataSource
            // .priceIndexQuarter`). Tant que le Lot 4 n'est pas livré, l'API
            // renvoie un facteur câblé à 1 : afficher « ×1,00 » laisserait
            // croire à une correction mesurée qui n'a pas eu lieu.
            (typeof method.timeAdjustmentFactor === "number" &&
            dataSource &&
            dataSource.priceIndexQuarter
              ? "<div><dt>Ajustement temporel médian</dt><dd>×" +
                method.timeAdjustmentFactor.toFixed(2).replace(".", ",") +
                " <small>(indice INSEE-Notaires " +
                escapeHtml(dataSource.priceIndexQuarter) +
                ")</small></dd></div>"
              : "") +
            (method.landValue
              ? "<div><dt>Valorisation du terrain</dt><dd>" +
                escapeHtml(formatPrice(method.landValue)) +
                "</dd></div>"
              : "") +
            "</dl>";

          methodologyHTML +=
            '<details class="report-details">' +
            "<summary>Coefficients appliqués à votre bien</summary>" +
            '<dl class="breakdown-list">' +
            coefficientRows
              .map(function (row) {
                if (typeof row.value !== "number") return "";
                return (
                  "<div><dt>" +
                  escapeHtml(coefficientLabel(row)) +
                  "<br><small>" +
                  coefficientOriginHTML(row) +
                  "</small></dt><dd>" +
                  escapeHtml(formatCoefficient(row.value)) +
                  "</dd></div>"
                );
              })
              .join("") +
            (typeof coefficients.total === "number"
              ? "<div><dt>Coefficient global</dt><dd>" +
                escapeHtml(formatCoefficient(coefficients.total)) +
                "</dd></div>"
              : "") +
            "</dl>" +
            (coefficients.clamped
              ? "<p>Le coefficient global a été ramené à sa borne : votre bien présente une " +
                "combinaison de caractéristiques atypique pour son secteur, ce qui rend " +
                "l'estimation par comparaison moins fiable. Ce plafonnement coûte des points " +
                "d'indice de confiance.</p>"
              : "") +
            "</details>";

          methodologyContentEl.innerHTML = methodologyHTML;
          methodologyCardEl.hidden = false;
        } else if (methodologyCardEl && methodologyContentEl && isStaticFallback) {
          methodologyContentEl.innerHTML =
            "<p>Le calcul de repli applique un prix moyen au m² par commune, ajusté du type " +
            "de bien, de la classe DPE et du nombre de pièces. Il n'exploite aucune " +
            "transaction réelle et ne comporte donc ni comparables, ni indice de dispersion. " +
            "Relancez le calcul pour obtenir une estimation fondée sur des ventes réelles.</p>";
          methodologyCardEl.hidden = false;
        }

        // ------------------------------------------------------------------
        // Marché local (§7.2 point 5). Ne subsiste QUE ce qui est sourçable :
        // le prix médian réellement observé, le volume de ventes, le périmètre
        // et la période. Délai de vente, marge de négociation, évolution sur
        // 12 mois et « prix maisons = prix au m² × 0,85 » sont supprimés — ils
        // étaient inventés et absents de DVF.
        // ------------------------------------------------------------------
        const cityAnalysis = document.getElementById("cityAnalysis");
        const cityName = capitalizeWords(lastEstimation.city);

        if (cityAnalysis && method && method.comparablesCount && !isStaticFallback) {
          const stats = [
            method.medianPriceM2Raw
              ? {
                  value: formatPrice(method.medianPriceM2Raw) + "/m²",
                  label: "Prix médian observé",
                }
              : null,
            {
              value: String(method.comparablesCount),
              label: "Ventes analysées",
            },
            method.windowMonths
              ? { value: method.windowMonths + " mois", label: "Période analysée" }
              : null,
          ].filter(Boolean);

          cityAnalysis.innerHTML +=
            "<p>Ces chiffres proviennent des ventes réellement enregistrées autour de votre " +
            "bien à " +
            escapeHtml(cityName) +
            ". Aucun indicateur de marché estimé ou modélisé (délai de vente, marge de " +
            "négociation) n'est affiché : ces données ne figurent pas dans la base publique " +
            "des transactions.</p>" +
            '<div class="stats-grid" style="margin: 25px 0;">' +
            stats
              .map(function (stat) {
                return (
                  '<div class="stat-item"><div class="stat-value">' +
                  escapeHtml(stat.value) +
                  '</div><div class="stat-label">' +
                  escapeHtml(stat.label) +
                  "</div></div>"
                );
              })
              .join("") +
            "</div>" +
            '<div class="info-box"><p>' +
            escapeHtml(describeLevel(method)) +
            ". Le prix médian ci-dessus est celui de l'échantillon retenu, avant application " +
            "des coefficients propres à votre bien : il diffère donc du prix au m² estimé." +
            "</p></div>";

          cityAnalysis.hidden = false;
        }

        // ------------------------------------------------------------------
        // « Relancer le calcul » (mode dégradé). Rejoue l'appel API à partir
        // du `lastEstimation` déjà validé, puis recharge la page.
        // ------------------------------------------------------------------
        const retryBtn = el("retryEstimationBtn");
        if (retryBtn && typeof requestEstimation === "function") {
          retryBtn.addEventListener("click", function () {
            const statusEl = el("retryEstimationStatus");
            retryBtn.disabled = true;
            if (statusEl) {
              statusEl.hidden = false;
              statusEl.textContent = "Nouvelle tentative en cours…";
            }

            const apiConfig = typeof CONFIG !== "undefined" && CONFIG.API ? CONFIG.API : {};
            requestEstimation(
              buildEstimationApiPayload(lastEstimation),
              { baseUrl: apiConfig.BASE_URL },
              function (response) {
                const mapped =
                  response.status === "ok"
                    ? mapApiResultToLegacyEstimation(response.result)
                    : null;

                if (!mapped) {
                  retryBtn.disabled = false;
                  if (statusEl) {
                    statusEl.textContent =
                      "Nos données de transactions restent indisponibles. Réessayez dans " +
                      "quelques minutes ou contactez un conseiller.";
                  }
                  return;
                }

                const updated = Object.assign({}, lastEstimation, {
                  estimation: mapped,
                  estimationStatus: "ok",
                });
                try {
                  localStorage.setItem("lastEstimation", JSON.stringify(updated));
                } catch (error) {
                  console.error("Impossible d'enregistrer l'estimation :", error);
                }
                window.location.reload();
              }
            );
          });
        } else if (retryBtn) {
          // `estimation-api.js` absent : mieux vaut masquer un bouton qui ne
          // peut rien faire que d'afficher une action morte.
          retryBtn.hidden = true;
        }
      }

      // Téléchargement du rapport PDF. La mise en page vit dans
      // `pdf-report.js` (chargé avant ce script), partagée avec la page de
      // preview `/pdf-preview/`.
      function downloadPDF() {
        const downloadButton = document.getElementById("downloadPdfBtn");
        const originalText = downloadButton.innerHTML;
        downloadButton.innerHTML = "⏳ Génération du PDF...";
        downloadButton.disabled = true;

        try {
          const doc = buildEstimationPdf(lastEstimation);
          doc.save(buildEstimationPdfFileName(lastEstimation));

          // Après `save()`, et pas au clic : un PDF qui a échoué n'est pas un
          // téléchargement. Ce signal sert de conversion secondaire (plan
          // §7.1) — le compter à tort gonflerait un indicateur d'engagement.
          if (typeof embTrack === "function") {
            embTrack("report_pdf_download", {
              lead_id: lastEstimation.lead_id,
              estimation_status: lastEstimation.estimationStatus,
            });
          }
        } catch (error) {
          console.error("Erreur PDF:", error);
          alert("Une erreur est survenue. Veuillez réessayer.");
        }

        downloadButton.innerHTML = originalText;
        downloadButton.disabled = false;
      }
