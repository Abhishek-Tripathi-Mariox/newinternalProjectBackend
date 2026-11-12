/**
 * Extra read endpoints the React app needs to load its store from the API (frontend INTEGRATION.md
 * "Extra backend endpoints"): list ?include= embeds, GET /milestones, GET /live/state,
 * GET /workday/state, GET /attendance/events, GET /shift-reports.
 */
import request from 'supertest';
import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb, clearTokens, tokenFor, app } from './helpers.js';
import { sod, addDays, ymd, MINUTE } from '../src/modules/workday/time.js';

const API = '/api/v1';
const NOW = Date.now();
const T = sod(NOW);
const TODAY = ymd(T);
const YDAY = ymd(addDays(T, -1));
const ago = (min) => new Date(NOW - min * MINUTE);
const doc = (entityType, entityId, name) => ({ entity_type: entityType, entity_id: entityId, name, size: 10, mime: 'text/plain', storage_path: `x/${name}` });

beforeAll(async () => {
  clearTokens();
  await resetDb();
  const sm = await as('sm@test.io');
  const pm = await as('pm@test.io');
  // Leads: activity + quote on MX-1001 (owner ak), a document on MX-1002 (owner ps)
  expect((await sm.post(`${API}/leads/MX-1001/activities`).send({ kind: 'call', text: 'Intro call' })).status).toBe(201);
  expect((await sm.post(`${API}/leads/MX-1001/quotes`).send({ items: [{ d: 'App', q: 1, r: 1000 }] })).status).toBe(201);
  // Bugs / CRs via the API so events + history rows exist
  const bug = await pm.post(`${API}/bugs`).send({ title: 'Crash on login', projectId: 'PR-101', dept: 'Mobile', env: 'Android', severity: 'Critical' });
  expect(bug.status).toBe(201);
  const cr = await pm.post(`${API}/change-requests`).send({ projectId: 'PR-101', title: 'Wishlist', description: 'x', requestedBy: 'Client', hours: 8, extraDays: 2, priority: 'High', target: 'new', team: [], tasks: [] });
  expect(cr.status).toBe(201);
  await db('documents').insert([
    doc('lead', 'MX-1002', 'brief.txt'), doc('project', 'PR-101', 'sow.txt'), doc('bug', bug.body.data.id, 'shot.txt'), doc('cr', cr.body.data.id, 'cr.txt'),
  ]);
  await db('milestones').where({ id: 'PR-101-M2' }).update({ approval_status: 'Pending', approval_asked_at: ago(60) });

  // Workday: vg working with a timer and idle 45m; dn on a lunch break; km checked in+out yesterday
  await db('attendance_events').insert([
    { person_id: 'vg', kind: 'login', at: ago(120) },
    { person_id: 'dn', kind: 'login', at: ago(100) },
    { person_id: 'dn', kind: 'break', at: ago(90) },
    { person_id: 'dn', kind: 'resume', at: ago(80) },
    { person_id: 'dn', kind: 'break', at: ago(5), meta: { type: 'Lunch', planMin: 45, note: 'canteen' } },
    { person_id: 'km', kind: 'login', at: new Date(addDays(T, -1) + 10 * 36e5) },
    { person_id: 'km', kind: 'logout', at: new Date(addDays(T, -1) + 18 * 36e5) },
  ]);
  await db('active_timers').insert({ person_id: 'vg', task_id: null, project_id: 'PR-101', milestone_id: 'PR-101-M2', title: 'Login screen', started_at: ago(60) });
  await db('presence').insert([{ person_id: 'vg', last_activity_at: ago(45) }, { person_id: 'dn', last_activity_at: ago(2) }]);
  await db('activity_feed').insert([
    { person_id: 'vg', kind: 'in', text: 'Checked in', at: ago(120) },
    { person_id: 'dn', kind: 'in', text: 'Checked in', at: ago(100) },
    { person_id: 'vg', kind: 'in', text: 'Checked in', at: new Date(addDays(T, -1) + 10 * 36e5) }, // yesterday: excluded
  ]);
  await db('shift_reports').insert([
    { person_id: 'km', day: YDAY, done: 'API work', rows: JSON.stringify([{ p: 'PR-102', ms: 'PR-102-M1', h: 8, note: 'API' }]), submitted_at: new Date(addDays(T, -1) + 18 * 36e5) },
    { person_id: 'vg', day: YDAY, done: 'Screens', plan: 'More screens', rows: JSON.stringify([{ p: 'PR-101', ms: 'PR-101-M2', h: 6, note: '' }]), pm_rows: JSON.stringify([]) },
    { person_id: 'ak', day: YDAY, is_sales: true, outcome: 'Good day', calls: 5, meetings: 1 },
  ]);
});
afterAll(closeDb);

