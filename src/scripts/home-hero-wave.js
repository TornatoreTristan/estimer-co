// ============================================================================
// HERO WAVE — nappe de particules ondulante en fond de hero
// ============================================================================
//
// Injecté tel quel comme les autres scripts de page (voir `RawScript.astro`) :
// ni bundler, ni `import`/`export`, style ES5.
//
// Reproduit en canvas l'effet « vague de points » du hero de hh.lepixelcode.fr
// — qui, chez eux, est une vidéo webm de 4 Mo. Ici tout est calculé : ~20 000
// points posés sur une grille projetée en perspective, dont la hauteur est la
// somme de trois sinusoïdes déphasées. Les crêtes s'éclairent en orange, les
// creux s'effacent dans le beige.
//
// Le fond de la hero n'est pas touché : le canvas est transparent et se
// superpose au dégradé beige/orange existant, sous le contenu (`z-index`).
//
// Garde-fous :
//   - pas de canvas 2D → le script s'arrête, la hero reste telle quelle ;
//   - `prefers-reduced-motion: reduce` → une seule image fixe, pas de boucle ;
//   - hero hors du viewport → la boucle est mise en pause (IntersectionObserver) ;
//   - onglet caché → pause aussi, et le temps ne saute pas au retour ;
//   - densité et `devicePixelRatio` plafonnés : le coût reste stable du mobile
//     au 4K.
//
// Le canvas est `aria-hidden` côté HTML : purement décoratif.

