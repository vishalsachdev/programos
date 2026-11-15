import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileInTree } from './host-fs-safety.js';

vi.mock('sharp', () => {
  const mockSharp = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image-data')),
  }));
  return { default: mockSharp };
});

vi.mock('./host-fs-safety.js', () => ({ writeFileInTree: vi.fn() }));

import sharp from 'sharp';

import {
  detectRasterFormat,
  parseImageReferences,
  processImage,
  UnsupportedImageFormatError,
} from './image.js';

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_BYTES = Buffer.concat([PNG_HEADER, Buffer.from('raw-image-data')]);

describe('image processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processImage', () => {
    it('resizes and saves image, returns content with caption', async () => {
      const buffer = PNG_BYTES;
      const result = await processImage(
        buffer,
        '/tmp/groups/test',
        'Check this out',
      );

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(
        /^\[Image: attachments\/img-\d+-[a-z0-9]+\.jpg\] Check this out$/,
      );
      expect(result!.relativePath).toMatch(
        /^attachments\/img-\d+-[a-z0-9]+\.jpg$/,
      );
      expect(writeFileInTree).toHaveBeenCalledWith(
        '/tmp/groups/test',
        result!.relativePath,
        Buffer.from('resized-image-data'),
      );
    });

    it('returns content without caption when none provided', async () => {
      const buffer = PNG_BYTES;
      const result = await processImage(buffer, '/tmp/groups/test', '');

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(
        /^\[Image: attachments\/img-\d+-[a-z0-9]+\.jpg\]$/,
      );
    });

    it('rejects SVG bytes without calling sharp', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      await expect(
        processImage(svg, '/tmp/groups/test', ''),
      ).rejects.toBeInstanceOf(UnsupportedImageFormatError);
      expect(sharp).not.toHaveBeenCalled();
      expect(writeFileInTree).not.toHaveBeenCalled();
    });

    it('returns null on empty buffer', async () => {
      const result = await processImage(
        Buffer.alloc(0),
        '/tmp/groups/test',
        '',
      );
      expect(result).toBeNull();
    });
  });

  describe('detectRasterFormat', () => {
    it('recognises the four accepted raster formats by their leading bytes', () => {
      expect(detectRasterFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
        'jpeg',
      );
      expect(detectRasterFormat(PNG_BYTES)).toBe('png');
      expect(detectRasterFormat(Buffer.from('GIF89a....'))).toBe('gif');
      expect(
        detectRasterFormat(
          Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'),
        ),
      ).toBe('webp');
    });

    it('returns null for SVG, PDF and unknown bytes whatever they are named', () => {
      expect(
        detectRasterFormat(Buffer.from('<?xml version="1.0"?><svg/>')),
      ).toBeNull();
      expect(
        detectRasterFormat(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        ),
      ).toBeNull();
      expect(detectRasterFormat(Buffer.from('%PDF-1.7'))).toBeNull();
      expect(detectRasterFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
    });
  });

  describe('parseImageReferences', () => {
    it('extracts image paths from message content', () => {
      const text =
        '[Image: attachments/img-123.jpg] hello\nplain text\n[Image: attachments/img-456.jpg]';
      const refs = parseImageReferences(text);

      expect(refs).toEqual([
        { relativePath: 'attachments/img-123.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/img-456.jpg', mediaType: 'image/jpeg' },
      ]);
    });

    it('returns empty array when no images', () => {
      expect(parseImageReferences('just text')).toEqual([]);
    });

    it('does not match malformed refs', () => {
      expect(parseImageReferences('[Image: wrong/path.jpg]')).toEqual([]);
      expect(parseImageReferences('[image: attachments/img.jpg]')).toEqual([]);
    });
  });
});
