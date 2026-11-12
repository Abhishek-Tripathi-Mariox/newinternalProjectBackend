import request from 'supertest';
import { app, resetDb, closeDb, as, clearTokens, PASSWORD } from './helpers.js';
import { db } from '../src/db/knex.js';

const API = '/api/v1';
const lastAudit = () => db('audit_logs').orderBy('id', 'desc').first();

beforeAll(async () => { await resetDb(); clearTokens(); });
afterAll(closeDb);

describe('GET /users', () => {
  test('lists with pagination meta, default order Active → Invited → Deactivated', async () => {
    const res = await (await as('ceo@test.io')).get(`${API}/users?pageSize=100`);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 100, total: 10, pageCount: 1 });
    const statuses = res.body.data.map((u) => u.status);
    expect(statuses[statuses.length - 1]).toBe('Deactivated');
    expect(res.body.data[0]).toEqual(expect.objectContaining({ id: expect.any(String), role: expect.any(String), roleName: expect.any(String) }));
    expect(res.body.data[0].passwordHash).toBeUndefined();
  });

  test('filters q / role / dept / status, sorts and pages', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.get(`${API}/users?q=gupta`)).body.data.map((u) => u.id)).toEqual(['u-vg']);
    expect((await ceo.get(`${API}/users?role=r-tm&status=Active`)).body.data.map((u) => u.id).sort()).toEqual(['u-si', 'u-vg']);
    expect((await ceo.get(`${API}/users?dept=Sales`)).body.meta.total).toBe(2);
    const sorted = await ceo.get(`${API}/users?sort=-name&pageSize=2&page=2`);
    expect(sorted.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 10, pageCount: 5 });
    expect(sorted.body.data).toHaveLength(2);
    expect((await ceo.get(`${API}/users?status=Bogus`)).status).toBe(422);
  });

  test('403 for roles without users view', async () => {
    const res = await (await as('pm@test.io')).get(`${API}/users`);
    expect(res.status).toBe(403);
  });

  test('preview as (X-View-As) applies the previewed role permissions', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.get(`${API}/users`).set('X-View-As', 'u-mj')).status).toBe(403);
    expect((await ceo.get(`${API}/users`).set('X-View-As', 'u-admin')).status).toBe(200);
  });

  test('GET /users/:id and 404', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.get(`${API}/users/u-mj`)).body.data).toMatchObject({ id: 'u-mj', memberId: 'mj', role: 'r-pm' });
    expect((await ceo.get(`${API}/users/u-nope`)).status).toBe(404);
  });
});

