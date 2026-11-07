import { BadRequestError, PayloadTooLargeError } from "../errors.js";
import type { BrandingImageSlot } from "./schema.js";
import { fileTypeFromBuffer } from "file-type";
import { createHash } from "node:crypto";
import { svgProblem } from "./svg.js";
import env from "../../env.js";

export interface CheckedImage {
  sha256: string;
  ext: "png" | "jpg" | "webp" | "svg" | "ico";
  mime: string;
  buffer: Buffer;
}

export const MIME_BY_EXT: Record<CheckedImage["ext"], string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

const ALLOWED_BY_SLOT: Record<BrandingImageSlot, CheckedImage["ext"][]> = {
  logo: ["png", "webp", "jpg", "svg"],
  logoDark: ["png", "webp", "jpg", "svg"],
  favicon: ["png", "svg", "ico"],
  background: ["png", "webp", "jpg"],
};

/** Whether a stored object's key has a type the slot accepts. */
export function keyFitsSlot(slot: BrandingImageSlot, objectKey: string) {
  const ext = objectKey.slice(objectKey.lastIndexOf(".") + 1);
  return (ALLOWED_BY_SLOT[slot] as string[]).includes(ext);
}

export function imageMaxBytes(slot: BrandingImageSlot): number {
  return slot === "background"
    ? env.BRANDING_BACKGROUND_MAX_SIZE_MB * 1024 * 1024
    : env.BRANDING_IMAGE_MAX_SIZE_KB * 1024;
}

export function imageTooLarge(slot: BrandingImageSlot): PayloadTooLargeError {
  const max = imageMaxBytes(slot);
  return new PayloadTooLargeError(
    `The ${slot} image exceeds ${
      slot === "background"
        ? `${max / (1024 * 1024)} MB`
        : `${Math.floor(max / 1024)} KB`
    }`
  );
}

export function brandingObjectKey(
  image: Pick<CheckedImage, "sha256" | "ext">
): string {
  return `${image.sha256}.${image.ext}`;
}

export function brandingAssetUrl(objectKey: string): string {
  return `/oauth/branding/assets/${objectKey}`;
}

// Written as an escape: a literal BOM trips no-irregular-whitespace.
const BOM_RE = new RegExp("^\\uFEFF");

const invalid = (message: string) =>
  new BadRequestError("invalid_branding_image", message);

async function detectExt(buffer: Buffer): Promise<CheckedImage["ext"] | null> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected) {
    switch (detected.mime) {
      case "image/png":
        return "png";
      case "image/jpeg":
        return "jpg";
      case "image/webp":
        return "webp";
      case "image/x-icon":
      case "image/vnd.microsoft.icon":
        return "ico";
      case "application/xml":
        break;
      default:
        return null;
    }
  }
  const head = buffer
    .subarray(0, 512)
    .toString("utf8")
    .replace(BOM_RE, "")
    .trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml") ? "svg" : null;
}

export async function checkImage(
  slot: BrandingImageSlot,
  buffer: Buffer
): Promise<CheckedImage> {
  if (buffer.length > imageMaxBytes(slot)) throw imageTooLarge(slot);

  const ext = await detectExt(buffer);
  if (!ext || !ALLOWED_BY_SLOT[slot].includes(ext)) {
    throw invalid(
      `The ${slot} image must be one of: ${ALLOWED_BY_SLOT[slot].join(", ")}`
    );
  }

  if (ext === "svg") {
    const problem = svgProblem(buffer.toString("utf8").replace(BOM_RE, ""));
    if (problem) throw invalid(`Unsafe SVG: ${problem}`);
  }

  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    ext,
    mime: MIME_BY_EXT[ext],
    buffer,
  };
}
