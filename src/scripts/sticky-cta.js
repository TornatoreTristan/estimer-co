// ============================================================================
// STICKY CTA — la barre d'appel à l'action collée en bas de page
// ============================================================================
//
// Injecté tel quel comme les autres scripts de page (voir `RawScript.astro`) :
// ni bundler, ni `import`/`export`, style ES5.
//
// Règle d'apparition, en une phrase : la barre se montre une fois la première
// section (la hero) passée, et se retire quand le pied de page arrive — le
// visiteur y trouve déjà les mêmes liens, une barre par-dessus ne ferait que
// masquer du contenu.
//
// Trois choix qui méritent une ligne :
//
//   1. L'ancre n'est pas une hauteur en pixels mais un ÉLÉMENT
//      (`[data-sticky-cta-anchor]`, à défaut `.hero` ou `.page-head`). Un
//      seuil du type « 600 px » se serait décalé au premier changement de
//      taille du titre ; le bas de la hero, lui, reste le bas de la hero.
//      Le repli sur 80 % de la hauteur d'écran ne sert qu'aux pages sans
//      aucune de ces sections — mieux vaut une barre un peu tardive que pas
//      de barre du tout.
//
//   2. Masquée, la barre est en `visibility: hidden` (cf. `global.css`), pas
//      seulement transparente ou décalée : elle sort ainsi du parcours clavier
//      et de l'arbre d'accessibilité. Une barre invisible mais tabulable est
//      un piège pour qui navigue au clavier ou au lecteur d'écran.
//
//   3. La fermeture est mémorisée en `sessionStorage`, pas en `localStorage` :
//      un visiteur qui ferme la barre ne veut pas la revoir de la journée,
//      mais une visite plus tard est une nouvelle intention. Le stockage peut
//      lever (Safari en navigation privée, cookies bloqués) : chaque accès est
//      donc gardé, et l'échec se paie d'une barre qui réapparaît — jamais
//      d'une page cassée.
//
// Garde-fous : l'animation d'entrée est neutralisée en
// `prefers-reduced-motion: reduce` (côté CSS), et le calcul de position est
// groupé dans un `requestAnimationFrame` pour ne pas lire la géométrie à
// chaque événement de défilement.

(function () {
  if (typeof document === "undefined") return;

  var barre = document.querySelector("[data-sticky-cta]");
  if (!barre) return;

  var CLE_FERMETURE = "emb.sticky-cta.ferme";

  // ---------------------------------------------------------------- Stockage

  function dejaFermee() {
    try {
      return window.sessionStorage.getItem(CLE_FERMETURE) === "1";
    } catch (erreur) {
      return false;
    }
  }

  function memoriserFermeture() {
    try {
      window.sessionStorage.setItem(CLE_FERMETURE, "1");
    } catch (erreur) {
      // Stockage indisponible : la barre reviendra au prochain chargement.
      // C'est le seul dégât, et il est préférable à une exception.
    }
  }

  if (dejaFermee()) {
    barre.parentNode && barre.parentNode.removeChild(barre);
    return;
  }

  // ------------------------------------------------------------------ Ancres

  var ancre =
    document.querySelector("[data-sticky-cta-anchor]") ||
    document.querySelector(".hero") ||
    document.querySelector(".page-head");

  var pied = document.querySelector(".site-footer");

  /** Vrai quand la barre doit être visible à la position de défilement courante. */
  function doitEtreVisible() {
    var hauteurEcran = window.innerHeight || document.documentElement.clientHeight || 0;

    // Le pied de page a la priorité : dès qu'il entre dans le viewport, la
    // barre s'efface, quel que soit le reste.
    if (pied && pied.getBoundingClientRect().top <= hauteurEcran) return false;

    if (ancre) return ancre.getBoundingClientRect().bottom <= 0;

    // Repli : ni ancre déclarée, ni hero, ni en-tête de page.
    return (window.scrollY || window.pageYOffset || 0) > hauteurEcran * 0.8;
  }

  var visible = false;

  function appliquer() {
    var cible = doitEtreVisible();
    if (cible === visible) return;
    visible = cible;
    barre.setAttribute("data-state", cible ? "visible" : "hidden");
  }

  // ------------------------------------------------------- Boucle de mesure

  var enAttente = false;

  function planifier() {
    if (enAttente) return;
    enAttente = true;
    var suite = function () {
      enAttente = false;
      appliquer();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(suite);
    } else {
      suite();
    }
  }

  window.addEventListener("scroll", planifier, { passive: true });
  window.addEventListener("resize", planifier, { passive: true });
  appliquer();

  // ---------------------------------------------------------------- Fermeture

  var fermer = barre.querySelector("[data-sticky-cta-close]");
  if (fermer) {
    fermer.addEventListener("click", function () {
      memoriserFermeture();
      barre.setAttribute("data-state", "hidden");
      visible = false;
      window.removeEventListener("scroll", planifier);
      window.removeEventListener("resize", planifier);
    });
  }
})();