describe('POST /users', () => {
  test('frontend validation wording', async () => {
    const admin = await as('admin@test.io');
    const post = (b) => admin.post(`${API}/users`).send({ role: 'r-tm', ...b });
    let r = await post({ name: '  ', email: 'a@b.co' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'RULE_VIOLATION', message: 'Enter the person’s name.' });
    r = await post({ name: 'X', email: 'not-an-email' });
    expect(r.body.error.message).toBe('Enter a valid work email.');
    r = await post({ name: 'X', email: 'DEV@test.io' });
    expect(r.body.error.message).toBe('Someone already uses this email.');
    r = await admin.post(`${API}/users`).send({ name: 'X', email: 'x@test.io' });
    expect(r.status).toBe(422); // role required
  });

  test('invite a delivery user → Invited + members row + audit', async () => {
    const admin = await as('admin@test.io');
    const res = await admin.post(`${API}/users`).send({ name: 'Riya Dev', email: 'riya@test.io', role: 'r-tm', dept: 'Mobile', title: 'Flutter Dev', shiftHours: 9 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'Invited', role: 'r-tm', dept: 'Mobile', shiftHours: 9 });
    expect(res.body.data.inviteToken).toEqual(expect.any(String));
    const m = await db('members').where({ id: res.body.data.memberId }).first();
    expect(m).toMatchObject({ name: 'Riya Dev', role_title: 'Flutter Dev', team: 'Mobile' });
    expect(Number(m.shift_hours)).toBe(9);
    const a = await lastAudit();
    expect(a).toMatchObject({ text: 'invited Riya Dev as Team Member', kind: 'Invite', actor_name: 'Ada Admin', actor_user_id: 'u-admin' });
  });

  test('add an active sales user → sales_owners row; non-team dept falls back to Web for delivery', async () => {
    const admin = await as('admin@test.io');
    const res = await admin.post(`${API}/users`).send({ name: 'Sam Sales', email: 'sam@test.io', role: 'r-se', dept: 'Sales', sendInvite: false, password: 'sampass123' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('Active');
    expect(res.body.data.ownerId).toEqual(expect.any(String));
    expect(await db('sales_owners').where({ id: res.body.data.ownerId }).first()).toMatchObject({ name: 'Sam Sales' });
    expect((await lastAudit()).text).toBe('added Sam Sales as Sales Executive');
    expect((await request(app).post(`${API}/auth/login`).send({ email: 'sam@test.io', password: 'sampass123' })).status).toBe(200);

    const qa = await admin.post(`${API}/users`).send({ name: 'Hari HR', email: 'hari@test.io', role: 'r-qa', dept: 'HR', sendInvite: false });
    expect(qa.body.data.resetToken).toEqual(expect.any(String)); // active, no password → one-time set-password token
    expect((await db('members').where({ id: qa.body.data.memberId }).first()).team).toBe('Web');
  });

  test('only a Super Admin may create a Super Admin; non-creators get 403', async () => {
    const admin = await as('admin@test.io');
    expect((await admin.post(`${API}/users`).send({ name: 'Boss', email: 'boss@test.io', role: 'r-super' })).status).toBe(403);
    expect((await (await as('sm@test.io')).post(`${API}/users`).send({ name: 'Y', email: 'y@test.io', role: 'r-tm' })).status).toBe(403);
  });
});

describe('PATCH /users/:id', () => {
  test('role change audits "changed X from A to B" and creates the member row', async () => {
    const admin = await as('admin@test.io');
    const res = await admin.patch(`${API}/users/u-ps`).send({ role: 'r-tl', dept: 'Backend' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'r-tl', ownerId: 'ps' });
    expect(res.body.data.memberId).toEqual(expect.any(String));
    expect((await db('members').where({ id: res.body.data.memberId }).first()).team).toBe('Backend');
    expect(await lastAudit()).toMatchObject({ text: 'changed Priya Sharma from Sales Executive to Team Lead', kind: 'Role' });
  });

  test('profile edit audits and syncs the member', async () => {
    const admin = await as('admin@test.io');
    const res = await admin.patch(`${API}/users/u-vg`).send({ name: 'Vikas G', title: 'Senior Android Dev' });
    expect(res.status).toBe(200);
    expect(await lastAudit()).toMatchObject({ text: 'updated Vikas G’s profile', kind: 'Profile' });
    expect(await db('members').where({ id: 'vg' }).first()).toMatchObject({ name: 'Vikas G', role_title: 'Senior Android Dev' });
    expect((await admin.patch(`${API}/users/u-vg`).send({ email: 'pm@test.io' })).body.error.message).toBe('Someone already uses this email.');
  });

  test('Admin cannot edit the Super Admin; 403 without users edit', async () => {
    expect((await (await as('admin@test.io')).patch(`${API}/users/u-ceo`).send({ name: 'X' })).status).toBe(403);
    expect((await (await as('dev@test.io')).patch(`${API}/users/u-si`).send({ name: 'X' })).status).toBe(403);
  });
});

describe('status, delete, invite, reset, force logout', () => {
  test('deactivate / reactivate with audit; the owner and yourself are protected', async () => {
    const ceo = await as('ceo@test.io');
    const d = await ceo.post(`${API}/users/u-si/deactivate`);
    expect(d.status).toBe(200);
    expect(d.body.data.status).toBe('Deactivated');
    expect(await lastAudit()).toMatchObject({ text: 'deactivated Sneha Iyer', kind: 'Access' });
    expect((await request(app).post(`${API}/auth/login`).send({ email: 'dev2@test.io', password: PASSWORD })).status).toBe(401);
    const r = await ceo.post(`${API}/users/u-si/reactivate`);
    expect(r.body.data.status).toBe('Active');
    expect((await lastAudit()).text).toBe('reactivated Sneha Iyer');
    expect((await ceo.post(`${API}/users/u-si/reactivate`)).status).toBe(422);

    expect((await ceo.post(`${API}/users/u-ceo/deactivate`)).body.error.message).toBe('The last Super Admin can’t be deactivated.');
    const demote = await ceo.patch(`${API}/users/u-ceo`).send({ name: 'CEO', email: 'ceo@test.io', role: 'r-admin' });
    expect(demote.body.error.message).toBe('The last Super Admin’s role can’t be changed.');
    const admin = await as('admin@test.io');
    expect((await admin.post(`${API}/users/u-admin/deactivate`)).body.error.message).toBe('You can’t deactivate your own account.');
  });

  test('delete only non-Active users; cancel invite wording; Admin lacks users delete', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.delete(`${API}/users/u-dn`)).status).toBe(422);
    expect((await ceo.delete(`${API}/users/u-ceo`)).status).toBe(422);
    expect((await (await as('admin@test.io')).delete(`${API}/users/u-off`)).status).toBe(403);
    expect((await ceo.delete(`${API}/users/u-off`)).status).toBe(204);
    expect((await lastAudit()).text).toBe('deleted Old Dev');
    const inv = await ceo.post(`${API}/users`).send({ name: 'Temp', email: 'temp@test.io', role: 'r-tm' });
    expect((await ceo.delete(`${API}/users/${inv.body.data.id}`)).status).toBe(204);
    expect((await lastAudit()).text).toBe('cancelled the invite for Temp');
  });

  test('resend invite issues a new token (old one stops working)', async () => {
    const admin = await as('admin@test.io');
    const inv = await admin.post(`${API}/users`).send({ name: 'Kim', email: 'kim@test.io', role: 'r-tm' });
    const r = await admin.post(`${API}/users/${inv.body.data.id}/resend-invite`);
    expect(r.status).toBe(200);
    expect(r.body.data.inviteToken).not.toBe(inv.body.data.inviteToken);
    expect(await lastAudit()).toMatchObject({ text: 'resent the invite to Kim', kind: 'Invite' });
    const old = await request(app).post(`${API}/auth/accept-invite`).send({ email: 'kim@test.io', token: inv.body.data.inviteToken, password: 'kimpass123' });
    expect(old.status).toBe(422);
    expect((await admin.post(`${API}/users/u-mj/resend-invite`)).status).toBe(422);
  });

  test('reset password returns a one-time token and audits', async () => {
    const admin = await as('admin@test.io');
    const r = await admin.post(`${API}/users/u-mj/reset-password`);
    expect(r.status).toBe(200);
    expect(r.body.data.resetToken).toEqual(expect.any(String));
    expect(await lastAudit()).toMatchObject({ text: 'sent a password reset to Meera Joshi', kind: 'Access' });
  });

  test('force logout revokes every refresh token', async () => {
    await request(app).post(`${API}/auth/login`).send({ email: 'qa@test.io', password: PASSWORD });
    const admin = await as('admin@test.io');
    const r = await admin.post(`${API}/users/u-dn/force-logout`);
    expect(r.status).toBe(200);
    expect(r.body.data.revokedSessions).toBeGreaterThan(0);
    expect(await db('refresh_tokens').where({ user_id: 'u-dn' }).whereNull('revoked_at')).toHaveLength(0);
    expect(await lastAudit()).toMatchObject({ text: 'signed Divya Nair out of all devices', kind: 'Access' });
  });
});

