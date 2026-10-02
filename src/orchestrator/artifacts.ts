import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export interface ScannedFile {
  path: string; // relatif terhadap root workspaces
  sha256: string;
  bytes: number;
  mimeType: string | null;
}

/** Artifact = semua file di out/ setelah run. Agent tidak perlu melaporkannya manual. */
export async function scanOutDir(workspacesDir: string, outDir: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const [buf, info] = await Promise.all([readFile(full), stat(full)]);
        files.push({
          path: path.relative(workspacesDir, full),
          sha256: createHash('sha256').update(buf).digest('hex'),
          bytes: info.size,
          mimeType: MIME[path.extname(e.name).toLowerCase()] ?? null,
        });
      }
    }
  };
  await walk(outDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
