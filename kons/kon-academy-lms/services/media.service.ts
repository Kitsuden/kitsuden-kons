/**
 * Academy LMS - Media Service
 *
 * Service for integration with Kitsuden's Media Library.
 * Handles upload, processing and management of multimedia files.
 */

import { z } from "zod";

// ============================================
// TYPES AND ENUMS
// ============================================

export interface MediaFile {
  id: string;
  url: string;
  thumbnailUrl?: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number; // For videos
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface UploadResult {
  success: boolean;
  file?: MediaFile;
  error?: string;
}

export interface MediaValidation {
  maxSize?: number; // en bytes
  allowedTypes?: string[]; // mime types
  maxWidth?: number; // for images
  maxHeight?: number;
  minWidth?: number;
  minHeight?: number;
}

export type MediaType = "image" | "video" | "document" | "audio" | "any";

// ============================================
// VALIDATION SCHEMAS
// ============================================

export const mediaFileSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  thumbnailUrl: z.string().url().optional(),
  filename: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number().positive(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  duration: z.number().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.date(),
});

export const uploadOptionsSchema = z.object({
  type: z.enum(["image", "video", "document", "audio", "any"]).default("any"),
  maxSize: z
    .number()
    .positive()
    .default(10 * 1024 * 1024), // 10MB default
  allowedTypes: z.array(z.string()).optional(),
  generateThumbnail: z.boolean().default(true),
  optimizeImage: z.boolean().default(true),
  folder: z.string().default("academy"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================
// CONFIGURATIONS BY TYPE
// ============================================

export const validationsByType: Record<MediaType, MediaValidation> = {
  image: {
    maxSize: 10 * 1024 * 1024, // 10MB
    allowedTypes: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"],
    maxWidth: 4096,
    maxHeight: 4096,
  },
  video: {
    maxSize: 500 * 1024 * 1024, // 500MB
    allowedTypes: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
  },
  document: {
    maxSize: 50 * 1024 * 1024, // 50MB
    allowedTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
    ],
  },
  audio: {
    maxSize: 50 * 1024 * 1024, // 50MB
    allowedTypes: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"],
  },
  any: {
    maxSize: 100 * 1024 * 1024, // 100MB
  },
};

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validates a file according to its type
 */
export function validateFile(
  file: File | { size: number; type: string; name: string },
  type: MediaType = "any"
): { valid: true } | { valid: false; errors: string[] } {
  const validation = validationsByType[type];
  const errors: string[] = [];

  // Validate size
  if (validation.maxSize && file.size > validation.maxSize) {
    errors.push(`Maximum size allowed: ${formatBytes(validation.maxSize)}`);
  }

  // Validate MIME type
  if (validation.allowedTypes && !validation.allowedTypes.includes(file.type)) {
    errors.push(`File type not allowed. Allowed: ${validation.allowedTypes.join(", ")}`);
  }

  if (errors.length > 0) {
    return { valid: false as const, errors };
  }

  return { valid: true as const };
}

/**
 * Determines the media type from the MIME type
 */
export function determineMediaType(mimeType: string): MediaType {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Formats bytes into a readable format
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

// ============================================
// PROCESSING FUNCTIONS
// ============================================

/**
 * Extracts information from a YouTube video link
 */
export function extractYoutubeInfo(url: string): {
  valid: boolean;
  videoId?: string;
  embedUrl?: string;
  thumbnailUrl?: string;
} {
  // YouTube URL patterns
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const videoId = match[1];
      return {
        valid: true,
        videoId,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      };
    }
  }

  return { valid: false };
}

/**
 * Normalizes a video URL (YouTube, Vimeo, etc.)
 */
export function normalizeVideoUrl(url: string): {
  type: "youtube" | "vimeo" | "direct" | "embed";
  url: string;
  thumbnailUrl?: string;
} {
  // YouTube
  const youtubeInfo = extractYoutubeInfo(url);
  if (youtubeInfo.valid) {
    return {
      type: "youtube",
      url: youtubeInfo.embedUrl!,
      thumbnailUrl: youtubeInfo.thumbnailUrl,
    };
  }

  // Vimeo
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) {
    const videoId = vimeoMatch[1];
    return {
      type: "vimeo",
      url: `https://player.vimeo.com/video/${videoId}`,
      thumbnailUrl: `https://vumbnail.com/${videoId}.jpg`,
    };
  }

  // Direct URL or embed
  if (url.includes("<iframe") || url.includes("</iframe>")) {
    return { type: "embed", url };
  }

  return { type: "direct", url };
}

