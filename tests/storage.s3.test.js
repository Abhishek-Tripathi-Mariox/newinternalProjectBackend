/**
 * S3 storage driver against the local MinIO (`npm run storage:up`). Skipped when MinIO isn't
 * reachable, so CI without it still passes; the rest of the suite uses the local-disk driver.
 */
import { Readable } from 'node:stream';
import { createS3Storage } from '../src/core/storage/s3.js';

const cfg = {
  bucket: 'mariox-portal-test', region: 'ap-south-1', endpoint: process.env.TEST_S3_ENDPOINT || 'http://localhost:9000', forcePathStyle: true,
  credentials: { accessKeyId: 'mariox', secretAccessKey: 'mariox_dev_password' }, prefix: 'test/', sse: null, presignTtl: 60,
};
const s3 = createS3Storage(cfg);
let up = true;
beforeAll(async () => {
  try { await s3.check({ create: true }); } catch { up = false; }
});
const maybe = (name, fn) => test(name, async () => { if (!up) return console.warn('MinIO not reachable — skipped'); await fn(); });
const read = async (stream) => { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); };

maybe('put → get → remove (streamed body)', async () => {
  const body = Buffer.from('hello mariox '.repeat(1000));
  await s3.put('a/b.txt', Readable.from(body), { contentType: 'text/plain' });
  const got = await s3.get('a/b.txt');
  expect(got.contentType).toBe('text/plain');
  expect(got.length).toBe(body.length);
  expect((await read(got.stream)).equals(body)).toBe(true);
  await s3.remove(['a/b.txt']);
  expect(await s3.get('a/b.txt')).toBeNull();
});

maybe('presigned URL downloads the object with a filename', async () => {
  await s3.put('p.bin', Buffer.from('presigned!'), { contentType: 'application/octet-stream' });
  const url = await s3.presign('p.bin', { filename: 'Quote Q-1.pdf' });
  const r = await fetch(url);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-disposition')).toContain('Quote%20Q-1.pdf');
  expect(await r.text()).toBe('presigned!');
  await s3.remove(['p.bin']);
});

maybe('missing key → null; removing missing keys is fine', async () => {
  expect(await s3.get('nope/missing.pdf')).toBeNull();
  await expect(s3.remove(['nope/1', 'nope/2'])).resolves.toBeUndefined();
});
