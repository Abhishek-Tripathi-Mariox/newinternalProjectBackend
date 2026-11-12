import request from 'supertest';
import { app, resetDb, closeDb, as, clearTokens, PASSWORD } from './helpers.js';
import { db } from '../src/db/knex.js';

const API = '/api/v1';
const cookieOf = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('mx_refresh='));
const tokenOf = (res) => decodeURIComponent(cookieOf(res).split(';')[0].split('=')[1]);
const login = (email, password = PASSWORD) => request(app).post(`${API}/auth/login`).send({ email, password });

beforeAll(async () => { await resetDb(); clearTokens(); });
afterAll(closeDb);

describe('POST /auth/login', () => {
  test('returns access token, principal and an httpOnly refresh cookie', async () => {
    const res = await login('PM@test.io');
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ id: 'u-mj', role: { id: 'r-pm', name: 'Project Manager' }, memberId: 'mj', pid: 'mj', team: 'PMO', isSuper: false });
    expect(res.body.data.user.role.perms.projects.v).toBe(true);
    expect(res.body.data.refreshToken).toBeUndefined();
    const c = cookieOf(res);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Path=\/api\/v1\/auth/);
    const stored = await db('refresh_tokens').where({ user_id: 'u-mj' });
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(tokenOf(res)); // only the hash is stored
    expect((await db('users').where({ id: 'u-mj' }).first()).last_active_at).not.toBeNull();
  });

  test('unknown email and wrong password give the same 401', async () => {
    const a = await login('nobody@test.io');
    const b = await login('pm@test.io', 'wrong-password');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe('Invalid email or password');
    expect(b.body.error.message).toBe('Invalid email or password');
  });

  test('deactivated / invited accounts get the frontend wording', async () => {
    const res = await login('off@test.io');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('This account is deactivated. Ask an admin to activate it.');
    await db('users').insert({ id: 'u-inv', name: 'Inv', email: 'inv@test.io', role_id: 'r-tm', status: 'Invited' });
    const r2 = await login('inv@test.io', 'whatever1');
    expect(r2.body.error.message).toBe('This account is invited. Ask an admin to activate it.');
  });

  test('validation error for a missing password', async () => {
    const res = await request(app).post(`${API}/auth/login`).send({ email: 'pm@test.io' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /auth/refresh (rotation)', () => {
  test('rotates the token; reusing a revoked one revokes every session', async () => {
    const l = await login('dev@test.io');
    const t1 = tokenOf(l);
    const r1 = await request(app).post(`${API}/auth/refresh`).set('Cookie', `mx_refresh=${t1}`);
    expect(r1.status).toBe(200);
    expect(r1.body.data.accessToken).toEqual(expect.any(String));
    expect(r1.body.data.user.id).toBe('u-vg');
    const t2 = tokenOf(r1);
    expect(t2).not.toBe(t1);

    // Replaying t1 (already rotated) → 401 and t2 is revoked too.
    const replay = await request(app).post(`${API}/auth/refresh`).set('Cookie', `mx_refresh=${t1}`);
    expect(replay.status).toBe(401);
    const after = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: t2 });
    expect(after.status).toBe(401);
    expect(await db('refresh_tokens').where({ user_id: 'u-vg' }).whereNull('revoked_at')).toHaveLength(0);
  });

  test('no token → 204 (signed out), unknown token → 401', async () => {
    expect((await request(app).post(`${API}/auth/refresh`)).status).toBe(204);
    expect((await request(app).post(`${API}/auth/refresh`).send({ refreshToken: 'nope' })).status).toBe(401);
  });

  test('expired token → 401', async () => {
    const l = await login('dev2@test.io');
    await db('refresh_tokens').where({ user_id: 'u-si' }).update({ expires_at: new Date(Date.now() - 1000) });
    const res = await request(app).post(`${API}/auth/refresh`).set('Cookie', `mx_refresh=${tokenOf(l)}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  test('revokes the current refresh token and clears the cookie', async () => {
    const l = await login('qa@test.io');
    const t = tokenOf(l);
    const res = await request(app).post(`${API}/auth/logout`).set('Cookie', `mx_refresh=${t}`);
    expect(res.status).toBe(204);
    expect(cookieOf(res)).toMatch(/mx_refresh=;/);
    expect((await request(app).post(`${API}/auth/refresh`).set('Cookie', `mx_refresh=${t}`)).status).toBe(401);
  });
});

describe('GET /auth/me', () => {
  test('returns the signed-in principal', async () => {
    const res = await (await as('sm@test.io')).get(`${API}/auth/me`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'u-ak', ownerId: 'ak', pid: 'ak', previewing: false, viewAs: null });
  });

  test('401 without a token, 401 with a garbage token', async () => {
    expect((await request(app).get(`${API}/auth/me`)).status).toBe(401);
    expect((await request(app).get(`${API}/auth/me`).set('Authorization', 'Bearer x.y.z')).status).toBe(401);
  });

  test('Super Admin can preview as someone with X-View-As; others cannot', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get(`${API}/auth/me`).set('X-View-As', 'u-vg');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'u-ceo', previewing: true, viewAs: { id: 'u-vg', role: { id: 'r-tm' } } });
    const dev = await as('dev@test.io');
    expect((await dev.get(`${API}/auth/me`).set('X-View-As', 'u-ceo')).status).toBe(403);
  });
});

describe('POST /auth/change-password', () => {
  test('wrong current password → 422; success signs out other sessions', async () => {
    const l = await login('dev2@test.io');
    const old = tokenOf(l);
    const agent = await as('dev2@test.io');
    const bad = await agent.post(`${API}/auth/change-password`).send({ currentPassword: 'nope', newPassword: 'newsecret123' });
    expect(bad.status).toBe(422);
    expect((await agent.post(`${API}/auth/change-password`).send({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(422);
    const res = await agent.post(`${API}/auth/change-password`).send({ currentPassword: PASSWORD, newPassword: 'newsecret123' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect((await request(app).post(`${API}/auth/refresh`).set('Cookie', `mx_refresh=${old}`)).status).toBe(401);
    expect((await login('dev2@test.io', 'newsecret123')).status).toBe(200);
    expect((await login('dev2@test.io')).status).toBe(401);
  });
});

describe('invite → accept-invite, reset password', () => {
  test('invited user accepts with the token and is signed in', async () => {
    const admin = await as('admin@test.io');
    const inv = await admin.post(`${API}/users`).send({ name: 'Nina New', email: 'nina@test.io', role: 'r-tm', dept: 'Web', sendInvite: true });
    expect(inv.status).toBe(201);
    const { inviteToken } = inv.body.data;
    expect(inviteToken).toEqual(expect.any(String));

    const wrong = await request(app).post(`${API}/auth/accept-invite`).send({ email: 'nina@test.io', token: 'x'.repeat(20), password: 'ninapass123' });
    expect(wrong.status).toBe(422);
    const res = await request(app).post(`${API}/auth/accept-invite`).send({ email: 'nina@test.io', token: inviteToken, password: 'ninapass123' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: 'nina@test.io', status: 'Active' });
    expect(cookieOf(res)).toBeDefined();
    const again = await request(app).post(`${API}/auth/accept-invite`).send({ email: 'nina@test.io', token: inviteToken, password: 'ninapass123' });
    expect(again.status).toBe(422);
    expect((await login('nina@test.io', 'ninapass123')).status).toBe(200);
  });

  test('expired invite is refused', async () => {
    const admin = await as('admin@test.io');
    const inv = await admin.post(`${API}/users`).send({ name: 'Old Invite', email: 'oldinv@test.io', role: 'r-tm', sendInvite: true });
    await db('users').where({ id: inv.body.data.id }).update({ invite_expires_at: new Date(Date.now() - 1000) });
    const res = await request(app).post(`${API}/auth/accept-invite`).send({ email: 'oldinv@test.io', token: inv.body.data.inviteToken, password: 'whatever123' });
    expect(res.status).toBe(422);
  });

  test('admin reset token lets the user set a new password once', async () => {
    const admin = await as('admin@test.io');
    const r = await admin.post(`${API}/users/u-dn/reset-password`);
    expect(r.status).toBe(200);
    const body = { email: 'qa@test.io', token: r.body.data.resetToken, password: 'qa-newpass1' };
    expect((await request(app).post(`${API}/auth/reset-password`).send(body)).status).toBe(204);
    expect((await request(app).post(`${API}/auth/reset-password`).send(body)).status).toBe(422);
    expect((await login('qa@test.io', 'qa-newpass1')).status).toBe(200);
  });
});
