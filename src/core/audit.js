import { db } from '../db/knex.js';

/**
 * Append an entry to the admin activity log (Users & roles → Activity log).
 * kind: 'Invite' | 'Role' | 'Access' | 'Profile'. Pass a transaction as `q` when inside one.
 */
export function audit(req, text, kind, q = db) {
  const actor = req.actor || req.user;
  return q('audit_logs').insert({ actor_user_id: actor ? actor.id : null, actor_name: actor ? actor.name : 'System', text, kind });
}
