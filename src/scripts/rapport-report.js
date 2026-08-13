// Récupérer les données depuis localStorage
      const lastEstimation = JSON.parse(localStorage.getItem("lastEstimation"));

      if (!lastEstimation) {
        window.location.href = "/estimation";
      } else {
        // Remplir les détails de la propriété
        const propertyDetails = document.getElementById("propertyDetails");

        // Construire le HTML des détails
        let detailsHTML = `
                <div class="detail-item">
                    <div class="detail-label">Type de bien</div>
                    <div class="detail-value">${capitalizeFirst(
                      lastEstimation.propertyType
                    )}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Surface habitable</div>
                    <div class="detail-value">${lastEstimation.surface} m²</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Nombre de pièces</div>
                    <div class="detail-value">${lastEstimation.rooms} pièce${
          lastEstimation.rooms > 1 ? "s" : ""
        }</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">DPE</div>
                    <div class="detail-value">${
                      lastEstimation.dpe === "unknown"
                        ? "Non renseigné"
                        : "Classe " + lastEstimation.dpe
                    }</div>
                </div>`;

        // Ajouter les infos terrain si c'est une maison
        if (
          lastEstimation.propertyType === "maison" &&
          lastEstimation.hasTerrain
        ) {
          detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Terrain</div>
                    <div class="detail-value">${
                      lastEstimation.hasTerrain === "yes" ? "Oui" : "Non"
                    }</div>
                </div>`;

          if (
            lastEstimation.hasTerrain === "yes" &&
            lastEstimation.terrainSize
          ) {
            detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Surface du terrain</div>
                    <div class="detail-value">${lastEstimation.terrainSize} m²</div>
                </div>`;
          }
        }

        detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Adresse</div>
                    <div class="detail-value">${lastEstimation.address}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Ville</div>
                    <div class="detail-value">${
                      lastEstimation.postalCode
                    } ${capitalizeFirst(lastEstimation.city)}</div>
                </div>`;

        // Ajouter la situation du demandeur
        if (lastEstimation.isOwner) {
          const isOwnerText = lastEstimation.isOwner === "yes" ? "Oui" : "Non";
          detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Propriétaire</div>
                    <div class="detail-value">${isOwnerText}</div>
                </div>`;
        }

        if (lastEstimation.wantToSell) {
          let wantToSellText = "Non";
          if (lastEstimation.wantToSell === "yes") wantToSellText = "Oui";
          else if (lastEstimation.wantToSell === "maybe")
            wantToSellText = "Peut-être";

          detailsHTML += `
                <div class="detail-item">
                    <div class="detail-label">Projet de vente</div>
                    <div class="detail-value">${wantToSellText}</div>
                </div>`;
        }

        propertyDetails.innerHTML = detailsHTML;

        // Remplir les prix
        document.getElementById("estimationMoyenne").textContent = formatPrice(
          lastEstimation.estimation.estimationMoyenne
        );
        document.getElementById("estimationMin").textContent = formatPrice(
          lastEstimation.estimation.estimationMin
        );
        document.getElementById("estimationMax").textContent = formatPrice(
          lastEstimation.estimation.estimationMax
        );
        document.getElementById("prixM2").textContent =
          formatPrice(lastEstimation.estimation.prixM2) + "/m²";

        // Analyse de la ville
        const cityAnalysis = document.getElementById("cityAnalysis");
        const cityName = capitalizeFirst(lastEstimation.city);
        const prixM2 = lastEstimation.estimation.prixM2;

        let cityDescription = "";
        let marketTrend = "";

        // Descriptions personnalisées par ville
        if (prixM2 >= 8000) {
          cityDescription = `${cityName} fait partie des villes les plus prisées de France avec un marché immobilier très dynamique. La forte demande maintient les prix à un niveau élevé, particulièrement dans les quartiers centraux et bien desservis.`;
          marketTrend = "Marché très tendu";
        } else if (prixM2 >= 5000) {
          cityDescription = `${cityName} bénéficie d'un marché immobilier attractif avec une demande soutenue. La ville offre un bon équilibre entre qualité de vie et accessibilité, ce qui explique la valorisation des biens immobiliers.`;
          marketTrend = "Marché dynamique";
        } else if (prixM2 >= 3500) {
          cityDescription = `${cityName} présente un marché immobilier équilibré avec des prix modérés. La ville attire de nouveaux habitants grâce à son cadre de vie agréable et ses infrastructures en développement.`;
          marketTrend = "Marché équilibré";
        } else {
          cityDescription = `${cityName} offre des opportunités intéressantes avec un marché immobilier accessible. Les prix attractifs permettent aux primo-accédants et investisseurs de réaliser leurs projets dans de bonnes conditions.`;
          marketTrend = "Marché accessible";
        }

        // Calculer des données dynamiques basées sur le prix au m²
        const delaiVenteMoyen =
          prixM2 >= 8000 ? 45 : prixM2 >= 5000 ? 65 : prixM2 >= 3500 ? 85 : 110;
        const evolutionAnnuelle =
          prixM2 >= 8000
            ? -1.2
            : prixM2 >= 5000
            ? 0.8
            : prixM2 >= 3500
            ? 2.1
            : 3.5;
        const tauxNegociation =
          prixM2 >= 8000
            ? 3.2
            : prixM2 >= 5000
            ? 4.5
            : prixM2 >= 3500
            ? 5.8
            : 7.2;
        const prixMaisonM2 = Math.round(prixM2 * 0.85);
        const prixAppartM2 = Math.round(prixM2 * 1.12);

        // Déterminer le profil de l'acquéreur type
        let profilAcquereur = "";
        if (lastEstimation.rooms >= 4) {
          profilAcquereur = "familles avec enfants recherchant de l'espace";
        } else if (lastEstimation.rooms >= 2) {
          profilAcquereur = "couples et jeunes actifs en quête de confort";
        } else {
          profilAcquereur = "investisseurs et primo-accédants";
        }

        // Points forts selon le type de bien
        let pointsForts = "";
        if (lastEstimation.propertyType === "maison") {
          pointsForts =
            lastEstimation.hasTerrain === "yes"
              ? "La présence d'un terrain est un atout majeur, très recherché par les acquéreurs souhaitant profiter d'un espace extérieur privatif."
              : "Les maisons sans terrain restent attractives pour leur indépendance et l'absence de charges de copropriété.";
        } else if (lastEstimation.propertyType === "appartement") {
          pointsForts =
            "Les appartements bénéficient généralement d'une meilleure liquidité sur le marché et attirent un public plus large d'acquéreurs.";
        } else {
          pointsForts =
            "Ce type de bien présente des caractéristiques spécifiques qui peuvent attirer des acquéreurs ciblés.";
        }

        cityAnalysis.innerHTML += `
                <p>${cityDescription}</p>

                <div class="stats-grid" style="margin: 25px 0;">
                    <div class="stat-item">
                        <div class="stat-value">${formatPrice(prixM2)}</div>
                        <div class="stat-label">Prix moyen au m²</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${delaiVenteMoyen} j</div>
                        <div class="stat-label">Délai de vente moyen</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value" style="color: ${
                          evolutionAnnuelle >= 0 ? "#446f28" : "#c33228"
                        };">${
          evolutionAnnuelle >= 0 ? "+" : ""
        }${evolutionAnnuelle}%</div>
                        <div class="stat-label">Évolution sur 12 mois</div>
                    </div>
                </div>

                <div class="info-box">
                    <p><strong>Tendance du marché :</strong> ${marketTrend}</p>
                    <p><strong>Marge de négociation moyenne :</strong> ${tauxNegociation}%</p>
                    <p><strong>Prix maisons :</strong> ${formatPrice(
                      prixMaisonM2
                    )}/m² | <strong>Prix appartements :</strong> ${formatPrice(
          prixAppartM2
        )}/m²</p>
                </div>

                <h4 style="margin-top: 32px; margin-bottom: 12px; color: #1d0c1b;">Analyse de votre bien</h4>
                <p>Les biens de type <strong>${
                  lastEstimation.propertyType
                }</strong> sont ${
          lastEstimation.propertyType === "appartement"
            ? "particulièrement recherchés en centre-ville"
            : "très appréciés pour leur espace et leur confort"
        }. Avec <strong>${lastEstimation.rooms} pièce${
          lastEstimation.rooms > 1 ? "s" : ""
        }</strong> et une surface de <strong>${
          lastEstimation.surface
        } m²</strong>, votre bien correspond à un profil <strong>${
          lastEstimation.rooms >= 4
            ? "familial"
            : lastEstimation.rooms >= 2
            ? "intermédiaire"
            : "compact"
        }</strong> très demandé sur le marché.</p>

                <p style="margin-top: 15px;">${pointsForts}</p>

                <h4 style="margin-top: 32px; margin-bottom: 12px; color: #1d0c1b;">Profil des acquéreurs potentiels</h4>
                <p>À ${cityName}, les biens similaires au vôtre attirent principalement les <strong>${profilAcquereur}</strong>. Le délai de vente moyen de ${delaiVenteMoyen} jours indique ${
          delaiVenteMoyen <= 60
            ? "un marché très réactif où les biens de qualité se vendent rapidement"
            : delaiVenteMoyen <= 90
            ? "un marché équilibré avec des délais raisonnables"
            : "un marché où il est important de bien positionner son prix pour attirer les acquéreurs"
        }.</p>

                <div class="info-box info-box--tip">
                    <p><strong>Conseil :</strong> ${
                      prixM2 >= 5000
                        ? "Dans un marché tendu, une mise en valeur soignée de votre bien (photos professionnelles, home staging) peut accélérer significativement la vente."
                        : "Pour optimiser votre vente, nous vous recommandons de mettre en avant les atouts de votre bien et de rester flexible sur les visites."
                    }</p>
                </div>
            `;
      }

      function capitalizeFirst(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
      }

      function formatPrice(price) {
        return price.toLocaleString("fr-FR") + " €";
      }

      // Fonction pour télécharger le rapport en PDF
      function downloadPDF() {
        const downloadButton = document.getElementById("downloadPdfBtn");
        const originalText = downloadButton.innerHTML;
        downloadButton.innerHTML = "⏳ Génération du PDF...";
        downloadButton.disabled = true;

        try {
          const { jsPDF } = window.jspdf;
          const doc = new jsPDF("p", "mm", "a4");
          const pageWidth = 210;
          const pageHeight = 297;
          const margin = 18;
          const contentWidth = pageWidth - 2 * margin;
          let y = 0;

          // Palette de couleurs raffinée
          const brandOrange = [255, 110, 52];
          const brandDark = [29, 12, 27];
          const darkText = [29, 12, 27];
          const grayText = [110, 72, 105];
          const lightGray = [247, 245, 242];
          const mediumGray = [235, 230, 235];
          const greenColor = [68, 111, 40];
          const redColor = [195, 50, 40];
          const orangeColor = [255, 124, 72];
          const brandAccent = [255, 186, 158];

          // ========== PAGE 1 ==========

          // Bandeau d'en-tête, en aplat
          const headerHeight = 65;
          doc.setFillColor(...brandDark);
          doc.rect(0, 0, pageWidth, headerHeight, "F");

          // Motif décoratif (cercles subtils)
          doc.setDrawColor(255, 255, 255);
          doc.setLineWidth(0.15);
          doc.setGState(new doc.GState({ opacity: 0.12 }));
          doc.circle(pageWidth - 25, 32, 45, "S");
          doc.circle(pageWidth - 25, 32, 35, "S");
          doc.circle(pageWidth - 25, 32, 25, "S");
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Logo maison élaboré
          const logoX = pageWidth / 2;
          const logoY = 18;
          doc.setFillColor(255, 255, 255);
          // Toit
          doc.triangle(
            logoX - 12,
            logoY + 8,
            logoX,
            logoY - 4,
            logoX + 12,
            logoY + 8,
            "F"
          );
          // Corps de la maison
          doc.rect(logoX - 9, logoY + 8, 18, 14, "F");
          // Porte
          doc.setFillColor(...brandOrange);
          doc.rect(logoX - 3, logoY + 13, 6, 9, "F");
          // Fenêtres
          doc.rect(logoX - 7, logoY + 11, 3, 3, "F");
          doc.rect(logoX + 4, logoY + 11, 3, 3, "F");
          // Cheminée
          doc.setFillColor(255, 255, 255);
          doc.rect(logoX + 5, logoY, 3, 6, "F");

          // Titre principal avec style
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(26);
          doc.setFont("helvetica", "bold");
          doc.text("RAPPORT D'ESTIMATION", pageWidth / 2, 44, {
            align: "center",
          });

          // Séparateur doré
          doc.setDrawColor(...brandAccent);
          doc.setLineWidth(1);
          doc.line(pageWidth / 2 - 35, 49, pageWidth / 2 + 35, 49);

          // Sous-titre
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(11);
          doc.setFont("helvetica", "normal");
          doc.setGState(new doc.GState({ opacity: 0.95 }));
          doc.text("Estimer mon bien", pageWidth / 2, 57, { align: "center" });
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Date du rapport (coin droit)
          doc.setFontSize(8);
          doc.setGState(new doc.GState({ opacity: 0.8 }));
          doc.text(
            new Date().toLocaleDateString("fr-FR", {
              day: "numeric",
              month: "long",
              year: "numeric",
            }),
            pageWidth - margin,
            10,
            { align: "right" }
          );
          doc.setGState(new doc.GState({ opacity: 1 }));

          y = headerHeight + 8;

          // === BANDEAU ADRESSE DU BIEN ===
          doc.setFillColor(255, 255, 255);
          doc.rect(margin, y, contentWidth, 20, "F");

          // Icône localisation
          doc.setFillColor(...brandOrange);
          doc.circle(margin + 12, y + 10, 5, "F");
          doc.setFillColor(255, 255, 255);
          doc.circle(margin + 12, y + 9, 1.5, "F");

          doc.setTextColor(...grayText);
          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.text("ADRESSE DU BIEN", margin + 22, y + 7);
          doc.setTextColor(...darkText);
          doc.setFontSize(11);
          doc.setFont("helvetica", "normal");
          const fullAddress =
            lastEstimation.address +
            ", " +
            lastEstimation.postalCode +
            " " +
            capitalizeFirst(lastEstimation.city);
          doc.text(fullAddress, margin + 22, y + 15);

          y += 28;

          // === ENCADRÉ ESTIMATION PRINCIPALE ===

          // Fond en aplat
          doc.setFillColor(...brandDark);
          doc.rect(margin, y, contentWidth, 60, "F");

          // Badge "Estimation"
          doc.setFillColor(255, 255, 255);
          doc.setGState(new doc.GState({ opacity: 0.2 }));
          doc.rect(margin + contentWidth / 2 - 35, y + 5, 70, 8, "F");
          doc.setGState(new doc.GState({ opacity: 1 }));
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.text("ESTIMATION MOYENNE", pageWidth / 2, y + 11, {
            align: "center",
          });

          // Prix principal
          doc.setFontSize(38);
          doc.setFont("helvetica", "bold");
          doc.text(
            formatPrice(lastEstimation.estimation.estimationMoyenne),
            pageWidth / 2,
            y + 32,
            { align: "center" }
          );

          // Ligne séparatrice
          doc.setDrawColor(255, 255, 255);
          doc.setLineWidth(0.3);
          doc.setGState(new doc.GState({ opacity: 0.4 }));
          doc.line(margin + 30, y + 38, pageWidth - margin - 30, y + 38);
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Fourchette de prix
          doc.setFontSize(10);
          doc.setFont("helvetica", "normal");
          const minPrice = formatPrice(lastEstimation.estimation.estimationMin);
          const maxPrice = formatPrice(lastEstimation.estimation.estimationMax);
          doc.text("Fourchette estimée", pageWidth / 2, y + 46, {
            align: "center",
          });
          doc.setFontSize(12);
          doc.setFont("helvetica", "bold");
          doc.text(minPrice + "  —  " + maxPrice, pageWidth / 2, y + 54, {
            align: "center",
          });

          y += 68;

          // === Prix au m² ===
          doc.setFillColor(...lightGray);
          doc.rect(margin, y, contentWidth, 14, "F");
          doc.setTextColor(...darkText);
          doc.setFontSize(10);
          doc.setFont("helvetica", "normal");
          doc.text("Prix au m² estimé : ", margin + 10, y + 9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(...brandOrange);
          doc.text(
            formatPrice(lastEstimation.estimation.prixM2) + " /m²",
            margin + 52,
            y + 9
          );

          y += 22;

          // === CARACTÉRISTIQUES DU BIEN ===
          doc.setTextColor(...darkText);
          doc.setFontSize(13);
          doc.setFont("helvetica", "bold");
          doc.text("Caractéristiques du bien", margin, y);

          // Ligne de soulignement stylisée
          doc.setFillColor(...brandOrange);
          doc.rect(margin, y + 3, 45, 1.5, "F");
          doc.setFillColor(...brandAccent);
          doc.rect(margin + 45, y + 3, 8, 1.5, "F");

          y += 12;

          // Grille de 4 cards améliorée
          const cardWidth = (contentWidth - 8) / 2;
          const cardHeight = 24;
          const cardData = [
            {
              label: "Type de bien",
              value: capitalizeFirst(lastEstimation.propertyType),
              color: brandOrange,
            },
            {
              label: "Surface habitable",
              value: lastEstimation.surface + " m²",
              color: [16, 185, 129],
            },
            {
              label: "Nombre de pièces",
              value:
                lastEstimation.rooms +
                " pièce" +
                (lastEstimation.rooms > 1 ? "s" : ""),
              color: [139, 92, 246],
            },
            {
              label: "Classe DPE",
              value:
                lastEstimation.dpe === "unknown"
                  ? "Non renseigné"
                  : "Classe " + lastEstimation.dpe.toUpperCase(),
              color: orangeColor,
            },
          ];

          cardData.forEach((card, index) => {
            const col = index % 2;
            const row = Math.floor(index / 2);
            const cardX = margin + col * (cardWidth + 8);
            const cardY = y + row * (cardHeight + 6);

            // Ombre de la card
            doc.setFillColor(0, 0, 0);
            doc.setGState(new doc.GState({ opacity: 0.06 }));
            doc.rect(cardX + 0.5, cardY + 0.5, cardWidth, cardHeight, "F");
            doc.setGState(new doc.GState({ opacity: 1 }));

            // Fond de la card
            doc.setFillColor(255, 255, 255);
            doc.rect(cardX, cardY, cardWidth, cardHeight, "F");

            // Bordure gauche colorée (plus épaisse)
            doc.setFillColor(...card.color);
            doc.rect(cardX, cardY, 3, cardHeight, "F");
            doc.rect(cardX + 1.5, cardY, 1.5, cardHeight, "F");

            // Label
            doc.setTextColor(...grayText);
            doc.setFontSize(8);
            doc.setFont("helvetica", "normal");
            doc.text(card.label.toUpperCase(), cardX + 10, cardY + 8);

            // Valeur
            doc.setTextColor(...darkText);
            doc.setFontSize(13);
            doc.setFont("helvetica", "bold");
            doc.text(card.value, cardX + 10, cardY + 18);
          });

          y += 2 * (cardHeight + 6) + 6;

          // Infos supplémentaires (terrain, propriétaire)
          let extraInfo = [];
          if (
            lastEstimation.propertyType === "maison" &&
            lastEstimation.hasTerrain
          ) {
            const terrainText =
              lastEstimation.hasTerrain === "yes"
                ? "Oui" +
                  (lastEstimation.terrainSize
                    ? " (" + lastEstimation.terrainSize + " m²)"
                    : "")
                : "Non";
            extraInfo.push({ label: "Terrain", value: terrainText });
          }
          if (lastEstimation.isOwner) {
            extraInfo.push({
              label: "Propriétaire",
              value: lastEstimation.isOwner === "yes" ? "Oui" : "Non",
            });
          }
          if (lastEstimation.wantToSell) {
            let wantText =
              lastEstimation.wantToSell === "yes"
                ? "Oui"
                : lastEstimation.wantToSell === "maybe"
                ? "Peut-être"
                : "Non";
            extraInfo.push({ label: "Projet de vente", value: wantText });
          }

          if (extraInfo.length > 0) {
            doc.setFillColor(255, 248, 245);
            doc.setDrawColor(...orangeColor);
            doc.setLineWidth(0.5);
            doc.rect(margin, y, contentWidth, 14, "FD");

            // Icône info
            doc.setFillColor(...orangeColor);
            doc.circle(margin + 8, y + 7, 3.5, "F");
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(7);
            doc.setFont("helvetica", "bold");
            doc.text("i", margin + 8, y + 9, { align: "center" });

            doc.setTextColor(...darkText);
            doc.setFontSize(9);
            doc.setFont("helvetica", "normal");
            const infoText = extraInfo
              .map((i) => i.label + " : " + i.value)
              .join("   |   ");
            doc.text(infoText, margin + 18, y + 9);
            y += 20;
          } else {
            y += 4;
          }

          // === ANALYSE DU MARCHÉ LOCAL ===
          doc.setTextColor(...darkText);
          doc.setFontSize(13);
          doc.setFont("helvetica", "bold");
          doc.text(
            "Analyse du marché à " + capitalizeFirst(lastEstimation.city),
            margin,
            y
          );

          doc.setFillColor(...brandOrange);
          doc.rect(margin, y + 3, 55, 1.5, "F");
          doc.setFillColor(...brandAccent);
          doc.rect(margin + 55, y + 3, 8, 1.5, "F");

          y += 12;

          const prixM2 = lastEstimation.estimation.prixM2;
          const cityName = capitalizeFirst(lastEstimation.city);
          const delaiVente =
            prixM2 >= 8000
              ? 45
              : prixM2 >= 5000
              ? 65
              : prixM2 >= 3500
              ? 85
              : 110;
          const evolution =
            prixM2 >= 8000
              ? -1.2
              : prixM2 >= 5000
              ? 0.8
              : prixM2 >= 3500
              ? 2.1
              : 3.5;
          const negociation =
            prixM2 >= 8000
              ? 3.2
              : prixM2 >= 5000
              ? 4.5
              : prixM2 >= 3500
              ? 5.8
              : 7.2;
          const prixMaisons = Math.round(prixM2 * 0.85);
          const prixApparts = Math.round(prixM2 * 1.12);

          // 3 colonnes de stats avec design amélioré
          const statColWidth = (contentWidth - 12) / 3;
          const statHeight = 32;

          // Stats cards
          const statsData = [
            {
              value: (evolution >= 0 ? "+" : "") + evolution + "%",
              label: "Évolution",
              sublabel: "12 mois",
              color: evolution >= 0 ? greenColor : redColor,
            },
            {
              value: delaiVente + " j",
              label: "Délai de",
              sublabel: "vente moyen",
              color: brandOrange,
            },
            {
              value: negociation + "%",
              label: "Marge",
              sublabel: "négociation",
              color: orangeColor,
            },
          ];

          statsData.forEach((stat, index) => {
            const statX = margin + index * (statColWidth + 6);

            // Fond avec ombre
            doc.setFillColor(0, 0, 0);
            doc.setGState(new doc.GState({ opacity: 0.05 }));
            doc.rect(statX + 0.5, y + 0.5, statColWidth, statHeight, "F");
            doc.setGState(new doc.GState({ opacity: 1 }));

            doc.setFillColor(255, 255, 255);
            doc.rect(statX, y, statColWidth, statHeight, "F");

            // Barre de couleur en haut
            doc.setFillColor(...stat.color);
            doc.rect(statX, y, statColWidth, 3, "F");
            doc.rect(statX, y + 1.5, statColWidth, 1.5, "F");

            // Valeur
            doc.setTextColor(...stat.color);
            doc.setFontSize(16);
            doc.setFont("helvetica", "bold");
            doc.text(stat.value, statX + statColWidth / 2, y + 16, {
              align: "center",
            });

            // Labels
            doc.setTextColor(...grayText);
            doc.setFontSize(7);
            doc.setFont("helvetica", "normal");
            doc.text(stat.label, statX + statColWidth / 2, y + 24, {
              align: "center",
            });
            doc.text(stat.sublabel, statX + statColWidth / 2, y + 29, {
              align: "center",
            });
          });

          y += statHeight + 8;

          // Prix par type avec icônes
          doc.setFillColor(...lightGray);
          doc.rect(margin, y, contentWidth, 16, "F");

          // Maison
          doc.setFillColor(...grayText);
          doc.setFontSize(8);
          doc.text("Maisons :", margin + 8, y + 10);
          doc.setTextColor(...darkText);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(10);
          doc.text(formatPrice(prixMaisons) + "/m²", margin + 30, y + 10);

          // Séparateur
          doc.setDrawColor(...mediumGray);
          doc.setLineWidth(0.3);
          doc.line(
            margin + contentWidth / 2,
            y + 4,
            margin + contentWidth / 2,
            y + 12
          );

          // Appartements
          doc.setTextColor(...grayText);
          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.text("Appartements :", margin + contentWidth / 2 + 8, y + 10);
          doc.setTextColor(...darkText);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(10);
          doc.text(
            formatPrice(prixApparts) + "/m²",
            margin + contentWidth / 2 + 42,
            y + 10
          );

          y += 22;

          // === PROFIL ACQUÉREURS ===
          let profilBien =
            lastEstimation.rooms >= 4
              ? "familial"
              : lastEstimation.rooms >= 2
              ? "intermédiaire"
              : "compact";
          let profilAcq =
            lastEstimation.rooms >= 4
              ? "Familles avec enfants"
              : lastEstimation.rooms >= 2
              ? "Couples et jeunes actifs"
              : "Investisseurs et primo-accédants";

          doc.setFillColor(247, 245, 242);
          doc.rect(margin, y, contentWidth, 22, "F");

          // Icône utilisateur
          doc.setFillColor(...brandOrange);
          doc.circle(margin + 14, y + 11, 7, "F");
          doc.setFillColor(255, 255, 255);
          doc.circle(margin + 14, y + 9, 2.5, "F");
          doc.ellipse(margin + 14, y + 15, 4, 2.5, "F");

          doc.setTextColor(...darkText);
          doc.setFontSize(10);
          doc.setFont("helvetica", "bold");
          doc.text(
            "Profil " + profilBien + " — Acquéreurs cibles",
            margin + 28,
            y + 9
          );
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          doc.setTextColor(...grayText);
          doc.text(
            profilAcq + " • Délai estimé : " + delaiVente + " jours",
            margin + 28,
            y + 17
          );

          y += 28;

          // Points forts avec check
          let pointsForts = "";
          if (lastEstimation.propertyType === "maison") {
            pointsForts =
              lastEstimation.hasTerrain === "yes"
                ? "Terrain privatif — Atout majeur très recherché par les acquéreurs"
                : "Maison individuelle — Indépendance et absence de charges de copropriété";
          } else {
            pointsForts =
              "Appartement — Excellente liquidité sur le marché immobilier";
          }

          doc.setFillColor(234, 250, 223);
          doc.setDrawColor(...greenColor);
          doc.setLineWidth(0.5);
          doc.rect(margin, y, contentWidth, 14, "FD");

          // Check icon
          doc.setFillColor(...greenColor);
          doc.circle(margin + 10, y + 7, 4, "F");
          doc.setDrawColor(255, 255, 255);
          doc.setLineWidth(0.8);
          doc.line(margin + 8, y + 7, margin + 9.5, y + 9);
          doc.line(margin + 9.5, y + 9, margin + 13, y + 5);

          doc.setTextColor(...greenColor);
          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.text(pointsForts, margin + 20, y + 9);

          // ========== PAGE 2 ==========
          doc.addPage();

          // En-tête page 2 avec dégradé
          const header2Height = 28;
          doc.setFillColor(...brandDark);
          doc.rect(0, 0, pageWidth, header2Height, "F");

          doc.setTextColor(255, 255, 255);
          doc.setFontSize(14);
          doc.setFont("helvetica", "bold");
          doc.text("ANALYSE DÉTAILLÉE", pageWidth / 2, 18, { align: "center" });

          // Numéro de page discret
          doc.setFontSize(8);
          doc.setGState(new doc.GState({ opacity: 0.7 }));
          doc.text("2/2", pageWidth - margin, 10, { align: "right" });
          doc.setGState(new doc.GState({ opacity: 1 }));

          y = header2Height + 12;

          // === MARCHÉ IMMOBILIER 2025 ===
          doc.setTextColor(...darkText);
          doc.setFontSize(13);
          doc.setFont("helvetica", "bold");
          doc.text("Le marché immobilier français en 2025", margin, y);

          doc.setFillColor(...brandOrange);
          doc.rect(margin, y + 3, 65, 1.5, "F");
          doc.setFillColor(...brandAccent);
          doc.rect(margin + 65, y + 3, 8, 1.5, "F");

          y += 14;

          doc.setTextColor(...darkText);
          doc.setFontSize(10);
          doc.setFont("helvetica", "normal");
          const infoText =
            "Le marché immobilier français connaît une dynamique contrastée selon les régions. Les grandes métropoles maintiennent des prix élevés avec une demande soutenue, tandis que les villes moyennes offrent des opportunités plus accessibles.";
          const splitInfo = doc.splitTextToSize(infoText, contentWidth);
          doc.text(splitInfo, margin, y);
          y += splitInfo.length * 4.5 + 6;

          // Stats nationales avec nouveau design

          // Fond en aplat
          doc.setFillColor(...brandDark);
          doc.rect(margin, y, contentWidth, 38, "F");

          const natStatWidth = contentWidth / 3;
          doc.setTextColor(255, 255, 255);

          // Stat nationale 1
          doc.setFontSize(22);
          doc.setFont("helvetica", "bold");
          doc.text("+3.2%", margin + natStatWidth / 2, y + 16, {
            align: "center",
          });
          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setGState(new doc.GState({ opacity: 0.85 }));
          doc.text("Évolution annuelle", margin + natStatWidth / 2, y + 26, {
            align: "center",
          });
          doc.text("moyenne nationale", margin + natStatWidth / 2, y + 32, {
            align: "center",
          });
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Séparateurs verticaux
          doc.setDrawColor(255, 255, 255);
          doc.setLineWidth(0.2);
          doc.setGState(new doc.GState({ opacity: 0.3 }));
          doc.line(margin + natStatWidth, y + 8, margin + natStatWidth, y + 32);
          doc.line(
            margin + 2 * natStatWidth,
            y + 8,
            margin + 2 * natStatWidth,
            y + 32
          );
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Stat nationale 2
          doc.setFontSize(22);
          doc.setFont("helvetica", "bold");
          doc.text(
            "3 000 €",
            margin + natStatWidth + natStatWidth / 2,
            y + 16,
            { align: "center" }
          );
          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setGState(new doc.GState({ opacity: 0.85 }));
          doc.text(
            "Prix moyen",
            margin + natStatWidth + natStatWidth / 2,
            y + 26,
            { align: "center" }
          );
          doc.text(
            "national au m²",
            margin + natStatWidth + natStatWidth / 2,
            y + 32,
            { align: "center" }
          );
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Stat nationale 3
          doc.setFontSize(22);
          doc.setFont("helvetica", "bold");
          doc.text(
            "85 jours",
            margin + 2 * natStatWidth + natStatWidth / 2,
            y + 16,
            { align: "center" }
          );
          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setGState(new doc.GState({ opacity: 0.85 }));
          doc.text(
            "Délai de vente",
            margin + 2 * natStatWidth + natStatWidth / 2,
            y + 26,
            { align: "center" }
          );
          doc.text(
            "moyen en France",
            margin + 2 * natStatWidth + natStatWidth / 2,
            y + 32,
            { align: "center" }
          );
          doc.setGState(new doc.GState({ opacity: 1 }));

          y += 48;

          // === IMPACT DPE ===
          doc.setTextColor(...darkText);
          doc.setFontSize(13);
          doc.setFont("helvetica", "bold");
          doc.text("Impact du DPE sur la valeur", margin, y);

          doc.setFillColor(...brandOrange);
          doc.rect(margin, y + 3, 50, 1.5, "F");
          doc.setFillColor(...brandAccent);
          doc.rect(margin + 50, y + 3, 8, 1.5, "F");

          y += 14;

          // Explication DPE
          doc.setTextColor(...darkText);
          doc.setFontSize(10);
          doc.setFont("helvetica", "normal");
          const dpeText =
            "Le DPE joue un rôle crucial dans la valorisation. Les biens classés A ou B bénéficient d'une surcote jusqu'à 15%, tandis que les passoires thermiques (F et G) subissent une décote de 15 à 25%.";
          const splitDpe = doc.splitTextToSize(dpeText, contentWidth);
          doc.text(splitDpe, margin, y);
          y += splitDpe.length * 4.5 + 6;

          // Échelle DPE visuelle améliorée
          const dpeColors = {
            A: [34, 139, 34],
            B: [50, 205, 50],
            C: [173, 255, 47],
            D: [255, 255, 0],
            E: [255, 200, 0],
            F: [255, 120, 0],
            G: [220, 20, 60],
          };
          const dpeLabels = ["A", "B", "C", "D", "E", "F", "G"];
          const dpeWidth = contentWidth / 7;

          // Fond de l'échelle
          doc.setFillColor(...lightGray);
          doc.rect(margin - 2, y - 2, contentWidth + 4, 22, "F");

          dpeLabels.forEach((label, index) => {
            const x = margin + index * dpeWidth;

            // Case DPE, en aplat
            doc.setFillColor(...dpeColors[label]);
            doc.rect(x + 1, y, dpeWidth - 2, 16, "F");

            // Lettre
            doc.setTextColor(255, 255, 255);
            if (label === "C" || label === "D") {
              doc.setTextColor(29, 12, 27);
            }
            doc.setFontSize(12);
            doc.setFont("helvetica", "bold");
            doc.text(label, x + dpeWidth / 2, y + 11, { align: "center" });

            // Indicateur si c'est le DPE du bien
            if (
              lastEstimation.dpe &&
              lastEstimation.dpe.toUpperCase() === label
            ) {
              doc.setFillColor(...darkText);
              doc.triangle(
                x + dpeWidth / 2 - 4,
                y + 21,
                x + dpeWidth / 2 + 4,
                y + 21,
                x + dpeWidth / 2,
                y + 17,
                "F"
              );
              doc.setTextColor(...darkText);
              doc.setFontSize(7);
              doc.setFont("helvetica", "bold");
              doc.text("VOTRE BIEN", x + dpeWidth / 2, y + 27, {
                align: "center",
              });
            }
          });

          y += 34;

          // Impact personnalisé
          let dpeImpact = "";
          let dpeImpactColor = grayText;
          let dpeIcon = "i";
          const dpe = lastEstimation.dpe;
          if (dpe === "A" || dpe === "B") {
            dpeImpact =
              "Votre bien classé " +
              dpe.toUpperCase() +
              " bénéficie d'une surcote de 10-15%. C'est un atout majeur !";
            dpeImpactColor = greenColor;
            dpeIcon = "✓";
          } else if (dpe === "C" || dpe === "D") {
            dpeImpact =
              "Votre bien classé " +
              dpe.toUpperCase() +
              " est dans la moyenne du marché actuel.";
            dpeImpactColor = orangeColor;
            dpeIcon = "○";
          } else if (dpe === "E") {
            dpeImpact =
              "Votre bien classé E subit une légère décote (5-10%). Rénovation énergétique conseillée.";
            dpeImpactColor = orangeColor;
            dpeIcon = "!";
          } else if (dpe === "F" || dpe === "G") {
            dpeImpact =
              "Votre bien classé " +
              dpe.toUpperCase() +
              " (passoire thermique) subit une décote de 15-25%.";
            dpeImpactColor = redColor;
            dpeIcon = "!";
          } else {
            dpeImpact =
              "Sans DPE renseigné, nous recommandons de réaliser un diagnostic énergétique.";
            dpeImpactColor = grayText;
            dpeIcon = "i";
          }

          // Box d'impact DPE
          const impactBgColor =
            dpeImpactColor === greenColor
              ? [236, 253, 245]
              : dpeImpactColor === redColor
              ? [254, 242, 242]
              : dpeImpactColor === orangeColor
              ? [255, 251, 235]
              : [248, 249, 250];
          doc.setFillColor(...impactBgColor);
          doc.setDrawColor(...dpeImpactColor);
          doc.setLineWidth(0.5);
          doc.rect(margin, y, contentWidth, 16, "FD");

          // Icône
          doc.setFillColor(...dpeImpactColor);
          doc.circle(margin + 10, y + 8, 4, "F");
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.text(dpeIcon, margin + 10, y + 10, { align: "center" });

          doc.setTextColor(...dpeImpactColor);
          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.text(dpeImpact, margin + 20, y + 10);

          y += 24;

          // === BON À SAVOIR ===
          doc.setFillColor(247, 245, 242);
          doc.setDrawColor(...brandOrange);
          doc.setLineWidth(0.5);
          doc.rect(margin, y, contentWidth, 22, "FD");

          // Icône ampoule
          doc.setFillColor(...brandOrange);
          doc.circle(margin + 12, y + 11, 6, "F");
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(10);
          doc.setFont("helvetica", "bold");
          doc.text("i", margin + 12, y + 14, { align: "center" });

          doc.setTextColor(...brandOrange);
          doc.setFontSize(10);
          doc.setFont("helvetica", "bold");
          doc.text("Bon à savoir", margin + 24, y + 9);
          doc.setTextColor(...darkText);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          doc.text(
            "Les biens avec un bon DPE se vendent en moyenne 30% plus rapidement.",
            margin + 24,
            y + 17
          );

          y += 28;

          // === MÉTHODOLOGIE ===
          doc.setTextColor(...darkText);
          doc.setFontSize(13);
          doc.setFont("helvetica", "bold");
          doc.text("Notre méthodologie", margin, y);

          doc.setFillColor(...brandOrange);
          doc.rect(margin, y + 3, 40, 1.5, "F");
          doc.setFillColor(...brandAccent);
          doc.rect(margin + 40, y + 3, 8, 1.5, "F");

          y += 14;

          doc.setTextColor(...darkText);
          doc.setFontSize(10);
          doc.setFont("helvetica", "normal");
          const methodoText =
            "Cette estimation est calculée à partir des données du marché actuel : localisation précise, surface habitable, type de bien, nombre de pièces, performance énergétique et état général du marché local.";
          const splitMethodo = doc.splitTextToSize(methodoText, contentWidth);
          doc.text(splitMethodo, margin, y);
          y += splitMethodo.length * 4.5 + 8;

          // === CONSEIL PERSONNALISÉ ===
          doc.setFillColor(255, 248, 245);
          doc.setDrawColor(...orangeColor);
          doc.setLineWidth(0.5);
          doc.rect(margin, y, contentWidth, 26, "FD");

          // Icône ampoule
          doc.setFillColor(...orangeColor);
          doc.circle(margin + 12, y + 13, 6, "F");
          doc.setFillColor(255, 255, 255);
          doc.circle(margin + 12, y + 11, 2, "F");
          doc.rect(margin + 10.5, y + 13, 3, 4, "F");

          const conseilText =
            prixM2 >= 5000
              ? "Dans un marché tendu, une mise en valeur soignée (photos pro, home staging) accélère la vente."
              : "Pour optimiser votre vente, mettez en avant les atouts de votre bien et restez flexible sur les visites.";

          doc.setTextColor(...darkText);
          doc.setFontSize(10);
          doc.setFont("helvetica", "bold");
          doc.text("Conseil personnalisé", margin + 24, y + 10);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          const splitConseil = doc.splitTextToSize(
            conseilText,
            contentWidth - 32
          );
          doc.text(splitConseil, margin + 24, y + 18);

          y += 34;

          // === CONTACT CTA ===

          // Fond en aplat
          doc.setFillColor(...brandDark);
          doc.rect(margin, y, contentWidth, 28, "F");

          doc.setTextColor(255, 255, 255);
          doc.setFontSize(11);
          doc.setFont("helvetica", "bold");
          doc.text(
            "Besoin d'un accompagnement personnalisé ?",
            pageWidth / 2,
            y + 11,
            { align: "center" }
          );
          doc.setFontSize(10);
          doc.setFont("helvetica", "normal");
          doc.setGState(new doc.GState({ opacity: 0.95 }));
          doc.text(
            "Contactez nos experts : estimermb@gmail.com",
            pageWidth / 2,
            y + 21,
            { align: "center" }
          );
          doc.setGState(new doc.GState({ opacity: 1 }));

          // ========== FOOTERS ==========

          // Footer page 2
          doc.setFillColor(...darkText);
          doc.rect(0, pageHeight - 16, pageWidth, 16, "F");

          // Logo mini dans le footer
          doc.setFillColor(255, 255, 255);
          doc.setGState(new doc.GState({ opacity: 0.9 }));
          doc.triangle(
            margin + 3,
            pageHeight - 6,
            margin + 7,
            pageHeight - 12,
            margin + 11,
            pageHeight - 6,
            "F"
          );
          doc.rect(margin + 4, pageHeight - 6, 6, 4, "F");
          doc.setGState(new doc.GState({ opacity: 1 }));

          doc.setTextColor(255, 255, 255);
          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setGState(new doc.GState({ opacity: 0.85 }));
          doc.text("Estimer mon bien", margin + 18, pageHeight - 6);
          doc.text(
            "© 2025 - Tous droits réservés",
            pageWidth / 2,
            pageHeight - 6,
            { align: "center" }
          );
          doc.text(
            "Généré le " + new Date().toLocaleDateString("fr-FR"),
            pageWidth - margin,
            pageHeight - 6,
            { align: "right" }
          );
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Footer page 1
          doc.setPage(1);
          doc.setFillColor(...darkText);
          doc.rect(0, pageHeight - 16, pageWidth, 16, "F");

          // Logo mini
          doc.setFillColor(255, 255, 255);
          doc.setGState(new doc.GState({ opacity: 0.9 }));
          doc.triangle(
            margin + 3,
            pageHeight - 6,
            margin + 7,
            pageHeight - 12,
            margin + 11,
            pageHeight - 6,
            "F"
          );
          doc.rect(margin + 4, pageHeight - 6, 6, 4, "F");
          doc.setGState(new doc.GState({ opacity: 1 }));

          doc.setTextColor(255, 255, 255);
          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setGState(new doc.GState({ opacity: 0.85 }));
          doc.text("Estimer mon bien", margin + 18, pageHeight - 6);
          doc.text(
            "© 2025 - Tous droits réservés",
            pageWidth / 2,
            pageHeight - 6,
            { align: "center" }
          );
          doc.text("Page 1/2", pageWidth - margin, pageHeight - 6, {
            align: "right",
          });
          doc.setGState(new doc.GState({ opacity: 1 }));

          // Télécharger le PDF
          const fileName =
            "Rapport_Estimation_" +
            capitalizeFirst(lastEstimation.city).replace(/\s+/g, "_") +
            "_" +
            new Date().toISOString().split("T")[0] +
            ".pdf";
          doc.save(fileName);
        } catch (error) {
          console.error("Erreur PDF:", error);
          alert("Une erreur est survenue. Veuillez réessayer.");
        }

        downloadButton.innerHTML = originalText;
        downloadButton.disabled = false;
      }
