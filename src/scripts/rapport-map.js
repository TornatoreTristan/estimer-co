// Variables globales pour la carte
      let map;
      let marker;

      // Charger l'API Google Maps dynamiquement
      function loadGoogleMapsAPI() {
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE.API_KEY}&callback=initMap`;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }

      // Initialiser la carte
      function initMap() {
        const lastEstimation = JSON.parse(
          localStorage.getItem("lastEstimation")
        );

        if (!lastEstimation) return;

        // Construire l'adresse complète
        const fullAddress = `${lastEstimation.address}, ${lastEstimation.postalCode} ${lastEstimation.city}, France`;

        // Afficher l'adresse
        document.getElementById("mapFullAddress").textContent = fullAddress;

        // Utiliser le Geocoder pour convertir l'adresse en coordonnées
        const geocoder = new google.maps.Geocoder();

        geocoder.geocode({ address: fullAddress }, function (results, status) {
          if (status === "OK" && results[0]) {
            const location = results[0].geometry.location;

            // Créer la carte centrée sur l'adresse (vue satellite par défaut)
            map = new google.maps.Map(document.getElementById("propertyMap"), {
              zoom: 18,
              center: location,
              mapTypeId: "satellite",
            });

            // Ajouter un marqueur personnalisé
            marker = new google.maps.Marker({
              map: map,
              position: location,
              title: lastEstimation.address,
              animation: google.maps.Animation.DROP,
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: "#ff6e34",
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 3,
              },
            });

            // Info-bulle au clic sur le marqueur
            const infoWindow = new google.maps.InfoWindow({
              content: `
                            <div style="padding: 10px; max-width: 250px;">
                                <strong style="color: #ff6e34; font-size: 14px;">${capitalizeFirst(
                                  lastEstimation.propertyType
                                )}</strong>
                                <p style="margin: 5px 0 0; color: #1d0c1b; font-size: 13px;">${
                                  lastEstimation.address
                                }</p>
                                <p style="margin: 3px 0 0; color: rgba(29,12,27,0.6); font-size: 12px;">${
                                  lastEstimation.postalCode
                                } ${capitalizeWords(lastEstimation.city)}</p>
                            </div>
                        `,
            });

            marker.addListener("click", function () {
              infoWindow.open(map, marker);
            });

            // Ouvrir l'info-bulle par défaut
            infoWindow.open(map, marker);
          } else {
            // En cas d'erreur de géocodage, afficher un message
            document.getElementById("propertyMap").innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #f7f5f2;">
                            <p style="color: rgba(29,12,27,0.6); text-align: center;">
                                Impossible de localiser l'adresse sur la carte.<br>
                                <small>Vérifiez que l'adresse est correcte.</small>
                            </p>
                        </div>
                    `;
          }
        });
      }

      // Charger l'API Google Maps au chargement de la page
      loadGoogleMapsAPI();
