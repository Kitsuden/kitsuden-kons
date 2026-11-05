# Guide: Social Media Preview

How to show a social preview of a post in the blog editor.

The `SocialPreview` component is part of the Kitsuden admin panel (the core repository), not of
this kon. kon-blog provides the data it reads: `GET /api/blog/seo/:slug`,
`POST /api/blog/validate-image`, `POST /api/blog/validate-seo` and
`POST /api/blog/:slug/refresh-og-cache`.

---

## 📸 Preview

The `SocialPreview` component shows how your post will look when shared on:

| Platform      | Preview Includes                                  |
| ------------- | ------------------------------------------------- |
| **WhatsApp**  | Chat with preview bubble, image validation        |
| **Telegram**  | Chat with link card, compatibility info           |
| **Facebook**  | Link card with image, title, description          |
| **Twitter/X** | Tweet with preview card                           |
| **LinkedIn**  | Post with featured image                          |

### Special Features

| Feature                 | Description                                  |
| ----------------------- | -------------------------------------------- |
| **A/B Comparison**      | Compares two versions of OG tags side by side |
| **Export Image**        | Saves the preview as PNG                     |
| **WhatsApp Validation** | Checks <300KB, dimensions, format            |
| **Debug Panel**         | Detailed SEO metrics                         |

---

## 🚀 Where it lives

### 1. Components (Kitsuden core admin)

```bash
packages/admin/src/lib/components/blog/SocialPreview.svelte
packages/admin/src/lib/components/blog/SocialPreviewExample.svelte
packages/admin/src/lib/components/blog/SocialPreviewABExample.svelte
```

### 2. Use in your Editor

```svelte
<script>
  import SocialPreview from "$lib/components/blog/SocialPreview.svelte";

  let post = {
    title: "My Post",
    slug: "my-post",
    excerpt: "Post description...",
    featuredImage: { url: "https://..." },
  };

  let seoData = $state(null);
  let showPreview = $state(false);

  async function loadPreview() {
    const res = await fetch(`/api/blog/seo/${post.slug}?preview=true`);
    const data = await res.json();
    seoData = data.seo;
    showPreview = true;
  }
</script>

<button on:click={loadPreview}> 👁️ View Social Preview </button>

{#if showPreview}
  <SocialPreview
    {seoData}
    postTitle={post.title}
    postUrl={`https://mysite.com/blog/${post.slug}`}
    postSlug={post.slug}
  />
{/if}
```

---

## 📖 Component API

### Props

| Prop        | Type     | Required | Description                              |
| ----------- | -------- | -------- | ---------------------------------------- |
| `seoData`   | `object` | ✅       | Data from the `/api/blog/seo/:slug` endpoint |
| `postTitle` | `string` | ❌       | Fallback title                           |
| `postUrl`   | `string` | ❌       | URL to display                           |
| `postSlug`  | `string` | ❌       | Slug to refresh data                     |
| `comparisonMode`, `variantA`, `variantB`, `labelA`, `labelB` | | ❌ | A/B comparison (see below) |

### seoData Structure

```typescript
{
  title: "SEO Title",
  metaDescription: "Description...",
  canonicalUrl: "https://...",
  openGraph: {
    title: "OG Title",
    description: "OG Description",
    image: {
      url: "https://...",
      width: 1200,
      height: 630,
      isWhatsAppCompatible: true
    }
  },
  twitterCard: {
    card: "summary_large_image",
    title: "Twitter Title",
    image: "https://..."
  },
  whatsAppValidation: {
    isValid: true,
    checks: { format: true, fileSize: true, dimensions: true, isAbsoluteUrl: true },
    warnings: [],
    recommendations: []
  }
}
```

`GET /api/blog/seo/:slug` returns this object as `seo`, but without `whatsAppValidation`: the route
puts the WhatsApp result in `social.openGraph` (`whatsAppReady`, `whatsAppWarnings`,
`whatsAppRecommendations`). To fill `whatsAppValidation`, call `POST /api/blog/validate-image` and
map its `valid`, `checks`, `warnings` and `recommendations`.

---

## 🎨 Customization

### Change Colors

The component defines no CSS variables for its colors. Override its classes instead (see
[CSS Styles](#-css-styles)).

### Tabs

The component has five fixed tabs: WhatsApp, Telegram, Facebook, Twitter/X and LinkedIn. There is
no prop to hide one.

---

## 🔌 Related API Endpoints

### Get SEO data

```bash
GET /api/blog/seo/:slug?preview=true&siteName=My%20Blog&baseUrl=https://example.com
```

`preview=true` works only with a staff session; anyone else gets 404 for an unpublished post.

### Validate image for WhatsApp

```bash
POST /api/blog/validate-image
{
  "imageUrl": "https://example.com/image.jpg",
  "width": 1200,
  "height": 630,
  "fileSize": 250000,
  "mimeType": "image/jpeg"
}
```

### Refresh Facebook cache

```bash
POST /api/blog/:slug/refresh-og-cache?baseUrl=https://example.com
```

Staff only. It asks the Facebook Graph API to re-scrape `<baseUrl>/blog/<slug>` (`baseUrl`
defaults to the API's own origin) and returns Facebook's status and a link to its debugger. It is
not exposed as an MCP tool.

---

## 📱 Examples by Platform

### Telegram

```svelte
<SocialPreview {seoData} />
<!-- Select the "Telegram" tab -->
```

**The Telegram preview includes:**

- Telegram-style chat with header
- Link preview with image
- Info panel about differences with WhatsApp

**Note:** Telegram is more permissive than WhatsApp:

- ✅ Accepts WebP without problems
- ✅ Has no strict 300KB limit
- ✅ Supports high-resolution images
- ⚠️ Following WhatsApp standards is recommended for maximum compatibility

### WhatsApp

```svelte
<!-- Visual WhatsApp validation -->
<SocialPreview {seoData} />

