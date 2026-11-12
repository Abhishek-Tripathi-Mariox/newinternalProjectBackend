import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import multer from 'multer';
import { config } from '../config/index.js';
import { badRequest } from '../core/errors.js';
import { storage } from '../core/storage/index.js';

const BLOCKED = /\.(exe|bat|cmd|sh|ps1|msi|dll|com|scr|js|mjs|cjs|jar|php|html?)$/i;

/** Object key for a new upload: documents/YYYY/MM/<uuid><ext> — never the client's file name. */
function newKey(originalname) {
  const d = new Date();
  const ext = path.extname(originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  return `documents/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${randomUUID()}${ext}`;
}

/**
 * Multer storage engine that streams each file straight to the configured storage (S3 in
 * production) — no temp files, no whole-file buffering. Sets `file.key` and `file.size`.
 * If the file hits the size limit mid-stream the stored object is deleted again.
 */
const streamingStorage = {
  _handleFile(_req, file, cb) {
    const key = newKey(file.originalname);
    let size = 0;
    let truncated = false;
    const counter = new PassThrough();
    file.stream.on('data', (chunk) => { size += chunk.length; });
    file.stream.on('limit', () => { truncated = true; });
    file.stream.pipe(counter);
    storage.put(key, counter, { contentType: file.mimetype })
      .then(async () => {
        if (truncated) {
          await storage.remove([key]).catch(() => {});
          return cb(new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname));
        }
        cb(null, { key, size });
      })
      .catch(cb);
  },
  _removeFile(_req, file, cb) {
    storage.remove([file.key]).then(() => cb(null), cb);
  },
};

/** multipart/form-data file uploads (field "files", up to 10 per request, MAX_UPLOAD_MB each). */
export const upload = multer({
  storage: streamingStorage,
  limits: { fileSize: config.uploads.maxBytes, files: 10 },
  fileFilter: (_req, file, cb) => (BLOCKED.test(file.originalname) ? cb(badRequest(`File type not allowed: ${file.originalname}`)) : cb(null, true)),
});
