import { randomUUID } from 'node:crypto';

/** Correlation id: reuse a sane incoming X-Request-Id or create one; echoed on the response. */
export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w.-]{8,100}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
