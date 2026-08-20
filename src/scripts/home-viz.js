// ============================================================================
// HOME VIZ — les trois visuels de la section « La solution » s'animent à l'écran
// ============================================================================
//
// Injecté tel quel comme les autres scripts de page (voir `RawScript.astro`) :
// ni bundler, ni `import`/`export`, style ES5.
//
// Le HTML rend l'état final : barres à leur hauteur, jauges DPE remplies,
// bandeaux de partenaires visibles. Sans JavaScript, la section est donc déjà
// juste. Le script ne fait que deux choses :
//
//   1. poser `is-armed` sur chaque `[data-viz]`, ce qui replie le visuel
//      (barres à zéro, jauges vides) — cf. les règles `.viz.is-armed` dans
//      `index.astro` ;
//   2. poser `is-in` quand le visuel entre dans le viewport, ce qui le
//      déroule, une seule fois.
//
// Le repli n'a lieu que si l'animation va effectivement se jouer : pas
// d'`IntersectionObserver`, pas de `is-armed`, donc jamais de visuel replié
// qui resterait vide.
//
// Garde-fous :
//   - `prefers-reduced-motion: reduce` → le script ne fait rien du tout ;
//   - un visuel déjà à l'écran au chargement est déroulé au premier callback
//     de l'observer, donc sans clignotement.
//
// Les visuels sont `aria-hidden` côté HTML : rien de tout ceci n'est annoncé,
// et aucun chiffre affiché ici n'est réel — ce sont des illustrations.

(function () {
  if (typeof document === "undefined") return;

  var vizList = document.querySelectorAll("[data-viz]");
  if (!vizList.length) return;

  if (
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    typeof IntersectionObserver !== "function"
  ) {
    return;
  }

  // --------------------------------------------------------------------
  // Compteur : le pourcentage en tête du graphique monte de 0 à sa valeur
  //
  // Le HTML porte déjà le texte final ; on ne l'écrase que le temps de
  // l'animation, puis on le laisse sur la valeur cible formatée à la
  // française (virgule décimale).
  // --------------------------------------------------------------------
  function countUp(el) {
    var cible = parseFloat(el.getAttribute("data-count-to"));
    if (isNaN(cible)) return;

    var prefixe = el.getAttribute("data-count-prefix") || "";
    var suffixe = el.getAttribute("data-count-suffix") || "";
    var decimales = (String(cible).split(".")[1] || "").length;
    var duree = 900;
    var debut = null;

    function ecrire(valeur) {
      el.textContent = prefixe + valeur.toFixed(decimales).replace(".", ",") + suffixe;
    }

    function trame(horodatage) {
      if (debut === null) debut = horodatage;
      var t = Math.min((horodatage - debut) / duree, 1);
      // Même sortie que `--ease` : rapide au départ, freinée à l'arrivée.
      ecrire(cible * (1 - Math.pow(1 - t, 3)));
      if (t < 1) window.requestAnimationFrame(trame);
    }

    ecrire(0);
    window.requestAnimationFrame(trame);
  }

  // --------------------------------------------------------------------
  // Repli, puis déroulé à l'entrée dans le viewport
  // --------------------------------------------------------------------
  var observer = new IntersectionObserver(
    function (entrees) {
      for (var i = 0; i < entrees.length; i++) {
        var entree = entrees[i];
        if (!entree.isIntersecting) continue;

        var viz = entree.target;
        observer.unobserve(viz);
        viz.classList.add("is-in");

        var compteurs = viz.querySelectorAll("[data-count-to]");
        for (var j = 0; j < compteurs.length; j++) countUp(compteurs[j]);
      }
    },
    // Un tiers du visuel visible : assez pour que l'animation se joue sous
    // les yeux du visiteur, pas si haut qu'elle attende un scroll de plus.
    { threshold: 0.35 },
  );

  for (var i = 0; i < vizList.length; i++) {
    vizList[i].classList.add("is-armed");
    observer.observe(vizList[i]);
  }
})();
