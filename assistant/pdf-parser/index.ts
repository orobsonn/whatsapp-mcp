import { WorkerEntrypoint } from "cloudflare:workers";
import { PDFDocument } from "pdf-lib";
export type PdfAdmissionResult = { state: "available"; pages: number } | { state: "blocked"; reason: "pdf_invalid_input" | "pdf_invalid" | "pdf_pages_limit" };
/** Deploy as its OWN Worker/isolate, with no bindings or secrets. The parser's
 * CPU/memory failure must not run in the host holding DB/model capabilities. */
export class MediaPdfParser extends WorkerEntrypoint<Record<string, never>> {
  async admitPdf(input: unknown): Promise<PdfAdmissionResult> {
    if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("bytes" in input) || !(input.bytes instanceof Uint8Array) || input.bytes.length < 5 || input.bytes.length > 2097152) return { state: "blocked", reason: "pdf_invalid_input" };
    const bytes = input.bytes.slice();
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") return { state: "blocked", reason: "pdf_invalid_input" };
    try {
      const document = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
      const pages = document.getPageCount();
      if (document.isEncrypted || pages < 1 || pages > 4) return { state: "blocked", reason: "pdf_pages_limit" };
      return { state: "available", pages };
    } catch { return { state: "blocked", reason: "pdf_invalid" }; }
  }
}
// No public parser route. Only a nominal service binding reaches admitPdf.
export default { fetch() { return new Response("Forbidden", { status: 403 }); } };
