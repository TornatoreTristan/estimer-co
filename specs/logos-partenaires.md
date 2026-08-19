# Logos partenaires

Fichiers servis tels quels à la racine du site : `public/logos/ritmodiag.svg` est
accessible en `/logos/ritmodiag.svg`.

## Avant d'ajouter un logo

N'ajoute le logo d'une marque **que si tu as son accord écrit d'usage**. La page
`/partenaires` s'intitule « partenaires de confiance » : un logo y est lu comme
une caution officielle de la marque, bien plus qu'un nom en texte. Sans accord,
c'est un usage de marque non autorisé, et potentiellement de la publicité
trompeuse.

Sans logo, la carte affiche automatiquement le champ `logoTexte` dans une
pastille — c'est le comportement par défaut, et il est parfaitement présentable.

## Format attendu

- **SVG de préférence** (net à toutes les tailles, quelques Ko). Sinon PNG sur
  fond transparent, largeur ≥ 400 px.
- **Version monochrome sombre ou couleur sur fond clair** : la pastille a un
  fond beige clair (`--beige-25`). Un logo blanc y serait invisible.
- Récupérer le fichier officiel dans le **kit presse / brand guidelines** de la
  marque, jamais une capture d'écran ni un logo repris d'un moteur de recherche.
- Nommer le fichier d'après le slug du partenaire : `ritmodiag.svg`,
  `les-bons-biens.svg`.

## Brancher le logo

Dans `src/data/partenaires.ts`, renseigner le champ `logo` de l'entrée :

```ts
{
  logo: "/logos/les-bons-biens.svg",
  logoTexte: "Les Bons Biens", // conservé comme repli
  name: "Les Bons Biens",
  ...
}
```

Le `alt` est généré automatiquement à partir de `name` (« Logo Les Bons Biens »).
