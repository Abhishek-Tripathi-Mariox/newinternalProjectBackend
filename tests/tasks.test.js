import bcrypt from 'bcryptjs';
import { as, closeDb, clearTokens, PASSWORD, resetDb } from './helpers.js';
import { db } from '../src/db/knex.js';

const addDays = (d, n) => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// Server works in local calendar days (helpers' `today` is UTC).
const localToday = () => addDays(new Date().toLocaleDateString('en-CA'), 0);
let today;
let pm; let dev; let tl;
const ids = {};

beforeAll(async () => {
  await resetDb();
  today = localToday();
  clearTokens();
  // Extra fixture: a Team Lead in the Mobile team.
  await db('members').insert({ id: 'tl', name: 'Tara Lead', role_title: 'Mobile Lead', team: 'Mobile', hue: 100 });
  await db('users').insert({ id: 'u-tl', name: 'Tara Lead', email: 'tl@test.io', role_id: 'r-tl', status: 'Active', password_hash: await bcrypt.hash(PASSWORD, 4), member_id: 'tl' });
  pm = await as('pm@test.io');
  dev = await as('dev@test.io');
  tl = await as('tl@test.io');
});
afterAll(closeDb);

describe('POST /tasks', () => {
  test('requires a title (frontend wording)', async () => {
    const res = await pm.post('/api/v1/tasks').send({ title: '  ', projectId: 'PR-101' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'RULE_VIOLATION', message: 'Add a task title.' });
  });

  test('creates a task; milestone defaults to the current milestone', async () => {
    const res = await pm.post('/api/v1/tasks').send({ title: 'Login screen', projectId: 'PR-101', assigneeId: 'vg', priority: 'High', dueDate: addDays(today, -2) });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Login screen', projectId: 'PR-101', milestoneId: 'PR-101-M2', assigneeId: 'vg', status: 'To do', priority: 'High' });
    expect(res.body.data.id).toMatch(/^T\d+$/);
    ids.vg = res.body.data.id;

    const a = await pm.post('/api/v1/tasks').send({ title: 'iOS push', projectId: 'PR-101', assigneeId: 'si', status: 'Blocked' });
    ids.si = a.body.data.id;
    const b = await pm.post('/api/v1/tasks').send({ title: 'API auth', projectId: 'PR-102', assigneeId: 'km', milestoneId: 'PR-102-M1' });
    ids.km = b.body.data.id;
    const c = await pm.post('/api/v1/tasks').send({ title: 'Unowned', projectId: 'PR-101' });
    ids.none = c.body.data.id;
    expect(c.body.data.assigneeId).toBeNull();
  });

  test('rejects a milestone from another project', async () => {
    const res = await pm.post('/api/v1/tasks').send({ title: 'X', projectId: 'PR-101', milestoneId: 'PR-102-M1' });
    expect(res.status).toBe(422);
  });

  test('team members cannot create tasks', async () => {
    const res = await dev.post('/api/v1/tasks').send({ title: 'Mine', projectId: 'PR-101' });
    expect(res.status).toBe(403);
  });
});

describe('GET /tasks scope', () => {
  test('PM (all) sees every task with chip counts', async () => {
    const res = await pm.get('/api/v1/tasks');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(4);
    expect(res.body.meta.counts).toMatchObject({ overdue: 1, blocked: 1, unassigned: 1, high: 1 });
    const chip = await pm.get('/api/v1/tasks?chip=overdue');
    expect(chip.body.data.map((t) => t.id)).toEqual([ids.vg]);
  });

  test('team member (own) only sees tasks assigned to them', async () => {
    const res = await dev.get('/api/v1/tasks');
    expect(res.body.data.map((t) => t.id)).toEqual([ids.vg]);
    expect((await dev.get(`/api/v1/tasks/${ids.si}`)).status).toBe(404);
  });

  test('team lead (team) sees their team on visible projects', async () => {
    const res = await tl.get('/api/v1/tasks');
    expect(res.body.data.map((t) => t.id).sort()).toEqual([ids.vg, ids.si].sort());
  });

  test('filters: team, q, pagination', async () => {
    expect((await pm.get('/api/v1/tasks?team=Backend')).body.data.map((t) => t.id)).toEqual([ids.km]);
    expect((await pm.get('/api/v1/tasks?q=push')).body.data.map((t) => t.id)).toEqual([ids.si]);
    const p = await pm.get('/api/v1/tasks?pageSize=2&page=2&sort=title');
    expect(p.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 4, pageCount: 2 });
  });
});

describe('PATCH /tasks/:id', () => {
  test('status change appends to the log', async () => {
    const res = await dev.patch(`/api/v1/tasks/${ids.vg}`).send({ status: 'In progress' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('In progress');
    expect(res.body.data.log.map((l) => l.t)).toEqual(['Status → In progress']);
  });

  test('empty title is rejected', async () => {
    const res = await pm.patch(`/api/v1/tasks/${ids.vg}`).send({ title: '' });
    expect(res.body.error.message).toBe('Add a task title.');
  });

  test('own-scope user cannot hand the task to someone else', async () => {
    expect((await dev.patch(`/api/v1/tasks/${ids.vg}`).send({ assigneeId: 'si' })).status).toBe(403);
    expect((await dev.patch(`/api/v1/tasks/${ids.si}`).send({ status: 'Done' })).status).toBe(404);
  });

  test('checklist is replaced (blank items dropped)', async () => {
    const res = await dev.patch(`/api/v1/tasks/${ids.vg}/checklist`).send({ checklist: [{ t: 'Design', done: true }, { t: ' ' }, { t: 'Build' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.checklist).toEqual([{ t: 'Design', done: true }, { t: 'Build', done: false }]);
  });
});

describe('DELETE /tasks/:id', () => {
  test('needs tasks delete permission', async () => {
    expect((await dev.delete(`/api/v1/tasks/${ids.vg}`)).status).toBe(403);
    expect((await pm.delete(`/api/v1/tasks/${ids.none}`)).status).toBe(204);
    expect((await pm.get(`/api/v1/tasks/${ids.none}`)).status).toBe(404);
  });
});
