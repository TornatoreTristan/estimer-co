// ============================================================================
// RAPPORT — carte de localisation du bien
// ============================================================================
//
// Ce fichier est injecté tel quel (voir `RawScript.astro`) : ni bundler ni
// modules ES, PAS de `import`/`export`. `initMap` doit rester une globale,
// c'est le nom passé en `callback=` à l'API Google Maps.
//
// `capitalizeFirst` / `capitalizeWords` viennent de `pdf-report.js`, chargé
// juste avant sur `/rapport` (cf. l'ordre des `<RawScript>` dans
// `rapport.astro`). Elles ne sont appelées que depuis `initMap`, donc bien
// après l'exécution de tous les scripts de la page.

// Variables globales pour la carte
var map;
var marker;

/**
 * Clé Google Maps telle qu'elle a été injectée AU BUILD
 * (`PUBLIC_GOOGLE_MAPS_API_KEY` -> `src/lib/config.ts` -> `ClientConfig.astro`).
 *
 * Une variable d'environnement absente vaut `undefined` et disparaît du JSON
 * sérialisé : `CONFIG.GOOGLE` vaut alors `{}`. Lecture entièrement défensive,
 * `.trim()` compris — `"  "` n'est pas une clé.
 *
 * NB : volontairement distincte de `readGoogleMapsApiKey()` de
 * `google-places.js`, qui n'est PAS chargé sur `/rapport`.
 *
 * @returns {string} la clé, ou "" si aucune clé exploitable n'est configurée.
 */
function readReportMapApiKey() {
  if (typeof CONFIG === "undefined" || !CONFIG || !CONFIG.GOOGLE) return "";
  return String(CONFIG.GOOGLE.API_KEY || "").trim();
}

/** Lecture défensive de `lastEstimation` (JSON corrompu -> null, jamais de throw). */
function readLastEstimation() {
  try {
    return JSON.parse(localStorage.getItem("lastEstimation"));
  } catch (error) {
    return null;
  }
}

/** Adresse complète telle qu'affichée sous la carte et géocodée par Google. */
function buildFullAddress(estimation) {
  return `${estimation.address}, ${estimation.postalCode} ${estimation.city}, France`;
}

/**
 * Affiche l'adresse sous la carte. Appelée AVANT tout appel à Google : que la
 * carte s'affiche ou non, l'utilisateur doit voir l'adresse de son bien.
 */
function renderMapAddress(estimation) {
  const el = document.getElementById("mapFullAddress");
  if (!el || !estimation) return;
  el.textContent = buildFullAddress(estimation);
}

/**
 * Remplace la carte par un message lisible. Sans cela, un build sans clé
 * laisse un cadre de 22rem vide (ou le carré gris « Oops! Something went
 * wrong » de Google), sans indiquer que le reste du rapport est valide.
 */
function showMapUnavailable(message) {
  const container = document.getElementById("propertyMap");
  if (!container) return;
  container.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #f7f5f2;">
                            <p style="color: rgba(29,12,27,0.6); text-align: center;">
                                ${message}
                            </p>
                        </div>
                    `;
}

/**
 * Charge l'API Google Maps — mais SEULEMENT si une clé existe.
 *
 * Injecter `key=undefined` (comportement précédent) produisait une carte grise
 * et une erreur `InvalidKeyMapError` opaque en console, indiscernable d'une
 * panne côté Google. On préfère ne rien demander et le dire.
 *
 * @returns {boolean} true si le script Google a réellement été injecté.
 */
function loadGoogleMapsAPI() {
  const lastEstimation = readLastEstimation();

  // Pas d'estimation : `rapport-report.js` redirige vers /estimation/. Rien à
  // afficher ici, et surtout aucun message qui clignoterait avant le départ.
  if (!lastEstimation) return false;

  renderMapAddress(lastEstimation);

  const apiKey = readReportMapApiKey();
  if (!apiKey) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(
        "[estimer.co] Carte de localisation desactivee : PUBLIC_GOOGLE_MAPS_API_KEY " +
          "est absente du build (variable d'environnement a definir sur l'hebergeur " +
          "AU MOMENT DU BUILD, pas seulement a l'execution)."
      );
    }
    showMapUnavailable(
      "La carte n'est pas disponible pour le moment.<br><small>L'adresse de votre bien reste indiquée ci-dessous.</small>"
    );
    return false;
  }

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
    apiKey
  )}&callback=initMap`;
  script.async = true;
  script.defer = true;
  script.onerror = function () {
    showMapUnavailable(
      "La carte n'a pas pu être chargée.<br><small>Vérifiez votre connexion.</small>"
    );
  };
  document.head.appendChild(script);
  return true;
}

// Initialiser la carte
function initMap() {
  const lastEstimation = readLastEstimation();

  if (!lastEstimation) return;

  // Construire l'adresse complète
  const fullAddress = buildFullAddress(lastEstimation);

  // Afficher l'adresse
  renderMapAddress(lastEstimation);

  // Utiliser le Geocoder pour convertir l'adresse en coordonnées
  const geocoder = new google.maps.Geocoder();

  geocoder.geocode({ address: fullAddress }, function (results, status) {
    if (status === "OK" && results[0]) {
      const location = results[0].geometry.location;

      // Créer la carte centrée sur l'adresse (vue satellite par défaut)
      map = new google.maps.Map(document.getElementById("propertyMap"), {
        zoom: 18,
        center: location,
        mapTypeId: "satellite",
      });

      // Ajouter un marqueur personnalisé
      marker = new google.maps.Marker({
        map: map,
        position: location,
        title: lastEstimation.address,
        animation: google.maps.Animation.DROP,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: "#ff6e34",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 3,
        },
      });

      // Info-bulle au clic sur le marqueur
      const infoWindow = new google.maps.InfoWindow({
        content: `
                            <div style="padding: 10px; max-width: 250px;">
                                <strong style="color: #ff6e34; font-size: 14px;">${capitalizeFirst(
                                  lastEstimation.propertyType
                                )}</strong>
                                <p style="margin: 5px 0 0; color: #1d0c1b; font-size: 13px;">${
                                  lastEstimation.address
                                }</p>
                                <p style="margin: 3px 0 0; color: rgba(29,12,27,0.6); font-size: 12px;">${
                                  lastEstimation.postalCode
                                } ${capitalizeWords(lastEstimation.city)}</p>
                            </div>
                        `,
      });

      marker.addListener("click", function () {
        infoWindow.open(map, marker);
      });

      // Ouvrir l'info-bulle par défaut
      infoWindow.open(map, marker);
    } else {
      // En cas d'erreur de géocodage, afficher un message
      showMapUnavailable(
        "Impossible de localiser l'adresse sur la carte.<br><small>Vérifiez que l'adresse est correcte.</small>"
      );
    }
  });
}

// Charger l'API Google Maps au chargement de la page
loadGoogleMapsAPI();
