// ============================================================================
// HOME CAROUSEL — les exemples d'estimations de la page d'accueil
// ============================================================================
//
// Injecté tel quel comme les autres scripts de page (voir `RawScript.astro`) :
// ni bundler, ni `import`/`export`, style ES5.
//
// Le défilement lui-même est natif : la piste est une liste en
// `overflow-x: auto` + `scroll-snap` (cf. `.carousel__track` dans
// `index.astro`). Sans JavaScript, la section reste donc parcourable à la
// molette, au doigt et au clavier. Le script se contente d'ajouter la couche
// de confort :
//
//   1. il révèle les flèches et les pastilles, `hidden` dans le markup — elles
//      n'apparaissent que s'il peut effectivement les câbler ;
//   2. il tient l'index courant à jour depuis la position de défilement, et
//      non l'inverse : c'est le scroll natif qui reste la source de vérité, ce
//      qui garde flèches, pastilles et geste tactile d'accord entre eux ;
//   3. il fait avancer le carrousel tout seul, en s'arrêtant dès que le
//      visiteur s'en occupe.
//
// Garde-fous :
//   - `prefers-reduced-motion: reduce` → pas de défilement automatique et les
//     sauts se font sans animation, mais les contrôles restent utilisables ;
//   - le défilement automatique s'arrête au survol, au focus clavier, à la
//     première interaction manuelle, et quand l'onglet passe en arrière-plan ;
//   - hors du viewport, il ne tourne pas non plus : inutile d'animer une
//     section que personne ne regarde.

