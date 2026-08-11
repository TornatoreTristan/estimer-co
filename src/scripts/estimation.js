// Initialiser EmailJS avec la configuration
      emailjs.init(CONFIG.EMAILJS.PUBLIC_KEY);

      // Charger Google Maps API dynamiquement
      function loadGoogleMapsAPI() {
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE.API_KEY}&libraries=places&callback=initAutocomplete`;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      loadGoogleMapsAPI();

      // ============================================
      // GOOGLE PLACES AUTOCOMPLETE
      // ============================================
      let autocomplete;

      function initAutocomplete() {
        const addressInput = document.getElementById("address");

        autocomplete = new google.maps.places.Autocomplete(addressInput, {
          types: ["address"],
          componentRestrictions: { country: "fr" },
        });

        // Quand l'utilisateur sélectionne une adresse
        autocomplete.addListener("place_changed", function () {
          const place = autocomplete.getPlace();

          if (!place.address_components) {
            return;
          }

          // Réinitialiser les champs
          document.getElementById("postalCode").value = "";
          document.getElementById("city").value = "";

          // Extraire les composants de l'adresse
          for (const component of place.address_components) {
            const type = component.types[0];

            switch (type) {
              case "postal_code":
                document.getElementById("postalCode").value =
                  component.long_name;
                break;
              case "locality":
                document.getElementById("city").value = component.long_name;
                break;
              case "administrative_area_level_2":
                // Si pas de locality, utiliser le département
                if (!document.getElementById("city").value) {
                  document.getElementById("city").value = component.long_name;
                }
                break;
            }
          }
        });
      }

      // Empêcher la soumission du formulaire quand on appuie sur Entrée dans le champ adresse
      document
        .getElementById("address")
        .addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
          }
        });

      // Afficher/masquer les questions terrain pour les maisons
      document
        .getElementById("propertyType")
        .addEventListener("change", function () {
          const hasTerrainGroup = document.getElementById("hasTerrainGroup");
          const terrainSizeGroup = document.getElementById("terrainSizeGroup");
          if (this.value === "maison") {
            hasTerrainGroup.style.display = "block";
          } else {
            hasTerrainGroup.style.display = "none";
            terrainSizeGroup.style.display = "none";
            document.getElementById("hasTerrain").value = "";
            document.getElementById("terrainSize").value = "";
          }
        });

      // Afficher/masquer la surface du terrain
      document
        .getElementById("hasTerrain")
        .addEventListener("change", function () {
          const terrainSizeGroup = document.getElementById("terrainSizeGroup");
          if (this.value === "yes") {
            terrainSizeGroup.style.display = "block";
          } else {
            terrainSizeGroup.style.display = "none";
            document.getElementById("terrainSize").value = "";
          }
        });

      // Afficher/masquer la question "Souhaitez-vous en faire un ?"
      document.getElementById("dpe").addEventListener("change", function () {
        const dpeRequestGroup = document.getElementById("dpeRequestGroup");
        if (this.value === "unknown") {
          dpeRequestGroup.style.display = "block";
        } else {
          dpeRequestGroup.style.display = "none";
          document.getElementById("dpeRequest").value = "";
        }
      });

      // Afficher le logo Ritmodiag si l'utilisateur souhaite faire un DPE
      document
        .getElementById("dpeRequest")
        .addEventListener("change", function () {
          const ritmodiagLink = document.getElementById("ritmodiagLink");
          if (this.value === "yes") {
            ritmodiagLink.style.display = "block";
          } else {
            ritmodiagLink.style.display = "none";
          }
        });

      // Base de données des prix moyens au m² par ville (données 2025)
      const prixMoyenM2 = {
        paris: 10500,
        lyon: 5200,
        marseille: 4100,
        toulouse: 3800,
        nice: 5500,
        nantes: 4200,
        strasbourg: 3500,
        montpellier: 4000,
        bordeaux: 5000,
        lille: 3200,
        rennes: 3900,
        reims: 2400,
        "saint-étienne": 1800,
        toulon: 3600,
        grenoble: 3400,
        dijon: 2800,
        angers: 3100,
        nîmes: 2700,
        villeurbanne: 4800,
        "le havre": 2300,
        "clermont-ferrand": 2500,
        "aix-en-provence": 5300,
        brest: 2200,
        tours: 2900,
        amiens: 2100,
        limoges: 1900,
        annecy: 5800,
        perpignan: 2600,
        besançon: 2400,
        metz: 2700,
        orléans: 2800,
        rouen: 2600,
        caen: 2800,
        mulhouse: 2300,
        nancy: 2500,
        argenteuil: 3800,
        montreuil: 5500,
        "saint-denis": 4200,
        default: 3000, // Prix moyen national par défaut
      };

      // Fonction pour calculer l'estimation
      function calculerEstimation(city, surface, rooms, propertyType, dpe) {
        // Extraire la ville et normaliser
        const cityLower = city.toLowerCase().trim();
        let prixM2 = prixMoyenM2["default"];

        // Rechercher la ville dans la base de données
        for (const ville in prixMoyenM2) {
          if (cityLower.includes(ville) || ville.includes(cityLower)) {
            prixM2 = prixMoyenM2[ville];
            break;
          }
        }

        // Ajustements selon le type de bien
        let coefficientType = 1;
        switch (propertyType) {
          case "appartement":
            coefficientType = 1;
            break;
          case "maison":
            coefficientType = 0.95; // Légèrement moins cher au m²
            break;
          case "terrain":
            coefficientType = 0.3; // Beaucoup moins cher
            break;
          case "local-commercial":
            coefficientType = 0.8;
            break;
        }

        // Ajustements selon le DPE
        let coefficientDPE = 1;
        switch (dpe) {
          case "A":
            coefficientDPE = 1.15; // +15% pour classe A
            break;
          case "B":
            coefficientDPE = 1.1; // +10% pour classe B
            break;
          case "C":
            coefficientDPE = 1.05; // +5% pour classe C
            break;
          case "D":
            coefficientDPE = 1; // Prix normal
            break;
          case "E":
            coefficientDPE = 0.95; // -5% pour classe E
            break;
          case "F":
            coefficientDPE = 0.85; // -15% pour classe F
            break;
          case "G":
            coefficientDPE = 0.75; // -25% pour classe G
            break;
          default:
            coefficientDPE = 1;
        }

        // Ajustement selon le nombre de pièces (bonus pour les grands appartements)
        let coefficientPieces = 1;
        if (propertyType === "appartement") {
          if (rooms >= 4) {
            coefficientPieces = 1.05;
          } else if (rooms === 1) {
            coefficientPieces = 0.95;
          }
        }

        // Calcul final
        const prixM2Final =
          prixM2 * coefficientType * coefficientDPE * coefficientPieces;
        const estimationMin = Math.round(prixM2Final * surface * 0.9);
        const estimationMax = Math.round(prixM2Final * surface * 1.1);
        const estimationMoyenne = Math.round(prixM2Final * surface);

        return {
          prixM2: Math.round(prixM2Final),
          estimationMin: estimationMin,
          estimationMax: estimationMax,
          estimationMoyenne: estimationMoyenne,
        };
      }

      document
        .getElementById("estimationForm")
        .addEventListener("submit", function (e) {
          e.preventDefault();

          // Récupération des données du formulaire
          const address = document.getElementById("address").value;
          const postalCode = document.getElementById("postalCode").value;
          const city = document.getElementById("city").value;
          const surface = parseFloat(document.getElementById("surface").value);
          const rooms = parseInt(document.getElementById("rooms").value);
          const propertyType = document.getElementById("propertyType").value;
          const propertyTypeText =
            document.getElementById("propertyType").options[
              document.getElementById("propertyType").selectedIndex
            ].text;
          const dpe = document.getElementById("dpe").value;
          const dpeText =
            document.getElementById("dpe").options[
              document.getElementById("dpe").selectedIndex
            ].text;
          const name = document.getElementById("name").value;
          const email = document.getElementById("email").value;
          const phone = document.getElementById("phone").value;
          const dpeRequest = document.getElementById("dpeRequest").value;
          const isOwner = document.getElementById("isOwner").value;
          const wantToSell = document.getElementById("wantToSell").value;
          const hasTerrain = document.getElementById("hasTerrain").value;
          const terrainSize = document.getElementById("terrainSize").value;

          // Calculer l'estimation
          const estimation = calculerEstimation(
            city,
            surface,
            rooms,
            propertyType,
            dpe
          );

          // Désactiver le bouton pendant l'envoi
          const submitBtn = this.querySelector('button[type="submit"]');
          const originalHTML = submitBtn.innerHTML;
          submitBtn.innerHTML = "<span>Envoi en cours...</span>";
          submitBtn.disabled = true;

          // Préparer les données pour l'email
          const templateParams = {
            from_name: name,
            from_email: email,
            phone: phone,
            subject: "Nouvelle demande d'estimation immobiliere",
            message: `NOUVELLE DEMANDE D'ESTIMATION

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INFORMATIONS DU BIEN
- Type de bien : ${propertyTypeText}
- Adresse : ${address}
- Code postal : ${postalCode}
- Ville : ${city}
- Surface : ${surface} m²
- Nombre de pieces : ${rooms}${
              propertyType === "maison"
                ? `
- Terrain : ${hasTerrain === "yes" ? "Oui" : "Non"}${
                    hasTerrain === "yes" && terrainSize
                      ? `
- Surface du terrain : ${terrainSize} m²`
                      : ""
                  }`
                : ""
            }
