/**
 * Project / change-request file uploads, delegated to the shared documents module
 * (files were already streamed to storage — S3 — by middleware/upload.js).
 */
import { badRequest } from '../../core/errors.js';
import { documentsService, DOC_KINDS } from '../documents/documents.service.js';

/**
 * Record uploaded files against `entityType` ('project' | 'cr'). An explicit `kind` (one of the
 * document kinds) overrides the kind guessed from each file name. Returns document DTOs.
 */
export async function attachDocuments(entityType, entityId, files, user, trx, kind) {
  if (!files || !files.length) throw badRequest('Attach at least one file (form field "files")');
  const docs = await documentsService.attach(entityType, entityId, files, user, trx);
  if (kind && DOC_KINDS.includes(kind)) {
    await trx('documents').whereIn('id', docs.map((d) => d.id)).update({ kind });
    return docs.map((d) => ({ ...d, kind }));
  }
  return docs;
}

export const discardUploads = (files) => documentsService.discard(files);

/** Delete an entity's document rows in `trx`; returns a callback that removes the files (call after commit). */
export const removeDocuments = (entityType, entityId, trx) => documentsService.removeForEntity(entityType, entityId, trx);
