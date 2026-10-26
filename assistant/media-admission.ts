export interface PdfAdmissionReader { admitPdf(input: { bytes: Uint8Array }): Promise<unknown> }
export type MediaAdmission = { kind: "image_context" | "pdf_context"; pages: number; width?: number; height?: number };
/** Structural admission only. This is not a full image decoder or a PDF sandbox.
 * Parsing precedes every financial/network effect. Runtime failure leaves no paid attempt. */
export async function admitMedia(input: Uint8Array, mime: string, pdfParser?: PdfAdmissionReader): Promise<MediaAdmission> {
  if (!(input instanceof Uint8Array) || input.length < 1 || input.length > 2097152) throw new Error("media_bytes_limit");
  const bytes = input.slice(), view = new DataView(bytes.buffer), ascii = (start: number, n: number) => String.fromCharCode(...bytes.subarray(start, start + n));
  if (mime === "application/pdf") {
    if (ascii(0, 5) !== "%PDF-") throw new Error("media_format");
    if (!pdfParser) throw new Error("media_pdf_parser_unconfigured");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // This deadline bounds cooperative waiting only. CPU and memory isolation
      // belong to the separately deployed parser Worker, never Promise.race.
      const raw = await Promise.race([pdfParser.admitPdf({ bytes }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("media_pdf_parser_failed")), 5000); })]);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("media_pdf_parser_failed");
      const result = raw as { state?: unknown; pages?: unknown; reason?: unknown };
      if (result.state === "blocked" && Object.keys(raw).length === 2 && ["pdf_invalid_input", "pdf_invalid", "pdf_pages_limit"].includes(String(result.reason))) throw new Error(result.reason === "pdf_pages_limit" ? "media_pages_limit" : "media_pdf_parser_failed");
      if (Object.keys(raw).length !== 2 || result.state !== "available" || !Number.isSafeInteger(result.pages) || Number(result.pages) < 1 || Number(result.pages) > 4) throw new Error("media_pdf_parser_failed");
      return { kind: "pdf_context", pages: Number(result.pages) };
    } catch (error) { if (error instanceof Error && error.message === "media_pages_limit") throw error; throw new Error("media_pdf_parser_failed"); }
    finally { clearTimeout(timer); }
  }
  let width = 0, height = 0;
  if (mime === "image/png" && bytes.length >= 45 && ascii(1, 3) === "PNG" && bytes[0] === 137 && ascii(4, 4) === "\r\n\x1a\n" && ascii(12, 4) === "IHDR" && view.getUint32(8) === 13 && ascii(bytes.length - 8, 4) === "IEND") {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (mime === "image/jpeg" && bytes.length > 12 && view.getUint16(0) === 0xffd8 && view.getUint16(bytes.length - 2) === 0xffd9) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) throw new Error("media_format");
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++]; if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(at); if (length < 2 || at + length > bytes.length) throw new Error("media_format");
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) { height = view.getUint16(at + 3); width = view.getUint16(at + 5); break; }
      at += length;
    }
  } else if (mime === "image/webp" && bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP" && view.getUint32(4, true) + 8 === bytes.length) {
    const kind = ascii(12, 4), len = view.getUint32(16, true);
    if (len + 20 > bytes.length) throw new Error("media_format");
    if (kind === "VP8X" && len >= 10) {
      if (bytes[20] & 2) throw new Error("media_animation_unsupported");
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536; height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (kind === "VP8 " && len >= 10 && ascii(23, 3) === "\x9d\x01\x2a") { width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff; }
    else if (kind === "VP8L" && len >= 5 && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
  }
  if (!width || !height) throw new Error("media_format");
  if (width > 4096 || height > 4096 || width * height > 12000000) throw new Error("media_pixels_limit");
  return { kind: "image_context", pages: 1, width, height };
}
