import { resetDb, closeDb, as, clearTokens } from './helpers.js';
import { db } from '../src/db/knex.js';

const API = '/api/v1';
const lastAudit = () => db('audit_logs').orderBy('id', 'desc').first();

beforeAll(async () => { await resetDb(); clearTokens(); });
afterAll(closeDb);

describe('GET /roles', () => {
  test('lists roles with user counts', async () => {
    const res = await (await as('admin@test.io')).get(`${API}/roles`);
    expect(res.status).toBe(200);
    const tm = res.body.data.find((r) => r.id === 'r-tm');
    expect(tm).toMatchObject({ name: 'Team Member', userCount: 3, locked: false });
    expect(res.body.data.find((r) => r.id === 'r-super')).toMatchObject({ locked: true, userCount: 1 });
    expect(tm.perms.tasks).toEqual({ v: true, c: false, e: true, d: false, scope: 'own' });
  });

  test('403 without users view (also when previewing)', async () => {
    expect((await (await as('sm@test.io')).get(`${API}/roles`)).status).toBe(403);
    expect((await (await as('ceo@test.io')).get(`${API}/roles`).set('X-View-As', 'u-ak')).status).toBe(403);
  });
});

describe('POST /roles and duplicate', () => {
  test('new role copies Team Member perms, unique name, audit', async () => {
    const admin = await as('admin@test.io');
    const a = await admin.post(`${API}/roles`).send({});
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ name: 'New role', locked: false, userCount: 0 });
    const tm = await db('roles').where({ id: 'r-tm' }).first();
    expect(a.body.data.perms).toEqual(tm.perms);
    expect(await lastAudit()).toMatchObject({ text: 'created a new role', kind: 'Role' });
    const b = await admin.post(`${API}/roles`).send({});
    expect(b.body.data.name).toBe('New role 2');
  });

  test('duplicate → "(copy)", never locked', async () => {
    const admin = await as('admin@test.io');
    const res = await admin.post(`${API}/roles/r-super/duplicate`);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Super Admin (copy)', locked: false });
    expect((await lastAudit()).text).toBe('created role Super Admin (copy)');
    expect((await admin.post(`${API}/roles/r-nope/duplicate`)).status).toBe(404);
  });

  test('403 without users create', async () => {
    expect((await (await as('pm@test.io')).post(`${API}/roles`).send({})).status).toBe(403);
  });
});

describe('PATCH /roles/:id', () => {
  let id;
  beforeAll(async () => {
    id = (await (await as('ceo@test.io')).post(`${API}/roles`).send({ name: 'Contractor' })).body.data.id;
  });

  test('rename / describe', async () => {
    const ceo = await as('ceo@test.io');
    const r = await ceo.patch(`${API}/roles/${id}`).send({ name: 'Freelancer', description: 'External devs' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Freelancer', description: 'External devs' });
    expect((await lastAudit()).kind).toBe('Role');
    const dup = await ceo.patch(`${API}/roles/${id}`).send({ name: 'team member' });
    expect(dup.status).toBe(422);
  });

  test('any of c/e/d turns View on; View off clears c/e/d; scope requires View', async () => {
    const ceo = await as('ceo@test.io');
    let r = await ceo.patch(`${API}/roles/${id}`).send({ perms: { leads: { e: true } } });
    expect(r.body.data.perms.leads).toEqual({ v: true, c: false, e: true, d: false, scope: 'all' });
    r = await ceo.patch(`${API}/roles/${id}`).send({ perms: { leads: { scope: 'own', d: true } } });
    expect(r.body.data.perms.leads).toMatchObject({ v: true, e: true, d: true, scope: 'own' });
    r = await ceo.patch(`${API}/roles/${id}`).send({ perms: { leads: { v: false } } });
    expect(r.body.data.perms.leads).toMatchObject({ v: false, c: false, e: false, d: false });
    r = await ceo.patch(`${API}/roles/${id}`).send({ perms: { dash: { scope: 'team' } } });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Turn on View first');
    r = await ceo.patch(`${API}/roles/${id}`).send({ perms: { nope: { v: true } } });
    expect(r.status).toBe(422);
  });

  test('locked Super Admin cannot change; no self-escalation; 403 without edit', async () => {
    const ceo = await as('ceo@test.io');
    const r = await ceo.patch(`${API}/roles/r-super`).send({ perms: { users: { d: false } } });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Super Admin is a locked system role');
    expect((await (await as('admin@test.io')).patch(`${API}/roles/r-admin`).send({ perms: { users: { d: true } } })).status).toBe(403);
    expect((await (await as('dev@test.io')).patch(`${API}/roles/${id}`).send({ name: 'X' })).status).toBe(403);
  });

  test('permission changes take effect for that role', async () => {
    const ceo = await as('ceo@test.io');
    // Give Sales Manager users view → sm can now list users.
    expect((await (await as('sm@test.io')).get(`${API}/users`)).status).toBe(403);
    await ceo.patch(`${API}/roles/r-sm`).send({ perms: { users: { v: true } } });
    expect((await (await as('sm@test.io')).get(`${API}/users`)).status).toBe(200);
  });
});

describe('DELETE /roles/:id', () => {
  test('refused while users have it / locked; 403 for Admin; ok when empty', async () => {
    const ceo = await as('ceo@test.io');
    const r = await ceo.delete(`${API}/roles/r-tm`);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/3 users have it/);
    expect((await ceo.delete(`${API}/roles/r-super`)).status).toBe(422);
    const created = (await ceo.post(`${API}/roles`).send({ name: 'Temp role' })).body.data;
    expect((await (await as('admin@test.io')).delete(`${API}/roles/${created.id}`)).status).toBe(403);
    expect((await ceo.delete(`${API}/roles/${created.id}`)).status).toBe(204);
    expect(await lastAudit()).toMatchObject({ text: 'deleted role Temp role', kind: 'Role' });
    expect((await ceo.get(`${API}/roles/${created.id}`)).status).toBe(404);
  });
});
