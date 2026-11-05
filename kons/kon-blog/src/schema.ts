/**
 * Kon Blog — Database Schema
 *
 * Re-exports from schema.local.ts for backward compatibility.
 * All schema definitions are in schema.local.ts
 */

export {
  blogPosts,
  blogPostsToTags,
  blogPostsToGames,
  blogCategories,
  blogPostsToCategories,
  blogStatusValues,
  blogStatusEnum,
  blogPostsRelations,
  blogPostsToTagsRelations,
  blogPostsToGamesRelations,
  blogCategoriesRelations,
  blogPostsToCategoriesRelations,
  type BlogPostStatus,
  type FAQItem,
  type FAQPageSchema,
  type ArticleSchema,
  type TOCItem,
  type ValidationResult,
  type FocalPoint,
} from "./schema.local";

export type {
  BlogPost,
  NewBlogPost,
  BlogPostToTag,
  BlogPostToGame,
  BlogCategory,
  NewBlogCategory,
  BlogPostToCategory,
  BlogPostSEOOverrides,
  BlogPostSource,
  BlogPostWithRelations,
  BlogPostAPIPayload,
} from "./schema.local";
