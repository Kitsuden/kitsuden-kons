# WhatsApp, Facebook, LinkedIn Guide - Open Graph

Specific guide to optimize sharing on social networks, especially **WhatsApp**, which has very strict technical requirements.

---

## 📱 WhatsApp - Strict Technical Requirements

WhatsApp is **VERY demanding** with Open Graph images. If you don't meet these requirements, it **will not show the image** in the chat preview.

### ⚠️ Mandatory Requirements

| Requirement          | Value                   | Consequence if it fails                     |
| -------------------- | ----------------------- | ------------------------------------------- |
| **Maximum size**     | **< 300 KB**            | WhatsApp does not load the image            |
| **Ideal dimensions** | **1200 x 630 px**       | Poor quality or incorrect cropping          |
| **Minimum dimensions** | **400 x 400 px**      | Does not show a preview                     |
| **Format**           | **JPG or PNG**          | WebP/GIF do not work in older versions      |
| **URL**              | **Absolute (https://)** | Relative URLs do not work                   |

### 🎯 Dimensions by Platform

```
┌─────────────────────────────────────────────────────────┐
│                    OPEN GRAPH IMAGE                      │
│                                                         │
│   WhatsApp: Crops to square (1:1) on mobile             │
│   Facebook: Respects 1.91:1 (1200x630)                  │
│   LinkedIn: Similar to Facebook                         │
│   Twitter: Uses Twitter Cards (2:1)                     │
│                                                         │
│   ✅ Safe zone for text/logo: Center of the image       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Aspect Ratio:**

- **1.91:1** (1200x630) - Ideal for Facebook/LinkedIn
- **1:1** (square) - WhatsApp crops to this on mobile
- **2:1** (1200x600) - Large Twitter Card

---

## 🔧 Implementation

### 1. Meta Tag Structure (HTML)

```html
<!-- Open Graph - WhatsApp, Facebook, LinkedIn -->
<meta property="og:type" content="article" />
<meta property="og:title" content="Catchy title for social networks" />
<meta
  property="og:description"
  content="Persuasive 1-2 line summary designed to get clicks on mobile"
/>
<meta property="og:url" content="https://yourdomain.com/blog/my-post" />
<meta property="og:site_name" content="Your Brand Name" />
<meta property="og:locale" content="en_US" />

<!-- OG Image - CRITICAL for WhatsApp -->
<meta property="og:image" content="https://yourdomain.com/og-image.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Image description" />
<meta property="og:image:type" content="image/jpeg" />

<!-- Article specific -->
<meta property="article:published_time" content="2024-01-15T10:00:00Z" />
<meta property="article:modified_time" content="2024-01-15T12:00:00Z" />
<meta property="article:author" content="Author Name" />
<meta property="article:section" content="Technology" />
<meta property="article:tag" content="SEO" />
<meta property="article:tag" content="Marketing" />

<!-- Twitter Cards -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@youraccount" />
<meta name="twitter:creator" content="@author" />
<meta name="twitter:title" content="Post title" />
<meta name="twitter:description" content="Description for Twitter" />
<meta name="twitter:image" content="https://yourdomain.com/twitter-image.jpg" />
<meta name="twitter:image:alt" content="Image description" />
```

---

## 📡 API Endpoints

### Validate Image for WhatsApp

Staff only (policy action `useTools`). The fields other than `imageUrl` are optional; without
`width`/`height` or `fileSize` the answer warns that they are unknown.

```bash
POST /api/blog/validate-image
Content-Type: application/json

{
  "imageUrl": "https://example.com/my-image.jpg",
  "width": 1200,
  "height": 630,
  "fileSize": 250000,
  "mimeType": "image/jpeg"
}
```

**Response:**

```json
{
  "valid": true,
  "whatsAppCompatible": true,
  "checks": {
    "format": true,
    "fileSize": true,
    "dimensions": true,
    "minDimensions": true,
    "isAbsoluteUrl": true
  },
  "warnings": [],
  "recommendations": [],
  "metadata": {
    "format": "image/jpeg",
    "fileSizeKB": 244.1,
    "width": 1200,
    "height": 630,
    "aspectRatio": 1.91
  },
  "requirements": {
    "maxFileSize": "300KB",
    "idealDimensions": "1200x630px (1.91:1 ratio)",
    "minDimensions": "400x400px",
    "formats": ["JPG", "PNG"],
    "avoid": ["WebP", "GIF", "SVG"]
  }
}
```

### Get Full SEO (includes WhatsApp validation)

```bash
GET /api/blog/seo/my-post-slug?siteName=My%20Blog&baseUrl=https://example.com
```

The OG image is a media item: `seoOverrides.og.imageId`, else the post's `ogImageId`, else its
`featuredImageId`, turned into `<baseUrl>/api/media/transform/<id>?w=1200&h=630&fit=cover&f=jpeg&q=90`
(with the focal point when set). This route derives `og:locale` from the post's `locale` (`es` → `es_ES`, `pt` → `pt_BR`), else `?language=`, else `en_US`.

**Response (social section):**

```json
{
  "social": {
    "openGraph": {
      "title": "SEO Guide 2024",
      "description": "Learn the best techniques...",
      "image": {
        "url": "https://example.com/image.jpg",
        "alt": "SEO guide",
        "width": 1200,
        "height": 630,
        "type": "image/jpeg",
        "isWhatsAppCompatible": true
      },
      "url": "https://example.com/blog/seo-guide-2024",
      "type": "article",
      "whatsAppReady": true,
      "whatsAppWarnings": [],
      "whatsAppRecommendations": []
    },
    "twitterCard": {
      "card": "summary_large_image",
      "title": "SEO Guide 2024",
      "description": "Learn the best techniques...",
      "image": "https://example.com/image.jpg"
    }
  }
}
```

---

## 🖼️ Image Optimization

### Recommended Workflow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Upload         │────▶│  Convert to      │────▶│  Compress to    │
│  original image │     │  JPG/PNG         │     │  < 300KB        │
│  (any           │     │  (avoid WebP)    │     │  (TinyPNG,      │
│   format)       │     │                  │     │   Squoosh)      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Verify in      │◀────│  Upload to CDN/  │◀────│  Resize         │
│  WhatsApp       │     │  server          │     │  to 1200x630px  │
│  Debugger       │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Recommended Tools

| Tool            | Use                         | URL                 |
| --------------- | --------------------------- | ------------------- |
| **Squoosh**     | Compression + resizing      | https://squoosh.app |
| **TinyPNG**     | Smart compression           | https://tinypng.com |
| **ImageMagick** | Batch processing            | CLI tool            |
| **Sharp**       | Node.js processing          | npm install sharp   |

### Example: Optimization with Sharp (Node.js)

```javascript
const sharp = require("sharp");

async function optimizeForWhatsApp(inputPath, outputPath) {
  await sharp(inputPath)
    // Resize to 1200x630 (smart crop)
    .resize(1200, 630, {
      fit: "cover",
      position: "center",
    })
    // Convert to JPEG with optimized quality
    .jpeg({
      quality: 85,
      progressive: true,
      mozjpeg: true, // Better compression
    })
    .toFile(outputPath);

  // Check size
  const stats = await fs.stat(outputPath);
  const sizeKB = stats.size / 1024;

  if (sizeKB > 300) {
    console.warn(`⚠️ Image ${sizeKB.toFixed(1)}KB exceeds the WhatsApp limit (300KB)`);
    // Recompress with lower quality
  }

  return {
    path: outputPath,
    sizeKB,
    dimensions: { width: 1200, height: 630 },
    whatsAppCompatible: sizeKB <= 300,
  };
}
```

---

## 🔍 Testing and Debugging

### WhatsApp Link Debugger

WhatsApp **does not have** an official debug tool, but you can use:

1. **Facebook Sharing Debugger**
   - URL: https://developers.facebook.com/tools/debug/
   - Scrapes OG tags the same way WhatsApp does
   - Shows useful warnings

2. **LinkedIn Post Inspector**
   - URL: https://www.linkedin.com/post-inspector/
   - Verifies OG tags

3. **Twitter Card Validator**
   - URL: https://cards-dev.twitter.com/validator
   - Specific to Twitter

### Testing Process on WhatsApp

```
1. Publish a post with an OG image
2. Copy the post URL
3. Send the URL to "My chat" in WhatsApp
4. Verify that the following appear:
   ✓ Title
   ✓ Description
   ✓ Image (critical)
   ✓ Domain URL
```

**If the image does not appear:**

1. Verify size < 300KB
2. Verify JPG/PNG format
3. Verify absolute URL (https://)
4. Verify minimum dimensions 400x400
5. Clear the WhatsApp cache (or wait 24h)

---

## 📊 Implementation Checklist

### Backend (API)

- [ ] Endpoint `/api/blog/seo/:slug` returns complete OG tags
- [ ] Endpoint `/api/blog/validate-image` checks WhatsApp requirements
- [ ] File size validation (< 300KB)
- [ ] Format validation (JPG/PNG)
- [ ] Dimension validation (1200x630 ideal)
- [ ] Conversion of relative URLs to absolute
- [ ] `og:image:width` and `og:image:height` fields included

### Frontend (HTML Head)

- [ ] `<meta property="og:type" content="article">`
- [ ] `<meta property="og:title">` present
- [ ] `<meta property="og:description">` present
- [ ] `<meta property="og:url">` absolute
- [ ] `<meta property="og:image">` absolute
- [ ] `<meta property="og:image:width">` = 1200
- [ ] `<meta property="og:image:height">` = 630
- [ ] `<meta property="og:image:type">` = image/jpeg
- [ ] `<meta name="twitter:card" content="summary_large_image">`
- [ ] `<meta name="twitter:image">` present

### CMS/Editor

- [ ] Image upload with automatic conversion to JPG
- [ ] Automatic resizing to 1200x630
- [ ] Automatic compression to < 300KB
- [ ] Preview of how it will look on WhatsApp
- [ ] Warning if the image does not meet requirements

---

## 🚨 Common Errors and Solutions

### Error: "Image does not appear on WhatsApp"

**Possible causes:**

1. ❌ File > 300KB
2. ❌ WebP/GIF/SVG format
3. ❌ Relative URL (/images/photo.jpg)
4. ❌ Dimensions < 400x400
5. ❌ Image blocked by robots.txt
6. ❌ Invalid HTTPS (expired certificate)

**Solution:**

```javascript
// Verify before saving
const validation = validateWhatsAppImage(imageUrl, {
  width: image.width,
  height: image.height,
  fileSizeBytes: image.size,
  mimeType: image.mimeType,
});

if (!validation.isValid) {
  console.error("WhatsApp validation failed:", validation.warnings);
  // Show error to the user
}
```

### Error: "Blurry image on WhatsApp"

**Cause:** WhatsApp cropped a small image

**Solution:** Use minimum dimensions of 1200x630

### Error: "Wrong description on WhatsApp"

**Cause:** WhatsApp cached an earlier version

**Solution:**

1. Add a unique parameter to the URL: `?v=2`
2. Wait 24 hours for the cache to expire
3. Use Facebook Debugger to refresh

---

## 📝 Full Example

### Input: Post with Image

```javascript
const post = {
  title: "10 SEO Strategies for 2024",
  slug: "seo-strategies-2024",
  excerpt: "Discover the most effective techniques to rank your website this year.",
  content: "<p>HTML body, or a JSON document</p>",
  featuredImageId: "image-uuid",
  status: "published",
  publishedAt: "2024-01-15T10:00:00Z",
  seoOverrides: {
    og: {
      title: "🚀 10 SEO Strategies That Work in 2024",
      description:
        "An analysis of 500+ success stories. Apply these tactics and grow your organic traffic.",
      imageId: "og-image-uuid", // a media item; see the note below
    },
    twitter: {
      card: "summary_large_image",
      title: "10 SEO Strategies for 2024 🧵",
    },
  },
};

const featuredImage = {
  url: "https://cdn.example.com/og/seo-2024.jpg",
  width: 1200,
  height: 630,
  mimeType: "image/jpeg",
  fileSize: 245000, // 245KB
  alt: "SEO strategies 2024",
};

const siteConfig = {
  name: "Digital Marketing Pro",
  baseUrl: "https://digitalmarketing.pro",
  defaultLanguage: "en_US",
  twitterHandle: "@marketingpro",
  defaultOgImage: "https://digitalmarketing.pro/og-default.jpg",
};
```

These are the inputs of `generateSEOMetadata({ post, featuredImage, siteConfig })`, exported by the
kon. `GET /api/blog/seo/:slug` calls the same function with only `name`, `baseUrl` and
`defaultLanguage` (from the post's locale) in `siteConfig`, so `twitter:site` only appears when
you call it yourself.

Note: `seoOverrides.og.image` (a URL) is deprecated, and the current code passes it to the
media transform URL as if it were a media id, which yields a broken image URL. Use
`seoOverrides.og.imageId`.

### Output: Generated Meta Tags

```html
<!-- Google / Bing -->
<title>10 SEO Strategies for 2024 | Digital Marketing Pro</title>
<meta
  name="description"
  content="Discover the most effective techniques to rank your website this year."
/>

<!-- Open Graph - WhatsApp, Facebook, LinkedIn -->
<meta property="og:type" content="article" />
<meta property="og:title" content="🚀 10 SEO Strategies That Work in 2024" />
<meta
  property="og:description"
  content="An analysis of 500+ success stories. Apply these tactics and grow your organic traffic."
/>
<meta property="og:url" content="https://digitalmarketing.pro/blog/seo-strategies-2024" />
<meta property="og:site_name" content="Digital Marketing Pro" />
<meta property="og:locale" content="en_US" />
<meta property="og:image" content="https://digitalmarketing.pro/api/media/transform/og-image-uuid?w=1200&h=630&fit=cover&f=jpeg&q=90" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="SEO strategies 2024" />
<meta property="og:image:type" content="image/jpeg" />
<meta property="article:published_time" content="2024-01-15T10:00:00Z" />

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@marketingpro" />
<meta name="twitter:title" content="10 SEO Strategies for 2024 🧵" />
<meta
  name="twitter:description"
  content="An analysis of 500+ success stories. Apply these tactics and grow your organic traffic."
/>
<meta name="twitter:image" content="https://cdn.example.com/og/seo-2024.jpg" />

<!-- JSON-LD Schema.org -->
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": "10 SEO Strategies for 2024",
    "description": "Discover the most effective techniques...",
    "image": {
      "@type": "ImageObject",
      "url": "https://cdn.example.com/og/seo-2024.jpg",
      "width": 1200,
      "height": 630
    }
  }
