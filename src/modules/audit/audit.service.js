import { db } from '../../db/knex.js';
import { pageParams } from '../../core/http.js';

const toDto = (r) => ({ id: r.id, at: new Date(r.created_at).toISOString(), actor: r.actor_name, actorUserId: r.actor_user_id, text: r.text, kind: r.kind });

/** Users & roles → Activity log: newest first, optional kind filter. */
export async function list(f) {
  const p = pageParams(f);
  const filtered = () => db('audit_logs').modify((q) => f.kind && q.where({ kind: f.kind }));
  const [{ count }] = await filtered().count('* as count');
  const rows = await filtered().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(p.limit).offset(p.offset);
  return { rows: rows.map(toDto), meta: p.meta(Number(count)) };
}
