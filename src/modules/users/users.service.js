import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { config } from '../../config/index.js';
import { nextId } from '../../core/ids.js';
import { audit } from '../../core/audit.js';
import { pageParams, sortParam } from '../../core/http.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { newInvite, newReset } from '../auth/oneTime.js';
import { sendMail } from '../../core/mailer.js';
import { inviteEmail, resetEmail } from './users.emails.js';
import * as repo from './users.repository.js';
import { toUserDto } from './users.mapper.js';

/** Roles that become delivery members (Team & hours, timesheets) — same as the frontend. */
export const DELIVERY_ROLES = ['r-pm', 'r-tl', 'r-tm', 'r-qa'];
/** Roles that own leads / follow-ups. */
export const SALES_ROLES = ['r-sm', 'r-se'];
/** Built-in roles that are never delivery members. */
const NON_DELIVERY = ['r-super', 'r-admin', 'r-sm', 'r-se', 'r-client'];

/**
 * Does this role make someone a delivery member (Team & hours, project / milestone pickers)?
 * Built-in PM / Team Lead / Team Member / QA always do; a custom role (e.g. "Developer") does when
 * it can see timesheets, tasks or bugs.
 */
export function isDeliveryRole(role) {
  if (!role) return false;
  if (DELIVERY_ROLES.includes(role.id)) return true;
  if (NON_DELIVERY.includes(role.id)) return false;
  const p = role.perms || {};
  return !!((p.ts && p.ts.v) || (p.tasks && p.tasks.v) || (p.bugs && p.bugs.v));
}
export const TEAMS = ['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];
const SUPER_ROLE = 'r-super';

/** True when `id` is the only active Super Admin left — that account can't lose access, or nobody could manage the portal. */
async function isLastSuperAdmin(q, id) {
  const u = await q('users').where({ id }).first('role_id', 'status');
  if (!u || u.role_id !== SUPER_ROLE || u.status !== 'Active') return false;
  const [{ n }] = await q('users').where({ role_id: SUPER_ROLE, status: 'Active' }).whereNot({ id }).count('* as n');
  return Number(n) === 0;
}

const randomHue = () => Math.floor(Math.random() * 360);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const SORTS = { name: 'u.name', email: 'u.email', role: 'r.name', dept: 'u.dept', status: 'u.status', lastActiveAt: 'u.last_active_at', joinDate: 'u.join_date', createdAt: 'u.created_at' };

export async function list(query) {
  const p = pageParams(query);
  const [{ count }] = await repo.applyFilters(repo.base(), query).count('* as count');
  const qb = repo.applyFilters(repo.base(), query).select(repo.USER_COLS).limit(p.limit).offset(p.offset);
  const sort = sortParam(query.sort, SORTS, null);
  if (sort) qb.orderBy(sort[0], sort[1]).orderBy('u.id');
  // Default order like the frontend: Active → Invited → Deactivated, then name.
  else qb.orderByRaw("case u.status when 'Active' then 0 when 'Invited' then 1 else 2 end").orderBy('u.name').orderBy('u.id');
  return { rows: (await qb).map(toUserDto), meta: p.meta(Number(count)) };
}

async function getRow(id, q = db) {
  const u = await repo.findById(id, q);
  if (!u) throw notFound('User');
  return u;
}
export const get = async (id) => toUserDto(await getRow(id));

const roleById = (id, q = db) => q('roles').where({ id }).first('id', 'name', 'perms');

/** Only a Super Admin may grant the Super Admin role or change a Super Admin account. */
function guardSuper(req, ...roleIds) {
  if (!req.user.isSuper && roleIds.includes('r-super')) throw forbidden('Only a Super Admin can manage Super Admin accounts');
}

/** Same checks and messages as the frontend saveUser(). */
async function validateForm(m, editId, q) {
  if (!m.name || !m.name.trim()) throw unprocessable('Enter the person’s name.');
  if (!EMAIL_RE.test((m.email || '').trim())) throw unprocessable('Enter a valid work email.');
  const dup = await q('users').whereRaw('email = ?', [m.email.trim()]).modify((qb) => editId && qb.whereNot('id', editId)).first('id');
  if (dup) throw unprocessable('Someone already uses this email.');
  const role = await roleById(m.role, q);
  if (!role) throw unprocessable('Pick a role.');
  if (m.reportsTo) {
    if (m.reportsTo === editId) throw unprocessable('Someone can’t report to themselves.');
    if (!(await q('users').where({ id: m.reportsTo }).first('id'))) throw unprocessable('Pick who they report to.');
  }
  return role;
}

/**
 * Keep the linked delivery member / sales owner in step with the user (frontend saveUser):
 * delivery roles get a members row, sales roles a sales_owners row.
 */
async function syncPeople(trx, m, role, old) {
  const delivery = isDeliveryRole(role);
  const team = TEAMS.includes(m.dept) ? m.dept : 'Web';
  let memberId = old ? old.member_id : null;
  let ownerId = old ? old.owner_id : null;
  if (delivery && !memberId) {
    memberId = await nextId(trx, 'member');
    await trx('members').insert({ id: memberId, name: m.name, role_title: m.title || role.name, team, hue: m.hue ?? randomHue(), shift_hours: m.shiftHours });
  } else if (memberId) {
    await trx('members').where({ id: memberId }).update({
      name: m.name, shift_hours: m.shiftHours, ...(m.title ? { role_title: m.title } : {}), ...(delivery ? { team } : {}),
    });
  }
  if (SALES_ROLES.includes(m.role) && !ownerId) {
    ownerId = await nextId(trx, 'member').then((x) => `s${x.slice(1)}`);
    await trx('sales_owners').insert({ id: ownerId, name: m.name, hue: m.hue ?? randomHue() });
  } else if (ownerId) {
    await trx('sales_owners').where({ id: ownerId }).update({ name: m.name });
  }
  return { memberId, ownerId };
}

const norm = (b, prev = {}) => ({
  name: (b.name ?? prev.name ?? '').trim(),
  email: (b.email ?? prev.email ?? '').trim(),
  phone: b.phone ?? prev.phone ?? '',
  title: (b.title ?? prev.title ?? '').trim(),
  role: b.role ?? prev.role_id,
  dept: b.dept ?? prev.dept ?? '',
  reportsTo: b.reportsTo !== undefined ? b.reportsTo : prev.reports_to ?? null,
  joinDate: b.joinDate !== undefined ? b.joinDate : prev.join_date ?? null,
  shiftHours: b.shiftHours ?? (prev.shift_hours != null ? Number(prev.shift_hours) : 8),
  clientOf: b.clientOf ?? prev.client_of ?? [],
  hue: prev.hue,
});

const userCols = (m) => ({
  name: m.name, email: m.email, phone: m.phone, title: m.title, role_id: m.role, dept: m.dept, reports_to: m.reportsTo,
  join_date: m.joinDate, shift_hours: m.shiftHours, client_of: m.role === 'r-client' ? m.clientOf : [],
});

/**
 * Email a one-time link (invite or set-password). When the email went out the raw token is NOT returned
 * (only the recipient can use it); if email isn't configured or sending failed, the token is returned
 * once so the admin can share the link by hand.
 */
async function deliverLink(kind, { name, email, roleName, invitedBy }, tok) {
  const msg = kind === 'invite'
    ? inviteEmail({ name, email, roleName, invitedBy, token: tok.token })
    : resetEmail({ name, email, token: tok.token });
  const emailSent = await sendMail(msg);
  const field = kind === 'invite' ? 'invite' : 'reset';
  return emailSent
    ? { emailSent, [`${field}ExpiresAt`]: tok.expiresAt.toISOString() }
    : { emailSent, [`${field}Token`]: tok.token, [`${field}ExpiresAt`]: tok.expiresAt.toISOString() };
}

/** Invite (status Invited + one-time invite token, emailed) or add an Active user. */
export async function create(req, body) {
  const m = norm(body);
  guardSuper(req, m.role);
  const out = await db.transaction(async (trx) => {
    const role = await validateForm(m, null, trx);
    const id = await nextId(trx, 'user');
    const hue = randomHue();
    const { memberId, ownerId } = await syncPeople(trx, { ...m, hue }, role, null);
    const invite = body.sendInvite ? newInvite() : null;
    const reset = !body.sendInvite && !body.password ? newReset() : null;
    await trx('users').insert({
      id, ...userCols(m), hue, status: body.sendInvite ? 'Invited' : 'Active', invited_at: trx.fn.now(), member_id: memberId, owner_id: ownerId,
      password_hash: !body.sendInvite && body.password ? await bcrypt.hash(body.password, config.bcryptRounds) : null,
      invite_token_hash: invite?.hash ?? null, invite_expires_at: invite?.expiresAt ?? null,
      reset_token_hash: reset?.hash ?? null, reset_expires_at: reset?.expiresAt ?? null,
    });
    await audit(req, `${body.sendInvite ? 'invited ' : 'added '}${m.name} as ${role.name}`, 'Invite', trx);
    return { id, invite, reset, roleName: role.name };
  });
  const user = await get(out.id);
  const who = { name: m.name, email: m.email.trim(), roleName: out.roleName, invitedBy: req.actor.name };
  if (out.invite) return { ...user, ...(await deliverLink('invite', who, out.invite)) };
  if (out.reset) return { ...user, ...(await deliverLink('reset', who, out.reset)) };
  return user;
}

export async function update(req, id, body) {
  await db.transaction(async (trx) => {
    const old = await trx('users').where({ id }).forUpdate().first();
    if (!old) throw notFound('User');
    const m = norm(body, old);
    guardSuper(req, old.role_id, m.role);
    if (id === req.actor.id && m.role !== old.role_id && !req.actor.isSuper) throw forbidden('You can’t change your own role.');
    if (m.role !== old.role_id && await isLastSuperAdmin(trx, id)) throw unprocessable('The last Super Admin’s role can’t be changed.');
    const role = await validateForm(m, id, trx);
    const { memberId, ownerId } = await syncPeople(trx, m, role, old);
    await trx('users').where({ id }).update({ ...userCols(m), member_id: memberId, owner_id: ownerId });
    if (old.role_id !== m.role) {
      const from = await roleById(old.role_id, trx);
      await audit(req, `changed ${m.name} from ${from ? from.name : old.role_id} to ${role.name}`, 'Role', trx);
    } else {
      await audit(req, `updated ${m.name}’s profile`, 'Profile', trx);
    }
  });
  return get(id);
}

/** A user's linked delivery member / sales owner follows the account: inactive accounts drop off Live, attendance and pickers. */
async function setPersonActive(trx, u, active) {
  if (u.member_id) await trx('members').where({ id: u.member_id }).update({ active });
  if (u.owner_id) await trx('sales_owners').where({ id: u.owner_id }).update({ active });
}

/** Load a user for an admin action, refusing the last Super Admin / yourself where it matters. */
async function target(req, id, { what, protect = false } = {}) {
  const u = await getRow(id);
  guardSuper(req, u.role_id);
  if (protect && await isLastSuperAdmin(db, id)) throw unprocessable(`The last Super Admin can’t be ${what}.`);
  if (protect && id === req.actor.id) throw unprocessable(`You can’t ${what === 'deleted' ? 'delete' : 'deactivate'} your own account.`);
  return u;
}

export async function setStatus(req, id, status) {
  const u = await target(req, id, { what: 'deactivated', protect: status === 'Deactivated' });
  if (status === 'Deactivated' && u.status === 'Deactivated') throw unprocessable(`${u.name} is already deactivated.`);
  if (status === 'Active' && u.status !== 'Deactivated') throw unprocessable(`${u.name} isn’t deactivated.`);
  await db.transaction(async (trx) => {
    await trx('users').where({ id }).update({ status });
    await setPersonActive(trx, u, status === 'Active');
    if (status === 'Deactivated') await trx('refresh_tokens').where({ user_id: id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
    await audit(req, `${status === 'Deactivated' ? 'deactivated ' : 'reactivated '}${u.name}`, 'Access', trx);
  });
  return get(id);
}

/** Delete a user or cancel an invite. Active users must be deactivated first. */
export async function remove(req, id) {
  const u = await target(req, id, { what: 'deleted', protect: true });
  if (u.status === 'Active') throw unprocessable('Deactivate this user before deleting them.');
  await db.transaction(async (trx) => {
    // Keep the member / sales-owner row (time logs and leads reference it) but take it off
    // Live now, attendance and dropdowns.
    await setPersonActive(trx, u, false);
    await trx('users').where({ id }).del();
    await audit(req, `${u.status === 'Invited' ? 'cancelled the invite for ' : 'deleted '}${u.name}`, 'Access', trx);
  });
}

/** New invite token (the old one stops working). */
export async function resendInvite(req, id) {
  const u = await target(req, id);
  if (u.status !== 'Invited') throw unprocessable(`${u.name} has already accepted their invite.`);
  const inv = newInvite();
  await db.transaction(async (trx) => {
    await trx('users').where({ id }).update({ invite_token_hash: inv.hash, invite_expires_at: inv.expiresAt, invited_at: trx.fn.now() });
    await audit(req, `resent the invite to ${u.name}`, 'Invite', trx);
  });
  const role = await roleById(u.role_id);
  return { id, email: u.email, ...(await deliverLink('invite', { name: u.name, email: u.email, roleName: role?.name, invitedBy: req.actor.name }, inv)) };
}

/** One-time password reset token (used at POST /auth/reset-password). */
export async function resetPassword(req, id) {
  const u = await target(req, id);
  if (u.status === 'Invited') throw unprocessable(`${u.name} hasn’t accepted their invite yet — resend the invite instead.`);
  if (u.status === 'Deactivated') throw unprocessable(`${u.name} is deactivated — reactivate them first.`);
  const r = newReset();
  await db.transaction(async (trx) => {
    await trx('users').where({ id }).update({ reset_token_hash: r.hash, reset_expires_at: r.expiresAt });
    await audit(req, `sent a password reset to ${u.name}`, 'Access', trx);
  });
  return { id, email: u.email, ...(await deliverLink('reset', { name: u.name, email: u.email }, r)) };
}

/** Revoke every refresh token (access tokens still expire on their own within their short TTL). */
export async function forceLogout(req, id) {
  const u = await target(req, id);
  let revoked = 0;
  await db.transaction(async (trx) => {
    revoked = await trx('refresh_tokens').where({ user_id: id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
    await audit(req, `signed ${u.name} out of all devices`, 'Access', trx);
  });
  return { id, revokedSessions: revoked };
}
