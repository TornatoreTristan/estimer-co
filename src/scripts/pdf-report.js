// Génération du rapport PDF (jsPDF).
//
// Chargé en script classique (`RawScript`), ce fichier expose des fonctions
// globales : `buildEstimationPdf(data)` construit et renvoie le document sans
// le sauvegarder — la page `/rapport/` le télécharge, la page de travail
// `/pdf-preview/` l'affiche dans un iframe.
//
// Mise en page : la charte du site (src/styles/global.css) est reprise telle
// quelle — fond beige, texte aubergine, orange en accent unique, ni angle
// arrondi ni ombre, la profondeur ne venant que des aplats et des filets. Tout
// passe par les primitives de la section 3 (pdfHeading, pdfParagraph, pdfBand…)
// qui font avancer un curseur vertical : aucune coordonnée n'est posée « à
// l'œil », et le contenu ne peut plus déborder sous le pied de page.

// ============================================================================
// 1. CONSTANTES DE MISE EN PAGE
// ============================================================================

var PDF_PAGE = {
  width: 210,
  height: 297,
  margin: 16,
  get content() {
    return this.width - 2 * this.margin;
  },
  // Bas de la zone de texte : au-delà, on passe à la page suivante.
  get bottom() {
    return this.height - 24;
  },
};

var PDF_COLORS = {
  black: [29, 12, 27], // --black
  aubergine3: [110, 72, 105], // --aubergine-3, textes secondaires
  aubergine5: [206, 194, 205], // --aubergine-5, filets appuyés
  aubergine6: [235, 230, 235], // --aubergine-6, filets
  beige25: [247, 245, 242], // --beige-25, aplats clairs
  beige50: [240, 235, 229], // --beige-50
  orange: [255, 110, 52], // --orange, accent unique
  orange25: [255, 220, 207], // --orange-25
  orange5: [255, 248, 245], // --orange-5, fond des encadrés
  success: [68, 111, 40], // --success
  successSoft: [234, 250, 223],
  error: [195, 50, 40], // --error
  errorSoft: [254, 227, 225],
  white: [255, 255, 255],
};

// Échelle typographique (pt). Volontairement courte : quatre niveaux de titre
// suffisent, tout le reste est du corps de texte.
var PDF_TYPE = {
  display: 30,
  title: 17,
  h2: 12,
  h3: 10,
  lead: 10,
  body: 9,
  small: 8,
  caption: 6.6,
};

// Rythme vertical : tous les espacements sont des multiples de 4 mm.
var PDF_RHYTHM = 4;

// ============================================================================
// 2. FORMATAGE
// ============================================================================

