import { config } from '../../config/index.js';
import { createS3Storage } from './s3.js';
import { createLocalStorage } from './local.js';

/**
 * File storage used for every upload (lead / project / bug / change-request documents).
 *   storage.put(key, streamOrBuffer, { contentType })   storage.get(key) → { stream, contentType, length } | null
 *   storage.remove([keys])                               storage.presign(key, { filename })  (s3 only)
 * Driver chosen by STORAGE_DRIVER (s3 | local). Keys look like `documents/2026/11/<uuid>.pdf`.
 */
export const storage = config.storage.driver === 's3'
  ? createS3Storage(config.storage.s3)
  : createLocalStorage(config.uploads.dir);

export const downloadMode = config.storage.driver === 's3' ? config.storage.s3.downloadMode : 'proxy';
