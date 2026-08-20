// ============================================================================
// GOOGLE PLACES — helpers partagés (accueil + wizard d'estimation)
// ============================================================================
//
// Ce fichier est injecté tel quel (voir `RawScript.astro`, `<script
// is:inline set:html={code} />` à partir d'un import `?raw`) : ni bundler ni
// modules ES, PAS de `import`/`export`. Tout ce qui est déclaré ici vit dans
// la portée globale de la page et doit donc être chargé AVANT les scripts
// qui le consomment :
//
// - `/estimation` : google-places.js -> estimation-wizard.js -> estimation-ui.js
// - `/`           : google-places.js -> home-address.js
//
// `parseGooglePlace` vivait auparavant dans `estimation-wizard.js` (§3) ; il
// est remonté ici depuis que le champ d'adresse du hero de l'accueil s'appuie
// sur le même widget Google — plutôt que d'en dupliquer la logique d'un côté
// ou de charger tout le wizard (table de prix comprise) sur la page d'accueil.

// ============================================================================
// 1. ADAPTER DE GÉOCODAGE — Google PlaceResult -> champs de formulaire
// ============================================================================

/**
 * Transforme un `google.maps.places.PlaceResult` en champs de formulaire.
 * Fonction pure : ne touche jamais au DOM, ne modifie JAMAIS la valeur du
 * champ adresse (cf. specs/estimation-wizard.md §0 — `rapport-map.js`
 * reconstruit l'adresse complète à partir de la valeur brute déposée dans le
 * champ par le widget Google).
 *
 * `locality` a toujours priorité sur `administrative_area_level_2`, quel que
 * soit l'ordre des `address_components` dans la réponse.
 *
 * @param {google.maps.places.PlaceResult|null|undefined} place
 * @returns {{postalCode:string, city:string, placeId:string}|null} null si
 *   `address_components` est absent (US-3 : repli manuel).
 */
function parseGooglePlace(place) {
  if (!place || !Array.isArray(place.address_components)) {
    return null;
  }

  var postalCode = "";
  var city = "";
  var cityFallback = ""; // administrative_area_level_2, utilisé seulement si pas de locality.

  for (var i = 0; i < place.address_components.length; i++) {
    var component = place.address_components[i];
    var type = component && component.types && component.types[0];

    switch (type) {
      case "postal_code":
        postalCode = component.long_name;
        break;
      case "locality":
        city = component.long_name;
        break;
      case "administrative_area_level_2":
        cityFallback = component.long_name;
        break;
    }
  }

  return {
    postalCode: postalCode,
    city: city || cityFallback,
    placeId: place.place_id || "",
  };
}

// ============================================================================
// 2. CHARGEMENT DE L'API GOOGLE MAPS
// ============================================================================

/**
 * Injecte le `<script>` de l'API Google Maps (librairie `places`) et demande
 * l'appel de `callbackName` une fois chargée. Le callback doit être publié sur
 * `window` par l'appelant AVANT cet appel.
 *
 * Ne fait rien si aucune clé n'est configurée (preview, dev sans `.env`) : à
 * l'appelant de prévoir son repli (bloc CP/ville manuel côté wizard, saisie
 * libre côté accueil).
 *
 * @param {string} callbackName nom global du callback (`window[callbackName]`)
 * @param {() => void} [onError] appelé si le script ne charge pas (bloqueur, réseau)
 * @returns {boolean} false si le chargement n'a même pas été tenté (clé absente)
 */
function loadGoogleMapsScript(callbackName, onError) {
  if (typeof document === "undefined") return false;
  if (typeof CONFIG === "undefined" || !CONFIG.GOOGLE || !CONFIG.GOOGLE.API_KEY) {
    return false;
  }

  var script = document.createElement("script");
  script.src =
    "https://maps.googleapis.com/maps/api/js?key=" +
    CONFIG.GOOGLE.API_KEY +
    "&libraries=places&callback=" +
    encodeURIComponent(callbackName);
  script.async = true;
  script.defer = true;
  script.onerror = function () {
    if (typeof onError === "function") onError();
  };
  document.head.appendChild(script);
  return true;
}

// ============================================================================
// 3. PRÉ-REMPLISSAGE PAR URL — /?address=... -> /estimation/?address=...
// ============================================================================

/**
 * Nom des paramètres d'URL transmis par le formulaire d'adresse de l'accueil
 * au wizard d'estimation. Source unique de vérité, partagée par l'émetteur
 * (`home-address.js`, via les `name` des champs) et le consommateur
 * (`estimation-ui.js`, via `parseAddressQuery`).
 */
var ADDRESS_QUERY_KEYS = {
  address: "address",
  postalCode: "postalCode",
  city: "city",
  source: "addressSource",
};

/**
 * Lit et ASSAINIT les paramètres d'adresse d'une query string. Fonction pure
 * (aucun accès à `window`/`document`), pour rester testable hors navigateur.
 *
 * Les valeurs viennent d'une URL, donc de l'extérieur : rien n'est cru sur
 * parole. Le code postal n'est retenu que s'il a exactement 5 chiffres (même
 * règle que `validateStep(1, ...)`), les chaînes sont rognées et bornées en
 * longueur, et `addressSource` ne peut valoir `autocomplete` que si le couple
 * CP + ville est bien présent — sinon le récapitulatif d'adresse du wizard
 * prétendrait à une sélection Google qui n'a jamais eu lieu.
 *
 * @param {string} search `window.location.search` (avec ou sans `?`)
 * @returns {{address:string, postalCode:string, city:string, addressSource:string}|null}
 *   null si aucune adresse exploitable n'est passée dans l'URL.
 */
function parseAddressQuery(search) {
  if (typeof URLSearchParams === "undefined") return null;

  var params;
  try {
    params = new URLSearchParams(String(search || ""));
  } catch (error) {
    return null;
  }

  var address = String(params.get(ADDRESS_QUERY_KEYS.address) || "").trim().slice(0, 200);
  if (!address) return null;

  var rawPostalCode = String(params.get(ADDRESS_QUERY_KEYS.postalCode) || "").trim();
  var postalCode = /^\d{5}$/.test(rawPostalCode) ? rawPostalCode : "";
  var city = String(params.get(ADDRESS_QUERY_KEYS.city) || "").trim().slice(0, 100);

  var claimedSource = String(params.get(ADDRESS_QUERY_KEYS.source) || "").trim();
  var addressSource = "";
  if (postalCode && city) {
    addressSource = claimedSource === "autocomplete" ? "autocomplete" : "manual";
  } else if (postalCode || city) {
    addressSource = "manual";
  }

  return {
    address: address,
    postalCode: postalCode,
    city: city,
    addressSource: addressSource,
  };
}
