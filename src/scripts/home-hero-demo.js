// ============================================================================
// HOME HERO DEMO — la carte du hero rejoue une estimation en direct
// ============================================================================
//
// Injecté tel quel comme les autres scripts de page (voir `RawScript.astro`) :
// ni bundler, ni `import`/`export`, style ES5.
//
// La carte `#heroDemo` contient trois scènes empilées (cf. `index.astro`) :
// « form » (quelqu'un remplit le formulaire), « compute » (le calcul tourne)
// et « result » (le rapport). Seule la dernière est dans le HTML sans
// l'attribut `hidden` : c'est l'état statique, celui que voient les visiteurs
// sans JavaScript. Le script révèle les deux autres, pose la classe
// `is-playing` sur la carte puis joue la séquence en boucle.
//
// Chaque tour rejoue un bien différent, pris dans `HERO_DEMO_SCENARIOS` (dix
// biens normands). Tout ce qui change d'un tour à l'autre est écrit par le
// script sur les éléments porteurs d'un attribut `data-demo-*` : adresse et
// surface frappées, type de bien et lettre DPE sélectionnés, puis les
// montants, la pastille DPE et la tendance du rapport.
//
// Garde-fous :
//   - `prefers-reduced-motion: reduce` → le script ne démarre pas du tout ;
//   - hors viewport ou onglet en arrière-plan → la boucle est arrêtée et
//     repart du début quand la carte redevient visible (pas d'animation qui
//     tourne dans le vide).
//
// La carte est `aria-hidden` côté HTML : rien de tout ceci n'est annoncé, et
// aucune donnée affichée ici n'est réelle — c'est une illustration.

var heroDemoEl = typeof document !== "undefined" ? document.getElementById("heroDemo") : null;

