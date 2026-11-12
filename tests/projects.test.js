import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb } from './helpers.js';
import { localDay, addDaysS } from '../src/modules/projects/dates.js';

const T = localDay();
const d = (n) => addDaysS(T, n);

/** A Running project whose health numbers are fully determined (see the health test). */
async function seedHealthProject() {
  await db('projects').insert({ id: 'PR-150', name: 'Health Probe', client: 'Probe Co', services: ['Web Development'], status: 'Running', pm_member_id: 'mj', start_date: d(-50), due_date: d(50), value: 200000 });
  await db('project_members').insert([{ project_id: 'PR-150', member_id: 'mj', alloc_hours: 50, position: 0 }, { project_id: 'PR-150', member_id: 'km', alloc_hours: 150, position: 1 }]);
  await db('milestones').insert([
    { id: 'PR-150-M1', project_id: 'PR-150', n: 1, name: 'One', alloc_hours: 50, due_date: d(-30), status: 'Done' },
    { id: 'PR-150-M2', project_id: 'PR-150', n: 2, name: 'Two', alloc_hours: 50, due_date: d(-10), status: 'In progress' },
    { id: 'PR-150-M3', project_id: 'PR-150', n: 3, name: 'Three', alloc_hours: 100, due_date: d(40), status: 'Not started' },
  ]);
  await db('time_logs').insert(Array.from({ length: 10 }, (_, i) => ({ id: `L-H${i}`, member_id: 'km', project_id: 'PR-150', milestone_id: 'PR-150-M2', day: d(-i - 1), hours: 15 })));
  await db('tasks').insert([
    { id: 'T-H1', project_id: 'PR-150', title: 'Blocked 1', status: 'Blocked' },
    { id: 'T-H2', project_id: 'PR-150', title: 'Blocked 2', status: 'Blocked' },
  ]);
  await db('bugs').insert({ id: 'BUG-H1', project_id: 'PR-150', title: 'Crash', dept: 'Backend', env: 'Web', severity: 'Critical', status: 'Open', reporter: 'dn', reported_on: T });
}

beforeAll(async () => { await resetDb(); });
afterAll(closeDb);

describe('GET /projects (list + health)', () => {
  beforeAll(seedHealthProject);

  test('health score and reasons are ported exactly', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get('/api/v1/projects?period=all');
    expect(res.status).toBe(200);
    const p = res.body.data.find((x) => x.id === 'PR-150');
    expect(p.budgetHours).toBe(200);
    expect(p.hours.used).toBe(150);
    expect(p.hours.period).toBe(150);
    expect(p.currentMilestone).toMatchObject({ id: 'PR-150-M2', step: 2, of: 3 });
    // 100 − 15 (1 overdue ms) − 10 (75% used vs 50% delivered) − 8 (critical bug) − 10 (2 blocked) = 57; ms overdue > 7d → Late
    expect(p.health).toEqual({
      label: 'Late',
      score: 57,
      reasons: ['1 milestone overdue', '75% of hours used, 50% delivered', '1 critical bug open', '2 blocked tasks'],
    });
    expect(p.team.map((t) => t.memberId)).toEqual(['mj', 'km']);
    expect(res.body.meta).toMatchObject({ total: 3, page: 1 });
  });

  test('filters: status, member, q', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.get('/api/v1/projects?member=km')).body.data.map((p) => p.id)).toEqual(['PR-102', 'PR-150']);
    expect((await ceo.get('/api/v1/projects?q=alpha')).body.data.map((p) => p.id)).toEqual(['PR-101']);
    expect((await ceo.get('/api/v1/projects?status=Completed')).body.data).toEqual([]);
    expect((await ceo.get('/api/v1/projects?period=nope')).status).toBe(422);
  });

  test('scope: team member sees only own projects, client only PR-101', async () => {
    const dev = await as('dev@test.io');
    expect((await dev.get('/api/v1/projects')).body.data.map((p) => p.id)).toEqual(['PR-101']);
    expect((await dev.get('/api/v1/projects/PR-102')).status).toBe(404);
    const client = await as('client@test.io');
    expect((await client.get('/api/v1/projects')).body.data.map((p) => p.id)).toEqual(['PR-101']);
    expect((await client.get('/api/v1/projects/PR-150')).status).toBe(404);
    expect((await client.get('/api/v1/projects/PR-101')).status).toBe(200);
  });
});

