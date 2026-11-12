import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb } from './helpers.js';
import { localDay, addDaysS } from '../src/modules/projects/dates.js';

beforeAll(async () => { await resetDb(); });
afterAll(closeDb);

const base = {
  projectId: 'PR-101', title: 'Wishlist feature', description: 'Save items for later', requestedBy: 'Client', requestedByName: '',
  hours: 16, extraDays: 5, priority: 'High', target: 'new', team: [],
  tasks: [{ title: 'Wishlist API', assigneeId: 'km', hours: 10 }, { title: 'Wishlist UI', assigneeId: 'vg', hours: 6 }, { title: '  ', hours: 3 }],
};

describe('change requests', () => {
  test('saveCr validation wording', async () => {
    const pm = await as('pm@test.io');
    let res = await pm.post('/api/v1/change-requests').send({ ...base, title: ' ' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Give the change request a title.');
    res = await pm.post('/api/v1/change-requests').send({ ...base, hours: 0 });
    expect(res.body.error.message).toBe('Estimate the hours this change needs.');
    res = await pm.post('/api/v1/change-requests').send({ ...base, target: 'PR-102-M1' });
    expect(res.status).toBe(422);
  });

  test('only the PM can create / act', async () => {
    const dev = await as('dev@test.io');
    expect((await dev.post('/api/v1/change-requests').send(base)).status).toBe(403);
    const admin = await as('admin@test.io');
    expect((await admin.post('/api/v1/change-requests').send(base)).status).toBe(403);
  });

  let id;
  test('create: default rate = crRate, history lines', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post('/api/v1/change-requests').send(base);
    expect(res.status).toBe(201);
    const c = res.body.data;
    id = c.id;
    expect(c).toMatchObject({ id: 'CR-101-1', status: 'Draft', rate: 3850, amount: 61600, team: ['km', 'vg'] });
    expect(c.tasks).toHaveLength(2);
    expect(c.history.map((h) => h.text)).toEqual(['Raised by Alpha Retail', 'Estimated 16h · ₹61,600 · +5 days']);
    expect(c.money).toMatchObject({ used: null, cost: null, estCost: (10 * 750 + 6 * 750), estProfit: 61600 - 12000 });
  });

  test('approve: requires signer, then updates project value/due/team, milestone, tasks', async () => {
    const pm = await as('pm@test.io');
    expect((await pm.post(`/api/v1/change-requests/${id}/actions`).send({ act: 'send' })).body.data.status).toBe('Sent to client');
    let res = await pm.post(`/api/v1/change-requests/${id}/actions`).send({ act: 'approve', signer: { name: 'Al' } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Enter the name of the client person who approved (needed for the approval record).');

    res = await pm.post(`/api/v1/change-requests/${id}/actions`).send({ act: 'approve', signer: { name: 'Riya Kapoor', title: 'CTO' }, note: 'Go ahead' });
    expect(res.status).toBe(200);
    const c = res.body.data;
    expect(c).toMatchObject({ status: 'Approved', milestoneId: 'PR-101-CR-101-1', message: 'CR-101-1 approved · 2 tasks created, hours, value and timeline updated' });
    expect(c.signature).toMatchObject({ name: 'Riya Kapoor', title: 'CTO', via: 'Recorded by Meera Joshi (client approved by email / call)', note: 'Go ahead' });
    expect(c.history.map((h) => h.text).slice(2)).toEqual([
      'Sent to client for approval',
      'Client comment · Go ahead',
      'Approved by Riya Kapoor · Recorded by Meera Joshi (client approved by email / call)',
      '+16h added to the budget · +₹61,600 contract value · due date moved by 5 days · 2 tasks created on the board',
    ]);
    expect(c.boardTasks.map((t) => [t.title, t.assigneeId, t.status, t.estimateHours])).toEqual([['Wishlist API', 'km', 'To do', 10], ['Wishlist UI', 'vg', 'To do', 6]]);

    const p = await db('projects').where({ id: 'PR-101' }).first();
    expect(Number(p.value)).toBe(1061600);
    expect(p.due_date).toBe('2027-01-05');
    const team = await db('project_members').where({ project_id: 'PR-101' }).orderBy('position');
    expect(team.map((t) => [t.member_id, Number(t.alloc_hours)])).toEqual([['mj', 40], ['vg', 126], ['si', 120], ['dn', 60], ['km', 10]]);
    const ms = await db('milestones').where({ id: 'PR-101-CR-101-1' }).first();
    const T = localDay();
    const expDue = addDaysS('2026-12-31' > T ? '2026-12-31' : T, 5);
    expect(ms).toMatchObject({ n: 3, name: 'CR: Wishlist feature', status: 'Not started', cr_id: 'CR-101-1', due_date: expDue });
    expect(Number(ms.alloc_hours)).toBe(16);
    const tasks = await db('tasks').where({ cr_id: 'CR-101-1' });
    expect(tasks.every((t) => t.milestone_id === 'PR-101-CR-101-1' && t.due_date === expDue && t.description === 'From CR-101-1 · Wishlist feature')).toBe(true);
  });

  test('locked once approved; start/done move the CR milestone; delete only Draft/Rejected', async () => {
    const pm = await as('pm@test.io');
    let res = await pm.patch(`/api/v1/change-requests/${id}`).send({ title: 'New' });
    expect(res.status).toBe(422);
    expect((await pm.delete(`/api/v1/change-requests/${id}`)).status).toBe(422);
    expect((await pm.post(`/api/v1/change-requests/${id}/actions`).send({ act: 'send' })).status).toBe(422);
    res = await pm.post(`/api/v1/change-requests/${id}/actions`).send({ act: 'start' });
    expect(res.body.data.status).toBe('In progress');
    expect((await db('milestones').where({ id: 'PR-101-CR-101-1' }).first()).status).toBe('In progress');
    res = await pm.post(`/api/v1/change-requests/${id}/actions`).send({ act: 'done' });
    expect(res.body.data.status).toBe('Done');
    expect((await db('milestones').where({ id: 'PR-101-CR-101-1' }).first()).status).toBe('Done');
    const docs = await pm.post(`/api/v1/change-requests/${id}/documents`).attach('files', Buffer.from('pdf'), 'approval.pdf');
    expect(docs.status).toBe(201);
  });

  test('approve into an existing milestone adds hours there', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post('/api/v1/change-requests').send({ ...base, title: 'Tweak', hours: 10, rate: 2000, extraDays: 0, target: 'PR-101-M2', tasks: [], send: true });
    expect(res.body.data).toMatchObject({ status: 'Sent to client', amount: 20000 });
    expect(res.body.data.history.map((h) => h.text)).toEqual(['Raised by Alpha Retail', 'Estimated 10h · ₹20,000 · no change to due date', 'Sent to client for approval']);
    const ap = await pm.post(`/api/v1/change-requests/${res.body.data.id}/actions`).send({ act: 'approve', signer: { name: 'Riya Kapoor' } });
    expect(ap.body.data.milestoneId).toBe('PR-101-M2');
    expect(ap.body.data.history.at(-1).text).toBe('+10h added to the budget · +₹20,000 contract value');
    expect(Number((await db('milestones').where({ id: 'PR-101-M2' }).first()).alloc_hours)).toBe(210);
    expect(ap.body.data.money.used).toBeNull();
  });

  test('reject + delete, patch draft, list filters, print escaping, scope', async () => {
    const pm = await as('pm@test.io');
    const c = (await pm.post('/api/v1/change-requests').send({ ...base, title: '<script>alert(1)</script>', requestedBy: 'Internal', requestedByName: 'Meera' })).body.data;
    expect(c.history[0].text).toBe('Draft created by Meera');
    const up = await pm.patch(`/api/v1/change-requests/${c.id}`).send({ hours: 20, rate: 1000 });
    expect(up.body.data).toMatchObject({ hours: 20, amount: 20000 });
    expect(up.body.data.history.at(-1).text).toBe('Estimated 20h · ₹20,000 · +5 days');

    const html = await pm.get(`/api/v1/change-requests/${c.id}/print`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/html/);
    expect(html.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.text).not.toContain('<script>alert(1)');

    const rj = await pm.post(`/api/v1/change-requests/${c.id}/actions`).send({ act: 'reject', note: 'Too costly' });
    expect(rj.body.data).toMatchObject({ status: 'Rejected', note: 'Too costly' });
    expect(rj.body.data.history.at(-1).text).toBe('Marked rejected · Too costly');

    const list = await pm.get('/api/v1/change-requests?status=Rejected');
    expect(list.body.data.map((x) => x.id)).toEqual([c.id]);
    expect((await pm.get('/api/v1/change-requests?project=PR-101')).body.meta.total).toBe(3);

    expect((await pm.delete(`/api/v1/change-requests/${c.id}`)).status).toBe(204);
    expect((await pm.get(`/api/v1/change-requests/${c.id}`)).status).toBe(404);

    const dev = await as('dev@test.io'); // on PR-101 → can view
    expect((await dev.get('/api/v1/change-requests')).body.meta.total).toBe(2);
    const se = await as('se@test.io'); // no projects permission
    expect((await se.get('/api/v1/change-requests')).status).toBe(403);
  });
});
