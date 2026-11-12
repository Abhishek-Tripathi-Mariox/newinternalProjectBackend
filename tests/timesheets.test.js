import bcrypt from 'bcryptjs';
import { as, closeDb, clearTokens, PASSWORD, resetDb } from './helpers.js';
import { db } from '../src/db/knex.js';

const addDays = (d, n) => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
// Server works in local calendar days.
const localToday = () => addDays(new Date().toLocaleDateString('en-CA'), 0);

let today; let yesterday;
let pm; let dev; let tl; let qa;

beforeAll(async () => {
  await resetDb();
  clearTokens();
  today = localToday();
  yesterday = addDays(today, -1);
  await db('members').insert({ id: 'tl', name: 'Tara Lead', role_title: 'Mobile Lead', team: 'Mobile', hue: 100 });
  await db('users').insert({ id: 'u-tl', name: 'Tara Lead', email: 'tl@test.io', role_id: 'r-tl', status: 'Active', password_hash: await bcrypt.hash(PASSWORD, 4), member_id: 'tl' });
  pm = await as('pm@test.io');
  dev = await as('dev@test.io');
  tl = await as('tl@test.io');
  qa = await as('qa@test.io');
});
afterAll(closeDb);

describe('POST /time-logs (saveLog rules)', () => {
  test('validation messages', async () => {
    const noDate = await dev.post('/api/v1/time-logs').send({ rows: [{ projectId: 'PR-101', hours: 2 }] });
    expect(noDate.status).toBe(422);
    expect(noDate.body.error).toMatchObject({ code: 'RULE_VIOLATION', message: 'Pick a date.' });
    const noRows = await dev.post('/api/v1/time-logs').send({ date: today, rows: [{ projectId: 'PR-101', hours: 0 }, { hours: 3 }] });
    expect(noRows.body.error.message).toBe('Enter hours for at least one project.');
  });

  test('logs own hours, rounds to 0.25, defaults milestone', async () => {
    const res = await dev.post('/api/v1/time-logs').send({ date: today, rows: [{ projectId: 'PR-101', hours: 6.1, note: ' Login API ' }, { projectId: '', hours: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ memberId: 'vg', projectId: 'PR-101', milestoneId: 'PR-101-M2', date: today, hours: 6, note: 'Login API' });
  });

  test('24 hour rule includes existing entries', async () => {
    const res = await dev.post('/api/v1/time-logs').send({ date: today, rows: [{ projectId: 'PR-101', hours: 18.5 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('That adds up to more than 24 hours for one day.');
    expect((await dev.post('/api/v1/time-logs').send({ date: today, rows: [{ projectId: 'PR-101', hours: 18 }] })).status).toBe(201);
  });

  test('own scope can only log for themselves; PM logs for anyone', async () => {
    expect((await dev.post('/api/v1/time-logs').send({ memberId: 'si', date: today, rows: [{ projectId: 'PR-101', hours: 1 }] })).status).toBe(403);
    expect((await dev.post('/api/v1/time-logs').send({ date: today, rows: [{ projectId: 'PR-102', hours: 1 }] })).status).toBe(403);
    const r1 = await pm.post('/api/v1/time-logs').send({ memberId: 'si', date: yesterday, rows: [{ projectId: 'PR-101', hours: 7.5, note: 'Push, "fast"' }] });
    expect(r1.status).toBe(201);
    await pm.post('/api/v1/time-logs').send({ memberId: 'km', date: today, rows: [{ projectId: 'PR-102', milestoneId: 'PR-102-M1', hours: 5 }] });
    await qa.post('/api/v1/time-logs').send({ date: today, rows: [{ projectId: 'PR-101', hours: 4, note: '=cmd' }] });
  });
});

describe('GET /time-logs scope', () => {
  test('team member only sees own entries', async () => {
    const res = await dev.get('/api/v1/time-logs');
    expect(res.status).toBe(200);
    expect(new Set(res.body.data.map((l) => l.memberId))).toEqual(new Set(['vg']));
    expect(res.body.meta.totalHours).toBe(24);
  });

  test('team lead sees their team on visible projects', async () => {
    const res = await tl.get('/api/v1/time-logs');
    expect(new Set(res.body.data.map((l) => l.memberId))).toEqual(new Set(['vg', 'si']));
  });

  test('PM sees all, newest first, with filters', async () => {
    const res = await pm.get('/api/v1/time-logs');
    expect(res.body.meta.total).toBe(5);
    expect(res.body.data[res.body.data.length - 1].date).toBe(yesterday);
    expect((await pm.get('/api/v1/time-logs?team=Backend')).body.data.map((l) => l.memberId)).toEqual(['km']);
    expect((await pm.get('/api/v1/time-logs?date=today')).body.meta.total).toBe(4);
    expect((await pm.get(`/api/v1/time-logs?date=custom&from=${yesterday}&to=${yesterday}`)).body.meta.total).toBe(1);
  });
});

describe('summary / matrix / CSV / team hours', () => {
  test('summary totals', async () => {
    const res = await pm.get('/api/v1/time-logs/summary?project=PR-101');
    expect(res.body.data).toMatchObject({ today: 28, yesterday: 7.5, all: 35.5, range: 35.5 });
  });

  test('matrix member × project', async () => {
    const res = await pm.get('/api/v1/time-logs/matrix');
    const m = res.body.data;
    expect(m.columns.map((c) => c.projectId)).toEqual(['PR-101', 'PR-102']);
    const vg = m.rows.find((r) => r.memberId === 'vg');
    expect(vg).toMatchObject({ total: 24, cells: [{ projectId: 'PR-101', hours: 24 }, { projectId: 'PR-102', hours: 0 }] });
    expect(m.grand).toBe(40.5);
    expect(m.totals).toEqual([{ projectId: 'PR-101', hours: 35.5 }, { projectId: 'PR-102', hours: 5 }]);
  });

  test('CSV export', async () => {
    const res = await pm.get('/api/v1/time-logs/export.csv?member=si');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="mariox-timesheets-/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('Date,Member,Team,Project,Milestone,Hours,Work done');
    expect(lines[1]).toBe(`${yesterday},Sneha Iyer,Mobile,Alpha App,Development · Phase 1,7.5,"Push, ""fast"""`);
    const qaCsv = await pm.get('/api/v1/time-logs/export.csv?member=dn');
    expect(qaCsv.text).toContain(",'=cmd");
    expect((await dev.get('/api/v1/time-logs/export.csv')).text.trim().split('\r\n')).toHaveLength(3);
  });

  test('team hours (module team)', async () => {
    expect((await dev.get('/api/v1/time-logs/team-hours')).status).toBe(403);
    const res = await pm.get('/api/v1/time-logs/team-hours');
    expect(res.status).toBe(200);
    const vg = res.body.data.find((r) => r.memberId === 'vg');
    expect(vg).toMatchObject({ shiftHours: 8, allocated: 120, taken: 24, utilisationPct: 20, projects: 1, notSubmitted: false, todayState: 'overtime' });
    expect(vg.hours).toMatchObject({ today: 24, all: 24 });
    const mj = res.body.data.find((r) => r.memberId === 'mj');
    expect(mj).toMatchObject({ allocated: 60, taken: 0, notSubmitted: true });
    const scoped = await pm.get('/api/v1/time-logs/team-hours?project=PR-102');
    expect(scoped.body.data.map((r) => r.memberId).sort()).toEqual(['km', 'mj']);
    expect(scoped.body.data.find((r) => r.memberId === 'mj')).toMatchObject({ allocated: 20, notSubmitted: false });
    const lead = await tl.get('/api/v1/time-logs/team-hours');
    expect(lead.body.data.map((r) => r.memberId).sort()).toEqual(['si', 'tl', 'vg']);
  });
});

describe('DELETE /time-logs/:id', () => {
  test('own entries only; others are hidden', async () => {
    const all = (await pm.get('/api/v1/time-logs')).body.data;
    const mine = all.find((l) => l.memberId === 'vg');
    const other = all.find((l) => l.memberId === 'si');
    expect((await dev.delete(`/api/v1/time-logs/${other.id}`)).status).toBe(404);
    expect((await dev.delete(`/api/v1/time-logs/${mine.id}`)).status).toBe(204);
    expect((await dev.get('/api/v1/time-logs')).body.meta.total).toBe(1);
  });
});