describe('GET /projects/:id detail', () => {
  test('milestones with used hours, team alloc/taken/remaining, day work', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.get('/api/v1/projects/PR-150');
    expect(res.status).toBe(200);
    const b = res.body.data;
    expect(b.milestones.find((m) => m.id === 'PR-150-M2')).toMatchObject({ usedHours: 150, current: true, overdue: true, people: ['km'] });
    expect(b.team.find((t) => t.memberId === 'km')).toMatchObject({ allocHours: 150, takenHours: 150, remainingHours: 0 });
    expect(b.dayWork.day).toBe(d(-1));
    expect(b.dayWork.people).toEqual([expect.objectContaining({ memberId: 'km', hours: 15 })]);
    expect(b.recentLogs).toHaveLength(10);
    expect(b.changeRequests.total).toBe(0);
    const ms = await pm.get('/api/v1/projects/PR-150/milestones');
    expect(ms.body.data.map((m) => m.n)).toEqual([1, 2, 3]);
  });
});

describe('POST /projects (saveProj)', () => {
  const base = { name: 'Gamma', client: 'Gamma Ltd', services: ['Web Development'], status: 'Planning', pmId: 'mj', startDate: '2026-01-01', dueDate: '2026-04-11', budgetHours: 400, team: ['km'], value: 300000 };

  test('validation wording', async () => {
    const pm = await as('pm@test.io');
    const cases = [
      [{ name: ' ' }, 'Project name and client are required.'],
      [{ services: [] }, 'Pick at least one service.'],
      [{ dueDate: '2025-12-01' }, 'Pick a start date and a due date after it.'],
      [{ links: [{ type: 'Figma', url: 'ftp://x' }] }, 'Links must start with https:// (check the Figma link).'],
    ];
    for (const [patch, msg] of cases) {
      const res = await pm.post('/api/v1/projects').send({ ...base, ...patch });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'RULE_VIOLATION', message: msg });
    }
  });

  test('creates template milestones, splits allocation, keeps valid links', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post('/api/v1/projects').send({ ...base, links: [{ type: 'Figma', url: ' https://figma.com/x ' }, { type: 'Other', url: '' }] });
    expect(res.status).toBe(201);
    const p = res.body.data;
    expect(p.id).toBe('PR-103');
    expect(p.team.map((t) => [t.memberId, t.allocHours])).toEqual([['mj', 200], ['km', 200]]);
    expect(p.milestones.map((m) => [m.name, m.allocHours, m.dueDate])).toEqual([
      ['Feature List', 60, '2026-01-16'],
      ['UI/UX Milestone 1', 120, '2026-02-15'],
      ['Frontend Milestone 2', 120, '2026-03-17'],
      ['Backend Milestone 3', 60, '2026-04-01'],
      ['QA, Third Party, Go Live - Milestone 4', 40, '2026-04-11'],
    ]);
    expect(p.links).toEqual([expect.objectContaining({ type: 'Figma', url: 'https://figma.com/x' })]);
    expect(p.health.label).toBe('Not started');
  });

  test('team member cannot create', async () => {
    const dev = await as('dev@test.io');
    expect((await dev.post('/api/v1/projects').send(base)).status).toBe(403);
  });
});

