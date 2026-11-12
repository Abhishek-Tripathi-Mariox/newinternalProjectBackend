import { as, closeDb, clearTokens, resetDb } from './helpers.js';
import { db } from '../src/db/knex.js';

const addDays = (d, n) => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const texts = (bug) => bug.events.map((e) => e.text);

// Server works in local calendar days (helpers' `today` is UTC).
const localToday = () => addDays(new Date().toLocaleDateString('en-CA'), 0);
let today;
let pm; let dev; let dev2; let client;
const ids = {};

beforeAll(async () => {
  await resetDb();
  today = localToday();
  clearTokens();
  pm = await as('pm@test.io');
  dev = await as('dev@test.io');
  dev2 = await as('dev2@test.io');
  client = await as('client@test.io');
});
afterAll(closeDb);

describe('POST /bugs', () => {
  test('requires a title (frontend wording)', async () => {
    const res = await pm.post('/api/v1/bugs').send({ projectId: 'PR-101' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'RULE_VIOLATION', message: 'Add a short bug title.' });
  });

  test('severity sets the due date, department auto-assigns, history is written', async () => {
    const res = await pm.post('/api/v1/bugs').send({ title: 'Crash on login', projectId: 'PR-101', dept: 'Mobile', env: 'Android', severity: 'Critical' });
    expect(res.status).toBe(201);
    const b = res.body.data;
    expect(b).toMatchObject({
      milestoneId: 'PR-101-M2', assigneeId: 'vg', reporter: 'mj', reportedOn: today, dueDate: addDays(today, 1), priority: 'High', status: 'Open',
    });
    expect(texts(b)).toEqual(['Reported by Meera Joshi', 'Assigned to Vikas Gupta']);
    ids.crit = b.id;

    const minor = await pm.post('/api/v1/bugs').send({ title: 'Typo', projectId: 'PR-102', dept: 'Design', severity: 'Minor', reportedOn: addDays(today, -10) });
    expect(minor.body.data).toMatchObject({ assigneeId: null, dueDate: addDays(today, -3) });
    expect(texts(minor.body.data)).toEqual(['Reported by Meera Joshi']);
    ids.minor = minor.body.data.id;
  });

  test('client can report a bug on their own project only', async () => {
    const res = await client.post('/api/v1/bugs').send({ title: 'Button misaligned', projectId: 'PR-101', severity: 'Trivial', assigneeId: 'si', status: 'Closed' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ reporter: 'client', reporterName: 'Client', status: 'Open', assigneeId: null, dueDate: addDays(today, 14) });
    expect(texts(res.body.data)).toEqual(['Reported by Client']);
    ids.client = res.body.data.id;
    expect((await client.post('/api/v1/bugs').send({ title: 'Other', projectId: 'PR-102' })).status).toBe(403);
  });

  test('team member reports as themselves', async () => {
    const res = await dev2.post('/api/v1/bugs').send({ title: 'Mine', projectId: 'PR-101', reporter: 'mj', assigneeId: 'dn' });
    expect(res.body.data).toMatchObject({ reporter: 'si', assigneeId: 'dn' });
    ids.si = res.body.data.id;
  });
});

describe('scope', () => {
  test('client sees every bug of their project but cannot edit', async () => {
    const res = await client.get('/api/v1/bugs?quick=all');
    expect(res.body.data.map((b) => b.id).sort()).toEqual([ids.crit, ids.client, ids.si].sort());
    expect((await client.get(`/api/v1/bugs/${ids.minor}`)).status).toBe(404);
    expect((await client.patch(`/api/v1/bugs/${ids.client}`).send({ title: 'x' })).status).toBe(403);
    expect((await client.post(`/api/v1/bugs/${ids.client}/comments`).send({ text: 'hi' })).status).toBe(403);
  });

  test('team member sees bugs assigned to them or reported by them', async () => {
    expect((await dev.get('/api/v1/bugs?quick=all')).body.data.map((b) => b.id)).toEqual([ids.crit]);
    expect((await dev2.get('/api/v1/bugs?quick=all')).body.data.map((b) => b.id)).toEqual([ids.si]);
    expect((await dev.patch(`/api/v1/bugs/${ids.si}`).send({ status: 'Fixed' })).status).toBe(404);
  });
});