describe('list ?include= embeds', () => {
  test('GET /leads?include=activities,quotes,documents embeds arrays per lead (scope kept)', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get(`${API}/leads?include=activities,quotes,documents&pageSize=100`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((l) => [l.id, l]));
    expect(byId['MX-1001'].activities.map((a) => a.text)).toContain('Intro call');
    expect(byId['MX-1001'].quotes).toHaveLength(1);
    expect(byId['MX-1001'].quotes[0]).toMatchObject({ leadId: 'MX-1001', total: expect.any(Number) });
    expect(byId['MX-1001'].documents).toEqual([]);
    expect(byId['MX-1002'].documents).toHaveLength(1);
    expect(byId['MX-1002'].documents[0]).toMatchObject({ name: 'brief.txt', url: expect.stringMatching(/^\/api\/v1\/documents\/.+\/download$/) });
    expect(byId['MX-1002'].activities).toEqual([]);

    const se = await as('se@test.io');
    const own = await se.get(`${API}/leads?include=quotes`);
    expect(own.body.data.map((l) => l.id)).toEqual(['MX-1002']);
    expect(own.body.data[0]).toHaveProperty('quotes');
    expect(own.body.data[0]).not.toHaveProperty('activities');
  });

  test('no include → no embedded arrays; unknown include → 422', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get(`${API}/leads`);
    expect(res.body.data[0]).not.toHaveProperty('activities');
    expect((await ceo.get(`${API}/leads?include=bogus`)).status).toBe(422);
  });

  test('GET /projects?include=documents', async () => {
    const res = await (await as('ceo@test.io')).get(`${API}/projects?include=documents&pageSize=100&period=all`);
    expect(res.status).toBe(200);
    const p = res.body.data.find((x) => x.id === 'PR-101');
    expect(p.documents.map((d) => d.name)).toEqual(['sow.txt']);
    expect(p.team.length).toBeGreaterThan(0);
    expect(p).toHaveProperty('links');
    expect(p).toHaveProperty('portal');
    expect(res.body.data.find((x) => x.id === 'PR-102').documents).toEqual([]);
  });

  test('GET /bugs?include=events,attachments', async () => {
    const res = await (await as('pm@test.io')).get(`${API}/bugs?include=events,attachments&quick=all&pageSize=100`);
    expect(res.status).toBe(200);
    const b = res.body.data[0];
    expect(b.events.map((e) => e.text)).toContain('Reported by Meera Joshi');
    expect(b.attachments.map((d) => d.name)).toEqual(['shot.txt']);
  });

  test('GET /change-requests?include=history,documents', async () => {
    const res = await (await as('pm@test.io')).get(`${API}/change-requests?include=history,documents&pageSize=100`);
    expect(res.status).toBe(200);
    const c = res.body.data[0];
    expect(c.history.length).toBeGreaterThan(0);
    expect(c.history[0]).toEqual({ at: expect.any(String), text: expect.any(String) });
    expect(c.documents.map((d) => d.name)).toEqual(['cr.txt']);
  });

  test('client sees only its projects in includes', async () => {
    const res = await (await as('client@test.io')).get(`${API}/projects?include=documents&period=all`);
    expect(res.body.data.map((p) => p.id)).toEqual(['PR-101']);
  });
});