<!-- Shows:
  - WhatsApp chat with realistic preview
  - Validation: ✓ Format | ✓ Size | ✓ Dimensions
  - Warnings if the image is > 300KB
  - Recommendations to fix problems
-->
```

### Facebook

```svelte
<!-- Facebook card preview -->
<!-- Shows 1200x630 image, title, description -->

<!-- Button to open Facebook Debugger -->
```

### Twitter/X

```svelte
<!-- Tweet preview with card -->
<!-- Shows: avatar, name, tweet text, card -->
```

---

## 🔄 Full Usage Flow

```
┌─────────────────────────────────────────────────────────┐
│  BLOG EDITOR                                             │
│                                                          │
│  Title: [My Blog Post              ]                    │
│  Description: [Short description... ]                   │
│  Image: [selected-image.jpg        ] [Change]           │
│                                                          │
│  [💾 Save] [👁️ View Social Preview]                     │
│                                                          │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼ click
┌─────────────────────────────────────────────────────────┐
│  SOCIAL PREVIEW                                          │
│                                                          │
│  [WhatsApp] [Facebook] [Twitter] [LinkedIn]             │
│                                                          │
│  ┌─────────────────────────────────────────┐            │
│  │  📱 WhatsApp Preview                   │            │
│  │                                         │            │
│  │  ┌──────────────────────────┐          │            │
│  │  │ [IMAGE 1200x630]         │          │            │
│  │  │                          │          │            │
│  │  │ My Blog Post             │          │            │
│  │  │ Short description...     │          │            │
│  │  │ example.com              │          │            │
│  │  └──────────────────────────┘          │            │
│  │                              ✓✓ 14:30  │            │
│  │                                         │            │
│  │  ✅ WhatsApp compatible                 │            │
│  │  ✓ Format ✓ Size ✓ Dimensions          │            │
│  │                                         │            │
│  └─────────────────────────────────────────┘            │
│                                                          │
│  [📋 Copy URL] [🔄 Refresh] [⚙️ Debug]                  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 🐛 Debug Mode

Click the `⚙️` icon to see:

- Title length (target: 50-60 chars)
- Description length (target: 150-160 chars)
- OG image dimensions
- WhatsApp validation status
- Canonical URL

---

## 🎯 Use Cases

### 1. Real-Time Preview

```svelte
<script>
  // Update the preview automatically while typing
  let debounceTimer;

  function handleInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      refreshPreview();
    }, 1000);
  }
</script>

<input bind:value={post.title} on:input={handleInput} />
```