</script>
```

---

## 🎓 Best Practices

### 1. OG Image Design

```
┌────────────────────────────────────────┐
│      SAFE ZONE (Center)                │
│    ┌────────────────────────┐          │
│    │                        │          │
│    │   TITLE / LOGO         │          │
│    │   (Keep it here)       │          │
│    │                        │          │
│    └────────────────────────┘          │
│                                        │
│  Edges may be cropped                  │
│  on certain platforms                  │
└────────────────────────────────────────┘
```

### 2. Text in Images

- ✅ Keep text in the **central 80%** of the image
- ✅ Use **large fonts** (minimum 60px for titles)
- ✅ High contrast (dark background + light text)
- ❌ Don't rely on small text at the edges
- ❌ Don't use text that reaches the edges

### 3. OG Description Content

```
❌ Bad (generic):
"Read this article about SEO on our blog"

✅ Good (specific + implicit CTA):
"Discover 10 proven SEO tactics that grew organic traffic for 500+ companies in 2024."
```

---

## 📚 References

- [Open Graph Protocol](https://ogp.me/)
- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/)
- [WhatsApp FAQ - Link Previews](https://faq.whatsapp.com/general/chats/about-links-in-chats/)
- [Twitter Cards Documentation](https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/abouts-cards)
- [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/)

---

**Applies to:** kon-blog 2.0.2