function capitalizeFirst(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * « saint-étienne » -> « Saint-Étienne », « villeneuve-lès-avignon » ->
 * « Villeneuve-lès-Avignon » : chaque mot passe en capitale sauf les
 * particules des noms de communes, qui restent en bas de casse — jamais en
 * première position (« Le Havre »).
 */
var PDF_CITY_PARTICLES = [
  "de", "du", "des", "la", "le", "les", "lès", "sur", "sous", "en", "et", "aux", "au", "d", "l",
];

function capitalizeWords(str) {
  if (!str) return "";
  return String(str).replace(/(^|[\s'\-])([^\s'\-]+)/g, function (match, sep, word) {
    if (sep && PDF_CITY_PARTICLES.indexOf(word.toLowerCase()) !== -1) {
      return sep + word.toLowerCase();
    }
    return sep + word.charAt(0).toUpperCase() + word.slice(1);
  });
}

/**
 * Séparateur de milliers avec une espace ORDINAIRE. `toLocaleString('fr-FR')`
 * produit une espace insécable étroite (U+202F) absente de l'encodage WinAnsi
 * des polices standard : elle s'affichait « / » dans le PDF (« 501 /600 € »).
 */
function formatNumber(value) {
  var rounded = Math.round(Number(value) || 0);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatPrice(value) {
  return formatNumber(value) + " €";
}

/** Surfaces : virgule décimale française, séparateur de milliers si besoin. */
function formatArea(value) {
  var number = Number(value);
  if (!isFinite(number)) return String(value || "");
  var parts = String(number).split(".");
  return formatNumber(parts[0]) + (parts[1] ? "," + parts[1] : "");
}

/** Nom de fichier proposé au téléchargement. */
function buildEstimationPdfFileName(lastEstimation) {
  return (
    "Rapport_Estimation_" +
    capitalizeWords(lastEstimation.city).replace(/\s+/g, "_") +
    "_" +
    new Date().toISOString().split("T")[0] +
    ".pdf"
  );
}

// ============================================================================
// 3. PRIMITIVES DE MISE EN PAGE
// ============================================================================

/**
 * Curseur de mise en page. `y` est la position verticale courante ; toutes les
 * primitives la font avancer et déclenchent un saut de page si nécessaire.
 */
function pdfLayout(doc, data) {
  return {
    doc: doc,
    data: data,
    x: PDF_PAGE.margin,
    width: PDF_PAGE.content,
    y: PDF_PAGE.margin,

    /** Réserve `height` mm ; passe à la page suivante s'ils ne tiennent pas. */
    reserve: function (height) {
      if (this.y + height > PDF_PAGE.bottom) this.newPage();
      return this.y;
    },

    /** Place aussi le rappel d'en-tête, absent de la page de couverture. */
    newPage: function () {
      this.doc.addPage();
      pdfCaption(this.doc, "Rapport d'estimation", PDF_PAGE.margin, 18, PDF_COLORS.aubergine3);
      pdfCaption(
        this.doc,
        capitalizeWords(this.data.city),
        PDF_PAGE.width - PDF_PAGE.margin,
        18,
        PDF_COLORS.aubergine3,
        "right"
      );
      pdfStroke(this.doc, PDF_COLORS.aubergine6, 0.2);
      this.doc.line(PDF_PAGE.margin, 21, PDF_PAGE.width - PDF_PAGE.margin, 21);
      this.y = 31;
      return this.y;
    },

    space: function (steps) {
      this.y += (steps === undefined ? 1 : steps) * PDF_RHYTHM;
    },
  };
}

/** Applique police, corps et couleur en une fois. */
function pdfFont(doc, size, weight, color) {
  doc.setFont("helvetica", weight || "normal");
  doc.setFontSize(size);
  doc.setTextColor.apply(doc, color || PDF_COLORS.black);
}

function pdfFill(doc, color) {
  doc.setFillColor.apply(doc, color);
}

function pdfStroke(doc, color, width) {
  doc.setDrawColor.apply(doc, color);
  doc.setLineWidth(width === undefined ? 0.2 : width);
}

/**
 * Libellé en petites capitales espacées — la seule fioriture typographique du
 * document, reprise des `eyebrow` du site.
 */
function pdfCaption(doc, text, x, y, color, align) {
  pdfFont(doc, PDF_TYPE.caption, "bold", color || PDF_COLORS.aubergine3);
  doc.setCharSpace(0.35);
  doc.text(String(text).toUpperCase(), x, y, align ? { align: align } : undefined);
  doc.setCharSpace(0);
}

/**
 * Titre de section : filet orange court au-dessus, titre en dessous. La marge
 * réservée couvre le titre ET le début de son contenu, pour qu'un titre ne
 * reste jamais seul en bas de page.
 */
function pdfHeading(l, text) {
  l.reserve(34);
  pdfFill(l.doc, PDF_COLORS.orange);
  l.doc.rect(l.x, l.y, 14, 1, "F");
  l.y += 6;
  pdfFont(l.doc, PDF_TYPE.h2, "bold", PDF_COLORS.black);
  l.doc.text(text, l.x, l.y);
  l.y += 5;
}

/**
 * Paragraphe courant. Le texte est mesuré puis découpé : il ne peut ni
 * déborder de la colonne, ni chevaucher le pied de page.
 */
function pdfParagraph(l, text, options) {
  var opts = options || {};
  var size = opts.size || PDF_TYPE.body;
  var lineHeight = size * 0.48; // ~1.35 d'interlignage, converti pt -> mm
  var width = opts.width || l.width;
  var x = opts.x === undefined ? l.x : opts.x;

  pdfFont(l.doc, size, opts.weight || "normal", opts.color || PDF_COLORS.aubergine3);
  var lines = l.doc.splitTextToSize(text, width);

  for (var i = 0; i < lines.length; i++) {
    l.reserve(lineHeight);
    l.y += lineHeight;
    // La police doit être réappliquée après un éventuel saut de page.
    pdfFont(l.doc, size, opts.weight || "normal", opts.color || PDF_COLORS.aubergine3);
    l.doc.text(lines[i], x, l.y);
  }
  return lines.length;
}

/** Hauteur qu'occuperait `text` avec `pdfParagraph`, pour dimensionner un bloc. */
function pdfMeasure(doc, text, size, width) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(size);
  return doc.splitTextToSize(text, width).length * (size * 0.48);
}

/**
 * Encadré d'appui (conseil, alerte DPE, point fort) : aplat très clair, filet
 * de 1 pt à gauche dans la couleur d'accent. Aucune icône dessinée à la main.
 */
function pdfNote(l, options) {
  var doc = l.doc;
  var accent = options.accent || PDF_COLORS.orange;
  var background = options.background || PDF_COLORS.orange5;
  var padding = 5;
  var textWidth = l.width - padding * 2 - 2;
  var bodyHeight = pdfMeasure(doc, options.text, PDF_TYPE.body, textWidth);
  var height = padding * 2 + bodyHeight + (options.title ? 5 : 0);

  l.reserve(height);
  pdfFill(doc, background);
  doc.rect(l.x, l.y, l.width, height, "F");
  pdfFill(doc, accent);
  doc.rect(l.x, l.y, 1.2, height, "F");

  var innerY = l.y + padding;
  if (options.title) {
    pdfCaption(doc, options.title, l.x + padding + 2, innerY, accent);
    innerY += 5;
  }

  pdfFont(doc, PDF_TYPE.body, "normal", PDF_COLORS.black);
  var lines = doc.splitTextToSize(options.text, textWidth);
  for (var i = 0; i < lines.length; i++) {
    innerY += PDF_TYPE.body * 0.48;
    doc.text(lines[i], l.x + padding + 2, innerY - 1);
  }

  l.y += height;
}

/**
 * Bande de chiffres clés : N colonnes séparées par des filets verticaux.
 * Sert au marché local comme aux repères nationaux — même composant, donc
 * même lecture d'une page à l'autre.
 */
function pdfStatBand(l, stats, options) {
  var doc = l.doc;
  var opts = options || {};
  var height = 24;
  var columnWidth = l.width / stats.length;

  l.reserve(height);
  pdfFill(doc, opts.background || PDF_COLORS.beige25);
  doc.rect(l.x, l.y, l.width, height, "F");

  stats.forEach(function (stat, index) {
    var centerX = l.x + columnWidth * (index + 0.5);

    if (index > 0) {
      pdfStroke(doc, opts.rule || PDF_COLORS.aubergine5, 0.2);
      doc.line(l.x + columnWidth * index, l.y + 5, l.x + columnWidth * index, l.y + height - 5);
    }

    pdfFont(doc, PDF_TYPE.title, "bold", stat.color || opts.valueColor || PDF_COLORS.black);
    doc.text(String(stat.value), centerX, l.y + 12, { align: "center" });
    pdfCaption(
      doc,
      stat.label,
      centerX,
      l.y + 18,
      opts.labelColor || PDF_COLORS.aubergine3,
      "center"
    );
  });

  l.y += height;
}

/**
 * Tableau des caractéristiques : cellules jointives séparées par des filets,
 * comme la grille `.property-details` du site. Chaque rangée reçoit un tableau
 * d'items et se partage la largeur — une rangée de trois n'a donc jamais de
 * quatrième case vide.
 */
function pdfDataGrid(l, rows) {
  var doc = l.doc;
  var cellHeight = 17;
  var height = rows.length * cellHeight;

  l.reserve(height);
  var top = l.y;

  pdfStroke(doc, PDF_COLORS.aubergine6, 0.2);
  doc.rect(l.x, top, l.width, height, "S");

  rows.forEach(function (items, rowIndex) {
    var cellWidth = l.width / items.length;
    var cellY = top + rowIndex * cellHeight;

    if (rowIndex > 0) {
      pdfStroke(doc, PDF_COLORS.aubergine6, 0.2);
      doc.line(l.x, cellY, l.x + l.width, cellY);
    }

    items.forEach(function (item, index) {
      var cellX = l.x + index * cellWidth;

      if (index > 0) {
        pdfStroke(doc, PDF_COLORS.aubergine6, 0.2);
        doc.line(cellX, cellY, cellX, cellY + cellHeight);
      }

      pdfCaption(doc, item.label, cellX + 5, cellY + 6.5);
      pdfFont(doc, PDF_TYPE.h3, "bold", PDF_COLORS.black);
      // Les valeurs longues (« Non renseigné ») sont réduites plutôt que tronquées.
      var value = String(item.value);
      if (doc.getTextWidth(value) > cellWidth - 10) {
        doc.setFontSize(PDF_TYPE.small);
      }
      doc.text(value, cellX + 5, cellY + 12.5);
    });
  });

  l.y += height;
}

// ============================================================================
// 4. DONNÉES DÉRIVÉES
// ============================================================================

/**
 * Lecture DÉFENSIVE de `lastEstimation` : les clés du Lot 3 (`confidence`,
 * `comparables`, `method`, `dataSource`, `estimationStatus`) peuvent toutes
 * manquer — un `lastEstimation` écrit par la version précédente du site doit
 * produire un PDF valide, simplement sans les nouvelles sections (US-11).
 *
 * @param {object} data
 * @returns {{estimation:object, status:string, confidence:object|null,
 *   display:object|null, method:object|null, dataSource:object|null,
 *   range:object|null, comparables:Array, isStaticFallback:boolean,
 *   isDeferred:boolean, showCentralValue:boolean, hasDvfSource:boolean}}
 */
function pdfReadContext(data) {
  var payload = data || {};
  var estimation = payload.estimation || {};
  var status = payload.estimationStatus || null;
  var display = estimation.display || null;
  var isStaticFallback = status === "static-fallback";
  var isDeferred = status === "deferred" || !payload.estimation;
  var dataSource = estimation.dataSource || null;

  return {
    estimation: estimation,
    status: status,
    confidence: estimation.confidence || null,
    display: display,
    method: estimation.method || null,
    dataSource: dataSource,
    range: estimation.range || null,
    comparables: Array.isArray(estimation.comparables) ? estimation.comparables : [],
    isStaticFallback: isStaticFallback,
    isDeferred: isDeferred,
    // C'est l'API qui décide d'afficher ou non la valeur centrale (§3.8) : le
    // PDF applique EXACTEMENT la même règle que la page.
    showCentralValue: !isDeferred && !(display && display.showCentralValue === false),
    // Mention Etalab : uniquement quand le chiffre vient réellement de DVF.
    // En repli statique, l'écrire serait faux et contreviendrait à
    // l'attribution de la Licence Ouverte (§8.2).
    hasDvfSource: !isStaticFallback && !!dataSource && dataSource.dataCoverage !== "no-dvf",
  };
}

/** « 2025-03 » -> « mars 2025 ». */
var PDF_MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function pdfFormatMonth(value) {
  var match = /^(\d{4})-(\d{2})/.exec(String(value || ""));
  if (!match) return String(value || "—");
  var label = PDF_MONTHS[Number(match[2]) - 1];
  return label ? label + " " + match[1] : String(value);
}

function pdfFormatDistance(metres) {
  var value = Number(metres);
  if (!isFinite(value)) return "—";
  return value >= 1000
    ? String(Math.round(value / 100) / 10).replace(".", ",") + " km"
    : Math.round(value) + " m";
}

/** 1,03 -> « +3 % » ; 0,88 -> « -12 % » ; 1 -> « neutre ». */
function pdfFormatCoefficient(coefficient) {
  var value = Number(coefficient);
  if (!isFinite(value)) return "—";
  var delta = Math.round((value - 1) * 1000) / 10;
  if (delta === 0) return "neutre";
  return (delta > 0 ? "+" : "-") + String(Math.abs(delta)).replace(".", ",") + " %";
}

/** Libellé lisible du niveau géographique retenu (§3.2). */
function pdfDescribeLevel(method) {
  if (!method) return "";
  switch (method.level) {
    case "radius":
      return method.radiusM
        ? "Ventes situées dans un rayon de " + pdfFormatDistance(method.radiusM)
        : "Ventes du voisinage immédiat";
    case "commune":
      return "Ventes de la commune";
    case "epci":
      return "Ventes de l'intercommunalité";
    case "departement":
      return "Ventes du département";
    case "region":
      return "Ventes de la région";
    case "national":
      return "Références nationales, à défaut de ventes comparables plus proches";
    case "departement-reference":
      return "Références départementales (hors base DVF)";
    default:
      return "";
  }
}

/**
 * Éléments d'analyse qualitative du marché local.
 *
 * ATTENTION — les indicateurs chiffrés qui vivaient ici (délai de vente,
 * marge de négociation, évolution sur 12 mois, « prix maisons = prix au m²
 * × 0,85 ») ont été SUPPRIMÉS : ils étaient déduits de seuils arbitraires sur
 * le prix au m², n'existent pas dans DVF et ne pouvaient donc pas être
 * sourcés (§7.2 point 5 et §8.4 : un indicateur non sourçable est retiré, pas
 * remplacé par une autre valeur inventée). Ne subsiste ici que du texte
 * éditorial, plus aucun chiffre présenté comme une mesure de marché.
 */
function pdfMarketInsights(data) {
  // `estimation` vaut `null` en mode différé : le PDF doit rester générable.
  var prixM2 = (data.estimation && data.estimation.prixM2) || 0;
  var rooms = Number(data.rooms) || 0;
  var city = capitalizeWords(data.city);

  var insights = {
    city: city,
    prixM2: prixM2,
  };

  if (prixM2 >= 8000) {
    insights.description =
      city +
      " fait partie des villes les plus prisées de France, avec un marché très dynamique. La forte demande maintient les prix à un niveau élevé, particulièrement dans les quartiers centraux et bien desservis.";
  } else if (prixM2 >= 5000) {
    insights.description =
      city +
      " bénéficie d'un marché attractif porté par une demande soutenue. La ville offre un bon équilibre entre qualité de vie et accessibilité, ce qui explique la valorisation des biens.";
  } else if (prixM2 >= 3500) {
    insights.description =
      city +
      " présente un marché équilibré, avec des prix modérés. La ville attire de nouveaux habitants grâce à son cadre de vie et à ses infrastructures en développement.";
  } else {
    insights.description =
      city +
      " offre des opportunités intéressantes sur un marché accessible. Les prix attractifs permettent aux primo-accédants comme aux investisseurs de concrétiser leur projet.";
  }

  insights.profilBien = rooms >= 4 ? "familial" : rooms >= 2 ? "intermédiaire" : "compact";
  insights.profilAcquereurs =
    rooms >= 4
      ? "familles avec enfants recherchant de l'espace"
      : rooms >= 2
      ? "couples et jeunes actifs en quête de confort"
      : "investisseurs et primo-accédants";

  if (data.propertyType === "maison") {
    insights.pointFort =
      data.hasTerrain === "yes"
        ? "Le terrain privatif est un atout majeur, très recherché par les acquéreurs qui veulent un espace extérieur."
        : "Une maison individuelle conserve l'avantage de l'indépendance et de l'absence de charges de copropriété.";
  } else {
    insights.pointFort =
      "Les appartements bénéficient d'une meilleure liquidité sur le marché et s'adressent à un public d'acquéreurs plus large.";
  }

  insights.conseil =
    prixM2 >= 5000
      ? "Dans un marché tendu, une mise en valeur soignée du bien (photos professionnelles, home staging) accélère nettement la vente."
      : "Pour optimiser la vente, mettez en avant les atouts du bien et restez flexible sur les horaires de visite.";

  return insights;
}

/**
 * Effet du DPE sur la valeur : texte, couleur d'accent et fond de l'encadré.
 *
 * Les fourchettes de surcote/décote écrites en dur ici (« 10 à 15 % »,
 * « 15 à 25 % »…) n'étaient adossées à AUCUNE source et ne correspondaient pas
 * au coefficient réellement appliqué au calcul. Elles sont remplacées par le
 * coefficient effectivement utilisé pour CE bien (`method.coefficients.dpe`),
 * avec la mention de son origine (§7.3 : « aligné sur `coefficients_reference`
 * et porte sa source, ou supprimé »). Quand ce coefficient n'est pas
 * disponible — repli statique ou `lastEstimation` d'ancienne génération — le
 * texte reste qualitatif, sans aucun chiffre.
 *
 * @param {string} dpe
 * @param {number|null} [appliedCoefficient] `method.coefficients.dpe`
 */
function pdfDpeImpact(dpe, appliedCoefficient) {
  var letter = dpe ? String(dpe).toUpperCase() : "";
  var hasCoefficient = typeof appliedCoefficient === "number" && isFinite(appliedCoefficient);
  var effect = hasCoefficient
    ? " Effet retenu dans cette estimation : " +
      pdfFormatCoefficient(appliedCoefficient) +
      " (coefficients de valeur verte de référence)."
    : "";

  if (letter === "A" || letter === "B") {
    return {
      accent: PDF_COLORS.success,
      background: PDF_COLORS.successSoft,
      title: "Un atout",
      text:
        "Classé " +
        letter +
        ", le bien se situe parmi les logements les mieux isolés du parc : à secteur et surface comparables, il se négocie au-dessus d'un équivalent énergivore." +
        effect,
    };
  }
  if (letter === "C" || letter === "D") {
    return {
      accent: PDF_COLORS.orange,
      background: PDF_COLORS.orange5,
      title: "Dans la moyenne du marché",
      text:
        "Classé " +
        letter +
        ", le bien se situe dans la moyenne des logements vendus aujourd'hui : le DPE ne pénalise pas sa valeur." +
        effect,
    };
  }
  if (letter === "E") {
    return {
      accent: PDF_COLORS.orange,
      background: PDF_COLORS.orange5,
      title: "Décote limitée",
      text:
        "Classé E, le bien subit une décote modérée. Des travaux d'isolation ciblés suffisent souvent à remonter d'une classe." +
        effect,
    };
  }
  if (letter === "F" || letter === "G") {
    return {
      accent: PDF_COLORS.error,
      background: PDF_COLORS.errorSoft,
      title: "Passoire thermique",
      text:
        "Classé " +
        letter +
        ", le bien subit une décote et sa mise en location est progressivement interdite. Une rénovation énergétique est le premier levier de valorisation." +
        effect,
    };
  }
  return {
    accent: PDF_COLORS.aubergine3,
    background: PDF_COLORS.beige25,
    title: "DPE non renseigné",
    text:
      "Sans diagnostic de performance énergétique, l'estimation retient une hypothèse neutre et la fourchette s'en trouve élargie. Réaliser un DPE permet de l'affiner et rassure les acquéreurs.",
  };
}

// ============================================================================
// 5. SECTIONS DU RAPPORT
// ============================================================================

/** Bandeau de couverture : identité, adresse, date. */
function pdfCoverBand(l, data) {
  var doc = l.doc;
  var addressLines = doc.splitTextToSize(data.address || "", l.width - 40);
  if (addressLines.length > 2) addressLines = addressLines.slice(0, 2);
  var height = 46 + addressLines.length * 8;

  pdfFill(doc, PDF_COLORS.black);
  doc.rect(0, 0, PDF_PAGE.width, height, "F");

  // Signature : un carré orange et le nom. Le pictogramme de maison dessiné
  // en primitives a été retiré, il ne tenait pas la comparaison avec le reste.
  pdfFill(doc, PDF_COLORS.orange);
  doc.rect(PDF_PAGE.margin, 14, 3, 3, "F");
  pdfCaption(doc, "Estimer mon bien", PDF_PAGE.margin + 5.5, 16.6, PDF_COLORS.white);

  pdfFont(doc, PDF_TYPE.small, "normal", PDF_COLORS.aubergine5);
  doc.text(
    new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }),
    PDF_PAGE.width - PDF_PAGE.margin,
    16.6,
    { align: "right" }
  );

  pdfCaption(doc, "Rapport d'estimation", PDF_PAGE.margin, 32, PDF_COLORS.orange);

  pdfFont(doc, PDF_TYPE.title, "bold", PDF_COLORS.white);
  addressLines.forEach(function (line, index) {
    doc.text(line, PDF_PAGE.margin, 41 + index * 8);
  });

  pdfFont(doc, PDF_TYPE.lead, "normal", PDF_COLORS.aubergine5);
  doc.text(
    (data.postalCode || "") + " " + capitalizeWords(data.city),
    PDF_PAGE.margin,
    41 + addressLines.length * 8 + 1
  );

  l.y = height + 10;
}

