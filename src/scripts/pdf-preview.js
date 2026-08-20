// Page de travail `/pdf-preview/` : régénère le PDF du rapport à chaque
// changement de champ et l'affiche dans un iframe, sans passer par le wizard
// ni le localStorage. La mise en page PDF elle-même vit dans `pdf-report.js`.

(function () {
  var form = document.getElementById("previewForm");
  var frame = document.getElementById("pdfFrame");
  var statusEl = document.getElementById("previewStatus");
  var jsonEl = document.getElementById("previewJson");
  var pageSelect = document.getElementById("previewPage");
  var stateSelect = document.getElementById("previewState");
  var autoEl = document.getElementById("previewAuto");
  var currentUrl = null;
  var currentData = null;

  /**
   * Bloc renvoyé par l'API (`EstimationResult` mappé, cf. §5.4) superposé au
   * payload de base. Il n'est PAS reconstructible depuis le formulaire : c'est
   * ce sélecteur d'état qui le fabrique, de façon à couvrir en un clic les
   * quatre états d'affichage du rapport (`ok`, `low-confidence`, `no-dvf`,
   * `static-fallback`) plus le mode différé et le format d'avant le Lot 3.
   *
   * @param {string} state
   * @param {{prixM2:number, surface:number, city:string, propertyType:string}} base
   * @returns {{estimationStatus:string|undefined, extra:object|null, estimation:null|undefined}}
   */
  function buildStateOverlay(state, base) {
    var prixM2 = base.prixM2;
    var surface = base.surface;
    var value = Math.round(prixM2 * surface);

    // Indice INSEE-Notaires (`dataSource.priceIndexQuarter`) : tant que le
    // Lot 4 n'est pas livré, l'API renvoie `null` et NI le rapport NI le PDF
    // n'impriment la ligne « Ajustement temporel » (cf. rapport-report.js et
    // pdf-report.js). La maquette doit donc valoir `null` par défaut : une
    // page de travail qui montre un état impossible en production induit en
    // erreur celui qui s'en sert pour valider une mise en page. L'état dédié
    // `ok-price-index` reste disponible pour prévisualiser le rendu du jour
    // où le Lot 4 arrivera.
    var priceIndexQuarter = state === "ok-price-index" ? "2025-T2" : null;

    function comparables(count) {
      var streets = [
        "Rue de la Paix",
        "Rue du Senechal",
        "Place Lantaire",
        "Rue de Champegaud",
        "Rue Jean Jaures",
      ];
      var list = [];
      for (var i = 0; i < count; i++) {
        list.push({
          street: streets[i % streets.length],
          city: base.city,
          distanceM: 150 + i * 100,
          date: "2025-0" + ((i % 9) + 1),
          propertyType: base.propertyType,
          surface: Math.round(surface * (0.85 + i * 0.07)),
          rooms: 3,
          pricePerSqm: Math.round(prixM2 * (0.82 + i * 0.09)),
          price: Math.round(prixM2 * (0.82 + i * 0.09) * surface),
          timeAdjustedPricePerSqm: Math.round(prixM2 * (0.82 + i * 0.09)),
        });
      }
      return list;
    }

    function dataSource(coverage) {
      return {
        dataCoverage: coverage,
        primary: coverage === "no-dvf" ? "REFERENCE" : "DVF",
        dvfPublicationDate: "2025-10-01",
        lastImportAt: "2025-11-04T02:15:00.000Z",
        priceIndexQuarter: priceIndexQuarter,
        licence: "Licence Ouverte / Etalab 2.0",
        // Le front n'écrit JAMAIS cette phrase : il rend celle de l'API. Le
        // jeu de test reproduit donc les deux formulations réelles, dont
        // celle des territoires hors DVF, qui ne cite ni la DGFiP ni Etalab.
        attributionFr:
          coverage === "no-dvf"
            ? "Source : références départementales internes, hors base publique DVF. Géocodage : Base Adresse Nationale."
            : "Source : Demandes de valeurs foncières (DVF), Direction générale des finances publiques, publiées le 1er octobre 2025, mises à jour dans notre base le 4 novembre 2025. Données diffusées sous Licence Ouverte / Etalab 2.0. Géocodage : Base Adresse Nationale.",
        disclaimerFr:
          "Cette estimation automatisée ne constitue ni une expertise immobilière, ni un avis de valeur au sens de la Charte de l'expertise en évaluation immobilière. Elle repose sur des transactions comparables et ne tient compte ni de l'état intérieur réel du bien, ni de ses spécificités (vue, exposition, nuisances, servitudes, travaux votés en copropriété). Seule une visite sur place permet une évaluation engageante.",
      };
    }

    function method(overrides) {
      return Object.assign(
        {
          kind: "comparables",
          level: "radius",
          radiusM: 500,
          windowMonths: 24,
          surfaceTolerancePct: 30,
          comparablesCount: 24,
          comparablesRejected: { iqr: 3 },
          medianPriceM2Raw: Math.round(prixM2 * 0.94),
          // Sans indice, l'API renvoie un facteur câblé à 1 (aucune correction
          // mesurée) : le couple doit rester cohérent avec la production.
          timeAdjustmentFactor: priceIndexQuarter ? 1.02 : 1,
          coefficients: {
            surface: 0.99,
            floor: 1.05,
            outdoor: 1.02,
            condition: 1.03,
            dpe: 1.03,
            total: 1.12,
            clamped: false,
          },
          landValue: 0,
        },
        overrides || {}
      );
    }

    if (state === "legacy") {
      // `lastEstimation` d'avant le Lot 3 : aucune des nouvelles clés, aucun
      // `estimationStatus`. C'est le test de non-régression US-11.
      return { estimationStatus: undefined, extra: null };
    }

    if (state === "static-fallback") {
      return { estimationStatus: "static-fallback", extra: null };
    }

    if (state === "deferred") {
      return { estimationStatus: "deferred", estimation: null, extra: null };
    }

    if (state === "no-dvf") {
      return {
        estimationStatus: "ok",
        extra: {
          confidence: {
            score: 35,
            label: "low",
            breakdown: { count: 0, proximity: 12, freshness: 0, dispersion: 0, penalties: 0 },
          },
          display: {
            showCentralValue: true,
            confidenceLabelFr: "Confiance faible",
            warnings: [
              "Les départements du Bas-Rhin, du Haut-Rhin, de la Moselle et de Mayotte relèvent du régime du Livre foncier : leurs transactions ne figurent pas dans la base publique DVF de la DGFiP.",
            ],
          },
          range: { low: Math.round(value * 0.8), high: Math.round(value * 1.2), halfWidthPct: 0.2, basis: "fixed" },
          method: method({
            kind: "reference-table",
            level: "departement-reference",
            radiusM: null,
            comparablesCount: 0,
            medianPriceM2Raw: null,
          }),
          comparables: [],
          dataSource: dataSource("no-dvf"),
          computedAt: "2025-11-04T09:12:00.000Z",
          apiVersion: 1,
        },
      };
    }

    if (state === "insufficient") {
      return {
        estimationStatus: "ok",
        extra: {
          confidence: {
            score: 18,
            label: "insufficient",
            breakdown: { count: 9.2, proximity: 5, freshness: 3.4, dispersion: 0.4, penalties: 0 },
          },
          display: {
            showCentralValue: false,
            confidenceLabelFr: "Données insuffisantes",
            warnings: [
              "Nous ne disposons pas encore d'assez de transactions comparables sur ce secteur pour produire une estimation défendable.",
            ],
          },
          range: { low: Math.round(value * 0.75), high: Math.round(value * 1.25), halfWidthPct: 0.25, basis: "iqr" },
          method: method({ level: "departement", radiusM: null, comparablesCount: 6 }),
          comparables: comparables(2),
          dataSource: dataSource("dvf"),
          computedAt: "2025-11-04T09:12:00.000Z",
          apiVersion: 1,
        },
      };
    }

    if (state === "low-confidence") {
      return {
        estimationStatus: "ok",
        extra: {
          confidence: {
            score: 41,
            label: "low",
            breakdown: { count: 18.4, proximity: 12, freshness: 7.2, dispersion: 8.4, penalties: 5 },
          },
          display: {
            showCentralValue: true,
            confidenceLabelFr: "Confiance faible",
            warnings: [
              "Peu de transactions comparables sur ce secteur : une visite sur place est recommandée.",
            ],
          },
          range: { low: Math.round(value * 0.78), high: Math.round(value * 1.22), halfWidthPct: 0.22, basis: "iqr" },
          method: method({
            level: "commune",
            radiusM: null,
            comparablesCount: 9,
            surfaceTolerancePct: 40,
            coefficients: {
              surface: 1.15,
              floor: 0.93,
              outdoor: 1.06,
              condition: 0.88,
              dpe: 0.84,
              total: 0.7,
              clamped: true,
            },
          }),
          comparables: comparables(3),
          dataSource: dataSource("dvf"),
          computedAt: "2025-11-04T09:12:00.000Z",
          apiVersion: 1,
        },
      };
    }

    // 'ok' — et 'ok-price-index', identique à l'exception de l'indice INSEE
    // ci-dessus (seul état qui fait apparaître la ligne « Ajustement
    // temporel », impossible en production tant que le Lot 4 n'est pas livré).
    return {
      estimationStatus: "ok",
      extra: {
        confidence: {
          score: 82,
          label: "high",
          breakdown: { count: 36.8, proximity: 22.5, freshness: 12.1, dispersion: 15.6, penalties: 5 },
        },
        display: { showCentralValue: true, confidenceLabelFr: "Confiance élevée", warnings: [] },
        range: { low: Math.round(value * 0.91), high: Math.round(value * 1.09), halfWidthPct: 0.09, basis: "iqr" },
        method: method(),
        comparables: comparables(5),
        dataSource: dataSource("dvf"),
        computedAt: "2025-11-04T09:12:00.000Z",
        apiVersion: 1,
      },
    };
  }

  // Jeux de données couvrant les branches de mise en page du PDF :
  // maison avec/sans terrain, appartement, DPE absent, prix bas/haut.
  var PRESETS = {
    appartementParis: {
      label: "Appartement Paris (marché tendu)",
      propertyType: "appartement",
      address: "18 rue des Petits Champs",
      postalCode: "75002",
      city: "paris",
      surface: 68,
      rooms: 3,
      dpe: "C",
      prixM2: 10400,
      hasTerrain: "no",
      terrainSize: "",
      isOwner: "yes",
      wantToSell: "yes",
    },
    maisonTerrain: {
      label: "Maison avec terrain (marché équilibré)",
      propertyType: "maison",
      address: "7 chemin des Vignes",
      postalCode: "33700",
      city: "mérignac",
      surface: 132,
      rooms: 5,
      dpe: "D",
      prixM2: 3800,
      hasTerrain: "yes",
      terrainSize: "620",
      isOwner: "yes",
      wantToSell: "maybe",
    },
    studioPassoire: {
      label: "Studio DPE G (décote)",
      propertyType: "appartement",
      address: "3 rue Gambetta",
      postalCode: "42000",
      city: "saint-étienne",
      surface: 24,
      rooms: 1,
      dpe: "G",
      prixM2: 1450,
      hasTerrain: "no",
      terrainSize: "",
      isOwner: "no",
      wantToSell: "no",
    },
    maisonSansDpe: {
      label: "Maison sans DPE, champs minimaux",
      propertyType: "maison",
      address: "12 route de la Forêt",
      postalCode: "56000",
      city: "vannes",
      surface: 95,
      rooms: 4,
      dpe: "unknown",
      prixM2: 3200,
      hasTerrain: "no",
      terrainSize: "",
      isOwner: "",
      wantToSell: "",
    },
  };

  /** Valeurs du formulaire -> payload identique à `lastEstimation`. */
  function readForm() {
    var get = function (name) {
      var field = form.elements[name];
      return field ? field.value : "";
    };

    var surface = parseFloat(get("surface")) || 0;
    var rooms = parseInt(get("rooms"), 10) || 0;
    var prixM2 = parseInt(get("prixM2"), 10) || 0;
    var propertyType = get("propertyType");

    var overlay = buildStateOverlay(stateSelect ? stateSelect.value : "ok", {
      prixM2: prixM2,
      surface: surface,
      city: get("city"),
      propertyType: propertyType,
    });

    var payload = {
      id: 0,
      timestamp: "1970-01-01T00:00:00.000Z",
      propertyType: propertyType,
      address: get("address"),
      postalCode: get("postalCode"),
      city: get("city"),
      surface: surface,
      rooms: rooms,
      dpe: get("dpe"),
      isOwner: get("isOwner"),
      wantToSell: get("wantToSell"),
      hasTerrain: propertyType === "maison" ? get("hasTerrain") : "",
      terrainSize: get("terrainSize"),
      name: "Aperçu",
      email: "preview@estimer.co",
      phone: "",
      estimation: {
        // Contrat historique, toujours les quatre mêmes clés.
        prixM2: prixM2,
        estimationMin: Math.round(prixM2 * surface * 0.9),
        estimationMax: Math.round(prixM2 * surface * 1.1),
        estimationMoyenne: Math.round(prixM2 * surface),
      },
    };

    if (overlay.estimationStatus !== undefined) {
      payload.estimationStatus = overlay.estimationStatus;
    }

    if (overlay.estimation === null) {
      payload.estimation = null;
    } else if (overlay.extra) {
      // Les bornes de la fourchette suivent `range` quand l'API en fournit une.
      payload.estimation = Object.assign({}, payload.estimation, overlay.extra, {
        estimationMin: overlay.extra.range.low,
        estimationMax: overlay.extra.range.high,
      });
    }

    return payload;
  }

  /** Payload -> formulaire (presets, JSON collé, dernière estimation réelle). */
  function writeForm(data) {
    var set = function (name, value) {
      var field = form.elements[name];
      if (field) field.value = value === undefined || value === null ? "" : value;
    };

    set("propertyType", data.propertyType);
    set("address", data.address);
    set("postalCode", data.postalCode);
    set("city", data.city);
    set("surface", data.surface);
    set("rooms", data.rooms);
    set("dpe", data.dpe);
    set("isOwner", data.isOwner);
    set("wantToSell", data.wantToSell);
    set("hasTerrain", data.hasTerrain);
    set("terrainSize", data.terrainSize);
    set("prixM2", data.estimation ? data.estimation.prixM2 : data.prixM2);
    syncTerrainVisibility();
  }

  /** Le bloc terrain n'est lu par le PDF que pour une maison. */
  function syncTerrainVisibility() {
    var isMaison = form.elements.propertyType.value === "maison";
    document.querySelectorAll("[data-maison-only]").forEach(function (el) {
      el.hidden = !isMaison;
    });
  }

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  /** Régénère le PDF et le réinjecte dans l'iframe. */
  function render() {
    var data = readForm();
    currentData = data;
    jsonEl.value = JSON.stringify(data, null, 2);

    try {
      var doc = buildEstimationPdf(data);
      var url = doc.output("bloburl");
      // Le fragment `#page=` est interprété par le lecteur PDF intégré :
      // on reste sur la page travaillée d'un rendu à l'autre.
      frame.src =
        url +
        "#page=" +
        pageSelect.value +
        "&zoom=page-fit&toolbar=0&navpanes=0";

      // L'URL précédente n'est révoquée qu'après le chargement du nouveau
      // document, sinon Chrome annule le rendu en cours.
      var previous = currentUrl;
      currentUrl = url;
      if (previous) {
        setTimeout(function () {
          URL.revokeObjectURL(previous);
        }, 1000);
      }

      setStatus(
        "Rendu à " +
          new Date().toLocaleTimeString("fr-FR") +
          " · " +
          (stateSelect ? stateSelect.value + " · " : "") +
          (data.estimation
            ? formatPrice(data.estimation.estimationMoyenne) +
              " (" +
              formatPrice(data.estimation.estimationMin) +
              " – " +
              formatPrice(data.estimation.estimationMax) +
              ")"
            : "aucune estimation (mode différé)") +
          " · " +
          doc.getNumberOfPages() +
          " page(s)",
        false
      );
    } catch (error) {
      console.error("Erreur de génération du PDF :", error);
      setStatus("Erreur : " + error.message, true);
    }
  }

  function renderIfAuto() {
    syncTerrainVisibility();
    if (autoEl.checked) render();
  }

  form.addEventListener("input", renderIfAuto);
  form.addEventListener("change", renderIfAuto);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    render();
  });

  pageSelect.addEventListener("change", render);

  if (stateSelect) stateSelect.addEventListener("change", render);

  document.getElementById("previewRender").addEventListener("click", render);

  document
    .getElementById("previewDownload")
    .addEventListener("click", function () {
      if (!currentData) return;
      buildEstimationPdf(currentData).save(
        buildEstimationPdfFileName(currentData)
      );
    });

  // Charge la dernière estimation réellement produite par le wizard, pour
  // vérifier le rendu sur des données de production.
  document
    .getElementById("previewLoadLast")
    .addEventListener("click", function () {
      var raw = null;
      try {
        raw = localStorage.getItem("lastEstimation");
      } catch (error) {
        raw = null;
      }
      if (!raw) {
        setStatus("Aucune estimation en localStorage.", true);
        return;
      }
      try {
        writeForm(JSON.parse(raw));
        render();
      } catch (error) {
        setStatus("localStorage illisible : " + error.message, true);
      }
    });

  document
    .getElementById("previewApplyJson")
    .addEventListener("click", function () {
      try {
        writeForm(JSON.parse(jsonEl.value));
        render();
      } catch (error) {
        setStatus("JSON invalide : " + error.message, true);
      }
    });

  document
    .getElementById("previewPreset")
    .addEventListener("change", function (event) {
      var preset = PRESETS[event.target.value];
      if (!preset) return;
      writeForm({
        propertyType: preset.propertyType,
        address: preset.address,
        postalCode: preset.postalCode,
        city: preset.city,
        surface: preset.surface,
        rooms: preset.rooms,
        dpe: preset.dpe,
        isOwner: preset.isOwner,
        wantToSell: preset.wantToSell,
        hasTerrain: preset.hasTerrain,
        terrainSize: preset.terrainSize,
        prixM2: preset.prixM2,
      });
      render();
    });

  // Premier rendu au chargement.
  syncTerrainVisibility();
  render();
})();
