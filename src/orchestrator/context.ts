import { EventEmitter } from 'node:events';
import { asc, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { events } from '../db/schema';
import type { Actor } from '../domain';
import type { AgentRuntime, RuntimeId } from '../runtimes/runtime';
import type { SecretBox } from '../secrets';

export interface NewEvent {
  type: string;
  entityType: string;
  entityId: string;
  objectiveId?: string | null;
  actor: Actor;
  payload?: Record<string, unknown>;
}

export type StoredEvent = typeof events.$inferSelect;

export interface RuntimeLimits {
  concurrency: number;
  /** Quota guard: batas run per jendela waktu (paket langganan). */
  maxRunsPerWindow?: number;
  windowHours?: number;
  costKind: 'actual' | 'estimate';
}

export interface OfficeContext {
  db: Db;
  bus: EventEmitter;
  workspacesDir: string;
  defaultModel: string;
  runtimes: Map<RuntimeId, AgentRuntime>;
  limits: Map<RuntimeId, RuntimeLimits>;
  /** Paksa semua agent memakai runtime ini (development tanpa kuota). */
  forceRuntime?: RuntimeId;
  /** Enkripsi credential provider. */
  secrets: SecretBox;
}

export type Emit = (ev: NewEvent) => void;

/**
 * Jalankan perubahan state dalam satu transaksi. Event ditulis di transaksi yang
 * sama (traceable), lalu dipublikasikan ke bus setelah commit (untuk SSE).
 */
export async function withTx<T>(ctx: OfficeContext, fn: (tx: Tx, emit: Emit) => Promise<T>): Promise<T> {
  let stored: StoredEvent[] = [];
  const result = await ctx.db.transaction(async (tx) => {
    const pending: NewEvent[] = [];
    const r = await fn(tx, (ev) => pending.push(ev));
    if (pending.length > 0) {
      // MySQL tidak punya RETURNING: ambil id auto-increment lalu baca ulang barisnya.
      const ids = await tx
        .insert(events)
        .values(pending.map((e) => ({ ...e, objectiveId: e.objectiveId ?? null, payload: e.payload ?? {} })))
        .$returningId();
      stored = await tx
        .select()
        .from(events)
        .where(inArray(events.id, ids.map((r) => r.id)))
        .orderBy(asc(events.id));
    }
    return r;
  });
  for (const ev of stored) ctx.bus.emit('event', ev);
  return result;
}

export function effectiveRuntime(ctx: OfficeContext, agentRuntime: string): RuntimeId {
  return ctx.forceRuntime ?? (agentRuntime as RuntimeId);
}
