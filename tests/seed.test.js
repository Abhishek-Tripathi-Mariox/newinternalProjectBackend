/**
 * Seeds: 01_base (roles, masters, settings) and 02_super_admin (the only starting account).
 * Runs inside a rolled-back transaction so the shared test fixtures are untouched.
 */
import bcrypt from 'bcryptjs';
import { db } from '../src/db/knex.js';
import { seed as seedBase, ROLES } from '../src/db/seeds/01_base.js';
import { createSuperAdmin } from '../src/db/seeds/02_super_admin.js';

const quiet = () => {};
let trx;

beforeAll(async () => { await db.migrate.latest({ directory: './src/db/migrations', loadExtensions: ['.js'] }); }, 60000);
beforeEach(async () => {
  trx = await db.transaction();
  await trx.raw('truncate users restart identity cascade');
  await seedBase(trx);
});
afterEach(async () => { await trx.rollback(); });
afterAll(() => db.destroy());

test('base seed loads every role', async () => {
  expect(Number((await trx('roles').count('* as n'))[0].n)).toBeGreaterThanOrEqual(ROLES.length);
});

test('creates one active Super Admin with the configured password, and is idempotent', async () => {
  const r = await createSuperAdmin(trx, { email: ' Boss@Example.com ', password: 'StrongPass1', name: 'Boss', rounds: 4, log: quiet });
  expect(r.created).toBe(true);
  expect(r.user).toMatchObject({ email: 'boss@example.com', name: 'Boss', role_id: 'r-super', status: 'Active' });
  expect(await bcrypt.compare('StrongPass1', r.user.password_hash)).toBe(true);

  const again = await createSuperAdmin(trx, { email: 'other@example.com', password: 'Different1', rounds: 4, log: quiet });
  expect(again.created).toBe(false);
  expect((await trx('users')).length).toBe(1);
  expect(await bcrypt.compare('StrongPass1', (await trx('users').first()).password_hash)).toBe(true);
});

test('generates a password when none is set; rejects bad input', async () => {
  const r = await createSuperAdmin(trx, { email: 'a@b.co', password: '', rounds: 4, log: quiet });
  expect(r.password).toHaveLength(16);
  expect(await bcrypt.compare(r.password, r.user.password_hash)).toBe(true);
  await expect(createSuperAdmin(trx, { email: 'not-an-email', password: 'x'.repeat(10), log: quiet })).rejects.toThrow(/SUPER_ADMIN_EMAIL/);
  await expect(createSuperAdmin(trx, { email: 'c@d.co', password: 'short', log: quiet })).rejects.toThrow(/8 characters/);
});
