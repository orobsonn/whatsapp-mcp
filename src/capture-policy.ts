import type { Env } from "./env";
import {
  assertActive,
  assertFence,
  currentFence,
  AppError,
  type Fence,
} from "./core";
export type CaptureMode = "default" | "enabled" | "disabled" | "legacy_hold";
export async function captureSetting(
  env: Env,
  chatId: string,
  fence: Fence = currentFence(env),
) {
  assertFence(env, fence);
  const s = await env.DB.prepare(
    "SELECT s.mode,s.revision,s.updated_at FROM capture_settings s JOIN chats c ON c.id=s.chat_id WHERE c.id=? AND c.epoch=? AND c.generation=?",
  )
    .bind(chatId, fence.epoch, fence.generation)
    .first<{ mode: CaptureMode; revision: number; updated_at: number }>();
  if (!s) throw new AppError("capture_setting_unavailable", 409);
  return s;
}
export function metricStatement(
  env: Env,
  field: "received" | "failed" | "skipped",
  amount = 1,
) {
  const f = currentFence(env),
    time = Date.now(),
    day = new Date(time).toISOString().slice(0, 10);
  return env.DB.prepare(
    `INSERT INTO capture_metrics(epoch,generation,day,${field},last_received_at) VALUES(?,?,?,?,?) ON CONFLICT(epoch,generation,day) DO UPDATE SET ${field}=${field}+excluded.${field},last_received_at=excluded.last_received_at`,
  ).bind(f.epoch, f.generation, day, amount, time);
}
export async function captureDiagnostics(env: Env) {
  assertActive(env);
  const f = currentFence(env);
  const global = await env.DB.prepare(
    "SELECT value_json FROM policies WHERE key=? AND epoch=?",
  )
    .bind(`capture_default_enabled:${f.generation}`, f.epoch)
    .first<{ value_json: string }>();
  const count = await env.DB.prepare(
    "SELECT c.kind,COUNT(*) total,SUM(c.capture_enabled) active,SUM(s.mode='enabled') explicitOn,SUM(s.mode='disabled') explicitOff,SUM(s.mode='legacy_hold') legacyHold,SUM(s.mode='default') inherited FROM chats c JOIN capture_settings s ON s.chat_id=c.id WHERE c.epoch=? AND c.generation=? GROUP BY c.kind",
  )
    .bind(f.epoch, f.generation)
    .all();
  const gaps = await env.DB.prepare(
    "SELECT COUNT(*) periods,SUM(g.ended_at IS NULL) openPeriods,SUM(g.unknown_start) unknownStarts FROM capture_gaps g JOIN chats c ON c.id=g.chat_id WHERE c.epoch=? AND c.generation=?",
  )
    .bind(f.epoch, f.generation)
    .first();
  const metrics = await env.DB.prepare(
    "SELECT day,received,stored,duplicates,skipped,failed,last_received_at FROM capture_metrics WHERE epoch=? AND generation=? ORDER BY day DESC LIMIT 30",
  )
    .bind(f.epoch, f.generation)
    .all();
  assertFence(env, f);
  return {
    captureDefaultEnabled: global ? global.value_json === "true" : true,
    counts: count.results,
    gaps,
    metrics: metrics.results,
    metricsScope: "authenticated_received_callbacks_since_instrumentation",
    dayTimezone: "UTC",
    duplicateMeaning:
      "Callback de ID já conhecido, incluindo replay, edição e exclusão; não é contagem de mensagens novas.",
    historicalImport: false,
    coverage:
      "Somente callbacks recebidos; histórico anterior, períodos sem callback e falhas do próprio banco podem não ser mensuráveis. Legado ambíguo permanece bloqueado até revisão.",
  };
}

export async function captureGaps(env: Env, chatId: string) {
  const f = currentFence(env);
  const result = await env.DB.prepare(
    "SELECT g.started_at,g.ended_at,g.reason,g.unknown_start FROM capture_gaps g JOIN chats c ON c.id=g.chat_id WHERE c.id=? AND c.epoch=? AND c.generation=? ORDER BY g.revision DESC LIMIT 21",
  )
    .bind(chatId, f.epoch, f.generation)
    .all();
  assertFence(env, f);
  return {
    periods: result.results.slice(0, 20),
    truncated: result.results.length > 20,
  };
}
