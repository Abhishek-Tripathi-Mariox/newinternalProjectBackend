import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb, clearTokens } from './helpers.js';
import { sod, ymd, MINUTE, HOUR } from '../src/modules/workday/time.js';

const W = '/api/v1/workday';

/** Move all of a person's events today back by `ms` (keeps their order). */
const backdateDay = (pid, ms) => db.raw('update attendance_events set at = at - (? * interval \'1 millisecond\') where person_id = ?', [ms, pid]);

beforeAll(async () => {
  clearTokens();
  await resetDb();
  await db('tasks').insert([
    { id: 'T1', project_id: 'PR-101', milestone_id: 'PR-101-M2', title: 'Checkout API', assignee_id: 'vg', status: 'In progress' },
    { id: 'T2', project_id: 'PR-102', milestone_id: 'PR-102-M1', title: 'Beta wireframes', assignee_id: 'km', status: 'To do' },
  ]);
});
afterAll(closeDb);

describe('access', () => {
  test('clients have no workday', async () => {
    const res = await (await as('client@test.io')).get(`${W}/me`);
    expect(res.status).toBe(403);
  });
  test('unauthenticated → 401', async () => {
    const { default: request } = await import('supertest');
    const { app } = await import('./helpers.js');
    expect((await request(app).get(`${W}/me`)).status).toBe(401);
  });
});