describe('GET /milestones', () => {
  test('all milestones of visible projects with approval + crId, paginated', async () => {
    const res = await (await as('ceo@test.io')).get(`${API}/milestones?pageSize=100`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m) => m.id)).toEqual(['PR-101-M1', 'PR-101-M2', 'PR-102-M1']);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 100, total: 3, pageCount: 1 });
    const m2 = res.body.data[1];
    expect(m2).toMatchObject({ projectId: 'PR-101', n: 2, crId: null, approval: { status: 'Pending', askedAt: expect.any(String) } });
    const p2 = await (await as('ceo@test.io')).get(`${API}/milestones?pageSize=1&page=2`);
    expect(p2.body.data.map((m) => m.id)).toEqual(['PR-101-M2']);
  });

  test('projectId filter and scope (client → own project only, others 404)', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.get(`${API}/milestones?projectId=PR-102`)).body.data.map((m) => m.id)).toEqual(['PR-102-M1']);
    const cl = await as('client@test.io');
    expect((await cl.get(`${API}/milestones`)).body.data.map((m) => m.projectId)).toEqual(['PR-101', 'PR-101']);
    expect((await cl.get(`${API}/milestones?projectId=PR-102`)).status).toBe(404);
    expect((await ceo.get(`${API}/milestones?pageSize=101`)).status).toBe(422);
  });
});

describe('GET /live/state & /workday/state', () => {
  test('Super Admin gets everyone in the frontend live shape', async () => {
    const res = await (await as('ceo@test.io')).get(`${API}/live/state`);
    expect(res.status).toBe(200);
    const L = res.body.data;
    expect(L.date).toBe(TODAY);
    expect(Object.keys(L.att).sort()).toEqual(['dn', 'vg']);
    expect(L.att.vg).toEqual({ in: ago(120).toISOString(), out: null, brk: null, brkMin: 0, brkType: null, brkPlan: 0, brkNote: '' });
    expect(L.att.dn).toMatchObject({ brk: ago(5).toISOString(), brkMin: 10, brkType: 'Lunch', brkPlan: 45, brkNote: 'canteen', out: null });
    expect(L.timers).toEqual({ vg: { task: null, p: 'PR-101', ms: 'PR-101-M2', title: 'Login screen', start: ago(60).toISOString() } });
    expect(L.idle).toEqual({ vg: ago(45).toISOString() });
    const texts = L.feed.map((f) => `${f.who}:${f.kind}:${f.source}`);
    expect(texts).toEqual(expect.arrayContaining(['vg:in:feed', 'dn:in:feed', 'ak:call:lead']));
    expect(L.feed).toHaveLength(4); // + the 'quote' activity written by quote creation
    expect(L.feed.find((f) => f.source === 'lead')).toMatchObject({ lead: 'MX-1001', text: 'Intro call' });
  });

  test('other staff see only themselves (also in preview)', async () => {
    const res = await (await as('dev@test.io')).get(`${API}/live/state`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.att)).toEqual(['vg']);
    expect(Object.keys(res.body.data.timers)).toEqual(['vg']);
    expect(res.body.data.feed.every((f) => f.who === 'vg')).toBe(true);

    const t = await tokenFor('ceo@test.io');
    const pv = await request(app).get(`${API}/live/state`).set('Authorization', `Bearer ${t}`).set('X-View-As', 'u-dn');
    expect(Object.keys(pv.body.data.att)).toEqual(['dn']);
    expect(pv.body.data.idle).toEqual({});
  });

  test('sales person: own lead activities in the feed', async () => {
    const res = await (await as('sm@test.io')).get(`${API}/live/state`);
    expect(res.body.data.feed.map((f) => f.kind)).toEqual(['call', 'quote']);
    expect(res.body.data.att).toEqual({});
  });

  test('client → 403; /workday/state = caller only', async () => {
    expect((await (await as('client@test.io')).get(`${API}/live/state`)).status).toBe(403);
    const me = await (await as('qa@test.io')).get(`${API}/workday/state`);
    expect(me.status).toBe(200);
    expect(Object.keys(me.body.data)).toEqual(['date', 'att', 'timers', 'idle', 'feed']);
    expect(Object.keys(me.body.data.att)).toEqual(['dn']);
    expect((await (await as('client@test.io')).get(`${API}/workday/state`)).status).toBe(403);
  });
});

