/**
 * Blog Content Target
 *
 * Implements ContentTarget for kon-blog.
 * Lets any other kon promote content to the Blog.
 */

import type { ContentTarget, PromotionData, PublishResult, KonContext } from "@kitsuden/shared";
import { eq, sql, and } from "drizzle-orm";

import {
  generateSlug,
  renderTemplate,
  generateExcerpt,
  estimateReadingTime,
} from "./content-utils";
import { blogPosts, blogPostsToTags, blogPostsToGames } from "./schema";

/**
 * Content Target for Blog
 */
export const blogContentTarget: ContentTarget = {
  id: "blog",
  name: "Blog Posts",
  konId: "kon-blog",
  capabilities: {
    supportsSeo: true,
    supportsScheduling: true,
    supportsEditorial: true, // draft → published → archived
    supportsTaxonomy: true, // tags
    supportsMedia: true, // featured images
  },

  /**
   * Publish content to the Blog
   */
  async publish(data: PromotionData, ctx: KonContext): Promise<PublishResult> {
    const { db, logger } = ctx;
    const { source, options } = data;

    if (!source?.data) {
      throw new Error("Promotion data must include source.data");
    }

    // 1. Generate title
    const title = options.title
      ? renderTemplate(options.title, source.data)
      : source.data.title || source.data.name || `Content from ${source.type}`;

    // 2. Generate unique slug
    // The incoming slug is normalized the same way as the one derived from the title: one with
    // `/`, spaces or capitals is not a valid `/blog/<slug>` address.
    const baseSlug = generateSlug(options.slug || "") || generateSlug(title) || "post";
    const slug = await generateUniqueSlug(db.instance, baseSlug);

    // 3. Generate excerpt and reading time
    const excerpt = generateExcerpt(source.data);
    const readingTime = estimateReadingTime(excerpt);

    // 4. Determine status and dates
    const status = options.autoPublish ? "published" : options.scheduledAt ? "scheduled" : "draft";

    const publishedAt = options.autoPublish ? new Date() : options.scheduledAt || null;

    // 5. Build source snapshot
    const snapshot = {
      title: source.data.title || source.data.name || "Untitled",
      rawData: source.data,
      capturedAt: new Date().toISOString(),
    };

    // 6. Build basic Lexical content
    const content = buildLexicalContent(excerpt);

    // 7. Create the post
    const [post] = await db.instance
      .insert(blogPosts)
      .values({
        title,
        slug,
        content,
        excerpt,
        status,
        publishedAt,
        authorId: options.authorId,
        readingTime,
        source: {
          type: source.type,
          konId: source.konId,
          table: source.table,
          recordId: source.recordId,
          snapshot,
        },
        seoOverrides: {},
        blocks: [],
      })
      .returning();

    // 8. Handle relations if they come in targetConfig
    const targetConfig = options.targetConfig || {};

    if (targetConfig.tagIds?.length) {
      await db.instance.insert(blogPostsToTags).values(
        targetConfig.tagIds.map((tagId: string) => ({
          postId: post.id,
          tagId,
        }))
      );
    }

    if (targetConfig.gameIds?.length) {
      await db.instance.insert(blogPostsToGames).values(
        targetConfig.gameIds.map((gameId: string) => ({
          postId: post.id,
          gameId,
        }))
      );
    }

    logger.info("Content promoted to Blog", {
      postId: post.id,
      slug: post.slug,
      sourceType: source.type,
      sourceId: source.recordId,
    });

    return {
      contentId: post.id,
      targetId: "blog",
      slug: post.slug,
      url: `/blog/${post.slug}`,
      status: post.status,
      createdAt: new Date(),
    };
  },

  /**
   * Get the public URL of a post
   */
  getPublishedUrl(result: PublishResult): string {
    return `/blog/${result.slug}`;
  },

  /**
   * Unpublish (archive) a post
   */
  async unpublish(contentId: string, ctx: KonContext): Promise<void> {
    const { db, logger } = ctx;

    await db.instance
      .update(blogPosts)
      .set({
        status: "archived",
        updatedAt: new Date(),
      })
      .where(eq(blogPosts.id, contentId));

    logger.info("Blog post archived", { postId: contentId });
  },

  /**
   * Update an existing post
   */
  async update(
    contentId: string,
    data: Partial<PromotionData>,
    ctx: KonContext
  ): Promise<PublishResult> {
    const { db, logger } = ctx;

    const updates: any = {
      updatedAt: new Date(),
    };

    if (data.options?.title) {
      updates.title = data.options.title;
    }

    if (data.options?.slug) {
      const base = generateSlug(data.options.slug);
      if (base) updates.slug = await generateUniqueSlug(db.instance, base, contentId);
    }

    if (data.source?.data) {
      updates.excerpt = generateExcerpt(data.source.data);
      updates.readingTime = estimateReadingTime(updates.excerpt);
    }

    const [updated] = await db.instance
      .update(blogPosts)
      .set(updates)
      .where(eq(blogPosts.id, contentId))
      .returning();

    if (!updated) {
      throw new Error(`Blog post not found: ${contentId}`);
    }

    logger.info("Blog post updated", { postId: contentId });

    return {
      contentId: updated.id,
      targetId: "blog",
      slug: updated.slug,
      url: `/blog/${updated.slug}`,
      status: updated.status,
      createdAt: updated.createdAt,
    };
  },

  /**
   * Get the status of a post
   */
  async getStatus(
    contentId: string,
    ctx: KonContext
  ): Promise<"draft" | "published" | "scheduled" | "archived"> {
    const { db } = ctx;

    const result = await db.instance
      .select({ status: blogPosts.status })
      .from(blogPosts)
      .where(eq(blogPosts.id, contentId))
      .limit(1);

    if (!result.length) {
      throw new Error(`Blog post not found: ${contentId}`);
    }

    return result[0].status as any;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a unique slug avoiding duplicates
 */
async function generateUniqueSlug(db: any, baseSlug: string, excludeId?: string): Promise<string> {
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    // Build where clause
    const conditions = [eq(blogPosts.slug, slug)];
    if (excludeId) {
      conditions.push(sql`${blogPosts.id} != ${excludeId}`);
    }

    const existing = await db
      .select({ id: blogPosts.id })
      .from(blogPosts)
      .where(and(...conditions))
      .limit(1);

    if (!existing.length) {
      return slug;
    }

    slug = `${baseSlug}-${counter}`;
    counter++;

    // Safety limit
    if (counter > 1000) {
      throw new Error("Could not generate unique slug after 1000 attempts");
    }
  }
}

/**
 * Build basic Lexical content
 */
function buildLexicalContent(text: string): any {
  return {
    root: {
      children: [
        {
          type: "paragraph",
          children: [{ text }],
        },
      ],
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  };
}