// ============================================
// KON MEDIA INTEGRATION
// ============================================

export interface MediaLibraryClient {
  upload: (
    file: File | Buffer,
    options: {
      folder?: string;
      filename?: string;
      metadata?: Record<string, unknown>;
    }
  ) => Promise<MediaFile>;
  delete: (fileId: string) => Promise<boolean>;
  getUrl: (fileId: string) => Promise<string>;
  optimizeImage: (
    fileId: string,
    options: { width?: number; height?: number; quality?: number }
  ) => Promise<MediaFile>;
}

// ============================================
// MEDIA URL GENERATION (KON-MEDIA)
// ============================================

/**
 * Generates a URL to get an image with a transformation preset
 * Uses the kon-media endpoints
 */
export function getMediaPresetUrl(
  mediaId: string,
  preset: "thumbnail" | "medium" | "large" | "original" = "original"
): string {
  return `/api/media/preset/${mediaId}/${preset}`;
}

/**
 * Generates a URL for a course cover (uses the large preset)
 * @param mediaId - Media ID in kon-media
 */
export function getCourseCoverUrl(mediaId: string | null | undefined): string | null {
  if (!mediaId) return null;
  return getMediaPresetUrl(mediaId, "large");
}

/**
 * Generates a URL for a quiz thumbnail (uses the thumbnail preset)
 * @param mediaId - Media ID in kon-media
 */
export function getQuizThumbnailUrl(mediaId: string | null | undefined): string | null {
  if (!mediaId) return null;
  return getMediaPresetUrl(mediaId, "thumbnail");
}

/**
 * Generates a URL for a learning path image (uses the large preset)
 * @param mediaId - Media ID in kon-media
 */
export function getLearningPathImageUrl(mediaId: string | null | undefined): string | null {
  if (!mediaId) return null;
  return getMediaPresetUrl(mediaId, "large");
}

/**
 * Generates a URL for a topic image (uses the medium preset)
 * @param mediaId - Media ID in kon-media
 */
export function getTopicImageUrl(mediaId: string | null | undefined): string | null {
  if (!mediaId) return null;
  return getMediaPresetUrl(mediaId, "medium");
}

/**
 * Generates a URL for a question file (uses the original preset)
 * @param mediaId - Media ID in kon-media
 */
export function getQuestionFileUrl(mediaId: string | null | undefined): string | null {
  if (!mediaId) return null;
  return getMediaPresetUrl(mediaId, "original");
}

/**
 * Generates a URL for a document (uses the original preset)
 * @param mediaId - Media ID in kon-media
 */
export function getDocumentUrl(mediaId: string | null | undefined): string | null {
  if (!mediaId) return null;
  return getMediaPresetUrl(mediaId, "original");
}

/**
 * Media service that integrates with Kitsuden's Media Library
 */
export class MediaService {
  private client: MediaLibraryClient;

  constructor(client: MediaLibraryClient) {
    this.client = client;
  }

