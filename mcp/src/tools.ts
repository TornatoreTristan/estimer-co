import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { BlogApiClient } from './blog_api_client.js'
import { formatBlogApiError } from './format_error.js'
import { encodeImageFromPath } from './image.js'
import { resolveIdempotencyKey } from './idempotency.js'
import type {
  ArticleUpsertInput,
  ArticleUpsertResponse,
  AuteurCreateInput,
  AuteurCreateResponse,
  GetArticleResponse,
  ImageInput,
  JobStatusResponse,
  ListAuteursResponse,
  ListCategoriesResponse,
  PublishArticleResponse,
} from './types.js'

/**
 * Rappel commun, répété dans les descriptions des outils d'écriture (§7) :
 * aucune de ces opérations ne publie ni ne merge quoi que ce soit. Un humain
 * relit toujours la PR ouverte sur GitHub avant que le contenu n'atteigne
 * `main`.
 */
const REVIEW_REMINDER =
  "Aucune publication n'est directe : cet appel ouvre ou met à jour une Pull " +
  'Request sur GitHub, relue par un humain. Un article créé ou mis à jour reste ' +
  'en statut "brouillon" tant que publish_article n\'a pas été appelé et accepté.'

/** Résout `imagePath`/`imageBase64`+`imageMimeType` (exclusifs) en `ImageInput`, ou `undefined`. */
async function resolveImageInput(input: {
  imagePath?: string
  imageBase64?: string
  imageMimeType?: string
}): Promise<ImageInput | undefined> {
  const { imagePath, imageBase64, imageMimeType } = input

  if (imagePath && imageBase64) {
    throw new Error('Fournissez soit imagePath, soit imageBase64 + imageMimeType, jamais les deux.')
  }
  if (imagePath) {
    return encodeImageFromPath(imagePath)
  }
  if (imageBase64) {
    if (!imageMimeType) {
      throw new Error('imageMimeType est requis quand imageBase64 est fourni (ex. "image/jpeg").')
    }
    return { data: imageBase64, mimeType: imageMimeType }
  }
  return undefined
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function jsonResult(summary: string, data: unknown): CallToolResult {
  return textResult(`${summary}\n\n${JSON.stringify(data, null, 2)}`)
}

function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: formatBlogApiError(error) }], isError: true }
}

const faqEntryShape = z.object({
  question: z.string().min(1),
  reponse: z.string().min(1),
})

const lienShape = z.object({
  type: z.enum(['linkedin', 'x', 'site', 'email']),
  url: z.string().min(1).max(300),
  texte: z.string().min(1).max(60),
  libelle: z.string().min(1).max(150),
})

const imageInputFields = {
  imagePath: z
    .string()
    .optional()
    .describe(
      'Chemin local (sur la machine qui exécute ce serveur MCP) vers un fichier JPEG, PNG ou WebP à lire et encoder. Exclusif avec imageBase64.'
    ),
  imageBase64: z
    .string()
    .optional()
    .describe('Contenu de l\'image déjà encodé en base64. Doit être accompagné de imageMimeType. Exclusif avec imagePath.'),
  imageMimeType: z
    .string()
    .optional()
    .describe('Type MIME déclaré de imageBase64 (ex. "image/jpeg"). Ignoré si imagePath est fourni.'),
}