/**
 * Bandeau d'état affiché AVANT le bloc prix : repli statique, estimation
 * différée, territoire Livre foncier, données insuffisantes. Le PDF applique
 * exactement les mêmes règles que la page (§7.3).
 */
function pdfStatusBanner(l, ctx) {
  if (ctx.isStaticFallback) {
    pdfNote(l, {
      title: "Estimation indicative",
      accent: PDF_COLORS.error,
      background: PDF_COLORS.errorSoft,
      text:
        "Nos données de transactions n'ont pas pu être consultées. Le montant ci-dessous provient d'un calcul de repli interne fondé sur des moyennes, et non sur les ventes réelles enregistrées autour du bien. Sa précision est nettement réduite.",
    });
    l.space(1);
    return;
  }

  if (ctx.isDeferred) {
    pdfNote(l, {
      title: "Estimation en cours de préparation",
      accent: PDF_COLORS.error,
      background: PDF_COLORS.errorSoft,
      text:
        "Nous n'avons pas pu calculer cette estimation en direct. Un conseiller vous l'adresse sous 24 h ouvrées.",
    });
    l.space(1);
    return;
  }

  if (ctx.dataSource && ctx.dataSource.dataCoverage === "no-dvf") {
    pdfNote(l, {
      title: "Territoire relevant du Livre foncier",
      accent: PDF_COLORS.error,
      background: PDF_COLORS.errorSoft,
      text:
        "Les départements du Bas-Rhin, du Haut-Rhin, de la Moselle et de Mayotte relèvent du régime du Livre foncier : leurs transactions ne figurent pas dans la base publique DVF de la DGFiP. Cette estimation repose sur des références départementales et non sur des transactions comparables. Sa précision est nettement réduite ; nous recommandons une évaluation sur place.",
    });
    l.space(1);
  }
}

