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

  test('milestone hours above the budget are rejected; budget drives the team split', async () => {
    const pm = await as('pm@test.io');
    const ms = [{ name: 'A', dueDate: '2026-11-20', allocHours: 40 }, { name: 'B', dueDate: '2026-12-20', allocHours: 30 }];
    let res = await pm.post(`${API}/projects`).send({ ...base, budgetHours: 60, milestones: ms });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Milestone hours (70h) are more than the budget (60h). Reduce them or raise the budget.');
    res = await pm.post(`${API}/projects`).send({ ...base, budgetHours: 100, team: ['km'], milestones: ms });
    expect(res.status).toBe(201);
    expect(res.body.data.team.map((t) => t.allocHours)).toEqual([50, 50]);
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

describe('project hours budget', () => {
  test('milestone hours cannot exceed the budget; raise the budget first', async () => {
    const pm = await as('pm@test.io');
    const p = (await pm.post(`${API}/projects`).send({
      ...base, budgetHours: 50, milestones: [{ name: 'A', dueDate: '2026-11-20', allocHours: 20 }, { name: 'B', dueDate: '2026-12-20', allocHours: 20 }],
    })).body.data;
    expect(p.budgetLimit).toBe(50);
    const [a] = p.milestones;

    let res = await pm.patch(`${API}/milestones/${a.id}`).send({ allocHours: 40 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Milestone hours would be 60h — more than the project budget (50h). Increase the project hours first (Edit project → Budget).');
    res = await pm.post(`${API}/projects/${p.id}/milestones`).send({ name: 'C', dueDate: '2026-12-25', allocHours: 11 });
    expect(res.status).toBe(422);
    expect((await pm.post(`${API}/projects/${p.id}/milestones`).send({ name: 'C', dueDate: '2026-12-25', allocHours: 10 })).status).toBe(201);

    res = await pm.patch(`${API}/projects/${p.id}`).send({ budgetHours: 40 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('The budget can’t be less than the milestone hours (50h). Reduce milestone hours first.');
    res = await pm.patch(`${API}/projects/${p.id}`).send({ budgetHours: 80 });
    expect(res.body.data.budgetLimit).toBe(80);
    expect((await pm.patch(`${API}/milestones/${a.id}`).send({ allocHours: 50 })).status).toBe(200);
  });

  test('approving a CR adds its hours to the budget', async () => {
    const pm = await as('pm@test.io');
    await db('projects').where({ id: 'PR-101' }).update({ budget_hours: 260 });
    const cr = (await pm.post(`${API}/change-requests`).send({
      projectId: 'PR-101', title: 'Extra', description: '', requestedBy: 'Client', requestedByName: '', hours: 12, rate: 1000, extraDays: 0,
      priority: 'Medium', target: 'new', team: [], tasks: [],
    })).body.data;
    expect((await pm.post(`${API}/change-requests/${cr.id}/actions`).send({ act: 'approve', signer: { name: 'Client Person' } })).status).toBe(200);
    expect(Number((await db('projects').where({ id: 'PR-101' }).first()).budget_hours)).toBe(272);
  });
});

describe('milestone team', () => {
  test('set on create, add and edit; outsiders join the project team', async () => {
    const pm = await as('pm@test.io');
    const p = (await pm.post(`${API}/projects`).send({
      ...base, team: ['km'], milestones: [{ name: 'API', dueDate: '2026-11-20', allocHours: 10, team: ['km'] }, { name: 'UI', dueDate: '2026-12-20', allocHours: 10 }],
    })).body.data;
    expect(p.milestones.map((m) => m.team)).toEqual([['km'], []]);

    const upd = await pm.patch(`${API}/milestones/${p.milestones[1].id}`).send({ team: ['vg', 'km'] });
    expect(upd.status).toBe(200);
    expect(upd.body.data.team.sort()).toEqual(['km', 'vg']);
    const proj = (await pm.get(`${API}/projects/${p.id}`)).body.data;
    expect(proj.team.map((t) => t.memberId)).toContain('vg'); // joined the project team

    const add = await pm.post(`${API}/projects/${p.id}/milestones`).send({ name: 'QA', dueDate: '2026-12-25', team: ['dn'] });
    expect(add.body.data.team).toEqual(['dn']);
    expect((await pm.patch(`${API}/milestones/${p.milestones[1].id}`).send({ team: ['nobody'] })).status).toBe(422);
    expect((await pm.patch(`${API}/milestones/${p.milestones[1].id}`).send({ team: [] })).body.data.team).toEqual([]);
  });
});

describe('milestone notes and "no budget"', () => {
  test('notes can be set on add and edit; a project without a budget has no limit', async () => {
    const pm = await as('pm@test.io');
    const p = (await pm.post(`${API}/projects`).send({ ...base })).body.data; // no budget, template milestones with 0h
    expect(p.budgetLimit).toBeNull();
    const [m1] = p.milestones;
    let res = await pm.patch(`${API}/milestones/${m1.id}`).send({ allocHours: 40, notes: '  Client wants dark mode first  ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ allocHours: 40, notes: 'Client wants dark mode first' });
    res = await pm.post(`${API}/projects/${p.id}/milestones`).send({ name: 'Extra', dueDate: '2026-12-30', notes: 'Phase 2 scope' });
    expect(res.body.data.notes).toBe('Phase 2 scope');
    // setting a budget turns the limit on; clearing it (null) turns it off
    expect((await pm.patch(`${API}/projects/${p.id}`).send({ budgetHours: 40 })).status).toBe(200);
    expect((await pm.patch(`${API}/milestones/${m1.id}`).send({ allocHours: 41 })).status).toBe(422);
    expect((await pm.patch(`${API}/projects/${p.id}`).send({ budgetHours: null })).body.data.budgetLimit).toBeNull();
    expect((await pm.patch(`${API}/milestones/${m1.id}`).send({ allocHours: 41 })).status).toBe(200);
  });
});

describe('primary developer', () => {
  test('set on create and toggled from the team', async () => {
    const pm = await as('pm@test.io');
    const p = (await pm.post(`${API}/projects`).send({ ...base, team: ['km', 'vg'], primaryTeam: ['km'] })).body.data;
    expect(p.team.map((t) => [t.memberId, t.primary])).toEqual([['mj', false], ['km', true], ['vg', false]]);
    let res = await pm.put(`${API}/projects/${p.id}/members/vg`).send({ primary: true });
    expect(res.status).toBe(200);
    await pm.put(`${API}/projects/${p.id}/members/km`).send({ primary: false });
    const team = (await pm.get(`${API}/projects/${p.id}`)).body.data.team;
    expect(team.filter((t) => t.primary).map((t) => t.memberId)).toEqual(['vg']);
    const dev = await as('dev@test.io');
    expect((await dev.put(`${API}/projects/${p.id}/members/vg`).send({ primary: false })).status).toBe(403);
  });
});