describe('PM-only edits', () => {
  test('team member and non-PM admin get 403; PM succeeds', async () => {
    const dev = await as('dev@test.io');
    expect((await dev.patch('/api/v1/projects/PR-101').send({ status: 'On hold' })).status).toBe(403);
    expect((await dev.put('/api/v1/projects/PR-101/members/vg').send({ allocHours: 999 })).status).toBe(403);
    expect((await dev.patch('/api/v1/milestones/PR-101-M2').send({ name: 'x' })).status).toBe(403);
    const admin = await as('admin@test.io');
    const a = await admin.put('/api/v1/projects/PR-101/members/vg').send({ allocHours: 999 });
    expect(a.status).toBe(403);

    const pm = await as('pm@test.io');
    const res = await pm.patch('/api/v1/projects/PR-101').send({ status: 'On hold', priority: 'Low' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'On hold', priority: 'Low' });
  });

  test('members: alloc with over-budget warning, add, remove', async () => {
    const pm = await as('pm@test.io');
    // PR-102 budget 40h; team alloc 120h is already over → no warning while it stays over
    let res = await pm.put('/api/v1/projects/PR-102/members/mj').send({ allocHours: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.warning).toBeUndefined();
    res = await pm.put('/api/v1/projects/PR-102/members/km').send({ allocHours: 10 });
    expect(res.body.data).toMatchObject({ allocTotal: 10, allocOverBudget: false });
    res = await pm.put('/api/v1/projects/PR-102/members/km').send({ allocHours: 50 });
    expect(res.body.data).toMatchObject({ allocTotal: 50, budgetHours: 40, warning: 'Over budget: team now 50h of 40h' });
    res = await pm.post('/api/v1/projects/PR-102/members').send({ memberId: 'si' });
    expect(res.status).toBe(201);
    expect(res.body.data.team.map((t) => t.memberId)).toEqual(['mj', 'km', 'si']);
    expect((await pm.post('/api/v1/projects/PR-102/members').send({ memberId: 'si' })).status).toBe(200);
    res = await pm.delete('/api/v1/projects/PR-102/members/si');
    expect(res.body.data.team.map((t) => t.memberId)).toEqual(['mj', 'km']);
    expect((await pm.delete('/api/v1/projects/PR-102/members/si')).status).toBe(404);
  });

  test('links replace + https validation', async () => {
    const pm = await as('pm@test.io');
    const bad = await pm.put('/api/v1/projects/PR-101/links').send({ links: [{ type: 'Repository', url: 'github.com/x' }] });
    expect(bad.body.error.message).toBe('Links must start with https:// (check the Repository link).');
    const res = await pm.put('/api/v1/projects/PR-101/links').send({ links: [{ type: 'Figma', url: 'https://f.io' }, { type: 'Repository', url: 'https://g.io' }] });
    expect(res.body.data.map((l) => l.type)).toEqual(['Figma', 'Repository']);
  });

  test('milestone patch (blank name → Milestone n) and ask-approval needs the portal', async () => {
    const pm = await as('pm@test.io');
    let res = await pm.patch('/api/v1/milestones/PR-101-M2').send({ name: '  ', allocHours: 220 });
    expect(res.body.data).toMatchObject({ name: 'Milestone 2', allocHours: 220 });
    res = await pm.post('/api/v1/milestones/PR-101-M2/ask-approval');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Turn on the client portal first.');
    res = await pm.post('/api/v1/projects/PR-101/portal').send({ on: true });
    expect(res.body.data.on).toBe(true);
    const token = res.body.data.token;
    res = await pm.post('/api/v1/milestones/PR-101-M2/ask-approval');
    expect(res.body.data).toMatchObject({ status: 'In review', approval: { status: 'Pending' } });
    expect((await pm.post('/api/v1/milestones/PR-101-M2/ask-approval')).status).toBe(422);
    // turning off and on again keeps the token
    await pm.post('/api/v1/projects/PR-101/portal').send({ on: false });
    expect((await pm.post('/api/v1/projects/PR-101/portal').send({ on: true })).body.data.token).toBe(token);
  });

  test('documents upload', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post('/api/v1/projects/PR-101/documents').field('kind', 'SOW').attach('files', Buffer.from('hello'), 'sow.pdf');
    expect(res.status).toBe(201);
    expect(res.body.data[0]).toMatchObject({ name: 'sow.pdf', size: 5 });
    const det = await pm.get('/api/v1/projects/PR-101');
    expect(det.body.data.documents).toHaveLength(1);
  });
});

describe('overview & capacity', () => {
  test('overview cards and needs-attention', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get('/api/v1/projects/overview?period=all');
    expect(res.status).toBe(200);
    const o = res.body.data;
    expect(o.statusCards[0]).toMatchObject({ label: 'All projects', count: 4 });
    expect(o.hoursByProject).toEqual([{ projectId: 'PR-150', name: 'Health Probe', hours: 150 }]);
    expect(o.hoursByTeam).toEqual([{ team: 'Backend', hours: 150 }]);
    expect(o.needsAttention[0]).toMatchObject({ projectId: 'PR-150', sub: '1 milestone overdue · 75% of hours used, 50% delivered · 1 critical bug open · 2 blocked tasks' });
    expect(o.hourCards.today).toHaveProperty('expected');
    expect(Array.isArray(o.missingTimesheets)).toBe(true);
  });

  test('capacity spreads remaining hours across working days', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get('/api/v1/projects/capacity?week=1');
    expect(res.status).toBe(200);
    const c = res.body.data;
    expect(c.days).toHaveLength(6);
    const km = c.members.find((m) => m.memberId === 'km');
    expect(km.capacity).toBe(48);
    expect(km.days.every((x) => x.hours >= 0)).toBe(true);
    expect(['over', 'full', 'free']).toContain(km.state);
    expect((await ceo.get('/api/v1/projects/capacity?week=5')).status).toBe(422);
  });
});
