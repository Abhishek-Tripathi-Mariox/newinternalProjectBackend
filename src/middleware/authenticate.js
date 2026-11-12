import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { unauthorized, forbidden } from '../core/errors.js';

/**
 * Load a user with their role and the derived "person id" (pid) used by attendance,
 * time logs and live status: the member id for delivery staff, the sales-owner id for sales.
 */
export async function loadPrincipal(userId) {
  const u = await db('users as u')
    .join('roles as r', 'r.id', 'u.role_id')
    .leftJoin('members as m', 'm.id', 'u.member_id')
    .where('u.id', userId)
    .first(
      'u.id', 'u.name', 'u.email', 'u.status', 'u.member_id', 'u.owner_id', 'u.client_of', 'u.dept', 'u.shift_hours',
      'r.id as role_id', 'r.name as role_name', 'r.perms', 'm.team as member_team',
    );
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    role: { id: u.role_id, name: u.role_name, perms: u.perms || {} },
    isSuper: u.role_id === 'r-super',
    memberId: u.member_id,
    ownerId: u.owner_id,
    clientOf: u.client_of || [],
    team: u.member_team || null,
    dept: u.dept,
    shiftHours: Number(u.shift_hours) || 8,
    pid: u.member_id || u.owner_id || u.id.replace(/^u-/, ''),
  };
}

/**
 * Requires `Authorization: Bearer <access token>`.
 * Sets req.actor (who is signed in) and req.user (whose permissions apply). They differ only when
 * a Super Admin sends `X-View-As: <userId>` to preview the portal as someone else — the same
 * "Preview as" feature as the frontend. Writes are still attributed to req.actor in audit logs.
 */
export async function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.accessSecret);
  } catch (e) {
    throw unauthorized(e.name === 'TokenExpiredError' ? 'Session expired — refresh your token' : 'Invalid token');
  }
  const actor = await loadPrincipal(payload.sub);
  if (!actor || actor.status !== 'Active') throw unauthorized('Account is not active');
  req.actor = actor;
  req.user = actor;

  const viewAs = req.get('x-view-as');
  if (viewAs && viewAs !== actor.id) {
    if (!actor.isSuper) throw forbidden('Only a Super Admin can preview as another user');
    const target = await loadPrincipal(viewAs);
    if (!target || target.status !== 'Active') throw forbidden('Preview user is not active');
    req.user = target;
    req.previewing = true;
  }
  next();
}
