import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Local-disk driver (automated tests / quick runs without S3). Keys are paths under `root`. */
export function createLocalStorage(rootDir) {
  const root = path.resolve(rootDir);
  const abs = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return p;
  };
  return {
    name: 'local',
    async put(key, body) {
      const p = abs(key);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      if (Buffer.isBuffer(body) || typeof body === 'string') await fs.promises.writeFile(p, body);
      else await pipeline(body, fs.createWriteStream(p));
    },
    async get(key) {
      const p = abs(key);
      try {
        const st = await fs.promises.stat(p);
        return { stream: fs.createReadStream(p), contentType: undefined, length: st.size };
      } catch {
        return null;
      }
    },
    async remove(keys) {
      await Promise.all((keys || []).filter(Boolean).map((k) => fs.promises.unlink(abs(k)).catch(() => {})));
    },
    presign() {
      throw new Error('Presigned URLs need the s3 storage driver');
    },
    async check() {
      await fs.promises.mkdir(root, { recursive: true });
    },
  };
}
