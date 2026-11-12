/** Project follow-ups: CRUD, project scoping, delete rights, tabs. */
import { resetDb, as, closeDb } from './helpers.js';

const API = '/api/v1/project-follow-ups';
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const fu = (over = {}) => ({ projectId: 'PR-101', type: 'Meeting', title: 'UAT walkthrough', dueAt: inHours(30), ...over });

beforeAll(async () => { await resetDb(); });
afterAll(closeDb);

describe('project follow-ups', () => {
  test('PM creates one; defaults owner to themselves; type defaults applied', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(API).send(fu({ meetUrl: 'https://meet.google.com/abc-defg-hij', attendees: 'client@alpha.io' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: expect.stringMatching(/^PF\d+$/), projectId: 'PR-101', project: { name: 'Alpha App', client: 'Alpha Retail' },
      ownerId: 'mj', ownerName: 'Meera Joshi', durationMin: 45, remindMin: 10, priority: 'Medium', done: false,
    });
    expect(res.body.data.calendarUrl).toContain('UAT%20walkthrough%20%C2%B7%20Alpha%20App');
  });

  test('validation: title, time, owner, project', async () => {
    const pm = await as('pm@test.io');
    expect((await pm.post(API).send(fu({ title: ' ' }))).body.error.message).toBe('Add a title.');
    expect((await pm.post(API).send(fu({ dueAt: 'nope' }))).body.error.message).toBe('Pick a date and time.');
    expect((await pm.post(API).send(fu({ ownerId: 'zzz' }))).status).toBe(422);
    expect((await pm.post(API).send(fu({ projectId: 'PR-999' }))).status).toBe(404);
  });

  test('team members see and add follow-ups only on their own projects; clients see none', async () => {
    const pm = await as('pm@test.io');
    await pm.post(API).send(fu({ projectId: 'PR-102', title: 'Beta sync', ownerId: 'km' }));
    const dev = await as('dev@test.io');
    const list = await dev.get(API);
    expect(list.status).toBe(200);
    expect(list.body.data.every((f) => f.projectId === 'PR-101')).toBe(true);
    expect((await dev.post(API).send(fu({ projectId: 'PR-102' }))).status).toBe(404);
    const mine = await dev.post(API).send(fu({ title: 'Ask client for assets', type: 'Task' }));
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({ ownerId: 'vg', durationMin: 0, remindMin: 60 });

    const client = await as('client@test.io');
    expect((await client.get(API)).status).toBe(403);
  });

  test('edit, toggle done, tabs and counts', async () => {
    const pm = await as('pm@test.io');
    const a = (await pm.post(API).send(fu({ title: 'Overdue call', type: 'Call', dueAt: inHours(-3) }))).body.data;
    const up = await pm.patch(`${API}/${a.id}`).send({ title: 'Overdue call v2', ownerId: 'dn', priority: 'High' });
    expect(up.body.data).toMatchObject({ title: 'Overdue call v2', ownerId: 'dn', priority: 'High', overdue: true });

    let res = await pm.get(API).query({ tab: 'overdue', projectId: 'PR-101' });
    expect(res.body.data.map((f) => f.id)).toContain(a.id);
    expect(res.body.meta.counts.overdue).toBeGreaterThanOrEqual(1);

    const t = await pm.patch(`${API}/${a.id}/toggle-done`);
    expect(t.body.data.done).toBe(true);
    res = await pm.get(API).query({ tab: 'completed' });
    expect(res.body.data.map((f) => f.id)).toEqual([a.id]);
  });

  test('delete: creator, owner or PM only', async () => {
    const pm = await as('pm@test.io');
    const f = (await pm.post(API).send(fu({ title: 'PM-only item' }))).body.data;
    const dev2 = await as('dev2@test.io'); // on PR-101 team, not creator / owner / PM
    expect((await dev2.delete(`${API}/${f.id}`)).status).toBe(403);
    const dev = await as('dev@test.io');
    const own = (await dev.post(API).send(fu({ title: 'Dev item' }))).body.data;
    expect((await dev.delete(`${API}/${own.id}`)).status).toBe(204);
    expect((await pm.delete(`${API}/${f.id}`)).status).toBe(204);
    expect((await pm.get(`${API}/${f.id}`)).status).toBe(404);
  });
});
