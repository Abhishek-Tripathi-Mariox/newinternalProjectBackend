/** Milestones typed in the new-project form, plus add / delete from the project drawer. */
import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb } from './helpers.js';

const API = '/api/v1';
const base = { name: 'Gamma', client: 'Gamma Co', services: ['Mobile App'], status: 'Planning', pmId: 'mj', startDate: '2026-11-01', dueDate: '2027-01-31', team: [] };

beforeAll(async () => { await resetDb(); });
afterAll(closeDb);

describe('new project with its own milestones', () => {
  test('uses the typed milestones; budget = their hours; blank name → "Milestone n"', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/projects`).send({
      ...base,
      budgetHours: 999, // ignored when milestones are given
      milestones: [
        { name: 'Feature List', dueDate: '2026-11-08', allocHours: 5 },
        { name: ' ', dueDate: '2026-11-28', allocHours: 0 },
        { name: 'QA, Third Party, Go Live - Milestone 4', dueDate: '2027-01-06', allocHours: 15 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.milestones.map((m) => [m.n, m.name, m.allocHours, m.dueDate])).toEqual([
      [1, 'Feature List', 5, '2026-11-08'],
      [2, 'Milestone 2', 0, '2026-11-28'],
      [3, 'QA, Third Party, Go Live - Milestone 4', 15, '2027-01-06'],
    ]);
    expect(res.body.data.budgetHours ?? res.body.data.milestones.reduce((x, m) => x + m.allocHours, 0)).toBe(20);
  });

  test('without milestones the five template ones are created', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/projects`).send({ ...base, budgetHours: 100 });
    expect(res.body.data.milestones.map((m) => m.name)).toEqual([
      'Feature List', 'UI/UX Milestone 1', 'Frontend Milestone 2', 'Backend Milestone 3', 'QA, Third Party, Go Live - Milestone 4',
    ]);
  });

  test('milestone before the project start is rejected', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/projects`).send({ ...base, milestones: [{ name: 'Early', dueDate: '2026-10-01', allocHours: 1 }] });
    expect(res.status).toBe(422);
  });
});

describe('add / delete milestones', () => {
  test('PM adds a milestone at the end; team member cannot', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/projects/PR-101/milestones`).send({ name: 'Go live', dueDate: '2026-12-20', allocHours: 30 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ projectId: 'PR-101', n: 3, name: 'Go live', allocHours: 30, dueDate: '2026-12-20', status: 'Not started' });
    const dev = await as('dev@test.io');
    expect((await dev.post(`${API}/projects/PR-101/milestones`).send({ name: 'x', dueDate: '2026-12-20' })).status).toBe(403);
  });

  test('delete renumbers the rest; a milestone with logged hours cannot be deleted', async () => {
    const pm = await as('pm@test.io');
    const a = (await pm.post(`${API}/projects/PR-102/milestones`).send({ name: 'A', dueDate: '2026-12-01', allocHours: 1 })).body.data;
    const b = (await pm.post(`${API}/projects/PR-102/milestones`).send({ name: 'B', dueDate: '2026-12-15', allocHours: 1 })).body.data;
    expect([a.n, b.n]).toEqual([2, 3]);

    const del = await pm.delete(`${API}/milestones/${a.id}`);
    expect(del.status).toBe(200);
    expect(del.body.data.milestones.map((m) => [m.id, m.n])).toEqual([['PR-102-M1', 1], [b.id, 2]]);

    // adding again never reuses an id that still exists
    const c = (await pm.post(`${API}/projects/PR-102/milestones`).send({ name: 'C', dueDate: '2026-12-20' })).body.data;
    expect(c.n).toBe(3);
    expect(new Set([b.id, c.id, 'PR-102-M1']).size).toBe(3);

    await db('time_logs').insert({ id: 'TL-T1', member_id: 'mj', project_id: 'PR-102', milestone_id: c.id, day: '2026-11-10', hours: 2 });
    const res = await pm.delete(`${API}/milestones/${c.id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Hours are logged/);
  });
});