/** Bloc principal : estimation moyenne, fourchette, prix au m², confiance. */
function pdfEstimationBlock(l, data, ctx) {
  var doc = l.doc;
  var estimation = data.estimation || {};
  var height = 50;

  l.reserve(height);
  pdfFill(doc, PDF_COLORS.beige25);
  doc.rect(l.x, l.y, l.width, height, "F");
  pdfFill(doc, PDF_COLORS.orange);
  doc.rect(l.x, l.y, l.width, 1, "F");

  pdfCaption(doc, ctx.showCentralValue ? "Estimation moyenne" : "Fourchette estimée", l.x + 8, l.y + 11);

  pdfFont(doc, PDF_TYPE.display, "bold", PDF_COLORS.black);
  if (ctx.showCentralValue) {
    doc.text(formatPrice(estimation.estimationMoyenne), l.x + 8, l.y + 25);
  } else {
    // Confiance insuffisante ou mode différé : la valeur centrale n'est PAS
    // affichée — même règle que la page, décidée par l'API (§3.8).
    pdfFont(doc, PDF_TYPE.title, "bold", PDF_COLORS.aubergine3);
    doc.text(
      ctx.isDeferred ? "Non calculée" : "Non communiquée",
      l.x + 8,
      l.y + 24
    );
  }

  // Prix au m², aligné à droite : la position se déduit de la largeur mesurée,
  // jamais d'un décalage écrit en dur.
  var rightX = l.x + l.width - 8;
  if (ctx.showCentralValue) {
    pdfCaption(doc, "Prix au m²", rightX, l.y + 11, PDF_COLORS.aubergine3, "right");
    pdfFont(doc, PDF_TYPE.h2, "bold", PDF_COLORS.orange);
    doc.text(formatPrice(estimation.prixM2), rightX, l.y + 25, { align: "right" });
  }

  // Ruban de confiance, à droite du prix au m².
  var confidenceLabel = pdfConfidenceLabel(ctx);
  if (confidenceLabel) {
    pdfCaption(doc, confidenceLabel.text, rightX, l.y + 31, confidenceLabel.color, "right");
  }

  if (ctx.isDeferred) {
    // Aucun chiffre n'a été produit : on n'affiche ni réglette ni bornes,
    // plutôt qu'une fourchette « 0 € – 0 € ».
    pdfFont(doc, PDF_TYPE.small, "normal", PDF_COLORS.aubergine3);
    doc.text(
      "Un conseiller vous adresse votre estimation sous 24 h ouvrées.",
      l.x + 8,
      l.y + 40
    );
    l.y += height;
    l.space(1.5);
    return;
  }

  // Fourchette : une réglette bornée min -> max, plus parlante qu'une ligne de
  // texte. Toute la barre représente la fourchette, bornes comprises.
  var barY = l.y + 36;
  var barX = l.x + 8;
  var barWidth = l.width - 16;
  pdfFill(doc, PDF_COLORS.orange);
  doc.rect(barX, barY, barWidth, 2, "F");
  pdfFill(doc, PDF_COLORS.black);
  doc.rect(barX, barY - 1.5, 0.8, 5, "F");
  doc.rect(barX + barWidth - 0.8, barY - 1.5, 0.8, 5, "F");

  // Amplitude RÉELLE sous la barre (`range.halfWidthPct`) — le ±10 % fixe a
  // disparu (§3.7). Sans `range` (ancien `lastEstimation` ou repli statique),
  // on n'affiche aucun pourcentage plutôt qu'un chiffre faux.
  var middleLabel = "Fourchette d'estimation";
  if (ctx.range && typeof ctx.range.halfWidthPct === "number") {
    var pct = Math.round(ctx.range.halfWidthPct * 1000) / 10;
    middleLabel =
      "Amplitude +/- " +
      String(pct).replace(".", ",") +
      " %" +
      (ctx.range.basis === "iqr" && ctx.method && ctx.method.comparablesCount
        ? " (dispersion de " + ctx.method.comparablesCount + " ventes réelles)"
        : "");
  } else if (ctx.isStaticFallback) {
    middleLabel = "Fourchette indicative";
  }

  pdfFont(doc, PDF_TYPE.small, "normal", PDF_COLORS.aubergine3);
  doc.text(formatPrice(estimation.estimationMin), barX, barY + 8);
  doc.text(middleLabel, barX + barWidth / 2, barY + 8, { align: "center" });
  doc.text(formatPrice(estimation.estimationMax), barX + barWidth, barY + 8, { align: "right" });

  l.y += height;
  l.space(1.5);
}

