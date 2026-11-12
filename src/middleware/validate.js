import { validationError } from '../core/errors.js';

const format = (issues) => issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/**
 * Validate and coerce request parts with Zod schemas: validate({ body, query, params }).
 * Parsed values are stored on req.valid (Express 5's req.query is read-only), and req.body is
 * replaced so unknown keys are stripped before reaching the service layer.
 */
export const validate = (schemas) => (req, _res, next) => {
  req.valid = req.valid || {};
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const r = schemas[part].safeParse(req[part] ?? {});
    if (!r.success) throw validationError(format(r.error.issues));
    req.valid[part] = r.data;
    if (part === 'body') req.body = r.data;
  }
  next();
};
