// ============================================================================
// HOME ADDRESS — champ d'adresse du hero, point d'entrée vers /estimation
// ============================================================================
//
// Ce fichier est injecté tel quel (voir `RawScript.astro`, `<script
// is:inline set:html={code} />` à partir d'un import `?raw`), juste après
// `google-places.js` dont il consomme les globales (`parseGooglePlace`,
// `loadGoogleMapsScript`). Comme les autres scripts de page : ni bundler, ni
// `import`/`export`.
//
// Principe : le formulaire du hero est un vrai `<form action="/estimation/"
// method="get">`. Sans JavaScript (ou sans clé Google), il fonctionne déjà —
// l'adresse saisie part en query string et le wizard la pré-remplit. Le
// script n'ajoute que la couche d'enrichissement : le widget Google Places
// renseigne les champs cachés code postal / ville, ce qui permet au wizard
// d'ouvrir directement l'étape 2 (cf. `parseAddressQuery` côté
// `estimation-ui.js`).
//
// Tout le câblage est protégé par la présence de `#heroAddressForm` : le
// fichier reste inerte sur une page qui ne contient pas le formulaire.

var heroAddressFormEl =
  typeof document !== "undefined" ? document.getElementById("heroAddressForm") : null;

if (heroAddressFormEl) {
  var heroAddressInputEl = document.getElementById("heroAddress");
  var heroPostalCodeEl = document.getElementById("heroPostalCode");
  var heroCityEl = document.getElementById("heroCity");
  var heroSourceEl = document.getElementById("heroAddressSource");
  var heroErrorEl = document.getElementById("heroAddress-error");

  // Délai laissé au widget Google pour émettre `place_changed` après un
  // « Entrée » sur une suggestion, avant de soumettre le formulaire avec la
  // seule saisie brute (cf. le listener `keydown` plus bas).
  var HERO_ENTER_SUBMIT_DELAY_MS = 200;

  var heroEnterTimeoutId = null;

  function clearHeroAddressDetails() {
    if (heroPostalCodeEl) heroPostalCodeEl.value = "";
    if (heroCityEl) heroCityEl.value = "";
    if (heroSourceEl) heroSourceEl.value = "";
  }

  function showHeroAddressError(message) {
    if (!heroErrorEl) return;
    heroErrorEl.textContent = message;
    heroErrorEl.hidden = false;
    if (heroAddressInputEl) heroAddressInputEl.setAttribute("aria-invalid", "true");
  }

  function clearHeroAddressError() {
    if (heroErrorEl) {
      heroErrorEl.hidden = true;
      heroErrorEl.textContent = "";
    }
    if (heroAddressInputEl) heroAddressInputEl.removeAttribute("aria-invalid");
  }

  function submitHeroForm() {
    if (typeof heroAddressFormEl.requestSubmit === "function") {
      heroAddressFormEl.requestSubmit();
    } else {
      heroAddressFormEl.submit();
    }
  }

  // --------------------------------------------------------------------
  // Widget Google Places — publié sur `window` car c'est ce nom que Google
  // appelle via le paramètre `callback=` de l'URL du script.
  // --------------------------------------------------------------------
  var heroAutocompleteInstance = null;

  function initHeroAutocomplete() {
    if (
      !heroAddressInputEl ||
      typeof google === "undefined" ||
      !google.maps ||
      !google.maps.places
    ) {
      return;
    }

    heroAutocompleteInstance = new google.maps.places.Autocomplete(heroAddressInputEl, {
      types: ["address"],
      componentRestrictions: { country: "fr" },
    });

    heroAutocompleteInstance.addListener("place_changed", function () {
      var parsed = parseGooglePlace(heroAutocompleteInstance.getPlace());

      // Pas d'`address_components` exploitables : on repart de la saisie
      // brute, le wizard demandera CP et ville à l'étape 1.
      if (!parsed) {
        clearHeroAddressDetails();
        return;
      }

      if (heroPostalCodeEl) heroPostalCodeEl.value = parsed.postalCode;
      if (heroCityEl) heroCityEl.value = parsed.city;
      if (heroSourceEl) heroSourceEl.value = "autocomplete";
      clearHeroAddressError();
    });
  }

  window.initHeroAutocomplete = initHeroAutocomplete;
  loadGoogleMapsScript("initHeroAutocomplete");

  // --------------------------------------------------------------------
  // Saisie manuelle : toute frappe invalide le CP/ville issus d'une
  // suggestion précédente (l'adresse affichée ne correspond plus).
  // --------------------------------------------------------------------
  if (heroAddressInputEl) {
    heroAddressInputEl.addEventListener("input", function () {
      clearHeroAddressDetails();
      clearHeroAddressError();
    });

    // « Entrée » dans un champ Places sert d'abord à valider une suggestion :
    // on empêche la soumission immédiate, on laisse `place_changed` remplir
    // les champs cachés, puis on soumet.
    heroAddressInputEl.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (heroEnterTimeoutId !== null) clearTimeout(heroEnterTimeoutId);
      heroEnterTimeoutId = setTimeout(function () {
        heroEnterTimeoutId = null;
        submitHeroForm();
      }, HERO_ENTER_SUBMIT_DELAY_MS);
    });
  }

  // --------------------------------------------------------------------
  // Soumission : adresse obligatoire, et on n'envoie pas de paramètres vides
  // dans l'URL (un champ `disabled` n'est pas sérialisé par le navigateur).
  // --------------------------------------------------------------------
  heroAddressFormEl.addEventListener("submit", function (e) {
    var address = heroAddressInputEl ? heroAddressInputEl.value.trim() : "";

    if (!address) {
      e.preventDefault();
      showHeroAddressError("Merci d'indiquer l'adresse du bien à estimer.");
      if (heroAddressInputEl) heroAddressInputEl.focus();
      return;
    }

    [heroPostalCodeEl, heroCityEl, heroSourceEl].forEach(function (el) {
      if (el) el.disabled = !el.value;
    });
  });
}
