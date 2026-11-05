/**
 * Academy LMS - PDF Service
 *
 * Service for generating PDF certificates.
 * Supports two modes:
 *   1. GENERATED: Creates a professional certificate from scratch with PDFKit
 *   2. TEMPLATE: Overlays onto an existing base PDF (like the Django app)
 *
 * Optional dependencies (lazy-loaded):
 *   - pdfkit: ^0.14.0    (generated mode)
 *   - pdf-lib: ^1.17.1   (template/overlay mode)
 */

import { Buffer } from "buffer";

// ═══════════════════════════════════════════════════════════════════════════
// LAZY LOADING OF OPTIONAL DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════════

let PDFKitModule: any = null;
let PDFLibModule: any = null;

async function getPDFDocument(): Promise<any> {
  if (!PDFKitModule) {
    const mod = await import("pdfkit");
    PDFKitModule = (mod as any).default || mod;
  }
  return PDFKitModule;
}

async function getPDFLib(): Promise<any> {
  if (!PDFLibModule) {
    const mod = await import("pdf-lib");
    PDFLibModule = (mod as any).default || mod;
  }
  return PDFLibModule;
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CertificateData {
  userName: string;
  courseName: string;
  completedAt: Date;
  durationHours: string | number;
  code: string;
}

export interface CertificateTemplate {
  type: "template" | "generated";
  /** Local path or public URL to the base PDF (requires pdf-lib) */
  backgroundPdf?: string;
  /** Background image (requires pdfkit + the image must be accessible) */
  backgroundImage?: string;
  primaryColor?: string;
  secondaryColor?: string;
  logoUrl?: string;
  signatureUrl?: string;
  primaryText?: string;
  secondaryText?: string;
}

/** Position configuration for overlay in template mode */
export interface OverlayConfig {
  userName: { x: number; y: number; fontSize?: number; color?: string };
  courseName: { x: number; y: number; fontSize?: number; color?: string };
  date: { x: number; y: number; fontSize?: number; color?: string };
  duration?: { x: number; y: number; fontSize?: number; color?: string };
  code?: { x: number; y: number; fontSize?: number; color?: string };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE MODE — Overlay on base PDF (like the Django app)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates a certificate by overlaying onto an existing template PDF.
 * Equivalent to the Django logic: template.pdf + canvas overlay.
 *
 * @param data - Certificate data
 * @param templatePath - Path/URL to the base PDF
 * @param overlay - Positions of each field in the PDF
 * @returns Buffer of the resulting PDF
 */
export async function generateCertificateOverlay(
  data: CertificateData,
  templatePath: string,
  overlay: OverlayConfig
): Promise<Buffer> {
  const { PDFDocument, rgb, StandardFonts } = await getPDFLib();

  // Load base PDF
  let templateBytes: Uint8Array;

  if (templatePath.startsWith("http://") || templatePath.startsWith("https://")) {
    const response = await fetch(templatePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch template: ${response.status} ${response.statusText}`);
    }
    templateBytes = new Uint8Array(await response.arrayBuffer());
  } else {
    // Local path — read with Bun/Node
    const file = await import("node:fs/promises");
    templateBytes = await file.readFile(templatePath);
  }

  const pdfDoc = await PDFDocument.load(templateBytes);
  const pages = pdfDoc.getPages();
  if (pages.length === 0) {
    throw new Error("Template PDF has no pages");
  }

  const page = pages[0];
  const { width, height: _height } = page.getSize();

  // Standard font
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  // const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Helper to draw text centered or at coordinates
  function drawText(
    text: string,
    cfg: { x: number; y: number; fontSize?: number; color?: string; font?: typeof font },
    options?: { align?: "left" | "center" | "right"; maxWidth?: number }
  ) {
    const size = cfg.fontSize ?? 16;
    const f = cfg.font ?? font;
    const align = options?.align ?? "left";
    const maxW = options?.maxWidth ?? width - 100;

    // Compute dynamic font size if the text is very long
    let currentSize = size;
    let textWidth = f.widthOfTextAtSize(text, currentSize);

    while (textWidth > maxW && currentSize > 10) {
      currentSize -= 1;
      textWidth = f.widthOfTextAtSize(text, currentSize);
    }

    let x = cfg.x;
    if (align === "center") {
      x = cfg.x - textWidth / 2;
    } else if (align === "right") {
      x = cfg.x - textWidth;
    }

    // Parsear color hex a rgb
    const color = cfg.color ? hexToRgb(cfg.color) : { r: 0, g: 0, b: 0 };

    page.drawText(text, {
      x,
      y: cfg.y,
      size: currentSize,
      font: f,
      color: rgb(color.r, color.g, color.b),
    });

    return { width: textWidth, size: currentSize };
  }

  // Student name (with auto-fit)
  if (overlay.userName) {
    const name = data.userName || "Student";
    drawText(
      name,
      {
        ...overlay.userName,
        font: fontBold,
      },
      { align: "center", maxWidth: width - 80 }
    );
  }

  // Course name
  if (overlay.courseName) {
    drawText(
      data.courseName || "",
      {
        ...overlay.courseName,
        font: fontBold,
      },
      { align: "center", maxWidth: width - 80 }
    );
  }

  // Date
  if (overlay.date) {
    const dateStr = new Date(data.completedAt).toLocaleDateString("es-ES", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    drawText(dateStr, overlay.date, { align: "center" });
  }

  // Duration
  if (overlay.duration && data.durationHours) {
    drawText(`${data.durationHours} hours`, overlay.duration, { align: "center" });
  }

  // Verification code
  if (overlay.code) {
    drawText(`Code: ${data.code}`, overlay.code, { align: "center" });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Generates a certificate with a base PDF template using default coordinates
 * similar to the original Django app.
 *
 * Default coordinates (landscape letter page: 792x612 pts):
 *   - Name: centered at Y=282
 *   - Course:  Y=224
 *   - Date:  Y=60
 */
export async function generateCertificateWithTemplate(
  data: CertificateData,
  templatePath: string
): Promise<Buffer> {
  const defaultOverlay: OverlayConfig = {
    userName: { x: 396, y: 282, fontSize: 36, color: "#1a1a2e" },
    courseName: { x: 186, y: 224, fontSize: 16, color: "#333333" },
    date: { x: 100, y: 60, fontSize: 14, color: "#333333" },
    duration: { x: 396, y: 420, fontSize: 12, color: "#666666" },
    code: { x: 396, y: 490, fontSize: 10, color: "#999999" },
  };

  return generateCertificateOverlay(data, templatePath, defaultOverlay);
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATED MODE — From scratch with PDFKit
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates a PDF certificate from scratch with a professional design.
 * Uses PDFKit. Needs no base template.
 */
export async function generateCertificatePdf(
  data: CertificateData,
  template?: CertificateTemplate
): Promise<Buffer> {
  // If backgroundPdf is specified, use template mode
  if (template?.backgroundPdf) {
    return generateCertificateWithTemplate(data, template.backgroundPdf);
  }

  const PDFDocument = await getPDFDocument();

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margin: 50,
      });

      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const primaryColor = template?.primaryColor || "#009c3c";
      const secondaryColor = template?.secondaryColor || "#1a1a2e";

      // Background
      if (template?.backgroundImage) {
        try {
          doc.image(template.backgroundImage, 0, 0, {
            width: doc.page.width,
            height: doc.page.height,
          });
        } catch {
          drawDefaultBackground(doc, primaryColor);
        }
      } else {
        drawDefaultBackground(doc, primaryColor);
      }

      const centerX = doc.page.width / 2;

      // Title
      doc
        .fontSize(42)
        .font("Helvetica-Bold")
        .fillColor(secondaryColor)
        .text("CERTIFICATE", centerX, 80, { align: "center" });

      doc
        .fontSize(16)
        .font("Helvetica")
        .fillColor("#666")
        .text("OF COMPLETION", centerX, 130, { align: "center" });

      // Decorative line
      doc
        .moveTo(centerX - 100, 170)
        .lineTo(centerX + 100, 170)
        .lineWidth(2)
        .strokeColor(primaryColor)
        .stroke();

      // Main text
      doc
        .fontSize(14)
        .font("Helvetica")
        .fillColor("#333")
        .text(template?.primaryText || "This certifies that", centerX, 200, { align: "center" });

      // Student name (auto-fit size)
      const nameSize = Math.min(36, Math.max(24, 600 / Math.max(data.userName.length, 1)));
      doc
        .fontSize(nameSize)
        .font("Helvetica-Bold")
        .fillColor(secondaryColor)
        .text(data.userName, centerX, 240, { align: "center" });

      // Secondary text
      doc
        .fontSize(14)
        .font("Helvetica")
        .fillColor("#333")
        .text(
          template?.secondaryText || "has successfully completed the course:",
          centerX,
          310,
          { align: "center" }
        );

      // Course name
      doc
        .fontSize(28)
        .font("Helvetica-Bold")
        .fillColor(primaryColor)
        .text(data.courseName, centerX, 350, { align: "center" });

      // Details
      doc
        .fontSize(12)
        .font("Helvetica")
        .fillColor("#666")
        .text(`Duration: ${data.durationHours} hours`, centerX, 420, { align: "center" });

      doc
        .fontSize(12)
        .fillColor("#666")
        .text(
          `Completion date: ${new Date(data.completedAt).toLocaleDateString("es-ES", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}`,
          centerX,
          445,
          { align: "center" }
        );

      // Verification code
      doc
        .fontSize(10)
        .font("Helvetica-Oblique")
        .fillColor("#999")
        .text(`Verification code: ${data.code}`, centerX, 490, {
          align: "center",
        });

      // Bottom line
      doc
        .moveTo(centerX - 150, 530)
        .lineTo(centerX + 150, 530)
        .lineWidth(1)
        .strokeColor("#ccc")
        .stroke();

      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor("#999")
        .text("Electronically generated document", centerX, 540, {
          align: "center",
        });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Draws a default background for the certificate
 */
function drawDefaultBackground(doc: any, color: string): void {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#ffffff");

  doc
    .rect(20, 20, doc.page.width - 40, doc.page.height - 40)
    .lineWidth(3)
    .strokeColor(color)
    .stroke();

  doc
    .rect(30, 30, doc.page.width - 60, doc.page.height - 60)
    .lineWidth(1)
    .strokeColor(color)
    .stroke();

  const cornerSize = 40;
  const corners = [
    { x: 30, y: 30 },
    { x: doc.page.width - 30 - cornerSize, y: 30 },
    { x: 30, y: doc.page.height - 30 - cornerSize },
    { x: doc.page.width - 30 - cornerSize, y: doc.page.height - 30 - cornerSize },
  ];

  corners.forEach((corner) => {
    doc.rect(corner.x, corner.y, cornerSize, cornerSize).fillColor(color).fill();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW AND UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates a preview of the certificate (simplified version)
 */
export async function generateCertificatePreview(data: CertificateData): Promise<Buffer> {
  return generateCertificatePdf(data, {
    type: "generated",
    primaryColor: "#009c3c",
    secondaryColor: "#1a1a2e",
    primaryText: "Preview - This certifies that",
  });
}

/**
 * Validates a certificate code
 */
export function validateCertificateCode(code: string): boolean {
  const regex = /^CERT-[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]+$/;
  return regex.test(code);
}

/**
 * Extracts information from the certificate code
 */
export function extractCodeInfo(code: string): {
  courseId: string;
  userId: string;
  timestamp: number;
} | null {
  if (!validateCertificateCode(code)) return null;

  const parts = code.split("-");
  if (parts.length < 4) return null;

  return {
    courseId: parts[1],
    userId: parts[2],
    timestamp: parseInt(parts[3], 36),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  const r = ((bigint >> 16) & 255) / 255;
  const g = ((bigint >> 8) & 255) / 255;
  const b = (bigint & 255) / 255;
  return { r, g, b };
}
