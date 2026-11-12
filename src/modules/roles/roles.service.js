import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { audit } from '../../core/audit.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { MODS } from './roles.schemas.js';

const LOCKED_MSG = 'Super Admin is a locked system role';
const EMPTY_PERM = { v: false, c: false, e: false, d: false, scope: 'all' };
const randomHue = () => Math.floor(Math.random() * 360);
const iso = (d) => (d ? new Date(d).toISOString() : null);

const toDto = (r) => ({
  id: r.id, name: r.name, description: r.description, hue: r.hue, locked: r.locked, perms: r.perms,
  userCount: Number(r.user_count || 0), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

const withCounts = (q = db) => q('roles as r')
  .select('r.*', q.raw('(select count(*) from users u where u.role_id = r.id) as user_count'));

export async function list() {
  return (await withCounts().orderBy('r.created_at').orderBy('r.id')).map(toDto);
}

async function getRow(id, q = db) {
  const r = await withCounts(q).where('r.id', id).first();
  if (!r) throw notFound('Role');
  return r;
}
export const get = async (id) => toDto(await getRow(id));

/** "New role", "New role 2", … — role names are unique. */
async function freeName(trx, wanted) {
  const taken = new Set((await trx('roles').pluck('name')).map((n) => n.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 2; ; i++) if (!taken.has(`${wanted} ${i}`.toLowerCase())) return `${wanted} ${i}`;
}

const normalisePerms = (perms) => Object.fromEntries(MODS.map((m) => [m, { ...EMPTY_PERM, ...(perms?.[m] || {}) }]));

/** New role with a copy of Team Member's permissions (frontend newRole). */
export async function create(req, body) {
  const id = await db.transaction(async (trx) => {
    const base = (await trx('roles').where({ id: 'r-tm' }).first()) || (await trx('roles').orderBy('created_at', 'desc').first());
    const rid = await nextId(trx, 'role');
    await trx('roles').insert({
      id: rid, name: await freeName(trx, body.name || 'New role'), description: body.description || '', hue: randomHue(), locked: false,
      perms: JSON.stringify(normalisePerms(base?.perms)),
    });
    await audit(req, 'created a new role', 'Role', trx);
    return rid;
  });
  return get(id);
}

export async function duplicate(req, roleId) {
  const id = await db.transaction(async (trx) => {
    const src = await trx('roles').where({ id: roleId }).first();
    if (!src) throw notFound('Role');
    const rid = await nextId(trx, 'role');
    const name = await freeName(trx, `${src.name} (copy)`);
    await trx('roles').insert({ id: rid, name, description: src.description, hue: src.hue, locked: false, perms: JSON.stringify(normalisePerms(src.perms)) });
    await audit(req, `created role ${name}`, 'Role', trx);
    return rid;
  });
  return get(id);
}

/**
 * Apply a permission patch with the frontend toggle rules: turning View off clears Create/Edit/Delete,
 * turning any of Create/Edit/Delete on turns View on, and a scope can only be set while View is on.
 */
export function applyPermPatch(current, patch) {
  const out = normalisePerms(current);
  for (const [mod, p] of Object.entries(patch || {})) {
    const x = { ...out[mod], ...p };
    if (['c', 'e', 'd'].some((a) => p[a] === true)) x.v = true;
    else if (p.v === false) { x.c = false; x.e = false; x.d = false; }
    if (p.scope !== undefined && !x.v) throw unprocessable('Turn on View first');
    out[mod] = x;
  }
  return out;
}

export async function update(req, id, body) {
  await db.transaction(async (trx) => {
    const r = await trx('roles').where({ id }).forUpdate().first();
    if (!r) throw notFound('Role');
    if (r.locked) throw unprocessable(LOCKED_MSG);
    // No self-escalation: a non-Super-Admin can't edit the role they hold.
    if (!req.actor.isSuper && req.actor.role.id === id) throw forbidden('You can’t edit your own role.');
    const patch = {};
    if (body.name !== undefined && body.name !== r.name) {
      if (await trx('roles').whereRaw('lower(name) = lower(?)', [body.name]).whereNot({ id }).first('id')) throw unprocessable(`A role called “${body.name}” already exists.`);
      patch.name = body.name;
    }
    if (body.description !== undefined) patch.description = body.description;
    if (body.hue !== undefined) patch.hue = body.hue;
    if (body.perms) patch.perms = JSON.stringify(applyPermPatch(r.perms, body.perms));
    if (!Object.keys(patch).length) return;
    await trx('roles').where({ id }).update(patch);
    const what = body.perms ? 'permissions of' : '';
    await audit(req, `updated ${what ? `${what} ` : ''}role ${patch.name || r.name}`, 'Role', trx);
  });
  return get(id);
}

export async function remove(req, id) {
  await db.transaction(async (trx) => {
    const r = await getRow(id, trx);
    if (r.locked) throw unprocessable(LOCKED_MSG);
    const n = Number(r.user_count);
    if (n) throw unprocessable(`Can't delete role “${r.name}” — ${n} user${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} it`);
    await trx('roles').where({ id }).del();
    await audit(req, `deleted role ${r.name}`, 'Role', trx);
  });
}
