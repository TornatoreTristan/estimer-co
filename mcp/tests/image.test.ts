import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { encodeImageFromPath, MAX_IMAGE_FILE_BYTES } from '../src/image.js'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'estimer-blog-mcp-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('détecte un JPEG par sa signature binaire et encode en base64', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'photo.bin')
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    await writeFile(filePath, bytes)
    const result = await encodeImageFromPath(filePath)
    assert.equal(result.mimeType, 'image/jpeg')
    assert.equal(result.data, bytes.toString('base64'))
  })
})

test('détecte un PNG par sa signature binaire même avec une autre extension', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'photo.dat')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    await writeFile(filePath, bytes)
    const result = await encodeImageFromPath(filePath)
    assert.equal(result.mimeType, 'image/png')
  })
})

test('détecte un WebP par sa signature binaire (RIFF....WEBP)', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'photo.dat')
    const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
    await writeFile(filePath, bytes)
    const result = await encodeImageFromPath(filePath)
    assert.equal(result.mimeType, 'image/webp')
  })
})

test("se rabat sur l'extension du fichier si la signature n'est pas reconnue", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'photo.png')
    await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    const result = await encodeImageFromPath(filePath)
    assert.equal(result.mimeType, 'image/png')
  })
})

test('rejette un fichier sans signature ni extension reconnue, avec un message actionnable', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'photo.bin')
    await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    await assert.rejects(() => encodeImageFromPath(filePath), /type de l'image/)
  })
})

test('rejette un fichier introuvable avec un message clair', async () => {
  await assert.rejects(
    () => encodeImageFromPath('/chemin/totalement/inexistant.jpg'),
    /Impossible de lire le fichier image/
  )
})

test('rejette un fichier de plus de 10 Mo AVANT de le lire (revue QA, mineur 4)', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'photo-trop-lourde.jpg')
    // Fichier "sparse" : sa TAILLE dépasse la limite (`stat`), sans qu'il
    // faille écrire 10+ Mo de contenu réel sur disque pour le test.
    const handle = await open(filePath, 'w')
    try {
      await handle.truncate(MAX_IMAGE_FILE_BYTES + 1)
    } finally {
      await handle.close()
    }

    await assert.rejects(
      () => encodeImageFromPath(filePath),
      /trop volumineuse/
    )
  })
})

test('accepte un fichier juste sous la limite de 10 Mo', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'photo-limite.bin')
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(MAX_IMAGE_FILE_BYTES - 4, 0),
    ])
    await writeFile(filePath, bytes)

    const result = await encodeImageFromPath(filePath)
    assert.equal(result.mimeType, 'image/jpeg')
  })
})
