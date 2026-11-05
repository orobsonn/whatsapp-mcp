import {IMAGE_CAPTURE_BYTES,IMAGE_RENDITION_VERSION,needsImageRendition,parseImageRendition,type ImageRendition} from './image-rendition';
import {readBounded,sha256} from './core';
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "./env";
import { assertActive, assertFence, LIMITS } from "./core";
import { resolveRuntimeEnv } from "./connection";
import { readCaptureSnapshot } from "./assistant-source-reader";
import { readMedia } from "./media";

const id = z.string().min(1).max(256), version = z.number().int().positive().max(2147483647);
const inputSchema = z.object({ secret: z.string().max(256), sourceEpoch: id, sourceGeneration: id, chatId: id, mediaId: id,
  expectedMessageVersion: version, expectedMediaVersion: version, expectedBlobHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const imageMimes = ["image/png", "image/jpeg", "image/webp"] as const;
type Mime = typeof imageMimes[number] | "application/pdf";
export type CaptureMediaResult =
  | { observation: "capture_media"; state: "available"; sourceEpoch: string; sourceGeneration: string; chatId: string; mediaId: string;
      messageVersion: number; mediaVersion: number; blobHash: string; mime: Mime; size: number; watermark: number; bytes: Uint8Array; normalization?:ImageRendition }
  | { observation: "capture_media"; state: "blocked" | "withdrawn"; reason: string };
const blocked = (reason: string): CaptureMediaResult => ({ observation: "capture_media", state: "blocked", reason });

/** Only stored image/PDF transport, never a URL fetcher, decoder or model tool. */
export class CaptureMediaReader extends WorkerEntrypoint<Env> {
  async readBoundedMedia(input: unknown): Promise<CaptureMediaResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new Error("reader_invalid_input");
    const query = parsed.data; // Zod owns this flat input before the first await.
    const snapshotQuery = { secret: query.secret, sourceEpoch: query.sourceEpoch, sourceGeneration: query.sourceGeneration,
      chatId: query.chatId, sourceId: query.mediaId, sourceKind: "media" };
    const before = await readCaptureSnapshot(this.env, snapshotQuery);
    if (before.state !== "available") return { observation: "capture_media", state: before.state, reason: before.reason ?? "media_unavailable" };
    const content = before.content!, media = content.media as Record<string, unknown> | undefined;
    if (!media || media.id !== query.mediaId || before.sourceVersion !== query.expectedMediaVersion ||
      media.version !== query.expectedMediaVersion || content.messageVersion !== query.expectedMessageVersion || media.hash !== query.expectedBlobHash)
      return blocked("media_reference_changed");
    const mime = media.mime;
    if (!((content.kind === "image" && [...imageMimes,'image/heic','image/heif'].includes(mime as typeof imageMimes[number])) || (content.kind === "pdf" && mime === "application/pdf")) ||
      !Number.isSafeInteger(media.size) || (media.size as number) < 1 || (media.size as number) > (content.kind==='image'?IMAGE_CAPTURE_BYTES:LIMITS.mediaBytes))
      return blocked("media_type_or_size");
    try {
      const env = await resolveRuntimeEnv(this.env);
      assertActive(env); assertFence(env, { epoch: query.sourceEpoch, generation: query.sourceGeneration });
      const original = await readMedia(env, query.mediaId,content.kind==='image'?IMAGE_CAPTURE_BYTES:LIMITS.mediaBytes);
      const after = await readCaptureSnapshot(this.env, snapshotQuery);
      if (after.state !== "available") return { observation: "capture_media", state: after.state, reason: after.reason ?? "media_unavailable" };
      if (JSON.stringify(before) !== JSON.stringify(after)) return blocked("media_snapshot_changed");
      const metadata = original.metadata;
      if (metadata.id !== query.mediaId || metadata.chatId !== query.chatId || metadata.version !== query.expectedMediaVersion ||
        metadata.sha256 !== query.expectedBlobHash || metadata.mime !== mime || metadata.size !== media.size || original.bytes.length !== media.size)
        return blocked("media_reference_changed");
      let bytes=original.bytes,readMime=mime as Mime,normalization:ImageRendition|undefined;
      if(content.kind==='image'&&needsImageRendition(bytes,mime as string)){
        const renditionId=await sha256(JSON.stringify([query.mediaId,query.expectedMediaVersion,query.expectedBlobHash,IMAGE_RENDITION_VERSION]));
        const d=await env.DB.prepare("SELECT text,object_key FROM media_derivatives WHERE id=? AND media_id=? AND media_version=? AND epoch=? AND generation=? AND kind='image_rendition' AND state='ready'").bind(renditionId,query.mediaId,query.expectedMediaVersion,query.sourceEpoch,query.sourceGeneration).first<{text:string;object_key:string}>();
        if(!d?.object_key)return blocked('image_rendition_pending');
        normalization=parseImageRendition(d.text);
        if(normalization.originalHash!==query.expectedBlobHash||normalization.originalMime!==mime||normalization.originalSize!==media.size)return blocked('media_reference_changed');
        const object=await env.MEDIA.get(d.object_key);if(!object)return blocked('image_rendition_unavailable');
        bytes=await readBounded(object.body,LIMITS.mediaBytes);
        if(bytes.length!==normalization.size||await sha256(bytes)!==normalization.hash)return blocked('image_rendition_unavailable');
        readMime=normalization.mime;
        const final=await readCaptureSnapshot(this.env,snapshotQuery);if(JSON.stringify(after)!==JSON.stringify(final))return blocked('media_snapshot_changed');
      }
      return { observation: "capture_media", state: "available", sourceEpoch: query.sourceEpoch, sourceGeneration: query.sourceGeneration,
        chatId: query.chatId, mediaId: query.mediaId, messageVersion: query.expectedMessageVersion, mediaVersion: query.expectedMediaVersion,
        blobHash: query.expectedBlobHash,mime:readMime,size:bytes.length,watermark:after.watermark!,bytes,...(normalization?{normalization}:{}) };
    } catch { return blocked("media_unavailable"); }
  }
}