describe('PATCH /bugs/:id history', () => {
  test('status, assignee and severity changes are recorded with frontend wording', async () => {
    const res = await pm.patch(`/api/v1/bugs/${ids.minor}`).send({ status: 'In progress', assigneeId: 'km', severity: 'Major' });
    expect(res.status).toBe(200);
    expect(texts(res.body.data)).toEqual(['Reported by Meera Joshi', 'Status → In progress', 'Assigned to Karan Malhotra', 'Severity → Major']);
    const un = await pm.patch(`/api/v1/bugs/${ids.minor}`).send({ assigneeId: null, title: 'Typo on home' });
    expect(texts(un.body.data).slice(-1)).toEqual(['Assigned to Unassigned']);
    const same = await pm.patch(`/api/v1/bugs/${ids.minor}`).send({ status: 'In progress' });
    expect(same.body.data.events).toHaveLength(5);
  });

  test('empty title is rejected', async () => {
    expect((await pm.patch(`/api/v1/bugs/${ids.minor}`).send({ title: ' ' })).body.error.message).toBe('Add a short bug title.');
  });

  test('comments', async () => {
    const res = await dev.post(`/api/v1/bugs/${ids.crit}/comments`).send({ text: '  Looking into it ' });
    expect(res.status).toBe(201);
    expect(texts(res.body.data).slice(-1)).toEqual(['Comment: Looking into it']);
    expect((await dev.post(`/api/v1/bugs/${ids.crit}/comments`).send({ text: '' })).status).toBe(422);
  });

  test('attachments added / removed', async () => {
    const up = await pm.post(`/api/v1/bugs/${ids.crit}/attachments`).attach('files', Buffer.from('trace'), 'crash.log').attach('files', Buffer.from('png'), 'shot.png');
    expect(up.status).toBe(201);
    expect(up.body.data.attachments.map((a) => a.name)).toEqual(['crash.log', 'shot.png']);
    expect(texts(up.body.data).slice(-1)).toEqual(['Added 2 attachments']);
    const rm = await pm.patch(`/api/v1/bugs/${ids.crit}`).send({ removeAttachmentIds: [up.body.data.attachments[0].id] });
    expect(rm.body.data.attachments).toHaveLength(1);
    expect(texts(rm.body.data).slice(-1)).toEqual(['Removed 1 attachment']);
    expect((await pm.get('/api/v1/bugs?quick=all')).body.data.find((b) => b.id === ids.crit).attachmentCount).toBe(1);
  });

  test('client may attach files to a bug they reported', async () => {
    const res = await client.post(`/api/v1/bugs/${ids.client}/attachments`).attach('files', Buffer.from('x'), 'screen.png');
    expect(res.status).toBe(201);
    expect((await client.post(`/api/v1/bugs/${ids.crit}/attachments`).attach('files', Buffer.from('x'), 'a.png')).status).toBe(403);
  });
});

describe('GET /bugs filters and KPIs', () => {
  beforeAll(async () => {
    await pm.patch(`/api/v1/bugs/${ids.si}`).send({ status: 'Closed' });
    // Closed 2 days after it was reported.
    await db('bugs').where({ id: ids.si }).update({ reported_on: addDays(today, -2) });
  });

  test('KPI block', async () => {
    const res = await pm.get('/api/v1/bugs');
    expect(res.status).toBe(200);
    expect(res.body.meta.kpis).toMatchObject({ total: 4, open: 3, critical: 1, overdue: 1, closed: 1, reopened: 0, avgDaysToClose: 2 });
    // Default quick filter is "open", most severe first.
    expect(res.body.data.map((b) => b.id)).toEqual([ids.crit, ids.minor, ids.client]);
  });

  test('quick filters, field filters, period', async () => {
    expect((await pm.get('/api/v1/bugs?quick=closed')).body.data.map((b) => b.id)).toEqual([ids.si]);
    expect((await pm.get('/api/v1/bugs?quick=unassigned')).body.data.map((b) => b.id).sort()).toEqual([ids.minor, ids.client].sort());
    expect((await pm.get('/api/v1/bugs?quick=all&reporter=client')).body.data.map((b) => b.id)).toEqual([ids.client]);
    expect((await pm.get('/api/v1/bugs?quick=all&dept=Mobile&sev=Critical')).body.data.map((b) => b.id)).toEqual([ids.crit]);
    const period = await pm.get(`/api/v1/bugs?quick=all&allTime=false&date=custom&from=${today}&to=${today}`);
    expect(period.body.meta.kpis.total).toBe(2);
  });

  test('detail and delete', async () => {
    const d = await pm.get(`/api/v1/bugs/${ids.crit}`);
    expect(d.body.data.events.length).toBeGreaterThan(2);
    expect(d.body.data.attachments[0].url).toMatch(/\/documents\/.+\/download$/);
    expect((await dev.delete(`/api/v1/bugs/${ids.crit}`)).status).toBe(403);
    expect((await pm.delete(`/api/v1/bugs/${ids.crit}`)).status).toBe(204);
    expect(await db('documents').where({ entity_type: 'bug', entity_id: ids.crit }).count('* as n').first()).toEqual({ n: 0 });
  });
});
