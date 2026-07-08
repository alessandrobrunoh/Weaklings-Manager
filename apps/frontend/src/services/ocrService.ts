/**
 * The result of OCR-ing an uploaded image.
 */
export interface OcrResult {
  text: string;
  lines: string[];
}

/**
 * Uploads an image to the backend's generic OCR utility and returns the extracted text.
 */
export async function ocrImage(file: File): Promise<OcrResult> {
  const formData = new FormData();
  formData.append("image", file);

  const res = await fetch("/api/utils/ocr", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `OCR failed with status ${res.status}`);
  }

  const body = await res.json();
  return body.data as OcrResult;
}