describe('delivery day: check-in → timer → break → resume → end shift', () => {
  let dev;
  // How far we can safely move today's events back without crossing midnight.
  const shift = Math.min(3 * HOUR, Date.now() - sod(Date.now()) - 2000);

  beforeAll(async () => { dev = await as('dev@test.io'); });

  test('starts not checked in; cannot break or start a timer', async () => {
    const me = await dev.get(`${W}/me`);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ pid: 'vg', status: 'Not checked in', checkedIn: false, workedMs: 0, timer: null });
    const b = await dev.post(`${W}/break`).send({ type: 'Lunch' });
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe('RULE_VIOLATION');
    expect((await dev.post(`${W}/timer/start`).send({ taskId: 'T1' })).status).toBe(422);
    expect((await dev.post(`${W}/check-out`)).status).toBe(422);
  });

  test('check in (twice → 409)', async () => {
    const r = await dev.post(`${W}/check-in`);
    expect(r.status).toBe(200);
    expect((await dev.post(`${W}/check-in`)).status).toBe(409);
    await backdateDay('vg', shift);
    const me = (await dev.get(`${W}/me`)).body.data;
    expect(me.status).toBe('Working');
    expect(me.events.map((e) => e.kind)).toEqual(['login']);
    expect(me.workedMs).toBeGreaterThanOrEqual(shift - 1000);
    const feed = await db('activity_feed').where({ person_id: 'vg', kind: 'in' });
    expect(feed[0].text).toBe('Checked in');
  });

  test('timer: invalid break type 422, task outside scope 404, start ok', async () => {
    expect((await dev.post(`${W}/break`).send({ type: 'Nap' })).status).toBe(422);
    expect((await dev.post(`${W}/timer/start`).send({ taskId: 'T2' })).status).toBe(404);
    const r = await dev.post(`${W}/timer/start`).send({ taskId: 'T1' });
    expect(r.status).toBe(200);
    expect(r.body.data.message).toBe('Timer started · Checkout API');
    const me = (await dev.get(`${W}/me`)).body.data;
    expect(me.timer).toMatchObject({ taskId: 'T1', projectId: 'PR-101', title: 'Checkout API' });
  });

  test('break stops the timer and logs its time', async () => {
    await db('active_timers').where({ person_id: 'vg' }).update({ started_at: db.raw("started_at - interval '6 minutes'") });
    const r = await dev.post(`${W}/break`).send({ type: 'Lunch', note: 'canteen' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ type: 'Lunch', planMin: 45, note: 'canteen' });
    expect(r.body.data.message).toMatch(/^Lunch break started · back by /);
    expect(r.body.data.log).toMatchObject({ projectId: 'PR-101', milestoneId: 'PR-101-M2', note: 'Checkout API · timer' });

    const logs = await db('time_logs').where({ member_id: 'vg' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ source: 'timer', note: 'Checkout API · timer', day: ymd(Date.now()) });
    expect(logs[0].hours).toBeCloseTo(0.1, 1);
    expect(await db('active_timers').where({ person_id: 'vg' })).toHaveLength(0);
    const stop = await db('activity_feed').where({ person_id: 'vg', kind: 'stop' }).first();
    expect(stop.text).toMatch(/^Stopped timer · Checkout API · 6m$/);

    const me = (await dev.get(`${W}/me`)).body.data;
    expect(me.status).toBe('On break');
    expect(me.break).toMatchObject({ type: 'Lunch', planMin: 45, note: 'canteen', over: false });
    expect((await dev.post(`${W}/break`).send({ type: 'Tea / coffee' })).status).toBe(409);
    expect((await dev.post(`${W}/timer/start`).send({ taskId: 'T1' })).status).toBe(422);
  });

  test('end break → "Welcome back" with overBy', async () => {
    const canOverrun = shift > 55 * MINUTE;
    if (canOverrun) {
      await db('attendance_events').where({ person_id: 'vg', kind: 'break' }).update({ at: db.raw("at - interval '50 minutes'") });
      const me = (await dev.get(`${W}/me`)).body.data;
      expect(me.break.over).toBe(true);
    }
    const r = await dev.post(`${W}/break/end`);
    expect(r.status).toBe(200);
    if (canOverrun) {
      expect(r.body.data.length).toBe('50m');
      expect(r.body.data.overBy).toBe('5m');
      expect(r.body.data.message).toBe('Welcome back · 50m break · 5m over');
    } else {
      expect(r.body.data.overBy).toBeNull();
    }
    expect((await dev.post(`${W}/break/end`)).status).toBe(422);
    const me = (await dev.get(`${W}/me`)).body.data;
    expect(me.status).toBe('Working');
    expect(me.events.map((e) => e.kind)).toEqual(['login', 'break', 'resume']);
    expect(me.breaks).toBe(1);
  });

  test('timer stop creates a time log', async () => {
    await dev.post(`${W}/timer/start`).send({ taskId: 'T1' });
    await db('active_timers').where({ person_id: 'vg' }).update({ started_at: db.raw("started_at - interval '3 minutes'") });
    const r = await dev.post(`${W}/timer/stop`);
    expect(r.status).toBe(200);
    expect(r.body.data.log.hours).toBeCloseTo(0.05, 2);
    expect(await db('time_logs').where({ member_id: 'vg', source: 'timer' })).toHaveLength(2);
    expect((await dev.post(`${W}/timer/stop`)).status).toBe(422);
  });

  test('heartbeat updates presence', async () => {
    const r = await dev.post(`${W}/heartbeat`);
    expect(r.status).toBe(200);
    expect(await db('presence').where({ person_id: 'vg' }).first()).toBeTruthy();
  });

  test('end-shift form is prefilled', async () => {
    await dev.post(`${W}/timer/start`).send({ taskId: 'T1' });
    const r = await dev.get(`${W}/end-shift`);
    expect(r.status).toBe(200);
    const f = r.body.data;
    expect(f.sales).toBe(false);
    expect(f.rows.map((x) => x.p)).toEqual(['PR-101']);
    expect(f.rows[0].ms).toBe('PR-101-M2');
    expect(f.rows[0].note).toContain('Checkout API · timer');
    expect(f.pmRows).toEqual([]);
    expect(f.workedHours).toBeGreaterThan(0);
  });

  test('end-shift validation (frontend wording)', async () => {
    let r = await dev.post(`${W}/end-shift`).send({ rows: [{ p: 'PR-101', h: '' }], done: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Add hours for at least one project.');
    r = await dev.post(`${W}/end-shift`).send({ rows: [{ p: 'PR-101', h: 20 }], done: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/^Logged 20h but you worked (\d+h )?\d+m\. Reduce hours to match time worked\.$/);
    r = await dev.post(`${W}/end-shift`).send({ rows: [{ p: 'PR-101', h: 0.01 }], done: '  ' });
    expect(r.body.error.message).toBe('Write what you completed today.');
    r = await dev.post(`${W}/end-shift`).send({ rows: [{ p: 'PR-101', h: 30 }], done: 'x' });
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('end-shift submit replaces today\'s logs and checks out', async () => {
    const worked = (await dev.get(`${W}/end-shift`)).body.data.workedHours;
    const h = Math.min(1, Math.floor(worked * 100) / 100);
    const r = await dev.post(`${W}/end-shift`).send({
      rows: [{ p: 'PR-101', ms: 'PR-101-M2', h: String(h), note: 'Checkout API' }, { p: '', h: '' }],
      done: 'Finished checkout API', blockers: '', plan: 'Tests', pmRows: [],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.message).toBe('Report submitted · shift ended');
    const logs = await db('time_logs').where({ member_id: 'vg', day: ymd(Date.now()) });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ project_id: 'PR-101', milestone_id: 'PR-101-M2', source: 'shift-report', note: 'Checkout API' });
    const rep = await db('shift_reports').where({ person_id: 'vg' }).first();
    expect(rep).toMatchObject({ is_sales: false, done: 'Finished checkout API', plan: 'Tests' });
    const me = (await dev.get(`${W}/me`)).body.data;
    expect(me.status).toBe('Checked out');
    expect(me.timer).toBeNull();
    expect(me.events.at(-1).kind).toBe('logout');
    expect(await db('activity_feed').where({ person_id: 'vg', kind: 'out', text: 'Checked out' })).toHaveLength(1);
  });

  test('check-out resumes an open break first', async () => {
    const qa = await as('qa@test.io');
    await qa.post(`${W}/check-in`);
    await qa.post(`${W}/break`).send({ type: 'Personal' });
    const r = await qa.post(`${W}/check-out`);
    expect(r.status).toBe(200);
    const kinds = (await db('attendance_events').where({ person_id: 'dn' }).orderBy('id')).map((e) => e.kind);
    expect(kinds).toEqual(['login', 'break', 'resume', 'logout']);
  });
});

describe('PM and sales end-shift forms', () => {
  test('PM gets status rows for projects they manage', async () => {
    const f = (await (await as('pm@test.io')).get(`${W}/end-shift`)).body.data;
    expect(f.pmRows.map((x) => x.p).sort()).toEqual(['PR-101', 'PR-102']);
    expect(f.pmRows[0].st).toBe('On track');
  });

  test('sales form has auto stats; summary is required', async () => {
    await db('lead_activities').insert([{ lead_id: 'MX-1002', kind: 'call', text: 'Called Riya' }, { lead_id: 'MX-1002', kind: 'email', text: 'Sent deck' }]);
    const se = await as('se@test.io');
    const f = (await se.get(`${W}/end-shift`)).body.data;
    expect(f.sales).toBe(true);
    expect(f.calls).toBe(1);
    expect(f.auto).toMatchObject({ leadsTouched: 1, calls: 1, emails: 1, quotes: 0 });
    expect(f.auto.followUpsDone).toBe('0 / 0');
    await se.post(`${W}/check-in`);
    let r = await se.post(`${W}/end-shift`).send({ outcome: ' ', calls: '1' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Write a short summary of your day.');
    r = await se.post(`${W}/end-shift`).send({ outcome: 'Good calls', calls: '3', meetings: '' });
    expect(r.status).toBe(200);
    expect(await db('shift_reports').where({ person_id: 'ps' }).first()).toMatchObject({ is_sales: true, calls: 3, meetings: 0, outcome: 'Good calls' });
    expect((await se.get(`${W}/me`)).body.data.status).toBe('Checked out');
  });

  test('sales cannot run task timers', async () => {
    const sm = await as('sm@test.io');
    await sm.post(`${W}/check-in`);
    const r = await sm.post(`${W}/timer/start`).send({ taskId: 'T1' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Timers are for delivery staff.');
  });
});