(function () {
  if (typeof document === "undefined") return;

  var carousel = document.querySelector("[data-carousel]");
  if (!carousel) return;

  var piste = carousel.querySelector("[data-carousel-track]");
  if (!piste) return;

  var slides = piste.children;
  if (slides.length < 2) return;

  var nav = document.querySelector("[data-carousel-nav]");
  var precedent = document.querySelector("[data-carousel-prev]");
  var suivant = document.querySelector("[data-carousel-next]");
  var pastilles = carousel.querySelector("[data-carousel-dots]");
  var boutonsPastille = pastilles ? pastilles.querySelectorAll("[data-carousel-dot]") : [];

  var reduit =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var DELAI = 5000;
  var minuteur = null;
  var arrete = false;
  var visible = true;
  var index = 0;

  // --------------------------------------------------------------------
  // Position
  //
  // Tout est mesuré dans le DOM plutôt que recalculé ici : la largeur d'une
  // slide change avec la fenêtre (trois, puis deux, puis une par écran), le
  // `gap` s'y ajoute, et la piste porte un rembourrage qui décale l'origine du
  // défilement. Dupliquer ces règles en JavaScript reviendrait à les tenir à
  // jour à deux endroits.
  // --------------------------------------------------------------------

  /** Rembourrage gauche de la piste — l'origine du défilement, en pixels. */
  function marge() {
    return parseFloat(window.getComputedStyle(piste).paddingLeft) || 0;
  }

  /** Défilement maximal : au-delà, la piste ne bouge plus. */
  function courseMax() {
    return Math.max(0, piste.scrollWidth - piste.clientWidth);
  }

  /**
   * Décalage de défilement qui amène la slide `i` en tête de piste — borné à
   * la course réelle, sans quoi les dernières slides renverraient toutes une
   * valeur inatteignable.
   */
  function offsetDe(i) {
    var cible =
      piste.scrollLeft +
      slides[i].getBoundingClientRect().left -
      piste.getBoundingClientRect().left -
      marge();
    return Math.max(0, Math.min(cible, courseMax()));
  }

  /**
   * Dernière slide réellement atteignable.
   *
   * Avec trois biens à l'écran et cinq slides, la piste bute après la
   * troisième : demander la quatrième ne bougerait plus rien. Cet index borne
   * les flèches, le tour automatique, et masque les pastilles en trop.
   */
  function dernierIndex() {
    var max = courseMax();
    for (var i = 0; i < slides.length; i++) {
      if (offsetDe(i) >= max - 1) return i;
    }
    return slides.length - 1;
  }

  /** Index de la slide la plus proche de la position de défilement. */
  function indexCourant() {
    var dernier = dernierIndex();
    var position = piste.scrollLeft;
    var meilleur = 0;
    var ecartMin = Infinity;

    for (var i = 0; i <= dernier; i++) {
      var ecart = Math.abs(offsetDe(i) - position);
      if (ecart < ecartMin) {
        ecartMin = ecart;
        meilleur = i;
      }
    }

    return meilleur;
  }

  function afficher(i) {
    index = i;
    var dernier = dernierIndex();

    for (var j = 0; j < boutonsPastille.length; j++) {
      boutonsPastille[j].hidden = j > dernier;
      boutonsPastille[j].setAttribute("aria-current", j === i ? "true" : "false");
    }

    // Les flèches se désactivent aux extrémités : la piste ne boucle pas au
    // geste, elles ne doivent pas laisser croire le contraire.
    if (precedent) precedent.disabled = i === 0;
    if (suivant) suivant.disabled = i >= dernier;
  }

  function allerA(i, immediat) {
    var borne = Math.max(0, Math.min(i, dernierIndex()));
    piste.scrollTo({
      left: offsetDe(borne),
      behavior: immediat || reduit ? "auto" : "smooth",
    });
    // L'écouteur de scroll confirmera ; mettre à jour tout de suite évite que
    // les pastilles traînent derrière l'animation.
    afficher(borne);
  }

  // --------------------------------------------------------------------
  // Défilement automatique
  // --------------------------------------------------------------------
  function relancer() {
    stopperMinuteur();
    if (arrete || reduit || !visible || slides.length < 2) return;
    minuteur = window.setInterval(function () {
      // Le tour se referme : arrivé en bout de piste, retour à la première.
      allerA(index >= dernierIndex() ? 0 : index + 1);
    }, DELAI);
  }

  function stopperMinuteur() {
    if (minuteur === null) return;
    window.clearInterval(minuteur);
    minuteur = null;
  }

  /** Le visiteur a pris la main : le carrousel ne repart plus tout seul. */
  function rendreLaMain() {
    arrete = true;
    stopperMinuteur();
  }

  // --------------------------------------------------------------------
  // Câblage
  // --------------------------------------------------------------------
  if (nav) nav.hidden = false;
  if (pastilles) pastilles.hidden = false;

  if (precedent) {
    precedent.addEventListener("click", function () {
      rendreLaMain();
      allerA(index - 1);
    });
  }

  if (suivant) {
    suivant.addEventListener("click", function () {
      rendreLaMain();
      allerA(index + 1);
    });
  }

  for (var i = 0; i < boutonsPastille.length; i++) {
    (function (cible) {
      boutonsPastille[cible].addEventListener("click", function () {
        rendreLaMain();
        allerA(cible);
      });
    })(i);
  }

  // Molette, doigt, barre de défilement : dans tous les cas c'est le scroll
  // natif qui bouge, et c'est lui qu'on relit.
  var attente = null;
  piste.addEventListener(
    "scroll",
    function () {
      if (attente !== null) window.clearTimeout(attente);
      attente = window.setTimeout(function () {
        afficher(indexCourant());
      }, 80);
    },
    { passive: true },
  );

  // Un geste tactile ou une molette sur la piste vaut prise en main.
  piste.addEventListener("pointerdown", rendreLaMain);
  piste.addEventListener("wheel", rendreLaMain, { passive: true });

  // Survol et focus clavier : simple pause, le tour reprend en sortant.
  carousel.addEventListener("mouseenter", stopperMinuteur);
  carousel.addEventListener("mouseleave", relancer);
  carousel.addEventListener("focusin", stopperMinuteur);
  carousel.addEventListener("focusout", relancer);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopperMinuteur();
    else relancer();
  });

  // Un changement de largeur change le nombre de slides visibles, donc les
  // offsets : on se recale sur la slide courante plutôt que de laisser la
  // piste à mi-chemin entre deux.
  var recalage = null;
  window.addEventListener("resize", function () {
    if (recalage !== null) window.clearTimeout(recalage);
    recalage = window.setTimeout(function () {
      allerA(index, true);
    }, 150);
  });

  // Ne tourne que sous les yeux du visiteur.
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(
      function (entrees) {
        visible = entrees[0].isIntersecting;
        if (visible) relancer();
        else stopperMinuteur();
      },
      { threshold: 0.25 },
    ).observe(carousel);
  }

  afficher(indexCourant());
  relancer();
})();