describe('GET /audit-logs', () => {
  test('newest first, filter by kind, paginated; 403 without users view', async () => {
    const ceo = await as('ceo@test.io');
    const all = await ceo.get(`${API}/audit-logs?pageSize=5`);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(5);
    expect(all.body.meta.total).toBeGreaterThan(5);
    const ids = all.body.data.map((x) => x.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(all.body.data[0]).toEqual(expect.objectContaining({ at: expect.any(String), actor: expect.any(String), text: expect.any(String) }));
    const roles = await ceo.get(`${API}/audit-logs?kind=Role`);
    expect(roles.body.data.every((x) => x.kind === 'Role')).toBe(true);
    expect((await ceo.get(`${API}/audit-logs?kind=Nope`)).status).toBe(422);
    expect((await (await as('pm@test.io')).get(`${API}/audit-logs`)).status).toBe(403);
  });
});

describe('/members and /sales-owners', () => {
  test('any signed-in user can read the directory', async () => {
    const dev = await as('dev@test.io');
    const m = await dev.get(`${API}/members?team=Mobile`);
    expect(m.status).toBe(200);
    expect(m.body.data.map((x) => x.id).sort()).toEqual(expect.arrayContaining(['si', 'vg']));
    expect(m.body.data[0]).toEqual(expect.objectContaining({ roleTitle: expect.any(String), team: 'Mobile', shiftHours: expect.any(Number) }));
    expect((await dev.get(`${API}/members/vg`)).body.data).toMatchObject({ id: 'vg', userId: 'u-vg' });
    expect((await dev.get(`${API}/members/zz`)).status).toBe(404);
    const o = await (await as('client@test.io')).get(`${API}/sales-owners`);
    expect(o.status).toBe(200);
    expect(o.body.data.map((x) => x.id)).toEqual(expect.arrayContaining(['ak', 'ps']));
  });

  test('PATCH /members/:id needs users edit; syncs the user shift', async () => {
    expect((await (await as('pm@test.io')).patch(`${API}/members/vg`).send({ shiftHours: 7 })).status).toBe(403);
    const admin = await as('admin@test.io');
    const r = await admin.patch(`${API}/members/vg`).send({ shiftHours: 7, costPerHour: 900 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ shiftHours: 7, costPerHour: 900 });
    expect(Number((await db('users').where({ id: 'u-vg' }).first()).shift_hours)).toBe(7);
    expect((await admin.patch(`${API}/members/vg`).send({ shiftHours: 30 })).status).toBe(422);
  });
});
