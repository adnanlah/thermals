export type RgbaRasterSource = {
  data: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  monochromeThreshold: number;
};

export type EscposBitmapPrintOptions = RgbaRasterSource & {
  feedAfterReceiptLines: number;
  cutAfterPrint: boolean;
};

const ESC_POS_INIT = Buffer.from([
  0x1b, 0x40, // ESC @: initialize printer.
  0x1b, 0x3d, 0x01, // ESC = 1: select printer.
  0x1c, 0x2e // FS .: cancel Chinese/Kanji mode on common clones.
]);

const FULL_CUT = Buffer.from([0x1d, 0x56, 0x00]);

export function createEscposBitmapPrintBuffer(
  options: EscposBitmapPrintOptions
): Buffer {
  return Buffer.concat([
    ESC_POS_INIT,
    createEscposRasterImageCommand(options),
    createLineFeeds(options.feedAfterReceiptLines),
    options.cutAfterPrint ? FULL_CUT : Buffer.alloc(0)
  ]);
}

export function createEscposRasterImageCommand(options: RgbaRasterSource): Buffer {
  validateRasterSource(options);

  const widthBytes = Math.ceil(options.targetWidth / 8);
  const imageBytes = Buffer.alloc(widthBytes * options.targetHeight);

  for (let y = 0; y < options.targetHeight; y++) {
    for (let xByte = 0; xByte < widthBytes; xByte++) {
      let packedByte = 0;

      for (let bit = 0; bit < 8; bit++) {
        const x = xByte * 8 + bit;

        if (x < options.targetWidth && isTargetPixelBlack(options, x, y)) {
          packedByte |= 0x80 >> bit;
        }
      }

      imageBytes[y * widthBytes + xByte] = packedByte;
    }
  }

  return Buffer.concat([
    Buffer.from([
      0x1d,
      0x76,
      0x30,
      0x00,
      widthBytes & 0xff,
      (widthBytes >> 8) & 0xff,
      options.targetHeight & 0xff,
      (options.targetHeight >> 8) & 0xff
    ]),
    imageBytes
  ]);
}

export function createMonochromePreviewRgba(
  options: RgbaRasterSource
): Uint8ClampedArray {
  validateRasterSource(options);

  const preview = new Uint8ClampedArray(options.targetWidth * options.targetHeight * 4);

  for (let y = 0; y < options.targetHeight; y++) {
    for (let x = 0; x < options.targetWidth; x++) {
      const offset = (y * options.targetWidth + x) * 4;
      const value = isTargetPixelBlack(options, x, y) ? 0 : 255;

      preview[offset] = value;
      preview[offset + 1] = value;
      preview[offset + 2] = value;
      preview[offset + 3] = 255;
    }
  }

  return preview;
}

function validateRasterSource(options: RgbaRasterSource): void {
  if (
    options.sourceWidth <= 0 ||
    options.sourceHeight <= 0 ||
    options.targetWidth <= 0 ||
    options.targetHeight <= 0
  ) {
    throw new Error("Raster dimensions must be positive.");
  }

  const widthBytes = Math.ceil(options.targetWidth / 8);

  if (widthBytes > 0xffff || options.targetHeight > 0xffff) {
    throw new Error("Raster image is too large for ESC/POS GS v 0.");
  }

  if (options.data.length < options.sourceWidth * options.sourceHeight * 4) {
    throw new Error("RGBA buffer is smaller than the declared dimensions.");
  }
}

function isTargetPixelBlack(
  options: RgbaRasterSource,
  targetX: number,
  targetY: number
): boolean {
  const xStart = Math.floor((targetX * options.sourceWidth) / options.targetWidth);
  const xEnd = Math.max(
    xStart + 1,
    Math.floor(((targetX + 1) * options.sourceWidth) / options.targetWidth)
  );
  const yStart = Math.floor((targetY * options.sourceHeight) / options.targetHeight);
  const yEnd = Math.max(
    yStart + 1,
    Math.floor(((targetY + 1) * options.sourceHeight) / options.targetHeight)
  );
  let lumaTotal = 0;
  let samples = 0;

  for (let y = yStart; y < Math.min(yEnd, options.sourceHeight); y++) {
    for (let x = xStart; x < Math.min(xEnd, options.sourceWidth); x++) {
      const offset = (y * options.sourceWidth + x) * 4;
      const alpha = options.data[offset + 3] / 255;
      const luma =
        0.299 * options.data[offset] +
        0.587 * options.data[offset + 1] +
        0.114 * options.data[offset + 2];

      lumaTotal += luma * alpha + 255 * (1 - alpha);
      samples++;
    }
  }

  return lumaTotal / Math.max(1, samples) < options.monochromeThreshold;
}

function createLineFeeds(count: number): Buffer {
  return Buffer.alloc(Math.max(0, Math.floor(count)), 0x0a);
}