describe('GET /attendance/events', () => {
  test('Super Admin: everyone in range, person filter', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get(`${API}/attendance/events?from=${YDAY}&to=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
    expect(res.body.data[0]).toEqual({ at: expect.any(String), personId: 'km', kind: 'login', meta: {} });
    const dn = await ceo.get(`${API}/attendance/events?from=${TODAY}&to=${TODAY}&person=dn`);
    expect(dn.body.data.map((e) => e.kind)).toEqual(['login', 'break', 'resume', 'break']);
    expect(dn.body.data[3].meta).toEqual({ type: 'Lunch', planMin: 45, note: 'canteen' });
    expect((await ceo.get(`${API}/attendance/events`)).body.data).toHaveLength(5); // default: today
  });

  test('staff: person is forced to their own pid; bad ranges rejected', async () => {
    const dev = await as('dev@test.io');
    const res = await dev.get(`${API}/attendance/events?from=${YDAY}&to=${TODAY}&person=dn`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((e) => e.personId)).toEqual(['vg']);
    expect((await dev.get(`${API}/attendance/events?from=${TODAY}&to=${YDAY}`)).status).toBe(422);
    expect((await dev.get(`${API}/attendance/events?from=2020-01-01&to=${TODAY}`)).status).toBe(422);
    expect((await dev.get(`${API}/attendance/events?from=nope`)).status).toBe(422);
    expect((await (await as('client@test.io')).get(`${API}/attendance/events`)).status).toBe(403);
  });

  test('CEO-only attendance routes untouched', async () => {
    expect((await (await as('dev@test.io')).get(`${API}/attendance`)).status).toBe(403);
    expect((await (await as('ceo@test.io')).get(`${API}/attendance`)).status).toBe(200);
  });
});

describe('GET /shift-reports', () => {
  test('Super Admin: all reports in the frontend shape', async () => {
    const res = await (await as('ceo@test.io')).get(`${API}/shift-reports?from=${YDAY}&to=${YDAY}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.who).sort()).toEqual(['ak', 'km', 'vg']);
    const vg = res.body.data.find((r) => r.who === 'vg');
    expect(vg).toEqual({
      id: expect.stringMatching(/^R\d+$/), who: 'vg', d: YDAY, t: expect.any(String), sales: false, done: 'Screens', blockers: '', plan: 'More screens',
      outcome: '', calls: 0, meetings: 0, rows: [{ p: 'PR-101', ms: 'PR-101-M2', h: 6, note: '' }], pm: [], internal: [],
    });
    expect(res.body.data.find((r) => r.who === 'ak')).toMatchObject({ sales: true, outcome: 'Good day', calls: 5, meetings: 1 });
    expect((await (await as('ceo@test.io')).get(`${API}/shift-reports?person=km`)).body.data.map((r) => r.who)).toEqual(['km']);
    expect((await (await as('ceo@test.io')).get(`${API}/shift-reports?from=${TODAY}`)).body.data).toEqual([]);
  });

  test('staff see only their own', async () => {
    const res = await (await as('dev@test.io')).get(`${API}/shift-reports?person=km`);
    expect(res.body.data.map((r) => r.who)).toEqual(['vg']);
    expect((await (await as('client@test.io')).get(`${API}/shift-reports`)).status).toBe(403);
  });
});

describe('list endpoints accept pageSize=100', () => {
  test.each(['/leads', '/follow-ups?tab=all', '/projects', '/milestones', '/change-requests', '/tasks', '/bugs?quick=all', '/time-logs', '/users', '/audit-logs'])('%s', async (path) => {
    const res = await (await as('ceo@test.io')).get(`${API}${path}${path.includes('?') ? '&' : '?'}pageSize=100`);
    expect(res.status).toBe(200);
    expect(res.body.meta.pageSize).toBe(100);
  });
});
