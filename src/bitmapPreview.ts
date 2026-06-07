import { createCanvas, loadImage } from "canvas";
import {
  createMonochromePreviewRgba,
  RgbaRasterSource
} from "./escposRaster";

export type RgbaImage = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export function createMonochromePreviewPngBuffer(
  rasterSource: RgbaRasterSource,
  printerDpi: number
): Buffer {
  const canvas = createCanvas(rasterSource.targetWidth, rasterSource.targetHeight);
  const context = canvas.getContext("2d", {
    alpha: false,
    pixelFormat: "RGB24"
  });
  const previewImage = context.createImageData(
    rasterSource.targetWidth,
    rasterSource.targetHeight
  );

  previewImage.data.set(createMonochromePreviewRgba(rasterSource));
  context.putImageData(previewImage, 0, 0);

  return canvas.toBuffer("image/png", {
    resolution: printerDpi
  });
}

export async function readPngAsRgbaImage(pngBuffer: Buffer): Promise<RgbaImage> {
  const image = await loadImage(pngBuffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d", {
    alpha: false,
    pixelFormat: "RGB24"
  });

  context.drawImage(image, 0, 0);

  const imageData = context.getImageData(0, 0, image.width, image.height);

  return {
    data: imageData.data,
    width: imageData.width,
    height: imageData.height
  };
}
