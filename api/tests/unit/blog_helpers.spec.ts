import { test } from '@japa/runner'
import sharp from 'sharp'

import { isValidSlug, slugify } from '#services/blog/slug'
import { canonicalJson, hashPayload, sha256Hex } from '#services/blog/hash'
import { buildAuteurJson, buildMarkdownFile, parseMarkdownFile } from '#services/blog/markdown'
import {
  detectImageFormat,
  InvalidImageError,
  MAX_DECODED_IMAGE_BYTES,
  processImage,
} from '#services/blog/image_service'
import { deriveInitiales } from '#services/blog/orchestrator_service'

test.group('slug', () => {
  test('isValidSlug accepte le kebab-case ASCII, rejette le reste (anti path-traversal)', ({
    assert,
  }) => {
    assert.isTrue(isValidSlug('estimation-maison-caen'))
    assert.isFalse(isValidSlug('Estimation-Maison'))
    assert.isFalse(isValidSlug('../../etc/passwd'))
    assert.isFalse(isValidSlug('slug avec espace'))
    assert.isFalse(isValidSlug('slug/traversal'))
  })

  test('slugify translittère les accents et nettoie la ponctuation', ({ assert }) => {
    assert.equal(slugify('Estimation Maison à Caen !'), 'estimation-maison-a-caen')
    assert.equal(slugify('  Déjà   --- Slug  '), 'deja-slug')
  })
})

test.group('hash', () => {
  test('hashPayload est stable indépendamment de l’ordre des clés', ({ assert }) => {
    const a = hashPayload({ title: 'X', categorie: 'vendre' })
    const b = hashPayload({ categorie: 'vendre', title: 'X' })
    assert.equal(a, b)
  })

  test('hashPayload change si une valeur change', ({ assert }) => {
    const a = hashPayload({ title: 'X' })
    const b = hashPayload({ title: 'Y' })
    assert.notEqual(a, b)
  })

  test('sha256Hex produit une empreinte hexadécimale de 64 caractères', ({ assert }) => {
    assert.match(sha256Hex('token'), /^[0-9a-f]{64}$/)
  })

  test('canonicalJson trie récursivement les clés', ({ assert }) => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  })
})

test.group('markdown', () => {
  test('buildMarkdownFile omet les champs undefined, jamais "champ: null"', ({ assert }) => {
    const md = buildMarkdownFile({ slug: 'x', metaTitle: undefined, title: 'Titre' }, 'Corps.')
    assert.notInclude(md, 'metaTitle')
    assert.match(md, /^---\n/)
    assert.include(md, '\n---\n\nCorps.\n')
  })

  test('parseMarkdownFile fait l’aller-retour avec buildMarkdownFile', ({ assert }) => {
    const original = { slug: 'x', categorie: 'vendre', faq: [{ question: 'Q ?', reponse: 'R.' }] }
    const md = buildMarkdownFile(original, 'Le corps de l’article.')
    const parsed = parseMarkdownFile(md)
    assert.equal(parsed.data.slug, 'x')
    assert.equal(parsed.data.categorie, 'vendre')
    assert.deepEqual(parsed.data.faq, original.faq)
    assert.equal(parsed.body, 'Le corps de l’article.')
  })

  test('buildAuteurJson produit un JSON indenté sans champs undefined', ({ assert }) => {
    const json = buildAuteurJson({ nom: 'X', photo: undefined, initiales: 'X' })
    const parsed = JSON.parse(json)
    assert.notProperty(parsed, 'photo')
    assert.equal(parsed.nom, 'X')
  })
})

test.group('image_service', () => {
  test('detectImageFormat reconnaît JPEG, PNG, WebP par signature binaire', async ({ assert }) => {
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
      .jpeg()
      .toBuffer()
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
    const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
      .webp()
      .toBuffer()

    assert.equal(detectImageFormat(jpeg), 'jpeg')
    assert.equal(detectImageFormat(png), 'png')
    assert.equal(detectImageFormat(webp), 'webp')
    assert.isNull(detectImageFormat(Buffer.from('pas une image')))
  })

  test('processImage convertit en WebP, largeur plafonnée', async ({ assert }) => {
    const jpeg = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: 'blue' },
    })
      .jpeg()
      .toBuffer()
    const result = await processImage(jpeg.toString('base64'))
    const meta = await sharp(result.buffer).metadata()
    assert.equal(meta.format, 'webp')
    assert.isAtMost(meta.width ?? Infinity, 1600)
  })

  test('processImage rejette une signature invalide', async ({ assert }) => {
    await assert.rejects(
      () => processImage(Buffer.from('pas une image').toString('base64')),
      InvalidImageError
    )
  })

  test('processImage rejette un contenu décodé de plus de 10 Mo', async ({ assert }) => {
    const big = Buffer.alloc(MAX_DECODED_IMAGE_BYTES + 1, 0)
    big[0] = 0xff
    big[1] = 0xd8
    big[2] = 0xff
    await assert.rejects(() => processImage(big.toString('base64')), InvalidImageError)
  })
})

test.group('deriveInitiales', () => {
  test('prend la première lettre du premier et du dernier mot', ({ assert }) => {
    assert.equal(deriveInitiales('Tristan Tornatore'), 'TT')
    assert.equal(deriveInitiales('Marie Curie Sklodowska'), 'MS')
  })

  test('double la lettre pour un nom composé d’un seul mot', ({ assert }) => {
    assert.equal(deriveInitiales('Madonna'), 'MM')
  })
})
