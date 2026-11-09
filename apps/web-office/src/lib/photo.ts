import { supabase, newId } from "./supabase";

/** Снять фото камерой телефона. */
export function pickPhoto(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*"; input.setAttribute("capture", "environment");
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Сжать до 1600 px по длинной стороне: WebP, на старых iPhone — JPEG. */
export async function compress(file: File, max = 1600): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const webp = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.8));
  if (webp && webp.type === "image/webp") return webp;
  return new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.82));
}

export function geo(): Promise<{ lat: number; lon: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null), { enableHighAccuracy: true, timeout: 10_000 });
  });
}

/** Снять, сжать, загрузить в Storage. Возвращает путь или null, если пользователь отменил. */
export async function takeAndUpload(folder: string): Promise<{ path: string; takenAt: string } | null> {
  const file = await pickPhoto();
  if (!file) return null;
  const blob = await compress(file);
  const path = `${folder}/${newId()}.${blob.type === "image/webp" ? "webp" : "jpg"}`;
  const { error } = await supabase.storage.from("crew-photos").upload(path, blob, { contentType: blob.type });
  if (error) throw new Error("Фото не загрузилось: " + error.message);
  return { path, takenAt: new Date(file.lastModified || Date.now()).toISOString() };
}