/** Enregistre les 7 outils MCP du module blog (specs §7) sur le serveur donné. */
export function registerBlogTools(server: McpServer, api: BlogApiClient): void {
  server.registerTool(
    'list_categories',
    {
      title: 'Lister les catégories du blog',
      description:
        "Liste les catégories valides du blog (slug + libellé). À appeler AVANT create_or_update_article : " +
        'le champ "categorie" doit être un des slugs renvoyés ici, sinon l\'API répond 422.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await api.request<ListCategoriesResponse>('GET', '/v1/blog/categories')
        return jsonResult(`${result.categories.length} catégorie(s) disponible(s).`, result)
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'list_auteurs',
    {
      title: 'Lister les auteurs du blog',
      description:
        "Liste les auteurs connus (id, nom, fonction, photo). À appeler AVANT create_or_update_article si vous " +
        "comptez renseigner \"auteur\" : sa valeur doit correspondre à un id existant ici (ou être omise, auquel " +
        "cas l'auteur par défaut du site est utilisé), sinon l'API répond 422 en vous invitant à créer l'auteur " +
        'via create_auteur.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await api.request<ListAuteursResponse>('GET', '/v1/blog/auteurs')
        return jsonResult(`${result.auteurs.length} auteur(s) connu(s).`, result)
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'create_auteur',
    {
      title: 'Créer une fiche auteur',
      description:
        'Crée une nouvelle fiche auteur (nom, fonction, biographie, liens, photo optionnelle) sur une branche ' +
        'dédiée et ouvre une Pull Request distincte de celle des articles. ' +
        REVIEW_REMINDER +
        ' La bio doit faire au moins 50 caractères. Si un id est omis, il est dérivé du nom. ' +
        'Un id déjà pris renvoie une erreur 409 : choisissez-en un autre ou réutilisez l\'id existant comme ' +
        '"auteur" dans create_or_update_article.',
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('Identifiant kebab-case (ex. "jean-dupont"). Dérivé du nom si omis.'),
        nom: z.string().min(1).max(150),
        fonction: z.string().min(1).max(150),
        bio: z.string().min(50).max(2000).describe('Biographie, 50 caractères minimum.'),
        liens: z.array(lienShape).max(6).optional(),
        ...imageInputFields,
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            "Clé d'idempotence à réutiliser pour rejouer exactement le même appel (même réponse, aucun doublon). " +
              'Générée automatiquement si omise.'
          ),
      },
    },
    async (args) => {
      try {
        const photo = await resolveImageInput(args)
        const payload: AuteurCreateInput = {
          id: args.id,
          nom: args.nom,
          fonction: args.fonction,
          bio: args.bio,
          liens: args.liens,
          photo,
        }
        const idempotencyKey = resolveIdempotencyKey(args.idempotencyKey)
        const result = await api.request<AuteurCreateResponse>('POST', '/v1/blog/auteurs', {
          body: payload,
          idempotencyKey,
        })
        return jsonResult(
          `Auteur "${result.id}" créé, PR ouverte (idempotencyKey utilisée : ${idempotencyKey}).`,
          result
        )
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'create_or_update_article',
    {
      title: 'Créer ou mettre à jour un article de blog (brouillon)',
      description:
        'Crée un article (si son slug — ou celui dérivé du titre — est absent de main et de toute PR ouverte) ' +
        "ou met à jour son contenu (même slug, nouvelle version). L'article résultant reste TOUJOURS en statut " +
        '"brouillon" ; appelez publish_article séparément pour demander sa publication. ' +
        REVIEW_REMINDER +
        ' Appelez list_categories et, si vous fournissez un auteur, list_auteurs avant cet outil : une ' +
        'catégorie ou un auteur inconnu renvoie une erreur 422. imageAlt est obligatoire dès qu\'une image est ' +
        'fournie (accessibilité) — sans lui, l\'API refuse et rien n\'est écrit. En cas de réponse en erreur, ' +
        'lisez le détail champ par champ, corrigez le payload et renvoyez l\'appel.',
      inputSchema: {
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .optional()
          .describe('kebab-case ASCII. Dérivé du titre si omis. Fournir le même slug met à jour l\'article existant.'),
        categorie: z.string().min(1).describe('Slug de catégorie — voir list_categories.'),
        title: z.string().min(1).max(200),
        metaTitle: z.string().max(200).optional(),
        metaDescription: z.string().max(200).optional(),
        extrait: z.string().max(300).optional(),
        contenu: z.string().min(1).describe('Corps de l\'article en Markdown.'),
        imageAlt: z
          .string()
          .max(300)
          .optional()
          .describe('Texte alternatif de l\'image — obligatoire dès qu\'une image (imagePath/imageBase64) est fournie.'),
        imageCadrage: z.number().min(0).max(100).optional(),
        auteur: z.string().optional().describe('Id d\'un auteur connu — voir list_auteurs. Omis = auteur par défaut du site.'),
        faq: z.array(faqEntryShape).max(10).optional(),
        motsClesCibles: z.array(z.string().min(1)).optional(),
        articlesLies: z.array(z.string()).max(4).optional().describe('Slugs d\'articles liés, 4 maximum.'),
        datePublication: z.string().optional(),
        ordreAffichage: z.number().optional(),
        ...imageInputFields,
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            "Clé d'idempotence à réutiliser pour rejouer exactement le même appel (même réponse, aucun doublon " +
              'ni nouvelle PR). Générée automatiquement si omise. Renvoyer le même slug avec un contenu modifié ' +
              'et une NOUVELLE clé pousse un commit supplémentaire sur la PR existante.'
          ),
      },
    },
    async (args) => {
      try {
        const image = await resolveImageInput(args)
        const payload: ArticleUpsertInput = {
          slug: args.slug,
          categorie: args.categorie,
          title: args.title,
          metaTitle: args.metaTitle,
          metaDescription: args.metaDescription,
          extrait: args.extrait,
          contenu: args.contenu,
          image,
          imageAlt: args.imageAlt,
          imageCadrage: args.imageCadrage,
          auteur: args.auteur,
          faq: args.faq,
          motsClesCibles: args.motsClesCibles,
          articlesLies: args.articlesLies,
          datePublication: args.datePublication,
          ordreAffichage: args.ordreAffichage,
        }
        const idempotencyKey = resolveIdempotencyKey(args.idempotencyKey)
        const result = await api.request<ArticleUpsertResponse>('POST', '/v1/blog/articles', {
          body: payload,
          idempotencyKey,
        })
        return jsonResult(
          `Article "${result.slug}" en statut "${result.statut}" (idempotencyKey utilisée : ${idempotencyKey}). ` +
            REVIEW_REMINDER,
          result
        )
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'get_article',
    {
      title: "Consulter l'état d'un article",
      description:
        "Renvoie l'état actuel d'un article : son contenu s'il existe sur main (existsOnMain, data), et la Pull " +
        "Request ouverte le concernant s'il y en a une (openPr). Utile avant une mise à jour, pour repartir du " +
        'contenu existant plutôt que de l\'écraser.',
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const result = await api.request<GetArticleResponse>(
          'GET',
          `/v1/blog/articles/${encodeURIComponent(args.slug)}`
        )
        return jsonResult(
          result.existsOnMain ? `Article "${args.slug}" présent sur main.` : `Article "${args.slug}" absent de main.`,
          result
        )
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'publish_article',
    {
      title: 'Demander la publication d\'un article',
      description:
        "Demande le passage d'un article en statut \"publie\". L'API rejoue la même gate de contenu que la CI " +
        "avant d'accepter : si le contenu est incomplet, elle répond en erreur avec le détail des points bloquants " +
        "— corrigez via create_or_update_article puis réessayez. " +
        REVIEW_REMINDER,
      inputSchema: {
        slug: z.string().min(1),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Clé d'idempotence à réutiliser pour rejouer exactement le même appel. Générée automatiquement si omise."),
      },
    },
    async (args) => {
      try {
        const idempotencyKey = resolveIdempotencyKey(args.idempotencyKey)
        const result = await api.request<PublishArticleResponse>(
          'POST',
          `/v1/blog/articles/${encodeURIComponent(args.slug)}/publish`,
          { body: {}, idempotencyKey }
        )
        return jsonResult(
          `Publication de "${result.slug}" demandée (idempotencyKey utilisée : ${idempotencyKey}). ` +
            REVIEW_REMINDER,
          result
        )
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'get_job_status',
    {
      title: "Consulter l'état d'une opération (job)",
      description:
        'Consulte l\'état d\'une opération asynchrone identifiée par son "id" de job, renvoyé par ' +
        'create_or_update_article, create_auteur ou publish_article. Statuts possibles : pending, validating, ' +
        'failed (voir errorMessage/validationErrors), pushed, pr_open, pr_merged (un humain a mergé la PR), ' +
        'pr_closed (un humain l\'a fermée sans merger).',
      inputSchema: {
        jobId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const result = await api.request<JobStatusResponse>(
          'GET',
          `/v1/blog/jobs/${encodeURIComponent(args.jobId)}`
        )
        return jsonResult(`Job "${result.id}" (${result.action}) — statut : ${result.status}.`, result)
      } catch (error) {
        return errorResult(error)
      }
    }
  )
}
