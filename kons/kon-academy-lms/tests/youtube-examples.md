# 🎬 YouTube Integration Examples

This document shows how to integrate YouTube videos into the Academy LMS.

## Supported URL Formats

### 1. Standard YouTube URL

```
https://www.youtube.com/watch?v=VIDEO_ID
```

**Example:**

```
https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

### 2. Short URL (youtu.be)

```
https://youtu.be/VIDEO_ID
```

**Example:**

```
https://youtu.be/dQw4w9WgXcQ
```

### 3. Embed URL

```
https://www.youtube.com/embed/VIDEO_ID
```

**Example:**

```
https://www.youtube.com/embed/dQw4w9WgXcQ
```

### 4. URL with Parameters

```
https://www.youtube.com/watch?v=VIDEO_ID&t=30s
https://www.youtube.com/watch?v=VIDEO_ID&list=PLAYLIST_ID
```

## API Endpoints

### Extract YouTube Information

```http
POST /api/academy/media/youtube-info
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

**Response:**

```json
{
  "valid": true,
  "videoId": "dQw4w9WgXcQ",
  "embedUrl": "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "thumbnailUrl": "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
}
```

### Normalize Video URL

```http
POST /api/academy/media/normalize-video
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

**Response:**

```json
{
  "type": "youtube",
  "url": "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "thumbnailUrl": "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
}
```

## Create a Topic with a YouTube Video

### Full Example

```http
POST /api/academy/topics
Content-Type: application/json
Authorization: Bearer TOKEN

{
  "moduleId": "module_123",
  "title": "Introduction to the Course",
  "content": "In this topic we will cover the fundamentals...",
  "position": 1,
  "videoYoutube": "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "externalVideo": null,
  "videoLocal": null
}
```

### Recommended Flow

1. **Validate the YouTube URL:**

```http
POST /api/academy/media/youtube-info
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

2. **Use the normalized URL in the topic:**

```javascript
const response = await fetch("/api/academy/media/youtube-info", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: userInputUrl }),
});

const { embedUrl, thumbnailUrl } = await response.json();

// Create topic with normalized URL
await fetch("/api/academy/topics", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    moduleId: "mod_123",
    title: "New Topic",
    content: "...",
    videoYoutube: embedUrl,
    // The thumbnail (thumbnailUrl) is for previews; a topic image is an imageId from kon-media
  }),
});
```

## Frontend Implementation Examples

### React Component

```tsx
import { useState } from "react";

function VideoYoutubeInput({ onVideoSelected }) {
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);

  const validateYoutubeUrl = async (inputUrl) => {
    setLoading(true);
    try {
      const response = await fetch("/api/academy/media/youtube-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: inputUrl }),
      });

      const data = await response.json();

      if (data.valid) {
        setInfo(data);
        onVideoSelected(data);
      } else {
        alert("Invalid YouTube URL");
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <input
        type="text"
        placeholder="Paste the YouTube URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button onClick={() => validateYoutubeUrl(url)} disabled={loading}>
        {loading ? "Validating..." : "Validate"}
      </button>

      {info && (
        <div className="video-preview">
          <img src={info.thumbnailUrl} alt="Thumbnail" />
          <p>Video ID: {info.videoId}</p>
          <p>Type: YouTube</p>
        </div>
      )}
    </div>
  );
}
```

### Vue Component

```vue
<template>
  <div>
    <input v-model="url" placeholder="YouTube URL" @blur="validateUrl" />
    <div v-if="info" class="preview">
      <img :src="info.thumbnailUrl" />
      <p>{{ info.videoId }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";

const url = ref("");
const info = ref(null);

const validateUrl = async () => {
  const response = await fetch("/api/academy/media/youtube-info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.value }),
  });

  info.value = await response.json();
};
</script>
```

## Test URLs

### Valid Videos

```
https://www.youtube.com/watch?v=dQw4w9WgXcQ
https://youtu.be/dQw4w9WgXcQ
https://www.youtube.com/embed/dQw4w9WgXcQ
https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s
```

### Invalid Videos (for testing)

```
https://www.google.com
https://www.youtube.com
https://youtu.be/
not-a-url
```

## YouTube Thumbnails

The system automatically extracts the thumbnail URL:

```
https://img.youtube.com/vi/{VIDEO_ID}/maxresdefault.jpg
```

Available resolutions:

- `maxresdefault.jpg` - Maximum resolution (1280x720)
- `sddefault.jpg` - Standard resolution (640x480)
- `hqdefault.jpg` - High quality (480x360)
- `mqdefault.jpg` - Medium quality (320x180)
- `default.jpg` - Default (120x90)

## Embed Options

### Recommended Embed Parameters

```html
<iframe
  width="560"
  height="315"
  src="https://www.youtube.com/embed/VIDEO_ID?rel=0&modestbranding=1"
  frameborder="0"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
  allowfullscreen
></iframe>
```

### Optional Parameters

- `rel=0` - Do not show related videos
- `modestbranding=1` - Small YouTube logo
- `start=30` - Start at second 30
- `end=120` - End at second 120

## Integration with the Topic Schema

```typescript
// academy-lms.schema.ts
export const topicTable = pgTable("topics", {
  // ... other fields
  videoYoutube: text("video_youtube"), // YouTube embed URL
  videoLocal: text("video_local"), // Reference to kon-media
  externalVideo: text("external_video"), // iframe or external link
  imageId: text("image_id"), // Reference to kon-media
});
```

## Frontend Validation

```javascript
// Regex to validate YouTube URLs
const youtubeRegex =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[a-zA-Z0-9_-]{11}/;

function isValidYoutubeUrl(url) {
  return youtubeRegex.test(url);
}
```

## Error Handling

```json
// Error: Invalid URL
{
  "error": "Invalid YouTube URL"
}

// Error: URL missing
{
  "error": "URL required"
}

// Success
{
  "valid": true,
  "videoId": "dQw4w9WgXcQ",
  "embedUrl": "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "thumbnailUrl": "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
}
```

## Test with cURL

```bash
# Validate YouTube URL
curl -X POST http://localhost:3000/api/academy/media/youtube-info \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'

# Normalize video
curl -X POST http://localhost:3000/api/academy/media/normalize-video \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'

# Create topic with video
curl -X POST http://localhost:3000/api/academy/topics \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "moduleId": "mod_123",
    "title": "Topic with YouTube",
    "content": "Topic content",
    "videoYoutube": "https://www.youtube.com/embed/dQw4w9WgXcQ"
  }'
```