(function () {
  if (typeof document === "undefined") return;

  var canvas = document.getElementById("heroWave");
  if (!canvas || typeof canvas.getContext !== "function") return;

  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduit =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --------------------------------------------------------------------
  // Géométrie
  //
  // On ne fait pas de vraie 3D : la grille est projetée directement en
  // espace écran par un facteur de perspective `p` qui ne dépend que de la
  // profondeur. Toujours positif, donc jamais de point « derrière la
  // caméra » à gérer.
  //
  //   p = 1 / (1 + d * PROFONDEUR)   d ∈ [0,1], 0 = premier plan
  //
  // `p` pilote tout d'un coup : position, écartement, amplitude, taille du
  // point et luminosité. C'est ce qui donne la sensation de profondeur.
  // --------------------------------------------------------------------
  var PROFONDEUR = 1.6; // plus grand = fuyante plus marquée
  var HORIZON = -0.78; // ligne d'horizon, en fraction de hauteur
  var PORTEE = 2.03; // hauteur balayée par la nappe
  var ETALEMENT = 2.3; // largeur du premier plan, en fraction de largeur
  var DERIVE = -0.26; // décalage horizontal du fond : la nappe fuit vers la gauche
  var AMPLITUDE = 0.28; // hauteur des vagues, en fraction de hauteur

  // --------------------------------------------------------------------
  // Les trois sinusoïdes
  //
  // Fréquences volontairement non multiples entre elles : la nappe ne se
  // répète jamais à l'œil. Chaque terme mélange `u` (largeur) et `d`
  // (profondeur), ce qui oriente les crêtes en diagonale plutôt qu'en
  // bandes horizontales.
  //
  //   [fréquence u, fréquence d, amplitude, vitesse]
  // --------------------------------------------------------------------
  var ONDES = [
    [3.4, 16.0, 0.55, 0.55],
    [5.1, -9.0, 0.28, -0.37],
    [13.0, 13.0, 0.12, 0.9],
  ];
  var NB_ONDES = ONDES.length;

  // Rampe de couleurs : creux lointains presque invisibles (aubergine),
  // crêtes en orange de marque. Précalculée une fois — poser `fillStyle`
  // 20 000 fois par image coûterait bien plus cher que les points eux-mêmes.
  var NIVEAUX = 20;
  var teintes = new Array(NIVEAUX);
  (function () {
    for (var k = 0; k < NIVEAUX; k++) {
      var t = k / (NIVEAUX - 1);
      var r = Math.round(29 + (255 - 29) * t);
      var v = Math.round(12 + (110 - 12) * t);
      var b = Math.round(27 + (52 - 27) * t);
      var a = 0.06 + 0.9 * Math.pow(t, 1.1);
      teintes[k] = "rgba(" + r + "," + v + "," + b + "," + a.toFixed(3) + ")";
    }
  })();

  var largeur = 0;
  var hauteur = 0;
  var ratio = 1;
  var colonnes = 0;
  var rangees = 0;

  // Tout ce qui ne dépend que de la profondeur est calculé au
  // redimensionnement et pas à chaque image.
  var pProf, yProf, xCentre, pas, ampProf, penteProf, taille, lumProf;

  // Rotation d'un pas de colonne, par onde (cf. `dessiner`).
  var cosPas = new Float64Array(NB_ONDES);
  var sinPas = new Float64Array(NB_ONDES);

  // Points de l'image en cours, à plat. Alloués une fois : rien de neuf
  // n'est créé pendant l'animation, donc pas de passage du GC.
  var px, py, pr, pn, ordre;
  var comptes = new Int32Array(NIVEAUX);
  var debuts = new Int32Array(NIVEAUX + 1);

  function mesurer() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    // DPR plafonné à 1.5 : au-delà, on quadruple le nombre de pixels à
    // remplir pour un gain invisible sur des points de 2 px.
    ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    largeur = Math.round(rect.width * ratio);
    hauteur = Math.round(rect.height * ratio);
    canvas.width = largeur;
    canvas.height = hauteur;

    // Densité proportionnelle à la surface, mais bornée des deux côtés :
    // lisible sur mobile, jamais plus de ~23 000 points sur grand écran.
    colonnes = Math.max(70, Math.min(200, Math.round(rect.width / 6)));
    rangees = Math.max(50, Math.min(115, Math.round(rect.height / 5)));

    var total = colonnes * rangees;
    px = new Int32Array(total);
    py = new Int32Array(total);
    pr = new Int32Array(total);
    pn = new Int32Array(total);
    ordre = new Int32Array(total);

    var du = 1 / (colonnes - 1);
    for (var k = 0; k < NB_ONDES; k++) {
      var wu = ONDES[k][0] * du;
      cosPas[k] = Math.cos(wu);
      sinPas[k] = Math.sin(wu);
    }

    var pMin = 1 / (1 + PROFONDEUR);
    pProf = new Float64Array(rangees);
    yProf = new Float64Array(rangees);
    xCentre = new Float64Array(rangees);
    pas = new Float64Array(rangees);
    ampProf = new Float64Array(rangees);
    penteProf = new Float64Array(rangees);
    taille = new Int32Array(rangees);
    lumProf = new Float64Array(rangees);

    for (var j = 0; j < rangees; j++) {
      var d = j / (rangees - 1);
      var p = 1 / (1 + d * PROFONDEUR);
      pProf[j] = p;
      yProf[j] = (HORIZON + PORTEE * p) * hauteur;
      // Le premier plan déborde du cadre, le fond dérive vers la gauche.
      xCentre[j] = largeur * (0.5 + DERIVE * (1 - p)) - largeur * ETALEMENT * p * 0.5;
      pas[j] = largeur * ETALEMENT * p * du;
      ampProf[j] = AMPLITUDE * hauteur * p;
      // Dérivée de la ligne de fuite : de combien de pixels la rangée `j`
      // descendrait si la nappe était plate. Sert à mesurer le resserrement.
      penteProf[j] = PORTEE * hauteur * PROFONDEUR * p * p;
      taille[j] = Math.max(1, Math.round(2.6 * p * ratio));
      // Luminosité de base : le fond s'estompe, le premier plan ressort.
      lumProf[j] = 0.28 + 0.72 * ((p - pMin) / (1 - pMin));
    }

    return true;
  }

  // --------------------------------------------------------------------
  // Dessin
  //
  // Deux astuces portent tout le coût de l'animation :
  //
  //  1. Aucun appel trigonométrique dans la boucle des colonnes. Le long
  //     d'une rangée, l'angle de chaque sinusoïde avance d'un pas constant :
  //     on part de (sin, cos) du premier point et on fait tourner le couple
  //     par la formule d'addition. Douze multiplications remplacent six
  //     `Math.sin`/`Math.cos` par point, et la dérivée (le cosinus) vient
  //     gratuitement — or c'est elle qui allume les crêtes. Le couple est
  //     réamorcé à chaque rangée, donc la dérive numérique ne s'accumule
  //     jamais au-delà de quelques centaines de pas.
  //
  //  2. Un tri par comptage range les points par niveau de couleur avant
  //     le tracé : `fillStyle` est posé 20 fois par image au lieu de
  //     20 000. Tout passe par des tableaux typés alloués une seule fois.
  //
  // L'effet caractéristique du modèle vient de la dérivée en profondeur :
  // là où la nappe se redresse face à la caméra, les rangées se rapprochent
  // à l'écran, les points s'accumulent et dessinent un trait lumineux. On
  // mesure ce resserrement en pixels au lieu de l'espérer.
  // --------------------------------------------------------------------
  function dessiner(t) {
    ctx.clearRect(0, 0, largeur, hauteur);

    var n = 0;
    var k;
    for (k = 0; k < NIVEAUX; k++) comptes[k] = 0;

    // Sinus et cosinus courants de chaque onde, réamorcés à chaque rangée.
    var s0 = 0, s1 = 0, s2 = 0;
    var c0 = 0, c1 = 0, c2 = 0;

    var cp0 = cosPas[0], sp0 = sinPas[0];
    var cp1 = cosPas[1], sp1 = sinPas[1];
    var cp2 = cosPas[2], sp2 = sinPas[2];

    // Amplitudes, et coefficients de la dérivée en profondeur (fréquence
    // en `d` × amplitude).
    var a0 = ONDES[0][2], a1 = ONDES[1][2], a2 = ONDES[2][2];
    var d0 = ONDES[0][1] * a0, d1 = ONDES[1][1] * a1, d2 = ONDES[2][1] * a2;

    for (var j = 0; j < rangees; j++) {
      var d = j / (rangees - 1);
      var y0 = yProf[j];
      var x = xCentre[j];
      var dx = pas[j];
      var amp = ampProf[j];
      var pente = penteProf[j];
      var lum = lumProf[j];
      var r = taille[j];

      // Angle de chaque onde au premier point de la rangée (u = 0).
      var ang0 = d * ONDES[0][1] + t * ONDES[0][3];
      var ang1 = d * ONDES[1][1] + t * ONDES[1][3];
      var ang2 = d * ONDES[2][1] + t * ONDES[2][3];
      s0 = Math.sin(ang0); c0 = Math.cos(ang0);
      s1 = Math.sin(ang1); c1 = Math.cos(ang1);
      s2 = Math.sin(ang2); c2 = Math.cos(ang2);

      for (var i = 0; i < colonnes; i++, x += dx) {
        var h = s0 * a0 + s1 * a1 + s2 * a2;
        var dh = c0 * d0 + c1 * d1 + c2 * d2;

        // Rotation d'un pas de colonne, pour le point suivant.
        var ns = s0 * cp0 + c0 * sp0; c0 = c0 * cp0 - s0 * sp0; s0 = ns;
        ns = s1 * cp1 + c1 * sp1; c1 = c1 * cp1 - s1 * sp1; s1 = ns;
        ns = s2 * cp2 + c2 * sp2; c2 = c2 * cp2 - s2 * sp2; s2 = ns;

        if (x < -8 || x > largeur + 8) continue;

        var y = y0 - h * amp;
        if (y < -8 || y > hauteur + 8) continue;

        // Écart vertical, en pixels, avec le point de la rangée suivante.
        // Proche de zéro = la nappe est vue par la tranche : c'est une crête.
        var ecart = (pente - dh * amp) / rangees;
        if (ecart < 0) ecart = -ecart;
        // Quadratique : seul un écart de 1 à 3 px allume vraiment. Au-delà
        // la nappe redevient un simple maillage de fond.
        var serrage = 1 / (1 + ecart * ecart * 0.12);

        // `c²(2.1 − 1.1c)` : seules les crêtes s'allument, les flancs
        // restent sourds. C'est ce contraste qui fait le relief.
        var c = (h + 1) * 0.5;
        var eclat = c * c * (2.1 - c * 1.1) * lum * (0.85 + 1.15 * serrage);

        var niveau = (eclat * (NIVEAUX - 1)) | 0;
        if (niveau < 0) niveau = 0;
        else if (niveau > NIVEAUX - 1) niveau = NIVEAUX - 1;

        px[n] = x;
        py[n] = y;
        pr[n] = r;
        pn[n] = niveau;
        comptes[niveau]++;
        n++;
      }
    }

    // Tri par comptage : `debuts[k]` = index du premier point du niveau `k`.
    debuts[0] = 0;
    for (k = 0; k < NIVEAUX; k++) debuts[k + 1] = debuts[k] + comptes[k];
    // `comptes` est réutilisé comme curseur d'écriture par niveau.
    for (k = 0; k < NIVEAUX; k++) comptes[k] = debuts[k];
    for (var m = 0; m < n; m++) ordre[comptes[pn[m]]++] = m;

    for (k = 0; k < NIVEAUX; k++) {
      var fin = debuts[k + 1];
      if (debuts[k] === fin) continue;
      ctx.fillStyle = teintes[k];
      for (var q = debuts[k]; q < fin; q++) {
        var idx = ordre[q];
        var s = pr[idx];
        ctx.fillRect(px[idx], py[idx], s, s);
      }
    }
  }

  // --------------------------------------------------------------------
  // Boucle
  //
  // `temps` est une horloge propre à l'animation : on n'y ajoute que les
  // deltas des images réellement rendues. Onglet caché ou hero hors écran,
  // l'horloge s'arrête — au retour la vague reprend où elle en était au
  // lieu de sauter de plusieurs secondes.
  // --------------------------------------------------------------------
  var temps = 0;
  var derniere = 0;
  var boucle = 0;
  var visible = true;

  function image(now) {
    boucle = window.requestAnimationFrame(image);
    var delta = derniere ? (now - derniere) / 1000 : 0;
    derniere = now;
    // Un onglet qui revient au premier plan peut livrer un delta énorme.
    if (delta > 0.1) delta = 0.1;
    temps += delta;
    dessiner(temps);
  }

  function demarrer() {
    if (boucle || reduit) return;
    derniere = 0;
    boucle = window.requestAnimationFrame(image);
  }

  function arreter() {
    if (!boucle) return;
    window.cancelAnimationFrame(boucle);
    boucle = 0;
  }

  function redimensionner() {
    if (!mesurer()) return;
    dessiner(temps);
  }

  if (!mesurer()) return;
  dessiner(temps);

  if (reduit) return; // image fixe : la nappe est là, elle ne bouge pas.

  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(
      function (entrees) {
        visible = entrees[0].isIntersecting;
        if (visible && !document.hidden) demarrer();
        else arreter();
      },
      { threshold: 0 }
    ).observe(canvas);
  } else {
    demarrer();
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && visible) demarrer();
    else arreter();
  });

  // `ResizeObserver` plutôt que `resize` : la hauteur de la hero bouge aussi
  // quand le contenu se réagence (wrap du formulaire, barre d'URL mobile).
  if (typeof ResizeObserver === "function") {
    var minuteur = 0;
    new ResizeObserver(function () {
      window.clearTimeout(minuteur);
      minuteur = window.setTimeout(redimensionner, 120);
    }).observe(canvas);
  } else {
    window.addEventListener("resize", redimensionner);
  }
})();
