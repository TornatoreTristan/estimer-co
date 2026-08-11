// Initialiser EmailJS avec la configuration
      emailjs.init(CONFIG.EMAILJS.PUBLIC_KEY);

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
          const subjectText =
            subjectSelect.options[subjectSelect.selectedIndex].text;
          const message = document.getElementById("message").value;

          // Désactiver le bouton pendant l'envoi
          const submitBtn = this.querySelector('button[type="submit"]');
          const originalText = submitBtn.textContent;
          submitBtn.textContent = "Envoi en cours...";
          submitBtn.disabled = true;

          // Paramètres pour le template EmailJS
          const templateParams = {
            from_name: name,
            from_email: email,
            phone: phone,
            subject: subjectText,
            message: message,
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
              console.log("SUCCESS!", response.status, response.text);
              alert(
                "Merci ! Votre message a été envoyé avec succès. Nous vous répondrons dans les plus brefs délais."
              );
              document.getElementById("contactForm").reset();
            })
            .catch(function (error) {
              console.error("FAILED...", error);
              alert(
                "Une erreur est survenue lors de l'envoi. Veuillez réessayer ou nous contacter directement à estimermb@gmail.com"
              );
            })
            .finally(function () {
              // Réactiver le bouton
              submitBtn.textContent = originalText;
              submitBtn.disabled = false;
            });

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
