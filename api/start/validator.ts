/*
|--------------------------------------------------------------------------
| Messages de validation — français
|--------------------------------------------------------------------------
|
| Spec §6.1 : les messages de validation renvoyés par l'API sont en français
| et « directement affichables » par le front, qui les reporte champ par
| champ sous l'input concerné. Ils ne doivent donc jamais contenir de jargon
| technique ni de nom de règle.
|
*/

import vine, { SimpleMessagesProvider } from '@vinejs/vine'

vine.messagesProvider = new SimpleMessagesProvider(
  {
    'required': 'Ce champ est obligatoire.',
    'string': 'Ce champ doit être un texte.',
    'number': 'Ce champ doit être un nombre.',
    'boolean': 'Ce champ doit valoir vrai ou faux.',
    'enum': "Cette valeur n'est pas autorisée.",
    'regex': "Le format de ce champ n'est pas valide.",
    'minLength': 'Ce champ doit contenir au moins {{ min }} caractères.',
    'maxLength': 'Ce champ ne doit pas dépasser {{ max }} caractères.',
    'min': 'La valeur doit être supérieure ou égale à {{ min }}.',
    'max': 'La valeur doit être inférieure ou égale à {{ max }}.',

    // Messages spécifiques, plus parlants que la règle générique.
    'q.required': "L'adresse à rechercher est obligatoire.",
    'q.minLength': "L'adresse doit contenir au moins {{ min }} caractères.",
    'q.maxLength': "L'adresse ne doit pas dépasser {{ max }} caractères.",
    'postcode.regex': 'Le code postal doit comporter 5 chiffres.',

    /*
     * `POST /v1/estimations` (§6.1). Ces messages sont affichés tels quels
     * sous le champ concerné, à l'étape du wizard correspondante : ils
     * doivent nommer la donnée attendue, jamais la règle technique.
     */
    'address.required': "L'adresse du bien est obligatoire.",
    'address.minLength': "L'adresse doit contenir au moins {{ min }} caractères.",
    'address.maxLength': "L'adresse ne doit pas dépasser {{ max }} caractères.",
    'postalCode.required': 'Le code postal est obligatoire.',
    'postalCode.regex': 'Le code postal doit comporter 5 chiffres.',
    'city.required': 'La commune est obligatoire.',
    'propertyType.required': 'Le type de bien est obligatoire.',
    'propertyType.enum':
      'Type de bien non pris en charge : appartement, maison, terrain ou local commercial.',
    'surface.required': 'La surface est obligatoire.',
    'surface.number': 'La surface doit être un nombre.',
    'rooms.number': 'Le nombre de pièces doit être un nombre entier.',
    'rooms.withoutDecimals': 'Le nombre de pièces doit être un nombre entier.',
    'rooms.min': 'Le bien doit comporter au moins {{ min }} pièce.',
    'rooms.max': 'Le nombre de pièces ne peut pas dépasser {{ max }}.',
    'dpe.required': 'La classe DPE est obligatoire (indiquez « unknown » si vous l’ignorez).',
    'dpe.enum': 'La classe DPE doit être comprise entre A et G, ou « unknown ».',
    'floor.withoutDecimals': "L'étage doit être un nombre entier.",
    'floor.min': "L'étage ne peut pas être négatif.",
    'floor.max': "L'étage ne peut pas dépasser {{ max }}.",
    'outdoor.enum': "Type d'extérieur non reconnu.",
    'condition.enum': 'État général non reconnu.',
    'terrainSize.min': 'La surface du terrain ne peut pas être négative.',
    'terrainSize.max': 'La surface du terrain ne peut pas dépasser {{ max }} m².',
    'lat.min': 'La latitude fournie est hors du territoire français.',
    'lat.max': 'La latitude fournie est hors du territoire français.',
    'lon.min': 'La longitude fournie est hors du territoire français.',
    'lon.max': 'La longitude fournie est hors du territoire français.',
  },
  {
    q: 'adresse',
    postcode: 'code postal',
    address: 'adresse',
    postalCode: 'code postal',
    city: 'commune',
    propertyType: 'type de bien',
    surface: 'surface',
    rooms: 'nombre de pièces',
    dpe: 'classe DPE',
    floor: 'étage',
    hasElevator: 'ascenseur',
    outdoor: 'extérieur',
    condition: 'état général',
    terrainSize: 'surface du terrain',
  }
)
