import { db } from '../db/knex.js';
import { scopeOf } from '../middleware/authorize.js';

/**
 * Who the current user may see for a module, mirroring the frontend's scopeState():
 *  - 'all'  → everyone
 *  - 'team' → people in the same delivery team as the user (plus the user)
 *  - 'own'  → only the user's own person id (member id / sales-owner id)
 * Returns { scope, pid, people: string[] | null } — `people` is null when unrestricted.
 */
export async function peopleScope(user, mod) {
  const scope = scopeOf(user, mod);
  if (scope === 'all') return { scope, pid: user.pid, people: null };
  if (scope === 'own' || !user.team) return { scope, pid: user.pid, people: [user.pid] };
  const rows = await db('members').where({ team: user.team }).pluck('id');
  return { scope, pid: user.pid, people: Array.from(new Set([user.pid, ...rows])) };
}

/**
 * Project ids the user may see (frontend rules): clients → their projects only; scope 'own' →
 * projects they manage or are on; 'team' → projects whose PM or a team member is in their team.
 * Returns null when unrestricted.
 */
export async function visibleProjectIds(user) {
  if (user.isSuper) return null;
  if (user.role.id === 'r-client') return user.clientOf || [];
  const { scope, people } = await peopleScope(user, 'projects');
  if (scope === 'all') return null;
  return db('projects as p')
    .leftJoin('project_members as pm', 'pm.project_id', 'p.id')
    .where((q) => q.whereIn('p.pm_member_id', people).orWhereIn('pm.member_id', people))
    .distinct('p.id')
    .pluck('p.id');
}

/** Apply an optional id allow-list to a query: `restrictTo(q, 'p.id', ids)`. */
export const restrictTo = (q, column, ids) => (ids ? q.whereIn(column, ids.length ? ids : ['__none__']) : q);