  /**
   * Uploads a file to the Media Library
   */
  async uploadFile(
    file: File | Buffer,
    options: z.infer<typeof uploadOptionsSchema>
  ): Promise<UploadResult> {
    try {
      const opts = uploadOptionsSchema.parse(options);

      // Validate file
      const fileInfo =
        file instanceof File
          ? { size: file.size, type: file.type, name: file.name }
          : { size: (file as Buffer).length, type: "application/octet-stream", name: "file" };

      const validation = validateFile(fileInfo, opts.type);
      if (!validation.valid) {
        return {
          success: false,
          error: (validation as any).errors.join(", "),
        };
      }

      // Upload file
      const mediaFile = await this.client.upload(file, {
        folder: opts.folder,
        metadata: {
          ...opts.metadata,
          uploadedBy: "academy-lms",
          type: opts.type,
        },
      });

      return {
        success: true,
        file: mediaFile,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error uploading file",
      };
    }
  }

  /**
   * Uploads multiple files
   */
  async uploadFiles(
    files: (File | Buffer)[],
    options: z.infer<typeof uploadOptionsSchema>
  ): Promise<{ successful: MediaFile[]; failed: Array<{ index: number; error: string }> }> {
    const succeeded: MediaFile[] = [];
    const failed: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < files.length; i++) {
      const result = await this.uploadFile(files[i], options);
      if (result.success && result.file) {
        succeeded.push(result.file);
      } else {
        failed.push({ index: i, error: result.error || "Unknown error" });
      }
    }

    return { successful: succeeded, failed };
  }

  /**
   * Deletes a file
   */
  async deleteFile(fileId: string): Promise<boolean> {
    return this.client.delete(fileId);
  }

  /**
   * Gets the URL of a file
   */
  async getUrl(fileId: string): Promise<string> {
    return this.client.getUrl(fileId);
  }

  /**
   * Optimizes an image
   */
  async optimizeImage(
    fileId: string,
    options: { width?: number; height?: number; quality?: number }
  ): Promise<MediaFile> {
    return this.client.optimizeImage(fileId, options);
  }
}

// ============================================
// ACADEMY LMS SPECIFIC UTILITIES
// ============================================

/**
 * Validates and processes a course cover
 */
export async function processCourseCover(
  mediaService: MediaService,
  file: File | Buffer
): Promise<UploadResult> {
  return mediaService.uploadFile(file, {
    type: "image",
    maxSize: 5 * 1024 * 1024, // 5MB
    folder: "academy/courses/covers",
    optimizeImage: true,
    generateThumbnail: true,
    metadata: { contentType: "course-cover" },
  });
}

/**
 * Validates and processes a topic video
 */
export async function processTopicVideo(
  mediaService: MediaService,
  file: File | Buffer
): Promise<UploadResult> {
  return mediaService.uploadFile(file, {
    type: "video",
    maxSize: 500 * 1024 * 1024, // 500MB
    folder: "academy/topics/videos",
    generateThumbnail: true,
    optimizeImage: false,
    metadata: { contentType: "topic-video" },
  });
}

/**
 * Validates and processes an attached document
 */
export async function processDocument(
  mediaService: MediaService,
  file: File | Buffer
): Promise<UploadResult> {
  return mediaService.uploadFile(file, {
    type: "document",
    maxSize: 50 * 1024 * 1024, // 50MB
    folder: "academy/documents",
    generateThumbnail: false,
    optimizeImage: false,
    metadata: { contentType: "additional-document" },
  });
}

/**
 * Validates and processes a quiz question image
 */
export async function processQuestionImage(
  mediaService: MediaService,
  file: File | Buffer
): Promise<UploadResult> {
  return mediaService.uploadFile(file, {
    type: "image",
    maxSize: 5 * 1024 * 1024, // 5MB
    folder: "academy/quizzes/images",
    generateThumbnail: true,
    optimizeImage: true,
    metadata: { contentType: "question-image" },
  });
}

/**
 * Processes a PDF certificate for storage
 */
export async function processCertificatePdf(
  mediaService: MediaService,
  pdfBuffer: Buffer,
  fileName: string
): Promise<UploadResult> {
  return mediaService.uploadFile(pdfBuffer, {
    type: "document",
    maxSize: 10 * 1024 * 1024, // 10MB
    folder: "academy/certificates",
    generateThumbnail: false,
    optimizeImage: false,
    metadata: { contentType: "certificate-pdf" },
  });
}