if (
  heroDemoEl &&
  typeof window.matchMedia === "function" &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches
) {
  // ----------------------------------------------------------------------
  // Les biens joués, un par tour de boucle
  //
  // Dix scénarios, un par ville, couvrant les cinq départements normands
  // (14, 27, 50, 61, 76) — du studio d'Alençon à l'appartement de Deauville,
  // pour montrer l'amplitude du marché plutôt que dix fois le même bien.
  //
  // Les montants sont illustratifs mais cohérents entre eux : le rapport
  // affiche `surface × pricePerSqm`, la fourchette vaut ±5 % et `gauge`
  // (position du curseur dans la fourchette) suit la tension du marché
  // décrite par `trend`. `surface × pricePerSqm` tombe volontairement sur une
  // centaine d'euros ronde, pour que le prix affiché et le prix au m² du
  // rapport ne se contredisent pas après arrondi.
  //
  // Le premier scénario reprend les valeurs écrites en dur dans
  // `index.astro` (celles du rendu sans JavaScript).
  // ----------------------------------------------------------------------
  var HERO_DEMO_SCENARIOS = [
    {
      address: "12 quai Sainte-Catherine, Honfleur",
      city: "Honfleur",
      type: "Maison",
      surface: 85,
      pricePerSqm: 4100,
      dpe: "C",
      trend: "+2,4 %",
      gauge: 68,
      analysed: 128,
    },
    {
      address: "24 rue Écuyère, Caen",
      city: "Caen",
      type: "Appartement",
      surface: 62,
      pricePerSqm: 3050,
      dpe: "D",
      trend: "+1,6 %",
      gauge: 62,
      analysed: 164,
    },
    {
      address: "8 rue Eau-de-Robec, Rouen",
      city: "Rouen",
      type: "Maison",
      surface: 118,
      pricePerSqm: 2850,
      dpe: "E",
      trend: "+0,9 %",
      gauge: 57,
      analysed: 143,
    },
    {
      address: "15 rue des Bains, Deauville",
      city: "Deauville",
      type: "Appartement",
      surface: 48,
      pricePerSqm: 5750,
      dpe: "B",
      trend: "+3,1 %",
      gauge: 74,
      analysed: 96,
    },
    {
      address: "9 rue Joséphine, Évreux",
      city: "Évreux",
      type: "Maison",
      surface: 132,
      pricePerSqm: 2050,
      dpe: "D",
      trend: "+1,2 %",
      gauge: 60,
      analysed: 118,
    },
    {
      address: "27 rue de Paris, Le Havre",
      city: "Le Havre",
      type: "Appartement",
      surface: 74,
      pricePerSqm: 2350,
      dpe: "C",
      trend: "+2,8 %",
      gauge: 71,
      analysed: 187,
    },
    {
      address: "9 rue du Puits-Salé, Dieppe",
      city: "Dieppe",
      type: "Maison",
      surface: 96,
      pricePerSqm: 2300,
      dpe: "F",
      trend: "−0,6 %",
      gauge: 44,
      analysed: 109,
    },
    {
      address: "5 avenue de la Libération, Granville",
      city: "Granville",
      type: "Appartement",
      surface: 58,
      pricePerSqm: 3400,
      dpe: "C",
      trend: "+2,1 %",
      gauge: 66,
      analysed: 121,
    },
    {
      address: "41 rue du Val-de-Saire, Cherbourg",
      city: "Cherbourg",
      type: "Maison",
      surface: 106,
      pricePerSqm: 1950,
      dpe: "E",
      trend: "+0,7 %",
      gauge: 54,
      analysed: 152,
    },
    {
      address: "18 rue aux Sieurs, Alençon",
      city: "Alençon",
      type: "Appartement",
      surface: 64,
      pricePerSqm: 1550,
      dpe: "D",
      trend: "+0,5 %",
      gauge: 51,
      analysed: 74,
    },
  ];

  // ----------------------------------------------------------------------
  // Rythme de la séquence
  // ----------------------------------------------------------------------
  var HERO_DEMO_TYPE_MS = 38; // vitesse de frappe moyenne, par caractère
  var HERO_DEMO_TYPE_JITTER_MS = 34; // irrégularité, pour ne pas faire robot
  var HERO_DEMO_GRADE_MS = 150; // pas du balayage de l'échelle DPE
  var HERO_DEMO_COMPUTE_MS = 2600; // durée de la barre de calcul
  var HERO_DEMO_COUNT_MS = 1100; // durée du décompte des montants
  var HERO_DEMO_COUNT_TICK_MS = 16; // pas du décompte
  var HERO_DEMO_HOLD_MS = 5200; // temps de lecture du rapport avant rejeu
  var HERO_DEMO_SPREAD = 0.05; // demi-largeur de la fourchette (±5 %)

  var heroDemoTitleEl = heroDemoEl.querySelector("[data-demo-title]");
  var heroDemoBadgeEl = heroDemoEl.querySelector("[data-demo-badge]");
  var heroDemoScenes = {};
  var heroDemoFields = {};

  Array.prototype.forEach.call(heroDemoEl.querySelectorAll("[data-demo-scene]"), function (el) {
    heroDemoScenes[el.getAttribute("data-demo-scene")] = el;
  });

  Array.prototype.forEach.call(heroDemoEl.querySelectorAll("[data-demo-field]"), function (el) {
    heroDemoFields[el.getAttribute("data-demo-field")] = el;
  });

  var heroDemoSubmitEl = heroDemoEl.querySelector("[data-demo-submit]");
  var heroDemoLoaderEl = heroDemoEl.querySelector("[data-demo-loader]");
  var heroDemoAnalysedEl = heroDemoEl.querySelector("[data-demo-analysed]");
  var heroDemoGaugeEl = heroDemoEl.querySelector("[data-demo-gauge]");
  var heroDemoLabelEl = heroDemoEl.querySelector("[data-demo-label]");
  var heroDemoSurfaceEl = heroDemoEl.querySelector("[data-demo-surface]");
  var heroDemoDpeEl = heroDemoEl.querySelector("[data-demo-dpe]");
  var heroDemoTrendEl = heroDemoEl.querySelector("[data-demo-trend]");
  var heroDemoTaskEls = heroDemoEl.querySelectorAll(".demo__task");
  var heroDemoChoiceEls = heroDemoEl.querySelectorAll("[data-demo-choice]");
  var heroDemoGradeEls = heroDemoEl.querySelectorAll("[data-demo-grade]");

  // Montants du rapport, indexés par le rôle déclaré en HTML
  // (`data-demo-number="price"`, `"min"`, `"max"`, `"sqm"`).
  var heroDemoNumberEls = {};
  Array.prototype.forEach.call(heroDemoEl.querySelectorAll("[data-demo-number]"), function (el) {
    heroDemoNumberEls[el.getAttribute("data-demo-number")] = el;
  });

  // Scénario courant. Le point d'entrée est tiré au hasard pour que deux
  // visites successives ne rejouent pas la même ville en premier.
  var heroDemoScenarioIndex = Math.floor(Math.random() * HERO_DEMO_SCENARIOS.length);

  function heroDemoScenario() {
    return HERO_DEMO_SCENARIOS[heroDemoScenarioIndex];
  }

  // ----------------------------------------------------------------------
  // Petites aides
  // ----------------------------------------------------------------------

  // Même séparateur de milliers que dans le HTML statique (espace simple),
  // pour que l'état final du décompte soit identique au rendu sans JS.
  function heroDemoFormat(value) {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  function heroDemoSetClass(el, className, on) {
    if (!el) return;
    if (on) el.classList.add(className);
    else el.classList.remove(className);
  }

  // ----------------------------------------------------------------------
  // Séquenceur : une liste d'étapes, chacune appelant `next` quand elle a
  // fini. Au plus deux minuteries en vol (la séquence et un décompte), toutes
  // deux annulées par `heroDemoStop` — c'est ce qui rend la pause propre.
  // ----------------------------------------------------------------------
  var heroDemoSteps = [];
  var heroDemoPlaying = false;
  var heroDemoTimer = null; // avancement de la séquence
  var heroDemoCountTimer = null; // décompte des montants, qui tourne en parallèle

  function heroDemoStep(fn) {
    heroDemoSteps.push(fn);
  }

  function heroDemoWait(ms) {
    heroDemoStep(function (next) {
      heroDemoTimer = setTimeout(next, ms);
    });
  }

  function heroDemoDo(fn) {
    heroDemoStep(function (next) {
      fn();
      next();
    });
  }

  function heroDemoRun(index) {
    if (!heroDemoPlaying) return;
    var i = index >= heroDemoSteps.length ? 0 : index;
    heroDemoSteps[i](function () {
      heroDemoRun(i + 1);
    });
  }

  // Frappe caractère par caractère, avec un léger aléa sur le délai.
  function heroDemoType(el, text, next) {
    var index = 0;
    el.textContent = "";

    function tick() {
      index += 1;
      el.textContent = text.slice(0, index);
      if (index >= text.length) {
        next();
        return;
      }
      heroDemoTimer = setTimeout(tick, HERO_DEMO_TYPE_MS + Math.random() * HERO_DEMO_TYPE_JITTER_MS);
    }

    heroDemoTimer = setTimeout(tick, HERO_DEMO_TYPE_MS);
  }

  // Décompte animé (easing sortant) sur une liste de cibles
  // `{ el, value, unit }`. Rythmé au `setTimeout` et non au
  // `requestAnimationFrame` : on ne peint que du texte, et un seul type de
  // minuterie à annuler garde la pause simple.
  function heroDemoCountUp(targets, duration, next) {
    var start = Date.now();

    function tick() {
      var progress = Math.min((Date.now() - start) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);

      targets.forEach(function (target) {
        target.el.textContent = heroDemoFormat(target.value * eased) + target.unit;
      });

      if (progress < 1) {
        heroDemoCountTimer = setTimeout(tick, HERO_DEMO_COUNT_TICK_MS);
        return;
      }
      if (next) next();
    }

    tick();
  }

  // Les quatre montants du rapport se déduisent du scénario : prix = surface
  // × prix au m², fourchette à ±5 % arrondie à la centaine.
  function heroDemoAmounts(scenario) {
    var price = scenario.surface * scenario.pricePerSqm;
    return {
      price: price,
      min: Math.round((price * (1 - HERO_DEMO_SPREAD)) / 100) * 100,
      max: Math.round((price * (1 + HERO_DEMO_SPREAD)) / 100) * 100,
      sqm: scenario.pricePerSqm,
    };
  }

  // Cibles du décompte : l'unité reste décrite en HTML (`data-demo-unit`).
  function heroDemoNumberTargets() {
    var amounts = heroDemoAmounts(heroDemoScenario());
    var targets = [];

    for (var role in heroDemoNumberEls) {
      if (!Object.prototype.hasOwnProperty.call(heroDemoNumberEls, role)) continue;
      var el = heroDemoNumberEls[role];
      targets.push({
        el: el,
        value: amounts[role] || 0,
        unit: el.getAttribute("data-demo-unit") || "",
      });
    }

    return targets;
  }

  // ----------------------------------------------------------------------
  // Passage d'une scène à l'autre
  // ----------------------------------------------------------------------
  function heroDemoShowScene(name) {
    for (var key in heroDemoScenes) {
      if (!Object.prototype.hasOwnProperty.call(heroDemoScenes, key)) continue;
      heroDemoSetClass(heroDemoScenes[key], "is-active", key === name);
    }
  }

  function heroDemoSetBadge(text) {
    if (!heroDemoBadgeEl) return;
    heroDemoBadgeEl.textContent = text || "";
    heroDemoBadgeEl.hidden = !text;
  }

  function heroDemoSetTitle(text) {
    if (heroDemoTitleEl) heroDemoTitleEl.textContent = text;
  }

  // Écrit dans le rapport tout ce qui dépend du bien joué. Appelé au
  // rembobinage : la scène « résultat » est alors invisible, la substitution
  // ne se voit pas.
  function heroDemoApplyScenario() {
    var scenario = heroDemoScenario();

    if (heroDemoLabelEl) {
      heroDemoLabelEl.textContent = "Estimation moyenne · " + scenario.city;
    }
    if (heroDemoSurfaceEl) {
      heroDemoSurfaceEl.textContent = scenario.surface + " m²";
    }
    if (heroDemoDpeEl) {
      // Vert jusqu'à C, neutre pour D-E, rouge à partir de F : la pastille
      // doit rester lisible comme une information, pas comme une décoration.
      var dpeTone = "tag--bad";
      if ("ABC".indexOf(scenario.dpe) !== -1) dpeTone = "tag--ok";
      else if ("DE".indexOf(scenario.dpe) !== -1) dpeTone = "tag--mid";

      heroDemoDpeEl.className = "tag " + dpeTone;
      heroDemoDpeEl.textContent = scenario.dpe;
    }
    if (heroDemoTrendEl) {
      // Un marché peut reculer : le signe pilote la couleur.
      heroDemoTrendEl.className = scenario.trend.charAt(0) === "−" ? "down" : "up";
      heroDemoTrendEl.textContent = scenario.trend;
    }
  }

  // Remet la carte dans l'état « formulaire vierge », prête pour un tour.
  function heroDemoReset() {
    heroDemoSetTitle("Estimation en cours");
    heroDemoSetBadge("");
    heroDemoApplyScenario();

    for (var key in heroDemoFields) {
      if (!Object.prototype.hasOwnProperty.call(heroDemoFields, key)) continue;
      heroDemoFields[key].className = "demo__field";
    }

    Array.prototype.forEach.call(heroDemoEl.querySelectorAll("[data-demo-typed]"), function (el) {
      el.textContent = "";
    });

    Array.prototype.forEach.call(heroDemoChoiceEls, function (el) {
      el.className = "demo__choice";
    });

    Array.prototype.forEach.call(heroDemoGradeEls, function (el) {
      el.className = "demo__grade";
    });

    if (heroDemoSubmitEl) heroDemoSubmitEl.className = "demo__submit";

    Array.prototype.forEach.call(heroDemoTaskEls, function (el) {
      el.className = "demo__task";
    });

    // La barre de calcul doit repartir de zéro sans rejouer sa transition :
    // on la coupe, on remet la largeur, puis on force un reflow.
    if (heroDemoLoaderEl) {
      heroDemoLoaderEl.style.transition = "none";
      heroDemoLoaderEl.style.width = "0%";
      void heroDemoLoaderEl.offsetWidth;
    }

    if (heroDemoAnalysedEl) heroDemoAnalysedEl.textContent = "0";

    // Idem pour la jauge du rapport : largeur inline vidée, la règle
    // `.preview.is-playing .preview__bar span` la ramène à 0.
    if (heroDemoGaugeEl) heroDemoGaugeEl.style.width = "";

    heroDemoNumberTargets().forEach(function (target) {
      target.el.textContent = "0" + target.unit;
    });

    heroDemoShowScene("form");
  }

  // ----------------------------------------------------------------------
  // La séquence
  // ----------------------------------------------------------------------

  // Scène 1 — la saisie
  heroDemoDo(heroDemoReset);
  heroDemoWait(900);

  heroDemoDo(function () {
    heroDemoSetBadge("Étape 1 / 4");
    heroDemoSetClass(heroDemoFields.address, "is-shown", true);
  });
  heroDemoWait(420);

  heroDemoDo(function () {
    heroDemoSetClass(heroDemoFields.address, "is-typing", true);
  });
  heroDemoStep(function (next) {
    var target = heroDemoFields.address.querySelector("[data-demo-typed]");
    heroDemoType(target, heroDemoScenario().address, next);
  });
  heroDemoDo(function () {
    heroDemoSetClass(heroDemoFields.address, "is-typing", false);
    heroDemoSetClass(heroDemoFields.address, "is-filled", true);
  });
  heroDemoWait(520);

  heroDemoDo(function () {
    heroDemoSetBadge("Étape 2 / 4");
    heroDemoSetClass(heroDemoFields.type, "is-shown", true);
  });
  heroDemoWait(780);
  heroDemoDo(function () {
    var wanted = heroDemoScenario().type;
    Array.prototype.forEach.call(heroDemoChoiceEls, function (choice) {
      heroDemoSetClass(choice, "is-picked", choice.getAttribute("data-demo-choice") === wanted);
    });
    heroDemoSetClass(heroDemoFields.type, "is-filled", true);
  });
  heroDemoWait(560);

  heroDemoDo(function () {
    heroDemoSetBadge("Étape 3 / 4");
    heroDemoSetClass(heroDemoFields.surface, "is-shown", true);
  });
  heroDemoWait(420);
  heroDemoDo(function () {
    heroDemoSetClass(heroDemoFields.surface, "is-typing", true);
  });
  heroDemoStep(function (next) {
    var target = heroDemoFields.surface.querySelector("[data-demo-typed]");
    heroDemoType(target, String(heroDemoScenario().surface), next);
  });
  heroDemoDo(function () {
    heroDemoSetClass(heroDemoFields.surface, "is-typing", false);
    heroDemoSetClass(heroDemoFields.surface, "is-filled", true);
  });
  heroDemoWait(520);

  heroDemoDo(function () {
    heroDemoSetBadge("Étape 4 / 4");
    heroDemoSetClass(heroDemoFields.dpe, "is-shown", true);
  });
  heroDemoWait(600);

  // Le curseur balaie l'échelle depuis A et s'arrête sur la lettre du bien :
  // la course est donc plus ou moins longue selon le scénario.
  heroDemoStep(function (next) {
    var wanted = heroDemoScenario().dpe;
    var stop = 0;
    var index = -1;

    Array.prototype.forEach.call(heroDemoGradeEls, function (grade, i) {
      if (grade.getAttribute("data-demo-grade") === wanted) stop = i;
    });

    function tick() {
      index += 1;
      Array.prototype.forEach.call(heroDemoGradeEls, function (grade, i) {
        heroDemoSetClass(grade, "is-hover", i === index);
      });

      if (index >= stop) {
        next();
        return;
      }
      heroDemoTimer = setTimeout(tick, HERO_DEMO_GRADE_MS);
    }

    tick();
  });
  heroDemoWait(240);

  heroDemoDo(function () {
    var wanted = heroDemoScenario().dpe;
    Array.prototype.forEach.call(heroDemoGradeEls, function (grade) {
      grade.classList.remove("is-hover");
      heroDemoSetClass(grade, "is-picked", grade.getAttribute("data-demo-grade") === wanted);
    });
    heroDemoSetClass(heroDemoFields.dpe, "is-filled", true);
  });
  heroDemoWait(500);

  heroDemoDo(function () {
    heroDemoSetClass(heroDemoSubmitEl, "is-shown", true);
  });
  heroDemoWait(700);
  heroDemoDo(function () {
    heroDemoSetClass(heroDemoSubmitEl, "is-pressed", true);
  });
  heroDemoWait(380);

  // Scène 2 — le calcul
  heroDemoDo(function () {
    heroDemoSetTitle("Analyse du marché");
    heroDemoSetBadge("");
    heroDemoShowScene("compute");

    if (heroDemoLoaderEl) {
      heroDemoLoaderEl.style.transition = "width " + HERO_DEMO_COMPUTE_MS + "ms linear";
      heroDemoLoaderEl.style.width = "100%";
    }
    if (heroDemoTaskEls[0]) heroDemoTaskEls[0].classList.add("is-running");
  });

  heroDemoDo(function () {
    if (!heroDemoAnalysedEl) return;
    // Le compteur de ventes tourne pendant que la barre se remplit : on le
    // laisse courir en tâche de fond, la suite de la séquence n'attend pas.
    heroDemoCountUp(
      [{ el: heroDemoAnalysedEl, value: heroDemoScenario().analysed, unit: "" }],
      HERO_DEMO_COMPUTE_MS - 200,
      null,
    );
  });

  [0, 1, 2].forEach(function (index) {
    heroDemoWait(Math.round(HERO_DEMO_COMPUTE_MS / 3));
    heroDemoDo(function () {
      var current = heroDemoTaskEls[index];
      var following = heroDemoTaskEls[index + 1];
      if (current) {
        current.classList.remove("is-running");
        current.classList.add("is-done");
      }
      if (following) following.classList.add("is-running");
    });
  });
  heroDemoWait(600);

  // Scène 3 — le rapport
  heroDemoDo(function () {
    heroDemoSetTitle("Rapport d'estimation");
    heroDemoShowScene("result");
    if (heroDemoGaugeEl) heroDemoGaugeEl.style.width = heroDemoScenario().gauge + "%";
  });
  heroDemoWait(260);
  heroDemoStep(function (next) {
    heroDemoCountUp(heroDemoNumberTargets(), HERO_DEMO_COUNT_MS, next);
  });

  heroDemoWait(HERO_DEMO_HOLD_MS);

  // Bien suivant : c'est la dernière étape, donc le rembobinage (`heroDemoRun`
  // revient à l'étape 0) rejoue immédiatement avec le nouveau scénario.
  heroDemoDo(function () {
    heroDemoScenarioIndex = (heroDemoScenarioIndex + 1) % HERO_DEMO_SCENARIOS.length;
  });

  // ----------------------------------------------------------------------
  // Démarrage, pause et reprise
  // ----------------------------------------------------------------------
  function heroDemoStart() {
    if (heroDemoPlaying) return;
    heroDemoPlaying = true;
    heroDemoRun(0);
  }

  function heroDemoStop() {
    heroDemoPlaying = false;
    if (heroDemoTimer !== null) {
      clearTimeout(heroDemoTimer);
      heroDemoTimer = null;
    }
    if (heroDemoCountTimer !== null) {
      clearTimeout(heroDemoCountTimer);
      heroDemoCountTimer = null;
    }
  }

  var heroDemoInView = true;

  function heroDemoSync() {
    if (heroDemoInView && !document.hidden) heroDemoStart();
    else heroDemoStop();
  }

  // La carte passe en mode animé : les scènes masquées entrent en scène et
  // les règles `.is-playing` prennent le relais.
  heroDemoSetClass(heroDemoEl, "is-playing", true);
  Array.prototype.forEach.call(heroDemoEl.querySelectorAll("[data-demo-scene]"), function (el) {
    el.hidden = false;
  });
  heroDemoReset();

  document.addEventListener("visibilitychange", heroDemoSync);

  if (typeof window.IntersectionObserver === "function") {
    new window.IntersectionObserver(
      function (entries) {
        heroDemoInView = entries[0].isIntersecting;
        heroDemoSync();
      },
      { threshold: 0.25 },
    ).observe(heroDemoEl);
  } else {
    heroDemoSync();
  }
}