/** Libellé + couleur du ruban de confiance, ou `null` s'il n'y a rien à dire. */
function pdfConfidenceLabel(ctx) {
  if (ctx.isStaticFallback) {
    return { text: "Confiance : indicatif", color: PDF_COLORS.error };
  }
  if (!ctx.confidence || typeof ctx.confidence.score !== "number") return null;

  var label =
    (ctx.display && ctx.display.confidenceLabelFr) || "Indice de confiance";
  var color =
    ctx.confidence.label === "high"
      ? PDF_COLORS.success
      : ctx.confidence.label === "medium"
      ? PDF_COLORS.orange
      : PDF_COLORS.error;

  return { text: label + " · " + Math.round(ctx.confidence.score) + "/100", color: color };
}

/** Caractéristiques du bien. */
function pdfPropertySection(l, data) {
  pdfHeading(l, "Le bien estimé");

  var rows = [
    [
      { label: "Type", value: capitalizeFirst(data.propertyType) },
      { label: "Surface", value: formatArea(data.surface) + " m²" },
      { label: "Pièces", value: data.rooms + " pièce" + (data.rooms > 1 ? "s" : "") },
      {
        label: "DPE",
        value:
          data.dpe === "unknown" || !data.dpe ? "Non renseigné" : String(data.dpe).toUpperCase(),
      },
    ],
  ];

  // Deuxième rangée : uniquement les informations réellement renseignées.
  var extras = [];
  if (data.propertyType === "maison" && data.hasTerrain) {
    extras.push({
      label: "Terrain",
      value:
        data.hasTerrain === "yes"
          ? data.terrainSize
            ? formatArea(data.terrainSize) + " m²"
            : "Oui"
          : "Non",
    });
  }
  if (data.isOwner) {
    extras.push({ label: "Propriétaire", value: data.isOwner === "yes" ? "Oui" : "Non" });
  }
  if (data.wantToSell) {
    extras.push({
      label: "Projet de vente",
      value:
        data.wantToSell === "yes" ? "Oui" : data.wantToSell === "maybe" ? "Peut-être" : "Non",
    });
  }
  if (extras.length) rows.push(extras);

  pdfDataGrid(l, rows);
  l.space(1.5);
}

/**
 * Indice de confiance (§7.3) : jauge horizontale 0-100, libellé, et détail des
 * composantes. Rien n'est affiché si `confidence` est absente — cas d'un
 * `lastEstimation` d'ancienne génération.
 */
function pdfConfidenceSection(l, ctx) {
  var doc = l.doc;
  var breakdown = ctx.confidence ? ctx.confidence.breakdown : null;

  var score;
  var label;
  var color;
  var note;

  if (ctx.isStaticFallback) {
    // Plafond d'affichage, assumé comme une convention : aucune confiance n'a
    // été mesurée, on ne prétend pas le contraire.
    score = 30;
    label = "Indicatif";
    color = PDF_COLORS.error;
    note =
      "Aucune transaction comparable n'a pu être analysée : cet indice est plafonné par convention et ne mesure pas la fiabilité réelle du montant affiché.";
  } else if (ctx.confidence && typeof ctx.confidence.score === "number") {
    score = Math.max(0, Math.min(100, Math.round(ctx.confidence.score)));
    label = (ctx.display && ctx.display.confidenceLabelFr) || "Indice de confiance";
    color =
      ctx.confidence.label === "high"
        ? PDF_COLORS.success
        : ctx.confidence.label === "medium"
        ? PDF_COLORS.orange
        : PDF_COLORS.error;
    note =
      ctx.confidence.label === "medium"
        ? "La fourchette reflète la dispersion observée sur le secteur."
        : ctx.confidence.label === "high"
        ? "L'échantillon de ventes comparables est fourni, proche et homogène."
        : "Peu de transactions comparables : une visite sur place est recommandée.";
  } else {
    return; // Rien de mesuré, rien à afficher.
  }

  pdfHeading(l, "Fiabilité de l'estimation");

  // Jauge : un rail clair, une portion remplie. Aucune animation, aucun
  // dégradé — le PDF doit rester lisible en niveaux de gris.
  l.reserve(20);
  var gaugeY = l.y + 2;
  var gaugeHeight = 5;
  pdfFill(doc, PDF_COLORS.beige50);
  doc.rect(l.x, gaugeY, l.width, gaugeHeight, "F");
  pdfFill(doc, color);
  doc.rect(l.x, gaugeY, (l.width * score) / 100, gaugeHeight, "F");

  pdfFont(doc, PDF_TYPE.h3, "bold", PDF_COLORS.black);
  doc.text(label, l.x, gaugeY + gaugeHeight + 6);
  pdfFont(doc, PDF_TYPE.h3, "bold", color);
  doc.text(score + " / 100", l.x + l.width, gaugeY + gaugeHeight + 6, { align: "right" });
  l.y = gaugeY + gaugeHeight + 9;

  l.space(0.5);
  pdfParagraph(l, note);

  if (breakdown) {
    l.space(1);
    pdfDataGrid(l, [
      [
        { label: "Nb de ventes (/40)", value: pdfFormatPoints(breakdown.count) },
        { label: "Proximité (/25)", value: pdfFormatPoints(breakdown.proximity) },
        { label: "Fraîcheur (/15)", value: pdfFormatPoints(breakdown.freshness) },
      ],
      [
        { label: "Homogénéité (/20)", value: pdfFormatPoints(breakdown.dispersion) },
        {
          label: "Pénalités",
          value:
            (Number(breakdown.penalties) > 0 ? "-" : "") + pdfFormatPoints(breakdown.penalties),
        },
        { label: "Total", value: score + " pts" },
      ],
    ]);
  }

  l.space(1.5);
}

/**
 * Indexe `method.coefficientSources` par `key`. Tolère l'absence du champ (le
 * backend peut le livrer après ce front) comme une valeur mal formée : le
 * résultat est alors un objet vide, et l'appelant retombe sur ses libellés.
 *
 * @param {Array<{key:string,label?:string,sourceLabel?:string,sourceUrl?:string,dateSource?:string}>} [sources]
 * @returns {Record<string, object>}
 */
