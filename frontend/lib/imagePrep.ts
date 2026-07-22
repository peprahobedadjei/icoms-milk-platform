import UTIF from "utif2";

// Vercel functions cap the request body at ~4.5 MB. We send full-resolution
// JPEG q92 (the fidelity-validated path: full-res -> JPEG -> backend PIL resize
// to 224). Only if that still exceeds the limit do we progressively downscale.
const BODY_LIMIT = 4_000_000;

export interface PreparedImage {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  bytes: number;
}

async function decodeToCanvas(file: File): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported in this browser");

  const name = file.name.toLowerCase();
  if (name.endsWith(".tif") || name.endsWith(".tiff")) {
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    if (!ifds.length) throw new Error("Could not read the TIFF file");
    UTIF.decodeImage(buf, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const w = ifds[0].width;
    const h = ifds[0].height;
    canvas.width = w;
    canvas.height = h;
    const imgData = ctx.createImageData(w, h);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
  } else {
    const bmp = await createImageBitmap(file);
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  }
  return canvas;
}

function downscaled(src: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxDim) return src;
  const scale = maxDim / longest;
  const dst = document.createElement("canvas");
  dst.width = Math.round(src.width * scale);
  dst.height = Math.round(src.height * scale);
  const ctx = dst.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return dst;
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to encode image"))),
      "image/jpeg",
      quality,
    ),
  );
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const decoded = await decodeToCanvas(file);

  // Attempt full-res first (matches validated fidelity path), then back off.
  const attempts: Array<[number, number]> = [
    [Infinity, 0.92],
    [1600, 0.9],
    [1024, 0.85],
  ];
  let blob: Blob | null = null;
  let used = decoded;
  for (const [maxDim, q] of attempts) {
    used = maxDim === Infinity ? decoded : downscaled(decoded, maxDim);
    blob = await toJpeg(used, q);
    if (blob.size <= BODY_LIMIT) break;
  }
  if (!blob) throw new Error("Could not prepare image");

  return {
    blob,
    previewUrl: URL.createObjectURL(blob),
    width: used.width,
    height: used.height,
    bytes: blob.size,
  };
}
