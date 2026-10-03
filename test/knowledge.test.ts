import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { knowledge } from '../src/db/schema';
import { confidenceOf, isStale, keywordsOf, knowledgePromptSection, searchKnowledge } from '../src/orchestrator/knowledge';
import { createObjective } from '../src/orchestrator/office';
import { FakeRuntime, type FakeHandler } from '../src/runtimes/fake';
import type { RunRequest } from '../src/runtimes/runtime';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const propsOf = (req: RunRequest) => Object.keys((req.outputSchema as { properties?: object }).properties ?? {});

describe('Knowledge (unit)', () => {
  it('keyakinan dihitung dari jumlah URL sumber yang berbeda', () => {
    expect(confidenceOf([])).toBe('low');
    expect(confidenceOf(['tidak terverifikasi'])).toBe('low');
    expect(confidenceOf(['https://a.com/x'])).toBe('medium');
    expect(confidenceOf(['https://a.com/x', 'https://a.com/x'])).toBe('medium');
    expect(confidenceOf(['https://a.com/x', 'https://b.com/y'])).toBe('high');
  });

  it('kata kunci mengabaikan kata umum', () => {
    expect(keywordsOf('Buat satu caption Instagram tentang kopi lokal untuk Instagram')).toEqual(['instagram', 'caption', 'kopi', 'lokal']);
  });
});

describe('Knowledge (alur)', () => {
  it('riset menyimpan knowledge, lalu task berikutnya menerimanya di prompt', async () => {
    const handler: FakeHandler = async (req) => {
      if (propsOf(req).includes('findings')) {
        return {
          output: {
            summary: 'Riset Instagram',
            findings: [{ point: 'Publish butuh akun bisnis', source: 'https://developers.facebook.com/docs/instagram' }],
            artifacts: [],
            knowledge: [
              {
                topic: 'Instagram Graph API: publish konten',
                category: 'api',
                content: 'Publish konten Instagram butuh akun bisnis dan container media.',
                sources: ['https://developers.facebook.com/docs/instagram', 'https://developers.facebook.com/docs/graph-api'],
              },
            ],
          },
        };
      }
      return new FakeRuntime().run(req, new AbortController().signal);
    };
    const o = await setupOffice(handler);
    cleanup = async () => (await o.worker.stop(), await o.close());

    await createObjective(o.ctx, { title: 'Publish konten Instagram kopi', mode: 'planned' });
    await o.worker.drain();

    const [k] = await o.db.select().from(knowledge);
    expect(k).toMatchObject({ topic: 'Instagram Graph API: publish konten', category: 'api', confidence: 'high' });
    const days = (k!.recheckAfter.getTime() - k!.lastVerifiedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    // Objective berikutnya: knowledge ikut di prompt penulis.
    await createObjective(o.ctx, { title: 'Caption Instagram tentang publish konten', mode: 'direct' });
    await o.worker.drain();
    const last = o.runtime.calls.at(-1)!;
    expect(last.prompt).toContain('## Knowledge organisasi yang relevan');
    expect(last.prompt).toContain('Instagram Graph API: publish konten');
    expect(last.prompt).toMatch(/valid sampai \d{4}-\d{2}-\d{2}/);
  });

  it('knowledge yang lewat masa berlaku ditandai perlu verifikasi ulang; riset ulang memperbaruinya', async () => {
    const o = await setupOffice();
    cleanup = async () => (await o.worker.stop(), await o.close());
    await createObjective(o.ctx, { title: 'Riset contoh knowledge', mode: 'planned' });
    await o.worker.drain();
    const [k] = await o.db.select().from(knowledge);
    expect(k?.topic).toBe('Contoh knowledge riset');

    const past = new Date(Date.now() - 86_400_000);
    await o.db.update(knowledge).set({ recheckAfter: past, lastVerifiedAt: new Date(Date.now() - 90 * 86_400_000) }).where(eq(knowledge.id, k!.id));
    const [stale] = await searchKnowledge(o.db, 'contoh knowledge riset');
    expect(isStale(stale!)).toBe(true);
    expect(knowledgePromptSection([stale!], true)).toContain('PERLU VERIFIKASI ULANG');

    await createObjective(o.ctx, { title: 'Riset contoh knowledge lagi', mode: 'planned' });
    await o.worker.drain();
    const all = await o.db.select().from(knowledge);
    expect(all).toHaveLength(1); // diperbarui, bukan diduplikasi
    expect(isStale(all[0]!)).toBe(false);
    expect(o.emitted.some((e) => e.type === 'knowledge.updated')).toBe(true);
  });
});
