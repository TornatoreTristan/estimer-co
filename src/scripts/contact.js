// ============================================================================
// FORMULAIRE DE CONTACT — envoi par l'API transactionnelle, EmailJS en repli
// ============================================================================
//
// Le message part par `POST /v1/leads` (kind `contact`), qui rend le gabarit
// et envoie via Scaleway TEM. EmailJS n'est conservé que comme repli LEGACY,
// pour les cas où l'on SAIT qu'aucun e-mail n'est parti — cf.
// `shouldUseLegacyFallback` dans `lead-api.js`. Il n'y a donc jamais deux
// envois pour une soumission.
//
// `lead-api.js` doit être chargé AVANT ce fichier (cf. contact.astro).

      // EmailJS — initialisation défensive : le CDN peut être bloqué, et ce
      // n'est plus le chemin nominal. Une `ReferenceError` ici casserait tout
      // le formulaire pour un repli dont on n'a le plus souvent pas besoin.
      if (
        typeof emailjs !== "undefined" &&
        typeof CONFIG !== "undefined" &&
        CONFIG.EMAILJS
      ) {
        emailjs.init(CONFIG.EMAILJS.PUBLIC_KEY);
      }

      document
        .getElementById("contactForm")
        .addEventListener("submit", function (e) {
          e.preventDefault();

          // Récupération des données du formulaire
          const name = document.getElementById("name").value;
          const email = document.getElementById("email").value;
          const phone =
            document.getElementById("phone").value || "Non renseigné";
          const subjectSelect = document.getElementById("subject");
          // Le CODE (`estimation`, `partenariat`…) part vers l'API, qui produit
          // le libellé lisible ; le LIBELLÉ sert au repli EmailJS et à
          // l'export CSV local, deux consommateurs qui attendent du texte.
          const subjectValue = subjectSelect.value;
          const subjectText =
            subjectSelect.options[subjectSelect.selectedIndex].text;
          const message = document.getElementById("message").value;

          // Désactiver le bouton pendant l'envoi
          const submitBtn = this.querySelector('button[type="submit"]');
          const originalText = submitBtn.textContent;
          submitBtn.textContent = "Envoi en cours...";
          submitBtn.disabled = true;

          function releaseButton() {
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
          }

          /**
           * Succès de l'envoi : on mesure, PUIS on affiche l'accusé de
           * réception.
           *
           * L'ordre n'est pas négociable. `alert()` bloque le fil
           * d'exécution : tant que le visiteur n'a pas cliqué « OK », aucune
           * micro-tâche ne tourne. Mesurer après l'alerte reviendrait à
           * suspendre la conversion à ce clic — et à la perdre si l'onglet est
           * fermé sur la boîte de dialogue.
           */
          function onSuccess() {
            const terminer = function (userData) {
              // Sur le SUCCÈS, jamais sur la soumission : un message que l'API
              // a refusé n'est pas un lead, et le compter reviendrait à payer
              // des clics publicitaires pour des formulaires qui n'aboutissent
              // pas.
              //
              // Le `lead_id` est frappé ici plutôt qu'à l'envoi : c'est une
              // conversion sans page de confirmation ni redirection, il ne
              // sert donc qu'à dédoublonner entre Google Ads et Meta (§2.4).
              if (typeof embTrack === "function") {
                embTrack("contact_lead", {
                  lead_id: embLeadId(),
                  lead_type: "contact",
                  contact_subject: subjectValue,
                  value: embContactValue(subjectValue),
                  currency: "EUR",
                  user_data: userData,
                });
              }

              alert(
                "Merci ! Votre message a été envoyé avec succès. Nous vous répondrons dans les plus brefs délais."
              );
              document.getElementById("contactForm").reset();
              releaseButton();
            };

            // Le hachage des coordonnées est asynchrone (Web Crypto). Il rend
            // toujours la main sous 500 ms, et son échec ne prive le visiteur
            // ni de son accusé de réception, ni nous de la conversion.
            // Le consentement est réappliqué de façon asynchrone à chaque
            // chargement de page : sans cette attente, la conversion partirait
            // sous le défaut « refusé » (cf. `embAttendreConsentement`). Ici le
            // coût est nul en pratique — l'appel à l'API a déjà duré plusieurs
            // centaines de millisecondes, le signal est arrivé depuis longtemps.
            const avecEmpreintes = function () {
              if (typeof embUserData === "function") {
                embUserData(email, document.getElementById("phone").value).then(
                  terminer,
                  function () {
                    terminer(null);
                  }
                );
              } else {
                terminer(null);
              }
            };

            if (typeof embAttendreConsentement === "function") {
              embAttendreConsentement().then(avecEmpreintes, avecEmpreintes);
            } else {
              avecEmpreintes();
            }
          }

          function onFailure(detail) {
            console.error("Envoi du message impossible :", detail);
            alert(
              "Une erreur est survenue lors de l'envoi. Veuillez réessayer ou nous contacter directement à " +
                (typeof CONFIG !== "undefined" && CONFIG.EMAIL && CONFIG.EMAIL.TO
                  ? CONFIG.EMAIL.TO
                  : "contact@estimer.co")
            );
            releaseButton();
          }

          /** Repli LEGACY : envoi par EmailJS depuis le navigateur. */
          function sendWithEmailJs() {
            if (
              typeof emailjs === "undefined" ||
              typeof CONFIG === "undefined" ||
              !CONFIG.EMAILJS ||
              !CONFIG.EMAILJS.SERVICE_ID
            ) {
              onFailure("aucun canal d'envoi disponible");
              return;
            }

            emailjs
              .send(CONFIG.EMAILJS.SERVICE_ID, CONFIG.EMAILJS.TEMPLATE_ID, {
                from_name: name,
                from_email: email,
                phone: phone,
                subject: subjectText,
                message: message,
                to_email: CONFIG.EMAIL ? CONFIG.EMAIL.TO : undefined,
              })
              .then(function (response) {
                console.log("SUCCESS!", response.status, response.text);
                onSuccess();
              })
              .catch(function (error) {
                onFailure(error);
              });
          }

          if (
            typeof requestLead === "function" &&
            typeof buildContactLeadPayload === "function"
          ) {
            const apiConfig =
              typeof CONFIG !== "undefined" && CONFIG.API ? CONFIG.API : {};

            requestLead(
              buildContactLeadPayload({
                name: name,
                email: email,
                // Le champ est facultatif : la valeur de courtoisie « Non
                // renseigné » n'a rien à faire dans un champ `phone` validé
                // par l'API, qui la refuserait (422).
                phone: document.getElementById("phone").value,
                subject: subjectValue,
                message: message,
              }),
              { baseUrl: apiConfig.BASE_URL },
              function (response) {
                if (response.status === "ok") {
                  if (response.mode === "dry-run") {
                    console.warn(
                      "Message accepté en mode dry-run : aucun e-mail n'a été envoyé (réf. " +
                        response.reference +
                        ")."
                    );
                  }
                  onSuccess();
                  return;
                }

                if (shouldUseLegacyFallback(response)) {
                  console.warn(
                    "API transactionnelle indisponible (" +
                      (response.reason || "inconnu") +
                      ") : repli EmailJS."
                  );
                  sendWithEmailJs();
                  return;
                }

                // 422 / 429 / timeout : rejouer par EmailJS enverrait soit un
                // message que l'API vient de refuser, soit un doublon.
                onFailure(response.message || response.reason);
              }
            );
          } else {
            sendWithEmailJs();
          }

          // Sauvegarder aussi dans localStorage
          const formData = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            name: name,
            email: email,
            phone: phone,
            subject: subjectText,
            message: message,
          };

          let database = JSON.parse(
            localStorage.getItem("contactDatabase") || "[]"
          );
          database.push(formData);
          localStorage.setItem("contactDatabase", JSON.stringify(database));
        });

      // Fonction pour exporter les données en CSV
      function exportContactsToCSV() {
        const database = JSON.parse(
          localStorage.getItem("contactDatabase") || "[]"
        );

        if (database.length === 0) {
          alert("Aucune donnée à exporter");
          return;
        }

        // Créer le header CSV
        const headers = [
          "ID",
          "Date",
          "Nom",
          "Email",
          "Téléphone",
          "Sujet",
          "Message",
        ];
        let csv = headers.join(";") + "\n";

        // Ajouter les données
        database.forEach((row) => {
          const values = [
            row.id,
            new Date(row.timestamp).toLocaleString("fr-FR"),
            row.name,
            row.email,
            row.phone || "N/A",
            row.subject,
            row.message.replace(/\n/g, " "),
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
          "contacts_" + new Date().toISOString().split("T")[0] + ".csv"
        );
        link.style.visibility = "hidden";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }

      // Fonction pour afficher les données
      function viewContactDatabase() {
        const database = JSON.parse(
          localStorage.getItem("contactDatabase") || "[]"
        );
        console.table(database);
        alert("Consultez la console (F12) pour voir les données");
      }

      // Fonction pour vider la base de données
      function clearContactDatabase() {
        if (
          confirm("Êtes-vous sûr de vouloir supprimer toutes les données ?")
        ) {
          localStorage.removeItem("contactDatabase");
          alert("Base de données vidée");
        }
      }