function pdfIndexCoefficientSources(sources) {
  var byKey = {};
  if (!Array.isArray(sources)) return byKey;
  sources.forEach(function (source) {
    if (source && source.key) byKey[source.key] = source;
  });
  return byKey;
}

/** Points de l'indice de confiance, une décimale, virgule française. */
function pdfFormatPoints(value) {
  var number = Number(value);
  if (!isFinite(number)) return "—";
  return String(Math.round(number * 10) / 10).replace(".", ",") + " pts";
}

/**
 * Transactions comparables (§7.3) : les 5 plus proches. Ni numéro de voie, ni
 * jour exact, distance arrondie — l'anonymisation est faite côté API (§8.3),
 * le PDF n'y ajoute rien et n'en retire rien.
 *
 * US-6 / §8.2 : la section entière disparaît en `method.kind ===
 * 'reference-table'` (territoires du Livre foncier). Il n'existe alors AUCUNE
 * transaction DVF derrière le chiffre : imprimer le titre « Ventes réelles
 * enregistrées par la DGFiP » au-dessus d'un état vide reviendrait à faire
 * cautionner l'estimation par la DGFiP. L'encadré « Territoire relevant du
 * Livre foncier » (§7.3, bandeaux d'état) porte seul l'explication.
 */
function pdfComparablesSection(l, ctx) {
  if (!ctx.method || ctx.isStaticFallback || ctx.isDeferred) return;
  if (ctx.method.kind === "reference-table") return;

  pdfHeading(l, "Ventes réelles enregistrées par la DGFiP");

  if (!ctx.comparables.length) {
    var levelText = pdfDescribeLevel(ctx.method);
    pdfParagraph(
      l,
      "Aucune vente comparable n'a pu être listée pour ce bien. " +
        (levelText
          ? "L'estimation s'appuie sur le niveau géographique suivant : " +
            levelText.toLowerCase() +
            "."
          : "L'estimation s'appuie sur des références plus larges que le voisinage immédiat.")
    );
    l.space(1.5);
    return;
  }

  var doc = l.doc;
  var items = ctx.comparables.slice(0, 5);
  var columns = [
    { label: "Voie", width: 0.34 },
    { label: "Distance", width: 0.13 },
    { label: "Date", width: 0.18 },
    { label: "Surface", width: 0.14 },
    { label: "Prix au m²", width: 0.21 },
  ];
  var rowHeight = 8;
  var headerHeight = 7;

  l.reserve(headerHeight + items.length * rowHeight + 4);
  var top = l.y;

  // En-tête
  var cursorX = l.x;
  pdfFill(doc, PDF_COLORS.beige25);
  doc.rect(l.x, top, l.width, headerHeight, "F");
  columns.forEach(function (column) {
    pdfCaption(doc, column.label, cursorX + 2, top + 4.8);
    cursorX += l.width * column.width;
  });

  // Lignes
  items.forEach(function (item, index) {
    var rowY = top + headerHeight + index * rowHeight;
    pdfStroke(doc, PDF_COLORS.aubergine6, 0.2);
    doc.line(l.x, rowY, l.x + l.width, rowY);

    var values = [
      capitalizeWords(item.street || ""),
      pdfFormatDistance(item.distanceM),
      pdfFormatMonth(item.date),
      formatArea(item.surface) + " m²",
      formatPrice(item.pricePerSqm) + "/m²",
    ];

    var x = l.x;
    values.forEach(function (value, columnIndex) {
      var columnWidth = l.width * columns[columnIndex].width;
      pdfFont(doc, PDF_TYPE.small, columnIndex === 4 ? "bold" : "normal", PDF_COLORS.black);
      // Les libellés de voie longs sont réduits plutôt que débordés.
      var text = String(value);
      if (doc.getTextWidth(text) > columnWidth - 4) doc.setFontSize(PDF_TYPE.caption);
      doc.text(text, x + 2, rowY + 5.5);
      x += columnWidth;
    });
  });

  l.y = top + headerHeight + items.length * rowHeight;
  pdfStroke(doc, PDF_COLORS.aubergine6, 0.2);
  doc.line(l.x, l.y, l.x + l.width, l.y);
  l.space(0.5);

  pdfParagraph(
    l,
    "Les " +
      items.length +
      " ventes les plus proches parmi les " +
      (ctx.method.comparablesCount || items.length) +
      " analysées. Les numéros de voie et les jours exacts de mutation sont volontairement omis.",
    { size: PDF_TYPE.small }
  );
  l.space(1.5);
}

/**
 * Méthodologie et sources (§7.3) : niveau géographique, rayon, période,
 * tolérance de surface, coefficients appliqués un par un avec leur origine.
 */
