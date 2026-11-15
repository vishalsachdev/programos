import sharp from 'sharp';

import { writeFileInTree } from './host-fs-safety.js';

const MAX_DIMENSION = 1024;
const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]\s]+)\]/g;

export interface ProcessedImage {
  content: string;
  relativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

export type RasterFormat = 'jpeg' | 'png' | 'gif' | 'webp';

/**
 * Identify the image format from the file's leading bytes, not from a
 * sender-supplied MIME type or file name, which can be faked. Only the four
 * raster formats Coordinator accepts are recognised; anything else (SVG, PDF, HEIC,
 * TIFF, unknown) returns null so it never reaches sharp/libvips.
 */
export function detectRasterFormat(buffer: Buffer): RasterFormat | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export class UnsupportedImageFormatError extends Error {
  constructor() {
    super(
      'unsupported image format (only JPEG, PNG, GIF and WebP are accepted)',
    );
    this.name = 'UnsupportedImageFormatError';
  }
}

export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  // Defence in depth for CVE-2026-96889 (librsvg RCE reachable through sharp):
  // refuse any input that is not a known raster format before decoding it.
  if (!detectRasterFormat(buffer)) throw new UnsupportedImageFormatError();

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  // groups/<folder> is agent-writable: never write through a planted link.
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const relativePath = `attachments/${filename}`;
  writeFileInTree(groupDir, relativePath, resized);
  const content = caption
    ? `[Image: ${relativePath}] ${caption}`
    : `[Image: ${relativePath}]`;

  return { content, relativePath };
}

export function parseImageReferences(text: string): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  IMAGE_REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_REF_PATTERN.exec(text)) !== null) {
    refs.push({ relativePath: match[1], mediaType: 'image/jpeg' });
  }
  return refs;
}
