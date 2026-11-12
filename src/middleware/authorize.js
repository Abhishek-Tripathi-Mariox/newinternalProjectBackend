import { forbidden } from '../core/errors.js';

/** Does the principal's role allow `act` ('v' view | 'c' create | 'e' edit | 'd' delete) on `mod`? */
export function can(user, mod, act = 'v') {
  if (!user) return false;
  if (user.isSuper) return true;
  const p = user.role.perms[mod];
  return !!(p && p[act]);
}

/** Data scope for a module: 'all' | 'team' | 'own' (Super Admin is always 'all'). */
export function scopeOf(user, mod) {
  if (user.isSuper) return 'all';
  const p = user.role.perms[mod];
  return (p && p.v && p.scope) || 'all';
}

/**
 * Route guard: `authorize('leads', 'e')`. Sets req.scope (all/team/own) for the module so the
 * service layer can filter rows. Module keys match the frontend permission matrix:
 * dash, leads, fu, projects, tasks, bugs, ts, team, users.
 */
export const authorize = (mod, act = 'v') => (req, _res, next) => {
  if (!can(req.user, mod, act)) {
    const verb = { v: 'view', c: 'create', e: 'edit', d: 'delete' }[act] || act;
    throw forbidden(`The ${req.user.role.name} role can't ${verb} ${mod}`);
  }
  req.scope = scopeOf(req.user, mod);
  next();
};

/** CEO-only areas (Live now, Attendance, Reports): signed-in Super Admin, not previewing. */
export function requireSuperAdmin(req, _res, next) {
  if (!req.actor.isSuper || req.previewing) throw forbidden('Only the Super Admin can open this');
  next();
}