function pdfMethodologySection(l, ctx) {
  pdfHeading(l, "Méthodologie et sources");

  if (ctx.isStaticFallback) {
    pdfParagraph(
      l,
      "Le calcul de repli applique un prix moyen au m² par commune, ajusté du type de bien, de la classe DPE et du nombre de pièces. Il n'exploite aucune transaction réelle et ne comporte donc ni comparable, ni mesure de dispersion. Aucune donnée publique de transaction n'a été mobilisée pour produire ce montant."
    );
    l.space(1.5);
    return;
  }

  if (!ctx.method) {
    pdfParagraph(
      l,
      "Cette estimation croise les caractéristiques déclarées du bien avec les données de marché disponibles : localisation, surface habitable, type de bien, nombre de pièces et performance énergétique. Une visite sur place permet de l'affiner en tenant compte de l'état, de l'exposition et des prestations."
    );
    l.space(1.5);
    return;
  }

  var method = ctx.method;
  var levelText = pdfDescribeLevel(method);

  pdfParagraph(
    l,
    (levelText || "Estimation fondée sur des ventes comparables") +
      (method.windowMonths ? ", sur les " + method.windowMonths + " derniers mois" : "") +
      (method.surfaceTolerancePct
        ? ", avec une tolérance de surface de +/- " + method.surfaceTolerancePct + " %"
        : "") +
      ". Le prix de référence est la médiane pondérée des ventes retenues (pondération par distance, ancienneté et écart de surface), et non leur moyenne."
  );
  l.space(1);

  var facts = [
    { label: "Transactions", value: String(method.comparablesCount || 0) },
  ];
  if (method.medianPriceM2Raw) {
    facts.push({
      label: "Médiane observée",
      value: formatPrice(method.medianPriceM2Raw) + "/m²",
    });
  }
  // Ajustement temporel : affiché uniquement si un trimestre d'indice
  // INSEE-Notaires a réellement servi (`dataSource.priceIndexQuarter`). Tant
  // que le Lot 4 n'est pas livré, le facteur renvoyé par l'API vaut 1 par
  // convention — imprimer « x1,00 » ferait passer une absence de correction
  // pour une correction mesurée.
  if (
    typeof method.timeAdjustmentFactor === "number" &&
    ctx.dataSource &&
    ctx.dataSource.priceIndexQuarter
  ) {
    facts.push({
      label: "Ajustement temporel",
      value:
        "x" +
        method.timeAdjustmentFactor.toFixed(2).replace(".", ",") +
        " (" +
        ctx.dataSource.priceIndexQuarter +
        ")",
    });
  }
  if (method.landValue) {
    facts.push({ label: "Valeur du terrain", value: formatPrice(method.landValue) });
  }
  pdfDataGrid(l, [facts]);
  l.space(1);

  // Coefficients appliqués, un par un, avec leur origine.
  var coefficients = method.coefficients || {};
  var rows = [
    {
      key: "surface",
      label: "Surface",
      value: coefficients.surface,
      origin: "dégressivité du prix au m² selon l'écart à la surface médiane des ventes retenues",
    },
    {
      key: "floor",
      label: "Étage et ascenseur",
      value: coefficients.floor,
      origin: "coefficients de référence en base, appartements uniquement",
    },
    {
      key: "outdoor",
      label: "Extérieur",
      value: coefficients.outdoor,
      origin: "coefficients de référence en base (balcon, terrasse, jardin privatif)",
    },
    {
      key: "condition",
      label: "État général",
      value: coefficients.condition,
      origin: "coefficients de référence en base (à rénover, correct, bon, refait à neuf)",
    },
    {
      key: "dpe",
      label: "Diagnostic énergétique",
      value: coefficients.dpe,
      origin: "coefficients de valeur verte de référence, différenciés appartement / maison",
    },
  ];

  // `method.coefficientSources` (ajout API à venir) : l'origine réelle de
  // chaque coefficient, telle que la base la documente — y compris la mention
  // « valeur provisoire … à calibrer », que les libellés écrits en dur
  // ci-dessus masquaient. Lecture DÉFENSIVE : sans le champ, on garde les
  // libellés d'origine.
  var coefficientSourceByKey = pdfIndexCoefficientSources(method.coefficientSources);

  rows.forEach(function (row) {
    if (typeof row.value !== "number") return;
    var source = coefficientSourceByKey[row.key];
    var label = source && source.label ? source.label : row.label;
    var origin = source && source.sourceLabel ? source.sourceLabel : row.origin;
    if (source && source.sourceLabel && source.dateSource) {
      origin += " (" + source.dateSource + ")";
    }
    pdfParagraph(
      l,
      label + " : " + pdfFormatCoefficient(row.value) + " — " + origin + ".",
      { size: PDF_TYPE.small }
    );
  });

  if (typeof coefficients.total === "number") {
    pdfParagraph(
      l,
      "Coefficient global appliqué : " + pdfFormatCoefficient(coefficients.total) + ".",
      { size: PDF_TYPE.small, weight: "bold", color: PDF_COLORS.black }
    );
  }

  if (coefficients.clamped) {
    l.space(1);
    pdfNote(l, {
      title: "Bien atypique",
      accent: PDF_COLORS.error,
      background: PDF_COLORS.errorSoft,
      text:
        "Le coefficient global a été ramené à sa borne : la combinaison de caractéristiques de ce bien est atypique pour son secteur, ce qui rend l'estimation par comparaison moins fiable. Ce plafonnement coûte des points d'indice de confiance.",
    });
  }

  // Attribution : TOUJOURS lue dans la réponse de l'API, jamais écrite en dur
  // — sans quoi la date de publication se périmerait silencieusement (§8.1).
  if (ctx.dataSource && ctx.dataSource.attributionFr) {
    l.space(1);
    pdfParagraph(l, ctx.dataSource.attributionFr, {
      size: PDF_TYPE.small,
      color: PDF_COLORS.aubergine3,
    });
  }

  l.space(1.5);
}

/**
 * Marché local. Ne subsiste QUE ce qui est réellement observé : prix médian de
 * l'échantillon, volume de ventes, périmètre et période. Le délai de vente, la
 * marge de négociation, l'évolution sur 12 mois et les prix par type de bien
 * ont été supprimés — ils étaient inventés (§8.4).
 */
function pdfLocalMarketSection(l, data, insights, ctx) {
  var method = ctx.method;

  pdfHeading(l, "Le marché à " + insights.city);

  if (method && method.comparablesCount && !ctx.isStaticFallback) {
    var stats = [];
    if (method.medianPriceM2Raw) {
      stats.push({
        value: formatPrice(method.medianPriceM2Raw) + "/m²",
        label: "Prix médian observé",
      });
    }
    stats.push({ value: String(method.comparablesCount), label: "Ventes analysées" });
    if (method.windowMonths) {
      stats.push({ value: method.windowMonths + " mois", label: "Période analysée" });
    }
    pdfStatBand(l, stats);
    l.space(1);

    pdfParagraph(
      l,
      "Ces chiffres proviennent des ventes réellement enregistrées autour du bien. Aucun indicateur estimé ou modélisé (délai de vente, marge de négociation, évolution annuelle) n'est affiché : ces données ne figurent pas dans la base publique des transactions. Le prix médian ci-dessus est celui de l'échantillon retenu, avant application des coefficients propres au bien : il diffère donc du prix au m² estimé."
    );
    l.space(1);
  }

  pdfParagraph(l, insights.description);
  l.space(1);
  pdfParagraph(
    l,
    "Un bien de " +
      data.rooms +
      " pièce" +
      (data.rooms > 1 ? "s" : "") +
      " pour " +
      formatArea(data.surface) +
      " m² correspond à un profil " +
      insights.profilBien +
      ", recherché par les " +
      insights.profilAcquereurs +
      "."
  );
  l.space(1);
  pdfNote(l, { title: "Point fort", text: insights.pointFort });
  l.space(1.5);
}

/** Échelle DPE et impact sur la valeur. */
function pdfDpeSection(l, data, ctx) {
  var doc = l.doc;
  pdfHeading(l, "Performance énergétique");

  pdfParagraph(
    l,
    "Le DPE pèse directement sur la valeur : à secteur, surface et type comparables, un logement bien classé se négocie au-dessus d'un logement énergivore. Le coefficient réellement retenu pour ce bien figure ci-dessous."
  );
  l.space(1);

  // Échelle A -> G. Palette volontairement adoucie par rapport aux couleurs
  // réglementaires : le document reste lisible en niveaux de gris.
  var scale = [
    { letter: "A", color: [45, 106, 63], light: true },
    { letter: "B", color: [79, 143, 63], light: true },
    { letter: "C", color: [127, 174, 60], light: false },
    { letter: "D", color: [212, 169, 43], light: false },
    { letter: "E", color: [224, 129, 41], light: true },
    { letter: "F", color: [213, 93, 40], light: true },
    { letter: "G", color: [195, 50, 40], light: true },
  ];
  var current = data.dpe ? String(data.dpe).toUpperCase() : "";
  var cellWidth = l.width / scale.length;
  var cellHeight = 13;

  l.reserve(cellHeight + 10);
  var top = l.y;

  scale.forEach(function (step, index) {
    var cellX = l.x + index * cellWidth;
    var isCurrent = step.letter === current;

    pdfFill(doc, step.color);
    doc.rect(cellX, top, cellWidth - 1.5, cellHeight, "F");

    pdfFont(doc, PDF_TYPE.h3, "bold", step.light ? PDF_COLORS.white : PDF_COLORS.black);
    doc.text(step.letter, cellX + (cellWidth - 1.5) / 2, top + 8.5, { align: "center" });

    if (isCurrent) {
      // Repère du bien : cartouche aubergine sous la case concernée.
      pdfFill(doc, PDF_COLORS.black);
      doc.rect(cellX, top + cellHeight + 1.5, cellWidth - 1.5, 6, "F");
      pdfCaption(
        doc,
        "Ce bien",
        cellX + (cellWidth - 1.5) / 2,
        top + cellHeight + 5.6,
        PDF_COLORS.white,
        "center"
      );
    }
  });

  l.y = top + cellHeight + (current && current !== "UNKNOWN" ? 12 : 4);

  var impact = pdfDpeImpact(
    data.dpe,
    ctx && ctx.method && ctx.method.coefficients ? ctx.method.coefficients.dpe : null
  );
  pdfNote(l, {
    title: impact.title,
    text: impact.text,
    accent: impact.accent,
    background: impact.background,
  });
  l.space(1.5);
}

