import {
  S3Client, GetObjectCommand, DeleteObjectsCommand, HeadBucketCommand, CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3 driver — AWS S3, or any S3-compatible store (MinIO, Cloudflare R2, DigitalOcean Spaces…)
 * via `endpoint` + `forcePathStyle`. Objects are private; access only through the API.
 */
export function createS3Storage(cfg) {
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle,
    ...(cfg.credentials ? { credentials: cfg.credentials } : {}),
  });
  const Bucket = cfg.bucket;
  const full = (key) => `${cfg.prefix}${key}`;
  const encryption = cfg.sse
    ? { ServerSideEncryption: cfg.sse, ...(cfg.sse === 'aws:kms' && cfg.kmsKeyId ? { SSEKMSKeyId: cfg.kmsKeyId } : {}) }
    : {};

  return {
    name: 's3',

    /** Stream (or Buffer) → object. Multipart upload under the hood, so memory stays small. */
    async put(key, body, { contentType, contentDisposition } = {}) {
      const up = new Upload({
        client,
        params: { Bucket, Key: full(key), Body: body, ContentType: contentType || 'application/octet-stream', ContentDisposition: contentDisposition, ...encryption },
        queueSize: 2,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await up.done();
    },

    /** → { stream, contentType, length } or null when the object doesn't exist. */
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key: full(key) }));
        return { stream: r.Body, contentType: r.ContentType, length: r.ContentLength };
      } catch (e) {
        if (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404)) return null;
        throw e;
      }
    },

    /** Delete many keys (batches of 1000). Missing keys are fine. */
    async remove(keys) {
      const list = (keys || []).filter(Boolean);
      for (let i = 0; i < list.length; i += 1000) {
        const Objects = list.slice(i, i + 1000).map((k) => ({ Key: full(k) }));
        await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
      }
    },

    /** Short-lived GET URL (download mode "redirect"). */
    presign(key, { filename, contentType, expiresIn = cfg.presignTtl } = {}) {
      const cmd = new GetObjectCommand({
        Bucket,
        Key: full(key),
        ...(filename ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` } : {}),
        ...(contentType ? { ResponseContentType: contentType } : {}),
      });
      return getSignedUrl(client, cmd, { expiresIn });
    },

    /**
     * Readiness check (and optional bucket creation for local MinIO).
     * HeadBucket needs s3:ListBucket; least-privilege IAM users often only have Get/Put/DeleteObject,
     * so on 403 we probe with a tiny write + delete instead — exactly the access the app needs.
     */
    async check({ create = false } = {}) {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch (e) {
        const status = e.$metadata && e.$metadata.httpStatusCode;
        if (status === 403) {
          const probe = `_healthcheck/${Date.now()}-${Math.random().toString(36).slice(2)}`;
          await this.put(probe, Buffer.from('ok'), { contentType: 'text/plain' });
          await this.remove([probe]);
          return;
        }
        const missing = e.name === 'NotFound' || status === 404;
        if (!missing || !create) throw e;
        await client.send(new CreateBucketCommand({ Bucket }));
      }
    },

    client,
  };
}
