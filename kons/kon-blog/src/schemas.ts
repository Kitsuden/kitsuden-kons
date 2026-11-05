/**
 * Blog — schemas of the operations (kon SDK) that are not body schemas
 * ============================================================================
 *
 * The write bodies (`createPostSchema`, `updatePostSchema`,
 * `categorySchema`…) live in `routes.ts`, next to the handler that validates them:
 * this kon already published its 400 `{ error: "Validation failed", issues }`,
 * so its operations declare `validatesHandler` and the SDK only publishes them.
 *
 * Here: parameters, query and outputs, for OpenAPI and MCP.
 */
import { z } from "zod";

const servedDate = () => z.string().datetime({ offset: true });

export const ParamId = z.object({ id: z.string().describe("Post/category id (uuid; anything else is a 404)") });
export const ParamSlug = z.object({ slug: z.string() });
export const ParamPost = z.object({ postId: z.string().describe("Post id (uuid)") });

export const ListQuery = z
  .object({
    limit: z.string().optional().describe("1-100, default 12"),
    page: z.string().optional().describe("1-based page"),
    status: z
      .string()
      .optional()
      .describe("draft | published | scheduled | archived | all (staff only; the public always gets published)"),
    category: z.string().optional().describe("Category slug or uuid"),
    game: z.string().optional().describe("Game uuid"),
    search: z.string().optional().describe("Text in title or excerpt"),
    locale: z.string().optional().describe("Two-letter language: one version per translation group"),
  })
  .passthrough();

export const SiteQuery = z
  .object({
    siteName: z.string().optional(),
    baseUrl: z.string().optional().describe("Public site origin used to build canonical URLs"),
    language: z
      .string()
      .optional()
      .describe("Site language for og:locale when the post has none (e.g. en, pt-BR); default en_US"),
  })
  .passthrough();

export const QueryBaseUrl = z.object({ baseUrl: z.string().optional() }).passthrough();

export const Input = z
  .object({
    id: z.guid(),
    title: z.string(),
    slug: z.string(),
    excerpt: z.string().nullable(),
    content: z.unknown(),
    status: z.enum(["draft", "published", "scheduled", "archived"]),
    publishedAt: servedDate().nullable(),
    authorId: z.string().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    featuredImageId: z.string().nullable(),
    blocks: z.array(z.unknown()).nullable(),
    commentsEnabled: z.boolean().nullable(),
    layout: z.string().nullable(),
    locale: z.string(),
    translationGroupId: z.string().nullable(),
    createdAt: servedDate().nullable(),
    updatedAt: servedDate().nullable(),
  })
  .passthrough();

const Thread = z.object({
  subjectType: z.literal("blog_post"),
  subjectId: z.string(),
  endpoint: z.string(),
  enabled: z.boolean(),
  count: z.number().int().nullable().describe("null = no comments kon installed"),
});

export const FullEntry = Input.extend({
  author: z.object({ id: z.string(), displayName: z.string(), image: z.string().nullable() }).nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  gameIds: z.array(z.string()).optional(),
  translations: z.array(z.object({ locale: z.string(), slug: z.string(), title: z.string() })).optional(),
  blocksHtml: z.string().optional(),
  interactiveBlocks: z.array(z.unknown()).optional(),
  comments: Thread,
}).passthrough();

export const EntriesList = z.object({
  docs: z.array(
    Input.extend({
      categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
      gameIds: z.array(z.string()),
      tagIds: z.array(z.string()),
      comments: Thread,
    }).passthrough()
  ),
  totalDocs: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  hasNextPage: z.boolean(),
  hasPrevPage: z.boolean(),
});

export const Category = z
  .object({
    id: z.guid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    parentId: z.guid().nullable(),
    displayOrder: z.number().int().nullable(),
  })
  .passthrough();

export const CategoryList = z
  .object({ docs: z.array(Category.extend({ postCount: z.number().int() }).passthrough()) })
  .passthrough();

export const Generic = z.record(z.string(), z.unknown()).describe("Result object (see the description)");