/**
 * Repères nationaux.
 *
 * La bande de chiffres qui figurait ici (« +3,2 % », « 3 000 €/m² »,
 * « 85 j ») a été SUPPRIMÉE : aucune source ne la portait, elle n'était pas
 * datée, et elle contredisait les chiffres réels du bloc d'estimation. §8.4 :
 * un indicateur non sourçable est retiré, pas remplacé.
 */
function pdfNationalSection(l) {
  pdfHeading(l, "Comprendre cette estimation");

  pdfParagraph(
    l,
    "Le marché immobilier français est contrasté selon les régions. Les grandes métropoles maintiennent des prix élevés portés par une demande soutenue, tandis que les villes moyennes et les zones rurales offrent des niveaux de prix plus accessibles. C'est pourquoi cette estimation ne part pas d'une moyenne nationale, mais des ventes réellement enregistrées autour du bien."
  );
  l.space(1);

  pdfParagraph(
    l,
    "Une estimation automatisée décrit un ordre de grandeur de marché, pas la valeur d'un bien précis : elle ignore l'état intérieur réel, l'exposition, la vue, les nuisances, les servitudes et les travaux votés en copropriété. Seule une visite sur place permet une évaluation engageante."
  );
  l.space(1.5);
}

/**
 * Conseil, appel au contact et avertissement légal. La méthodologie proprement
 * dite vit désormais dans `pdfMethodologySection` (§7.3).
 */
function pdfClosingSection(l, insights, ctx) {
  var doc = l.doc;
  pdfHeading(l, "Conseils");

  pdfNote(l, { title: "Conseil", text: insights.conseil });
  l.space(1.5);

  // Appel au contact + mentions : réservés ensemble, sinon les deux lignes de
  // mentions basculaient seules sur une page supplémentaire.
  var height = 24;
  // L'avertissement légal vient de l'API quand elle a répondu
  // (`dataSource.disclaimerFr`), pour rester identique sur le site, dans le
  // PDF et dans l'e-mail (§8.1). À défaut, mention générique de repli.
  var mentions =
    (ctx && ctx.dataSource && ctx.dataSource.disclaimerFr && !ctx.isStaticFallback
      ? ctx.dataSource.disclaimerFr
      : "Estimation indicative générée automatiquement à partir des informations déclarées. Elle ne constitue ni une expertise immobilière, ni un avis de valeur engageant, ni une offre d'achat ou de vente.");
  l.reserve(height + 4 + pdfMeasure(doc, mentions, PDF_TYPE.small, l.width));
  pdfFill(doc, PDF_COLORS.black);
  doc.rect(l.x, l.y, l.width, height, "F");
  pdfFont(doc, PDF_TYPE.h3, "bold", PDF_COLORS.white);
  doc.text("Besoin d'un accompagnement personnalisé ?", l.x + 8, l.y + 10);
  pdfFont(doc, PDF_TYPE.body, "normal", PDF_COLORS.orange25);
  doc.text("Nos experts vous répondent : contact@estimer.co", l.x + 8, l.y + 17);
  l.y += height;
  l.space(1);

  pdfParagraph(l, mentions, { size: PDF_TYPE.small, color: PDF_COLORS.aubergine3 });
}

/**
 * Pied de page appliqué à toutes les pages, une fois la pagination connue.
 *
 * Ajoute la mention Etalab EN PIED DE CHAQUE PAGE (§7.3) — mais uniquement
 * quand le chiffre vient réellement de DVF : en repli statique ou en
 * territoire Livre foncier, l'écrire serait factuellement faux et
 * contreviendrait à l'obligation de paternité de la Licence Ouverte (§8.2,
 * point 4). La date provient de `dataSource.dvfPublicationDate`, jamais d'une
 * valeur écrite en dur.
 */
function pdfPaintFooters(doc, data, ctx) {
  var total = doc.getNumberOfPages();
  var baseline = PDF_PAGE.height - 12;

  var sourceLine = "";
  if (ctx && ctx.hasDvfSource) {
    sourceLine =
      "Source : DVF (DGFiP)" +
      (ctx.dataSource.dvfPublicationDate
        ? ", " + pdfFormatSourceDate(ctx.dataSource.dvfPublicationDate)
        : "") +
      " — " +
      (ctx.dataSource.licence || "Licence Ouverte / Etalab 2.0");
  } else if (ctx && ctx.isStaticFallback) {
    sourceLine = "Estimation indicative — hors base publique de transactions";
  }

  for (var page = 1; page <= total; page++) {
    doc.setPage(page);
    pdfStroke(doc, PDF_COLORS.aubergine6, 0.2);
    doc.line(PDF_PAGE.margin, baseline - 5, PDF_PAGE.width - PDF_PAGE.margin, baseline - 5);

    if (sourceLine) {
      pdfFont(doc, PDF_TYPE.caption, "normal", PDF_COLORS.aubergine3);
      doc.text(sourceLine, PDF_PAGE.width / 2, baseline - 1.5, { align: "center" });
    }

    pdfFont(doc, PDF_TYPE.small, "normal", PDF_COLORS.aubergine3);
    doc.text("Estimer mon bien", PDF_PAGE.margin, baseline + 3);
    doc.text(
      capitalizeWords(data.city) + " • " + new Date().toLocaleDateString("fr-FR"),
      PDF_PAGE.width / 2,
      baseline + 3,
      { align: "center" }
    );
    doc.text(
      "Page " + page + " sur " + total,
      PDF_PAGE.width - PDF_PAGE.margin,
      baseline + 3,
      { align: "right" }
    );
  }
}

/** « 2025-10-01 » ou une date ISO -> « octobre 2025 ». Défensif. */
function pdfFormatSourceDate(value) {
  var raw = String(value || "");
  var match = /^(\d{4})-(\d{2})/.exec(raw);
  if (!match) return raw;
  var label = PDF_MONTHS[Number(match[2]) - 1];
  return label ? label + " " + match[1] : raw;
}

// ============================================================================
// 6. POINT D'ENTRÉE
// ============================================================================

/**
 * Construit le rapport PDF à partir d'un payload d'estimation
 * (même forme que `lastEstimation` en localStorage).
 *
 * @param {object} data
 * @returns {object} le document jsPDF (non sauvegardé)
 */
function buildEstimationPdf(data) {
  var jsPDFConstructor = window.jspdf.jsPDF;
  var doc = new jsPDFConstructor("p", "mm", "a4");
  var l = pdfLayout(doc, data);
  // Contexte défensif : un `lastEstimation` d'ancienne génération produit un
  // contexte « vide » et le PDF se contente des sections historiques (US-11).
  var ctx = pdfReadContext(data);
  var insights = pdfMarketInsights(data);

  doc.setProperties({
    title: "Rapport d'estimation — " + capitalizeWords(data.city),
    creator: "Estimer mon bien",
  });

  pdfCoverBand(l, data);
  pdfStatusBanner(l, ctx);
  pdfEstimationBlock(l, data, ctx);
  pdfPropertySection(l, data);
  pdfConfidenceSection(l, ctx);
  pdfComparablesSection(l, ctx);
  pdfLocalMarketSection(l, data, insights, ctx);
  pdfDpeSection(l, data, ctx);
  pdfMethodologySection(l, ctx);
  pdfNationalSection(l);
  pdfClosingSection(l, insights, ctx);
  pdfPaintFooters(doc, data, ctx);

  return doc;
}
