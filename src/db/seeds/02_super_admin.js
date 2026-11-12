/**
 * Creates the first Super Admin — the only account the portal starts with. Everyone else is invited
 * from Users & roles. Reads SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD / SUPER_ADMIN_NAME from .env.
 *
 * Idempotent: if a Super Admin (or a user with that email) already exists nothing is changed, so it is
 * safe to run on every deploy and never resets a password someone has since changed.
 * If SUPER_ADMIN_PASSWORD is empty a strong random password is generated and printed once.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const SUPER_ROLE = 'r-super';

export async function createSuperAdmin(knex, {
  email = process.env.SUPER_ADMIN_EMAIL,
  password = process.env.SUPER_ADMIN_PASSWORD,
  name = process.env.SUPER_ADMIN_NAME || 'Super Admin',
  rounds = Number(process.env.BCRYPT_ROUNDS) || 10,
  log = console.log,
} = {}) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set SUPER_ADMIN_EMAIL in .env to a valid email before seeding.');
  }
  if (password && password.length < 8) throw new Error('SUPER_ADMIN_PASSWORD must be at least 8 characters.');

  const existing = await knex('users').where({ role_id: SUPER_ROLE }).orWhereRaw('lower(email) = ?', [email]).first();
  if (existing) {
    log(`Super Admin seed: ${existing.email} already exists — nothing changed.`);
    return { created: false, user: existing };
  }

  const generated = !password;
  const pw = password || randomBytes(12).toString('base64url');
  const { rows } = await knex.raw('select nextval(?) as n', ['user_code_seq']);
  const today = new Date().toISOString().slice(0, 10);
  const [user] = await knex('users').insert({
    id: `u-${Number(rows[0].n).toString(36)}`,
    name: String(name).trim() || 'Super Admin',
    email,
    title: 'Super Admin',
    role_id: SUPER_ROLE,
    dept: 'Management',
    join_date: today,
    status: 'Active',
    hue: 265,
    password_hash: await bcrypt.hash(pw, rounds),
  }).returning('*');

  log(`Super Admin seed: created ${email}${generated ? ` with generated password: ${pw}  (change it after first sign-in)` : ''}`);
  return { created: true, user, password: generated ? pw : undefined };
}

export async function seed(knex) {
  await createSuperAdmin(knex);
}
