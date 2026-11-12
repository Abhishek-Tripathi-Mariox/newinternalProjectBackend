import multer from 'multer';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { config } from '../config/index.js';

/** 404 for unknown routes (mounted after all routers). */
export function notFoundRoute(req, res) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: req.id } });
}

/** Map Postgres errors to client errors where the cause is the request, not the server. */
function fromPg(err) {
  switch (err.code) {
    case '23505': return new AppError(409, 'CONFLICT', 'A record with these details already exists', { constraint: err.constraint });
    case '23503': return new AppError(409, 'REFERENCE_ERROR', 'A referenced record does not exist or is still in use', { constraint: err.constraint });
    case '23514': return new AppError(422, 'CHECK_VIOLATION', 'A value is out of the allowed range', { constraint: err.constraint });
    case '22P02':
    case '22007':
    case '22008': return new AppError(400, 'BAD_REQUEST', 'Malformed value in request');
    default: return null;
  }
}

/** Central error handler: one JSON error shape, no stack traces leaked outside development. */
export function errorHandler(err, req, res, _next) {
  let e = err;
  if (!(e instanceof AppError)) {
    if (e instanceof multer.MulterError) {
      e = new AppError(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_ERROR', e.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${Math.round(config.uploads.maxBytes / 1048576)} MB` : e.message);
    } else if (e.type === 'entity.parse.failed') {
      e = new AppError(400, 'BAD_JSON', 'Request body is not valid JSON');
    } else if (e.type === 'entity.too.large') {
      e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else {
      e = fromPg(e) || e;
    }
  }

  if (e instanceof AppError) {
    if (e.status >= 500) logger.error({ err, requestId: req.id }, e.message);
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: req.id } });
  }

  logger.error({ err, requestId: req.id }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side', requestId: req.id, ...(config.env === 'development' ? { debug: String(err.stack || err) } : {}) },
  });
}
