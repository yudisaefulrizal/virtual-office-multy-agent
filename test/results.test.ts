import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createObjective } from '../src/orchestrator/office';
import { buildZip, listResults, objectiveZip } from '../src/orchestrator/results';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** Pembaca ZIP minimal untuk memverifikasi keluaran buildZip lewat central directory. */
function readZip(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + size);
    out[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nameLen;
  }
  return out;
}

describe('Hasil kerja', () => {
  it('buildZip menghasilkan arsip yang bisa dibaca kembali (termasuk nama UTF-8)', () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('halo '.repeat(100)) },
      { name: 'folder/kopi ☕.md', data: Buffer.from('x') },
    ]);
    expect(readZip(zip)).toEqual({ 'a.txt': 'halo '.repeat(100), 'folder/kopi ☕.md': 'x' });
  });

  it('mendaftar hasil objective yang selesai dan membuat ZIP berisi file + ringkasan', async () => {
    const o = await setupOffice();
    cleanup = async () => {
      await o.worker.stop();
      await o.close();
    };
    expect(await listResults(o.ctx)).toEqual([]);

    const { objectiveId } = await createObjective(o.ctx, { title: 'Caption kopi lokal' });
    await o.worker.drain();

    const results = await listResults(o.ctx);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.id).toBe(objectiveId);
    expect(r.outputs.map((x) => x.kind).sort()).toEqual(['research', 'work']);
    // Hasil akhir = konten; riset hanya bahan pendukung.
    expect(r.outputs.filter((x) => x.final).map((x) => x.kind)).toEqual(['work']);
    expect(r.finalCount).toBe(1);
    expect(r.fileCount).toBeGreaterThan(0);
    // Nama file relatif terhadap out/, bukan path workspace penuh.
    expect(r.outputs.flatMap((x) => x.files.map((f) => f.name))).toEqual(expect.arrayContaining(['result.md']));

    const z = await objectiveZip(o.ctx, objectiveId);
    const entries = readZip(z!.zip);
    expect(Object.keys(entries)).toContain('RINGKASAN.md');
    // ZIP bawaan hanya berisi hasil akhir; bahan pendukung hanya bila diminta.
    const finalFiles = r.outputs.filter((x) => x.final).reduce((n, x) => n + x.files.length, 0);
    expect(Object.keys(entries).filter((n) => n !== 'RINGKASAN.md').length).toBe(finalFiles);
    const all = readZip((await objectiveZip(o.ctx, objectiveId, true))!.zip);
    expect(Object.keys(all).filter((n) => n.startsWith('bahan-pendukung/')).length).toBeGreaterThan(0);
    expect(entries['RINGKASAN.md']).toContain('# Caption kopi lokal');
    expect(await objectiveZip(o.ctx, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
