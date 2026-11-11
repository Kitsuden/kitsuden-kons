# SEO Guide for Kon Blog

How kon-blog builds SEO metadata (`src/seo-utils.ts`) and what its two SEO routes return.

## 📋 Index

- [Implemented Features](#implemented-features)
- [API Endpoints](#api-endpoints)
- [Basic Usage](#basic-usage)
- [SEO Metadata](#seo-metadata)
- [Validations](#validations)
- [Frontend Integration](#frontend-integration)
- [Examples](#examples)

---

## ✅ Implemented Features

### 1. Basic Meta Tags (Google/Bing)

- ✅ Optimized `<title>` (50-60 characters)
- ✅ Optimized `<meta name="description">` (150-160 characters)
- ✅ `<meta name="robots">` (configurable index/follow)
- ✅ `<meta name="keywords">` (optional)
- ✅ `<link rel="canonical">`

### 2. Open Graph (Facebook, LinkedIn, WhatsApp)

- ✅ `og:title` - Title for sharing
- ✅ `og:description` - Description for sharing
- ✅ `og:url` - Canonical URL
- ✅ `og:type` - Content type (article)
- ✅ `og:image` - Featured image
- ✅ `og:image:width` / `og:image:height` - Dimensions
- ✅ `og:site_name` - Site name
- ✅ `og:locale` - Language (`GET /api/blog/seo/:slug` derives it from the post's `locale`, e.g. `pt` → `pt_BR`; else `?language=`; else `en_US`)
- ✅ `og:article:published_time` - Publication date
- ✅ `og:article:modified_time` - Modification date
- ✅ `og:article:author` - Author
- ✅ `og:article:section` - Category
- ✅ `og:article:tag` - Tags

### 3. Twitter Cards (Twitter/X)

- ✅ `twitter:card` - Card type (summary_large_image)
- ✅ `twitter:site` - Site handle
- ✅ `twitter:creator` - Author handle
- ✅ `twitter:title` - Title
- ✅ `twitter:description` - Description
- ✅ `twitter:image` - Image
- ✅ `twitter:image:alt` - Alternative text

### 4. JSON-LD Schema.org (Rich Snippets)

- ✅ **BlogPosting** - Main type for posts
- ✅ **Article** - Alternative for articles
- ✅ **NewsArticle** - For time-sensitive news
- ✅ **BreadcrumbList** - Breadcrumbs
- ✅ **Blog** - For the site/blog
- ✅ **Person** - For the author
- ✅ **Organization** - For the publisher

> **What the route fills.** `generateSEOMetadata()` accepts an author, tags, categories, a Twitter
> handle and a publisher, but `GET /api/blog/seo/:slug` passes none of them: it calls it with the
> post, `siteName`, `baseUrl` and the post's language. So the route's output has no
> `og:article:author`, no `og:article:tag`, no `twitter:site` / `twitter:creator`, and
> `og:article:section` only when `seoOverrides.schema.articleSection` is set. Call
> `generateSEOMetadata()` yourself (it is exported by the kon) to get the full set.

### 5. SEO Validations

- ✅ Title length (50-60 characters)
- ✅ Description length (150-160 characters)
- ✅ Keyword in title
- ✅ Keyword in description
- ✅ SEO score (0-100)
- ✅ Specific warnings

---

## 🔌 API Endpoints

### GET `/api/blog/seo/:slug`

Gets all SEO metadata for a published post. Optional query: `siteName` (default `Kitsuden CMS`),
`baseUrl` (default: the API's own origin).

```bash
# Basic
GET /api/blog/seo/my-example-post

# With site parameters
GET /api/blog/seo/my-example-post?siteName=My%20Blog&baseUrl=https://example.com

# Preview of unpublished posts (staff session only; anyone else gets 404)
GET /api/blog/seo/my-example-post?preview=true
```

**Response:**

```json
{
  "success": true,
  "post": {
    "id": "uuid",
    "title": "Post Title",
    "slug": "my-example-post",
    "status": "published",
    "publishedAt": "2024-01-15T10:00:00Z"
  },
  "seo": {
    "title": "Post Title | My Blog",
    "metaDescription": "Optimized 150-160 character description of the post...",
    "canonicalUrl": "https://example.com/blog/my-example-post",
    "robots": "index,follow",
    "keywords": "tag1, tag2, tag3",
    "openGraph": {
      "title": "Post Title",
      "description": "Optimized description...",
      "url": "https://example.com/blog/my-example-post",
      "type": "article",
      "siteName": "My Blog",
      "locale": "en_US",
      "image": {
        "url": "https://example.com/image.jpg",
        "alt": "Image description",
        "width": 1200,
        "height": 630
      },
      "article": {
        "publishedTime": "2024-01-15T10:00:00Z",
        "modifiedTime": "2024-01-15T12:00:00Z"
      }
    },
    "twitterCard": {
      "card": "summary_large_image",
      "title": "Post Title",
      "description": "Optimized description...",
      "image": "https://example.com/image.jpg"
    },
    "jsonLd": [
      {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": "Post Title",
        "description": "Description...",
        "url": "https://example.com/blog/my-example-post",
        "datePublished": "2024-01-15T10:00:00Z",
        "image": {
          "@type": "ImageObject",
          "url": "https://example.com/image.jpg"
        }
      },
      { "@type": "BreadcrumbList", ... },
      { "@type": "Blog", ... }
    ],
    "readingTime": 5,
    "wordCount": 850,
    "score": 92,
    "warnings": []
  },
  "social": {
    "openGraph": { "title": "...", "description": "...", "image": "...", "url": "...", "type": "article",
                   "whatsAppReady": true, "whatsAppWarnings": [], "whatsAppRecommendations": [] },
    "twitterCard": { "card": "summary_large_image", "title": "...", "description": "...", "image": "..." }
  },
  "html": {
    "title": "<title>Post Title | My Blog</title>",
    "metaTags": [...],
    "canonical": "<link rel=\"canonical\" href=\"...\">",
    "jsonLd": ["<script type=\"application/ld+json\">...</script>"]
  }
}
```

`keywords` is set only when `seoOverrides.keywords` is. The title and description come from
`seoOverrides.metaTitle` / `seoOverrides.metaDescription` or are generated; this route does not read
the `metaTitle` and `metaDescription` columns (the GEO route does).

### POST `/api/blog/validate-seo`

Validates SEO metadata without saving (useful for previews in the editor). Staff only (policy
action `useTools`). Optional image fields: `imageUrl`, `imageWidth`, `imageHeight`,
`imageFileSize`, `imageMimeType`; with `imageUrl` the answer adds a `whatsApp` check.

```bash
POST /api/blog/validate-seo
Content-Type: application/json

{
  "title": "My post title",
  "metaDescription": "My post description...",
  "focusKeyword": "my keyword",
  "content": "Post content..."
}
```

**Response:**

```json
{
  "valid": false,
  "validation": {
    "title": {
      "current": 15,
      "min": 30,
      "optimal": 55,
      "max": 60,
      "isValid": false,
      "isOptimal": false
    },
    "description": {
      "current": 145,
      "min": 50,
      "optimal": 155,
      "max": 160,
      "isValid": true,
      "isOptimal": false
    }
  },
  "warnings": [
    "Title is too short (15 chars). Minimum recommended: 30",
    "Meta description could be longer (145 chars). Optimal: 155-160"
  ],
  "suggestions": [
    "Adjust the title to 55-60 characters",
    "Adjust the description to 155-160 characters"
  ],
  "whatsApp": null
}
```

---

## 🛠️ Basic Usage

### In the Frontend (SvelteKit)

```svelte
<!-- +page.svelte -->
<script>
  export let data;

  const { seo } = data;
</script>

<svelte:head>
  <!-- Title -->
  <title>{seo.title}</title>

  <!-- Meta Description -->
  <meta name="description" content={seo.metaDescription} />

  <!-- Robots -->
  <meta name="robots" content={seo.robots} />

  <!-- Canonical -->
  <link rel="canonical" href={seo.canonicalUrl} />

  <!-- Open Graph -->
  <meta property="og:title" content={seo.openGraph.title} />
  <meta property="og:description" content={seo.openGraph.description} />
  <meta property="og:url" content={seo.openGraph.url} />
  <meta property="og:type" content={seo.openGraph.type} />
  <meta property="og:site_name" content={seo.openGraph.siteName} />
  <meta property="og:locale" content={seo.openGraph.locale} />
  {#if seo.openGraph.image}
    <meta property="og:image" content={seo.openGraph.image.url} />
    <meta property="og:image:width" content={seo.openGraph.image.width} />
    <meta property="og:image:height" content={seo.openGraph.image.height} />
    <meta property="og:image:alt" content={seo.openGraph.image.alt} />
  {/if}

  <!-- Twitter Card -->
  <meta name="twitter:card" content={seo.twitterCard.card} />
  <meta name="twitter:title" content={seo.twitterCard.title} />
  <meta name="twitter:description" content={seo.twitterCard.description} />
  {#if seo.twitterCard.image}
    <meta name="twitter:image" content={seo.twitterCard.image} />
  {/if}

  <!-- JSON-LD -->
  {#each seo.jsonLd as schema}
    <script type="application/ld+json">
      {@html JSON.stringify(schema)}
    </script>
  {/each}
</svelte:head>
```

### In the Frontend ( using the generated HTML )

```svelte
<script>
  export let data;
</script>

<svelte:head>
  {@html data.html.title}
  {#each data.html.metaTags as tag}
    {#if tag.property}
      <meta property={tag.property} content={tag.content} />
    {:else if tag.name}
      <meta name={tag.name} content={tag.content} />
    {/if}
  {/each}
  {@html data.html.canonical}
  {#each data.html.jsonLd as script}
    {@html script}
  {/each}
</svelte:head>
```

---

## 📝 SEO Metadata

### The `seo_overrides` Field in the Database

The `seo_overrides` column (`seoOverrides` in the API) is a JSONB that customizes the SEO
(`SEOOverrides` in `src/seo-utils.ts`):

```json
{
  "metaTitle": "Custom SEO title (max 60 chars)",
  "metaDescription": "Custom description (max 160 chars)",
  "canonicalUrl": "https://other-site.com/canonical-url",
  "robots": "index,follow",
  "focusKeyword": "main keyword",
  "noindex": false,
  "nofollow": false,
  "keywords": "tag1, tag2, tag3, keyword",

  "og": {
    "title": "Title for Facebook",
    "description": "Description for social networks",
    "imageId": "<uuid of a media item>",
    "image": "https://example.com/special-image.jpg",
    "imageAlt": "Image description",
    "type": "article"
  },

  "twitter": {
    "title": "Title for Twitter",
    "description": "Description for Twitter",
    "image": "https://example.com/twitter-image.jpg",
    "card": "summary_large_image"
  },

  "schema": {
    "type": "NewsArticle",
    "articleSection": "Technology"
  },

  "hreflang": [
    { "lang": "en", "url": "https://example.com/en/my-post" },
    { "lang": "es", "url": "https://example.com/es/my-post" }
  ]
}
```

`og.image` (a URL) is deprecated; prefer `og.imageId`. `hreflang` is part of the metadata
`generateSEOMetadata()` returns, but `GET /api/blog/seo/:slug` does not include it in its answer.

### Automatic Generation

If no overrides are specified, the system generates automatically:

| Field          | Source                                  | Length        |
| -------------- | --------------------------------------- | ------------- |
| SEO Title      | `Post Title \| Site Name`               | 50-60 chars   |
| Description    | `excerpt` or content                    | 150-160 chars |
| OG Title       | Post title                              | ≤88 chars     |
| OG Description | SEO description                         | ≤200 chars    |
| Twitter Title  | Post title                              | ≤70 chars     |
| Image          | `ogImageId`, else `featuredImageId`     | -             |

---

## ⚠️ Validations

### Length Limits

| Element        | Minimum | Optimal | Maximum |
| -------------- | ------- | ------- | ------- |
| SEO Title      | 30      | 55-60   | 60      |
| Description    | 50      | 155-160 | 160     |
| OG Title       | -       | -       | 88      |
| OG Description | -       | -       | 200     |
| Twitter Title  | -       | -       | 70      |
| Twitter Desc.  | -       | -       | 200     |

### Common Warnings

- "Title is too short (X chars). Minimum recommended: 30"
- "Title is too long (X chars). Maximum: 60"
- "Title could be longer (X chars). Optimal: 55-60"
- "Meta description is too short..." / "is too long..." / "could be longer..."
- "Focus keyword not found in title"
- "Focus keyword not found in meta description"
- "Focus keyword appears only X times in content"

### SEO Score (0-100)

| Factor              | Weight |
| ------------------- | ------ |
| Start               | 100    |
| Optimal title       | +5     |
| Optimal description | +5     |
| Featured image      | +10    |
| Author defined      | +5     |
| Keywords/tags       | +5     |
| Each warning        | -5     |

The result is clamped to 0-100 (`calculateSEOScore`).

---

## 🔗 Frontend Integration

### Example: Page Load (SvelteKit)

```typescript
// +page.ts
export async function load({ params, fetch }) {
  const slug = params.slug;

  // Get SEO
  const seoRes = await fetch(`/api/blog/seo/${slug}?siteName=My%20Blog`);
  const seoData = await seoRes.json();

  // Get full post
  const postRes = await fetch(`/api/blog/slug/${slug}`);
  const post = await postRes.json();

  return {
    seo: seoData.seo,
    html: seoData.html,
    post,
  };
}
```

### Example: SEO Editor in Admin

```svelte
<script>
  let title = "";
  let description = "";
  let focusKeyword = "";
  let validation = null;

  async function validateSEO() {
    const res = await fetch("/api/blog/validate-seo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        metaDescription: description,
        focusKeyword,
        content: editorContent,
      }),
    });
    validation = await res.json();
  }
</script>

<div class="seo-editor">
  <input bind:value={title} maxlength="60" placeholder="SEO title (50-60 characters)" />

  <span class="char-count" class:warning={title.length > 60}>
    {title.length}/60
  </span>

  <textarea
    bind:value={description}
    maxlength="160"
    placeholder="Description (150-160 characters)"
  />

  <span class="char-count" class:warning={description.length > 160}>
    {description.length}/160
  </span>

  {#if validation}
    <div class="seo-score">
      Score: {validation.valid ? "✅" : "⚠️"}
    </div>

    {#if validation.warnings.length > 0}
      <ul class="warnings">
        {#each validation.warnings as warning}
          <li>{warning}</li>
        {/each}
      </ul>
    {/if}
  {/if}

  <button on:click={validateSEO}>Validate SEO</button>
</div>
```

---

## 📊 Examples

### Example 1: Basic Post

```javascript
// Request
GET /api/blog/seo/complete-seo-guide-2024?siteName=Digital%20Marketing&baseUrl=https://digitalmarketing.com

// Response (simplified)
{
  "seo": {
    "title": "Complete SEO Guide 2024 | Digital Marketing",
    "metaDescription": "Learn the best SEO techniques for 2024. Proven strategies, recommended tools and success stories.",
    "canonicalUrl": "https://digitalmarketing.com/blog/complete-seo-guide-2024",
    "openGraph": {
      "title": "Complete SEO Guide 2024",
      "description": "Learn the best SEO techniques for 2024...",
      "image": { "url": "...", "width": 1200, "height": 630 }
    },
    "twitterCard": {
      "card": "summary_large_image",
      "title": "Complete SEO Guide 2024",
      "description": "Learn the best SEO techniques..."
    },
    "score": 95,
    "warnings": []
  }
}
```

### Example 2: With Custom Overrides

```json
// seo_overrides in DB
{
  "metaTitle": "SEO 2024: The Definitive Guide (55 characters)",
  "metaDescription": "Discover the SEO strategies that work in 2024. An analysis of 100+ success stories. (155 chars)",
  "focusKeyword": "SEO 2024",
  "og": {
    "title": "🚀 SEO 2024: Everything you need to know",
    "image": "https://cdn.example.com/seo-2024-social.jpg"
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "SEO 2024: The Definitive Guide 🧵"
  },
  "schema": {
    "type": "TechArticle",
    "articleSection": "SEO and Marketing"
  }
}
```

### Example 3: Validation Preview

```javascript
// POST /api/blog/validate-seo
{
  "title": "SEO",
  "metaDescription": "A short guide",
  "focusKeyword": "marketing"
}

// Response
{
  "valid": false,
  "validation": {
    "title": { "current": 3, "min": 30, "max": 60, "isValid": false },
    "description": { "current": 13, "min": 50, "max": 160, "isValid": false }
  },
  "warnings": [
    "Title is too short (3 chars). Minimum recommended: 30",
    "Meta description is too short (13 chars). Minimum recommended: 50",
    "Focus keyword \"marketing\" not found in title",
    "Focus keyword \"marketing\" not found in meta description"
  ],
  "suggestions": [
    "Adjust the title to 55-60 characters",
    "Adjust the description to 155-160 characters"
  ]
}
```

---

## 🔧 Recommended Configuration

### Environment Variables

None. kon-blog reads no environment variables for SEO: the routes take the site name and base URL
from the `siteName` and `baseUrl` query parameters.

### Site Configuration

```typescript
// When calling generateSEOMetadata() yourself (the routes only set name, baseUrl
// and defaultLanguage from the post's locale, fallback "en_US")
const siteConfig: SiteSEOConfig = {
  name: "My Blog",
  baseUrl: "https://example.com",
  defaultLanguage: "en_US",
  twitterHandle: "@myblog",
  defaultOgImage: "https://example.com/og-default.jpg",
  publisher: {
    name: "My Company",
    logo: "https://example.com/logo.png",
    url: "https://example.com",
  },
  socialProfiles: {
    twitter: "https://twitter.com/myblog",
    facebook: "https://facebook.com/myblog",
    linkedin: "https://linkedin.com/company/myblog",
  },
};
```

---

## 📚 References

- [Google SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
- [Open Graph Protocol](https://ogp.me/)
- [Twitter Cards](https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/abouts-cards)
- [Schema.org](https://schema.org/)
- [Google Rich Snippets](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data)

---

**Applies to:** kon-blog 2.0.2
