import {z} from "zod";
import {sha256} from "./core";

const ref = z.string().min(1).max(200);
const options = { chatId: ref, replyTo: ref.optional() };
const file = {
  ...options,
  mediaId: ref,
  mediaHash: z.string().regex(/^[a-f0-9]{64}$/),
  caption: z.string().max(8000).optional(),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\x00-\x1f]+$/)
    .optional(),
};
export const sendEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...options,
      kind: z.literal("text"),
      text: z
        .string()
        .min(1)
        .max(8000)
        .refine((s) => s.trim().length > 0),
    })
    .strict(),
  z.object({ ...file, kind: z.literal("image") }).strict(),
  z.object({ ...file, kind: z.literal("pdf") }).strict(),
  z.object({ ...file, kind: z.literal("audio") }).strict(),
]);
/** MCP requires an object at the root; enforce the discriminated contract again in prepareAction. */
export const sendToolSchema = z
  .object({
    ...file,
    mediaId: file.mediaId
      .optional()
      .describe(
        "Referência obtida de recentUploads ou consultar_midia; obrigatória para imagem, PDF e áudio.",
      ),
    mediaHash: file.mediaHash
      .optional()
      .describe("Hash retornado pelo MCP junto à mídia, nunca pedido ao dono."),
    kind: z
      .enum(["text", "image", "pdf", "audio"])
      .describe(
        "Use image com caption para enviar imagem e texto juntos; text envia somente texto.",
      ),
    text: sendEnvelopeSchema.options[0].shape.text
      .optional()
      .describe("Somente para kind=text. Para imagem ou PDF use caption."),
  })
  .strict();
export type SendEnvelope = z.infer<typeof sendEnvelopeSchema>;

/** Parse to a fixed key order before hashing; unknown transport options are forbidden. */
export function canonicalEnvelope(input: unknown): string {
  return JSON.stringify(sendEnvelopeSchema.parse(input));
}
export async function actionDigest(input: unknown): Promise<string> {
  const parsed = JSON.parse(canonicalEnvelope(input));
  return sha256(JSON.stringify(parsed, Object.keys(parsed).sort()));
}