### 2. Validation Before Publishing

```svelte
<script>
  async function publishPost() {
    // First validate SEO
    const validation = await fetch("/api/blog/validate-seo", {
      method: "POST",
      body: JSON.stringify({
        title: post.title,
        metaDescription: post.excerpt,
        imageUrl: post.featuredImage?.url,
      }),
    }).then((r) => r.json());

    if (!validation.valid) {
      alert("Fix the SEO problems before publishing:\n" + validation.warnings.join("\n"));
      return;
    }

    // Publish...
  }
</script>
```

### 3. A/B Comparison Mode

Compares two different versions of OG tags:

```svelte
<script>
  const variantA = {
    title: "Title with Emoji 🚀",
    openGraph: { title: "...", image: { url: "img-a.jpg" } },
    whatsAppValidation: { isValid: true, warnings: [] },
  };

  const variantB = {
    title: "Descriptive Title",
    openGraph: { title: "...", image: { url: "img-b.jpg" } },
    whatsAppValidation: { isValid: false, warnings: ["Image > 300KB"] },
  };
</script>

<SocialPreview
  comparisonMode={true}
  {variantA}
  {variantB}
  labelA="Emoji Version"
  labelB="Formal Version"
/>
```

**Shows:**

- Toggle to switch between A and B
- Badge with number of issues per variant
- Winner highlighted in the debug panel

### 4. Export as Image

Saves the current preview as PNG:

```svelte
<!-- The 📷 button is built into the header -->
<SocialPreview {seoData} />

<!-- On click, it downloads: social-preview-whatsapp-2024-01-15.png -->
```

### 5. Refresh Cache After Publishing

```svelte
<script>
  async function publishAndRefresh() {
    // 1. Publish post
    await publishPost();

    // 2. Refresh Facebook cache
    await fetch(`/api/blog/${post.slug}/refresh-og-cache`, {
      method: "POST",
    });

    // 3. Show message
    alert("Post published. The Facebook cache will update in a few minutes.");
  }
</script>
```

---

## 🎨 CSS Styles

The component uses CSS classes that you can override:

```css
/* Main container */
.social-preview-container {
}

/* Header with gradient */
.preview-header {
}

/* Navigation tabs */
.preview-tabs {
}
.tab {
}
.tab.active {
}

/* Specific previews */
.whatsapp-preview {
}
.facebook-preview {
}
.twitter-preview {
}
.linkedin-preview {
}

/* Validation panel */
.validation-panel {
}
.validation-panel.valid {
}

/* Debug panel */
.debug-panel {
}
```

---

## 🔗 Facebook Debugger Integration

Each preview has a button to open the official tool:

```
[Open Facebook Debugger] → https://developers.facebook.com/tools/debug/
[Open Twitter Validator] → https://cards-dev.twitter.com/validator
[Open LinkedIn Inspector] → https://www.linkedin.com/post-inspector/
```

---

## ⚠️ Troubleshooting

### "Image does not appear on WhatsApp"

```
1. Check the validation in the WhatsApp panel
2. Verify that the image is < 300KB
3. Verify JPG/PNG format (NOT WebP)
4. Verify absolute URL (https://)
5. Use Facebook Debugger to force a rescrape
```

### "Preview does not update"

```
1. Click the 🔄 Refresh button
2. Verify that the post has a slug
3. Check the browser console (F12)
4. Verify that the /api/blog/seo/:slug endpoint responds
```

### "Outdated SEO data"

```svelte
<!-- Force reload with timestamp -->
<script>
  async function refresh() {
    const res = await fetch(`/api/blog/seo/${slug}?t=${Date.now()}`);
    seoData = (await res.json()).seo;
  }
</script>
```

---

## 📦 Dependencies

- `lucide-svelte` for the icons (a dependency of the admin panel).
- `html2canvas` for **Export Image**: imported dynamically when the button is pressed. The admin
  panel does not list it as a dependency, so export fails until it is installed.

---

## 🤝 Contributing

To add new platforms:

1. Create a new tab in `.preview-tabs`
2. Create a preview component (e.g. `.telegram-preview`)
3. Add specific validations
4. Update this documentation

---

**Applies to:** kon-blog 2.0.1