- DPE : ${dpeText}
- Souhaite un DPE : ${dpeRequest === "yes" ? "Oui" : "Non"}

SITUATION DU DEMANDEUR
- Proprietaire : ${isOwner === "yes" ? "Oui" : "Non"}
- Souhaite vendre : ${
              wantToSell === "yes"
                ? "Oui"
                : wantToSell === "maybe"
                ? "Peut-etre"
                : "Non"
            }

ESTIMATION CALCULEE
- Prix au m² : ${estimation.prixM2.toLocaleString("fr-FR")} €
- Estimation basse : ${estimation.estimationMin.toLocaleString("fr-FR")} €
- Estimation moyenne : ${estimation.estimationMoyenne.toLocaleString("fr-FR")} €
- Estimation haute : ${estimation.estimationMax.toLocaleString("fr-FR")} €

COORDONNEES DU CLIENT
- Nom : ${name}
- Email : ${email}
- Telephone : ${phone}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            to_email: CONFIG.EMAIL.TO,
          };

          // Envoyer l'email via EmailJS
          emailjs
            .send(
              CONFIG.EMAILJS.SERVICE_ID,
              CONFIG.EMAILJS.TEMPLATE_ID,
              templateParams
            )
            .then(function (response) {
              console.log(
                "Email envoye avec succes!",
                response.status,
                response.text
              );
            })
            .catch(function (error) {
              console.error("Erreur envoi email:", error);
            })
            .finally(function () {
              // Réactiver le bouton
              submitBtn.innerHTML = originalHTML;
              submitBtn.disabled = false;
            });

          const formData = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            propertyType: propertyType,
            address: address,
            postalCode: postalCode,
            city: city,
            surface: surface,
            rooms: rooms,
            dpe: dpe,
            dpeRequest: dpeRequest,
            isOwner: isOwner,
            wantToSell: wantToSell,
            hasTerrain: hasTerrain,
            terrainSize: terrainSize,
            name: name,
            email: email,
            phone: phone,
            estimation: estimation,
          };

          // Récupérer la base de données existante ou créer un tableau vide
          let database = JSON.parse(
            localStorage.getItem("estimationDatabase") || "[]"
          );

          // Ajouter les nouvelles données
          database.push(formData);

          // Sauvegarder dans localStorage
          localStorage.setItem("estimationDatabase", JSON.stringify(database));

          // Sauvegarder la dernière estimation pour la page de rapport
          localStorage.setItem("lastEstimation", JSON.stringify(formData));

          // Afficher dans la console pour vérification
          console.log("Données soumises:", formData);
          console.log("Base de données complète:", database);

          // Rediriger vers la page de rapport
          window.location.href = "/rapport";
        });

      // Fonction pour exporter les données en CSV
      function exportToCSV() {
        const database = JSON.parse(
          localStorage.getItem("estimationDatabase") || "[]"
        );

        if (database.length === 0) {
          alert("Aucune donnée à exporter");
          return;
        }

        // Créer le header CSV
        const headers = [
          "ID",
          "Date",
          "Type de bien",
          "Adresse",
          "Code postal",
          "Ville",
          "Surface (m²)",
          "Nombre de pièces",
          "DPE",
          "Demande DPE",
          "Nom",
          "Email",
          "Téléphone",
          "Prix m²",
          "Estimation Min",
          "Estimation Moyenne",
          "Estimation Max",
        ];
        let csv = headers.join(";") + "\n";

        // Ajouter les données
        database.forEach((row) => {
          const values = [
            row.id,
            new Date(row.timestamp).toLocaleString("fr-FR"),
            row.propertyType,
            row.address,
            row.postalCode || "N/A",
            row.city || "N/A",
            row.surface,
            row.rooms,
            row.dpe,
            row.dpeRequest || "N/A",
            row.name,
            row.email,
            row.phone,
            row.estimation ? row.estimation.prixM2 : "N/A",
            row.estimation ? row.estimation.estimationMin : "N/A",
            row.estimation ? row.estimation.estimationMoyenne : "N/A",
            row.estimation ? row.estimation.estimationMax : "N/A",
          ];
          csv += values.join(";") + "\n";
        });

        // Télécharger le fichier
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute(
          "download",
          "estimations_" + new Date().toISOString().split("T")[0] + ".csv"
        );
        link.style.visibility = "hidden";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }

      // Fonction pour afficher les données
      function viewDatabase() {
        const database = JSON.parse(
          localStorage.getItem("estimationDatabase") || "[]"
        );
        console.table(database);
        alert("Consultez la console (F12) pour voir les données");
      }

      // Fonction pour vider la base de données
      function clearDatabase() {
        if (
          confirm("Êtes-vous sûr de vouloir supprimer toutes les données ?")
        ) {
          localStorage.removeItem("estimationDatabase");
          alert("Base de données vidée");
        }
      }
