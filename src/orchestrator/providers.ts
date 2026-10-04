import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { agents, providers } from '../db/schema';
import { UserError } from '../domain';
import { OpenRouterRuntime } from '../runtimes/openrouter';
import { TEXT_PROVIDERS_OFF, textProvidersEnabled } from '../runtimes/text-providers';
import type { RuntimeId } from '../runtimes/runtime';
import { type OfficeContext, effectiveRuntime, withTx } from './context';
import { promoteAllObjectives } from './office';

export const PROVIDER_IDS = ['openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

function register(ctx: OfficeContext, id: ProviderId, apiKey: string, defaultModel: string) {
  ctx.runtimes.set(
    id,
    new OpenRouterRuntime({ apiKey, defaultModel, transcriptDir: path.join(ctx.workspacesDir, 'runtimes', id) }),
  );
  if (!ctx.limits.has(id)) ctx.limits.set(id, { concurrency: 2, costKind: 'actual' });
}

/** Saat start: daftarkan runtime untuk provider yang sudah dikonfigurasi Owner. */
export async function loadProviders(ctx: OfficeContext) {
  if (!textProvidersEnabled()) return;
  const rows = await ctx.db.select().from(providers);
  for (const r of rows) {
    if (!PROVIDER_IDS.includes(r.id as ProviderId)) continue;
    try {
      register(ctx, r.id as ProviderId, ctx.secrets.decrypt(r.apiKeyEnc), r.defaultModel);
    } catch (err) {
      console.error(`[providers] ${r.id} tidak bisa dibuka (kunci rahasia berubah?):`, err);
    }
  }
}

export async function listProviders(ctx: OfficeContext) {
  if (!textProvidersEnabled()) return [];
  const rows = await ctx.db.select().from(providers);
  return PROVIDER_IDS.map((id) => {
    const r = rows.find((x) => x.id === id);
    return { id, configured: !!r, apiKeyLast4: r?.apiKeyLast4 ?? null, defaultModel: r?.defaultModel ?? null, updatedAt: r?.updatedAt ?? null };
  });
}

/**
 * Owner memasang/mengganti credential provider. Key disimpan terenkripsi dan hanya
 * dibaca adapter. Agent yang menunggu provider ini otomatis aktif (DESIGN.md §4.5).
 */
export async function setProvider(ctx: OfficeContext, id: ProviderId, input: { apiKey?: string; defaultModel: string }) {
  if (!textProvidersEnabled()) throw new UserError(TEXT_PROVIDERS_OFF);
  const [existing] = await ctx.db.select().from(providers).where(eq(providers.id, id));
  const apiKey = input.apiKey?.trim() || (existing ? ctx.secrets.decrypt(existing.apiKeyEnc) : '');
  if (!apiKey) throw new UserError('API key wajib diisi');

  await withTx(ctx, async (tx, emit) => {
    const values = {
      apiKeyEnc: ctx.secrets.encrypt(apiKey),
      apiKeyLast4: apiKey.slice(-4),
      defaultModel: input.defaultModel,
      updatedAt: new Date(),
    };
    await tx.insert(providers).values({ id, ...values }).onDuplicateKeyUpdate({ set: values });
    emit({ type: 'provider.configured', entityType: 'runtime', entityId: id, actor: 'owner', payload: { defaultModel: input.defaultModel } });

    const waiting = await tx.select().from(agents).where(and(eq(agents.runtime, id), eq(agents.status, 'waiting_provider')));
    for (const a of waiting) {
      await tx.update(agents).set({ status: 'active', model: a.model ?? input.defaultModel }).where(eq(agents.id, a.id));
      emit({ type: 'agent.activated', entityType: 'agent', entityId: a.id, actor: 'orchestrator', payload: { name: a.name, runtime: id } });
    }
  });
  register(ctx, id, apiKey, input.defaultModel);
  await promoteAllObjectives(ctx);
}

/** Owner mengubah runtime/model/status agent. Runtime yang belum dikonfigurasi → waiting_provider. */
export async function updateAgent(
  ctx: OfficeContext,
  id: string,
  input: { runtime?: RuntimeId; model?: string | null; status?: 'active' | 'inactive' },
) {
  if (input.runtime === 'openrouter' && !textProvidersEnabled()) throw new UserError(TEXT_PROVIDERS_OFF);
  await withTx(ctx, async (tx, emit) => {
    const [a] = await tx.select().from(agents).where(eq(agents.id, id));
    if (!a) throw new UserError('Agent tidak ditemukan');
    const runtime = input.runtime ?? (a.runtime as RuntimeId);
    let status = input.status ?? (a.status === 'waiting_provider' ? 'active' : a.status);
    if (status === 'active' && !ctx.runtimes.has(effectiveRuntime(ctx, runtime))) status = 'waiting_provider';
    const model = input.model !== undefined ? input.model : a.model;
    await tx.update(agents).set({ runtime, model, status }).where(eq(agents.id, id));
    emit({ type: 'agent.updated', entityType: 'agent', entityId: id, actor: 'owner', payload: { name: a.name, runtime, model, status } });
  });
  await promoteAllObjectives(ctx);
}

/**
 * Owner mencabut provider: key dihapus, runtime dilepas, dan agent yang memakainya menunggu provider
 * (bisa dipindah ke runtime lain atau dipasang kembali). Task yang sedang berjalan boleh selesai.
 */
export async function removeProvider(ctx: OfficeContext, id: ProviderId) {
  if (!textProvidersEnabled()) throw new UserError(TEXT_PROVIDERS_OFF);
  await withTx(ctx, async (tx, emit) => {
    const [existing] = await tx.select().from(providers).where(eq(providers.id, id));
    if (!existing) throw new UserError('Provider belum dipasang');
    await tx.delete(providers).where(eq(providers.id, id));
    const users = await tx.select().from(agents).where(and(eq(agents.runtime, id), eq(agents.status, 'active')));
    for (const a of users) {
      await tx.update(agents).set({ status: 'waiting_provider' }).where(eq(agents.id, a.id));
      emit({ type: 'agent.updated', entityType: 'agent', entityId: a.id, actor: 'orchestrator', payload: { name: a.name, runtime: id, status: 'waiting_provider', reason: 'Provider dicabut Owner' } });
    }
    emit({ type: 'provider.removed', entityType: 'runtime', entityId: id, actor: 'owner' });
  });
  ctx.runtimes.delete(id);
  ctx.limits.delete(id);
}
