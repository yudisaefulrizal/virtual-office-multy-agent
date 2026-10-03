import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Credential provider (API key) disimpan terenkripsi di database. Kunci enkripsi
 * berasal dari VO_SECRET_KEY, atau dibuat sekali di file .vo-secret (mode 600).
 * Credential tidak pernah masuk ke prompt, env, atau workspace agent.
 */
export class SecretBox {
  private key: Buffer;

  constructor(keyHex: string) {
    this.key = Buffer.from(keyHex, 'hex');
    if (this.key.length !== 32) throw new Error('Kunci rahasia harus 32 byte (64 karakter hex)');
  }

  static load(envKey: string | undefined, file: string) {
    if (envKey) return new SecretBox(envKey);
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    return new SecretBox(readFileSync(file, 'utf8').trim());
  }

  encrypt(plain: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  decrypt(sealed: string) {
    const buf = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }
}
