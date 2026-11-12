import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { config } from '../../config/index.js';
import { unauthorized, unprocessable } from '../../core/errors.js';
import { signAccessToken, newRefreshToken, hashToken } from '../../core/tokens.js';
import { loadPrincipal } from '../../middleware/authenticate.js';

const INVALID = 'Invalid email or password';

/** Principal → the user object the frontend keeps for the session. */
export const principalDto = (p) => (p ? {
  id: p.id, name: p.name, email: p.email, status: p.status, role: p.role, isSuper: p.isSuper, memberId: p.memberId,
  ownerId: p.ownerId, clientOf: p.clientOf, team: p.team, dept: p.dept, shiftHours: p.shiftHours, pid: p.pid,
} : null);

/** Issue an access token + a stored (hashed) refresh token for a user (call after the user's changes are committed). */
async function issueSession(userId, meta, q = db) {
  const principal = await loadPrincipal(userId);
  const rt = newRefreshToken();
  await q('refresh_tokens').insert({ user_id: userId, token_hash: rt.hash, expires_at: rt.expiresAt, user_agent: meta.userAgent || null, ip: meta.ip || null });
  return { accessToken: signAccessToken(principal), refreshToken: rt.token, user: principalDto(principal) };
}

const inactiveMsg = (status) => `This account is ${(status || 'inactive').toLowerCase()}. Ask an admin to activate it.`;

export async function login({ email, password }, meta) {
  const u = await db('users').whereRaw('email = ?', [email.trim()]).first('id', 'status', 'password_hash');
  // Same message for unknown email and wrong password (no user enumeration).
  if (!u) throw unauthorized(INVALID);
  if (u.status !== 'Active') throw unauthorized(inactiveMsg(u.status));
  if (!u.password_hash || !(await bcrypt.compare(password, u.password_hash))) throw unauthorized(INVALID);
  await db('users').where({ id: u.id }).update({ last_active_at: db.fn.now() });
  return issueSession(u.id, meta);
}

/**
 * Rotate a refresh token: the presented token is revoked and a new one issued. Presenting a token
 * that was already revoked means it was stolen or replayed — every session of that user is revoked.
 */
export async function refresh(token, meta) {
  if (!token) throw unauthorized('No refresh token');
  return db.transaction(async (trx) => {
    const row = await trx('refresh_tokens').where({ token_hash: hashToken(token) }).forUpdate().first();
    if (!row) throw unauthorized('Invalid refresh token');
    if (row.revoked_at) {
      await trx('refresh_tokens').where({ user_id: row.user_id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
      return { reused: true };
    }
    if (new Date(row.expires_at) <= new Date()) throw unauthorized('Refresh token expired — sign in again');
    const user = await trx('users').where({ id: row.user_id }).first('status');
    if (!user || user.status !== 'Active') throw unauthorized('Account is not active');
    await trx('refresh_tokens').where({ id: row.id }).update({ revoked_at: trx.fn.now() });
    await trx('users').where({ id: row.user_id }).update({ last_active_at: trx.fn.now() });
    return issueSession(row.user_id, meta, trx);
  }).then((r) => {
    // Thrown outside the transaction so the revocation above is committed.
    if (r.reused) throw unauthorized('Refresh token was already used — all sessions were signed out');
    return r;
  });
}

export async function logout(token) {
  if (!token) return;
  await db('refresh_tokens').where({ token_hash: hashToken(token) }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}

export async function changePassword(userId, { currentPassword, newPassword }, meta) {
  const u = await db('users').where({ id: userId }).first('password_hash');
  if (!u || !u.password_hash || !(await bcrypt.compare(currentPassword, u.password_hash))) throw unprocessable('Your current password is wrong.');
  const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
  await db.transaction(async (trx) => {
    await trx('users').where({ id: userId }).update({ password_hash: hash, reset_token_hash: null, reset_expires_at: null });
    // Sign out every other device; the caller gets a fresh session.
    await trx('refresh_tokens').where({ user_id: userId }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
  });
  return issueSession(userId, meta);
}

/** Find a user by email whose one-time token (invite/reset) matches and has not expired. */
async function byOneTimeToken(email, token, kind) {
  const [hashCol, expCol] = kind === 'invite' ? ['invite_token_hash', 'invite_expires_at'] : ['reset_token_hash', 'reset_expires_at'];
  const u = await db('users').whereRaw('email = ?', [email.trim()]).first('id', 'name', 'status', hashCol, expCol);
  if (!u || !u[hashCol] || u[hashCol] !== hashToken(token) || !u[expCol] || new Date(u[expCol]) <= new Date()) {
    throw unprocessable(kind === 'invite' ? 'This invite link is invalid or has expired. Ask an admin to resend it.' : 'This reset link is invalid or has expired.');
  }
  return u;
}

/** Invited person sets their password: account becomes Active and they are signed in. */
export async function acceptInvite({ email, token, password }, meta) {
  const u = await byOneTimeToken(email, token, 'invite');
  if (u.status !== 'Invited') throw unprocessable('This invite was already used.');
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  await db.transaction(async (trx) => {
    const n = await trx('users').where({ id: u.id, status: 'Invited' }).update({ password_hash: hash, status: 'Active', invite_token_hash: null, invite_expires_at: null, last_active_at: trx.fn.now() });
    if (!n) throw unprocessable('This invite was already used.');
    await trx('audit_logs').insert({ actor_user_id: u.id, actor_name: u.name, text: `${u.name} accepted the invite`, kind: 'Invite' });
  });
  return issueSession(u.id, meta);
}

/** Complete an admin-issued password reset; signs the user out everywhere. */
export async function resetPassword({ email, token, password }) {
  const u = await byOneTimeToken(email, token, 'reset');
  if (u.status === 'Deactivated') throw unprocessable(inactiveMsg(u.status));
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  await db.transaction(async (trx) => {
    await trx('users').where({ id: u.id }).update({ password_hash: hash, reset_token_hash: null, reset_expires_at: null });
    await trx('refresh_tokens').where({ user_id: u.id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
  });
}
