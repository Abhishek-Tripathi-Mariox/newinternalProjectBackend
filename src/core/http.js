/**
 * Response helpers so every endpoint returns the same envelope:
 *   success: { data, meta? }
 *   error:   { error: { code, message, details?, requestId } }   (see middleware/errorHandler)
 */
export const ok = (res, data, meta) => res.json(meta ? { data, meta } : { data });
export const created = (res, data) => res.status(201).json({ data });
export const noContent = (res) => res.status(204).end();

/**
 * Parse ?page=&pageSize= (1-based, pageSize capped at 100) and build pagination meta.
 * Use: const p = pageParams(req.query); ... query.limit(p.limit).offset(p.offset); ok(res, rows, p.meta(total))
 */
export function pageParams(query = {}, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number.parseInt(query.pageSize, 10) || defaultSize));
  return {
    page,
    pageSize,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    meta: (total) => ({ page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) }),
  };
}

/** Whitelisted ?sort=field or ?sort=-field → [column, direction]. */
export function sortParam(sort, allowed, fallback) {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  return allowed[key] ? [allowed[key], desc ? 'desc' : 'asc'] : fallback;
}
