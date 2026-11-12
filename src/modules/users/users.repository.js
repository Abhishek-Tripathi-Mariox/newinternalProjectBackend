import { db } from '../../db/knex.js';

export const USER_COLS = ['u.id', 'u.name', 'u.email', 'u.phone', 'u.title', 'u.role_id', 'r.name as role_name', 'u.dept', 'u.reports_to', 'u.join_date',
  'u.status', 'u.invited_at', 'u.last_active_at', 'u.hue', 'u.member_id', 'u.owner_id', 'u.client_of', 'u.shift_hours', 'u.created_at', 'u.updated_at'];

export const base = (q = db) => q('users as u').join('roles as r', 'r.id', 'u.role_id');

export function applyFilters(qb, f) {
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    qb.where((w) => w.whereILike('u.name', like).orWhereILike('u.email', like).orWhereILike('u.title', like));
  }
  if (f.role) qb.where('u.role_id', f.role);
  if (f.dept) qb.where('u.dept', f.dept);
  if (f.status) qb.where('u.status', f.status);
  return qb;
}

export const findById = (id, q = db) => base(q).where('u.id', id).first(USER_COLS);
