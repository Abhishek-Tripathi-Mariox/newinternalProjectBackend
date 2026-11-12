import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb, clearTokens, tokenFor, app } from './helpers.js';
import request from 'supertest';
import { sod, addDays, isSunday, ymd, MINUTE, HOUR } from '../src/modules/workday/time.js';

const API = '/api/v1';

// A recent past working day (Mon–Sat) so the fixture is independent of when tests run.
let D = addDays(sod(Date.now()), -1);
while (isSunday(D)) D = addDays(D, -1);
const DAY = ymd(D);
const at = (h, m = 0) => new Date(D + h * HOUR + m * MINUTE);

beforeAll(async () => {
  clearTokens();
  await resetDb();
  await db('attendance_events').insert([
    // Divya: 09:00 in, 13:00–13:45 lunch, 18:30 out → 8h 45m worked, 45m break, on time
    { person_id: 'dn', kind: 'login', at: at(9) },
    { person_id: 'dn', kind: 'break', at: at(13), meta: { type: 'Lunch', planMin: 45, note: '' } },
    { person_id: 'dn', kind: 'resume', at: at(13, 45) },
    { person_id: 'dn', kind: 'logout', at: at(18, 30) },
    // Karan: 11:00 in (late), 15:00 out → 4h
    { person_id: 'km', kind: 'login', at: at(11) },
    { person_id: 'km', kind: 'logout', at: at(15) },
  ]);
  await db('shift_reports').insert({ person_id: 'dn', day: DAY, done: 'Regression pass', rows: JSON.stringify([{ p: 'PR-101', ms: 'PR-101-M2', h: 8, note: 'QA' }]) });
});
afterAll(closeDb);

describe('CEO-only access', () => {
  test.each(['/live', '/attendance', '/reports/timeline', '/reports/hours-log', '/attendance/export.csv'])('%s → 403 for staff', async (path) => {
    const res = await (await as('pm@test.io')).get(`${API}${path}`);
    expect(res.status).toBe(403);
  });

  test('admin and CEO previewing are refused', async () => {
    expect((await (await as('admin@test.io')).get(`${API}/live`)).status).toBe(403);
    const t = await tokenFor('ceo@test.io');
    const res = await request(app).get(`${API}/live`).set('Authorization', `Bearer ${t}`).set('X-View-As', 'u-vg');
    expect(res.status).toBe(403);
    const act = await request(app).post(`${API}/live/vg/check-in`).set('Authorization', `Bearer ${t}`).set('X-View-As', 'u-vg');
    expect(act.status).toBe(403);
  });

  test('staff cannot act on others', async () => {
    expect((await (await as('dev@test.io')).post(`${API}/live/si/check-in`)).status).toBe(403);
  });
});

describe('Live now', () => {
  let ceo;
  beforeAll(async () => { ceo = await as('ceo@test.io'); });

  test('people, KPIs, summary', async () => {
    const res = await ceo.get(`${API}/live`);
    expect(res.status).toBe(200);
    const L = res.body.data;
    const ids = L.people.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['mj', 'vg', 'si', 'dn', 'km', 'ak', 'ps']));
    expect(L.kpis.map((k) => k.key)).toEqual(['work', 'break', 'idle', 'absent', 'delivery', 'sales']);
    expect(L.summary).toMatch(/^Mariox · .+ · .+\n\d+ working · \d+ on break · \d+ idle · \d+ not checked in\nDelivery hours today: [\d.]+h\nLeads touched today: \d+\n/);
    expect(L.chips[0]).toMatchObject({ key: 'all', label: 'Everyone', count: 7 });
    expect(['absent', 'off']).toContain(L.people.find((p) => p.id === 'vg').key);
  });

  test('CEO acts on a person: check-in, timer, break, resume, check-out', async () => {
    await db('tasks').insert({ id: 'T9', project_id: 'PR-101', milestone_id: 'PR-101-M2', title: 'Login screen', assignee_id: 'vg', status: 'In progress' });
    expect((await ceo.post(`${API}/live/nobody/check-in`)).status).toBe(404);
    expect((await ceo.post(`${API}/live/vg/check-in`)).status).toBe(200);

    let L = (await ceo.get(`${API}/live`)).body.data;
    let vg = L.people.find((p) => p.id === 'vg');
    expect(vg).toMatchObject({ key: 'notimer', status: 'No timer running', checkedIn: true, canStart: true, brkLabel: 'Break' });
    expect(vg.tasks).toEqual([{ value: 'T9', label: 'Login screen · Alpha App' }]);
    expect(L.alerts.map((a) => a.title)).toContain('1 checked in with no timer running');
    expect(L.feed.find((f) => f.personId === 'vg')).toMatchObject({ who: 'Vikas Gupta', text: 'Checked in', kind: 'in', group: 'team' });

    expect((await ceo.post(`${API}/live/vg/timer/start`).send({ taskId: 'T9' })).status).toBe(200);
    L = (await ceo.get(`${API}/live?filter=work`)).body.data;
    vg = L.people.find((p) => p.id === 'vg');
    expect(vg).toMatchObject({ key: 'work', status: 'Working', doing: 'Login screen' });
    expect(vg.doingSub).toMatch(/^Alpha App · timer running \d+m$/);

    // idle: no activity for 40 minutes
    await db('presence').where({ person_id: 'vg' }).update({ last_activity_at: new Date(Date.now() - 40 * MINUTE) });
    L = (await ceo.get(`${API}/live`)).body.data;
    expect(L.people.find((p) => p.id === 'vg')).toMatchObject({ key: 'idle', status: 'Idle 40m' });
    expect(L.alerts.map((a) => a.title)).toContain('1 idle for 30+ minutes');

    expect((await ceo.post(`${API}/live/vg/break`)).status).toBe(200);
    vg = (await ceo.get(`${API}/live`)).body.data.people.find((p) => p.id === 'vg');
    expect(vg).toMatchObject({ key: 'break', brkLabel: 'Resume', hasTimer: false });
    expect(vg.status).toMatch(/^On break · \d+m$/);
    expect((await ceo.post(`${API}/live/vg/resume`)).status).toBe(200);
    expect((await ceo.post(`${API}/live/vg/check-out`)).status).toBe(200);
    vg = (await ceo.get(`${API}/live`)).body.data.people.find((p) => p.id === 'vg');
    expect(vg.key).toBe('off');
    expect(vg.status).toMatch(/^Checked out /);

    const feed = (await ceo.get(`${API}/live?feed=team`)).body.data.feed.filter((f) => f.personId === 'vg').map((f) => f.text);
    expect(feed).toEqual(expect.arrayContaining(['Checked in', 'Started timer · Login screen', 'Went on break', 'Checked out']));
    expect((await ceo.get(`${API}/live?feed=sales`)).body.data.feed.every((f) => f.group === 'sales')).toBe(true);
    expect((await ceo.get(`${API}/live?feed=bogus`)).status).toBe(422);
  });
});

describe('Attendance', () => {
  let ceo;
  beforeAll(async () => { ceo = await as('ceo@test.io'); });

  test('day view sums worked / breaks / late', async () => {
    const res = await ceo.get(`${API}/attendance?range=date&date=${DAY}`);
    expect(res.status).toBe(200);
    const A = res.body.data;
    expect(A.view).toBe('day');
    const dn = A.rows.find((r) => r.personId === 'dn');
    expect(dn).toMatchObject({ status: 'Logged out', present: true, late: false, worked: '8h 45m', brkL: '1 · 45m', workMs: 8.75 * HOUR, breakMs: 45 * MINUTE });
    expect(dn.segs.map((s) => s.kind)).toEqual(['work', 'break', 'work']);
    expect(dn.events.map((e) => e.text)).toEqual(['Logged in', 'Started break', 'Back from break', 'Logged out']);
    expect(dn.report[0]).toEqual({ k: 'Hours', v: 'Alpha App 8h (QA)' });
    const km = A.rows.find((r) => r.personId === 'km');
    expect(km).toMatchObject({ late: true, worked: '4h 00m' });
    expect(A.rows.find((r) => r.personId === 'vg').status).toBe('Absent');
    const k = Object.fromEntries(A.kpis.map((x) => [x.label, x.value]));
    expect(k).toMatchObject({ Present: '2 / 7', Late: 1, 'Total worked': '12h 45m' });
  });

  test('team / q filters and person view', async () => {
    const qa = (await ceo.get(`${API}/attendance?range=date&date=${DAY}&team=QA`)).body.data;
    expect(qa.rows.map((r) => r.personId)).toEqual(['dn']);
    const q = (await ceo.get(`${API}/attendance?range=date&date=${DAY}&q=karan`)).body.data;
    expect(q.rows.map((r) => r.personId)).toEqual(['km']);
    const p = (await ceo.get(`${API}/attendance?range=date&date=${DAY}&person=dn`)).body.data;
    expect(p.view).toBe('person');
    expect(p.rows).toHaveLength(1);
    expect(p.kpis[0]).toMatchObject({ label: 'Days present', value: '1 / 1' });
    expect((await ceo.get(`${API}/attendance?range=date&date=${DAY}&person=zz`)).status).toBe(404);
  });

  test('summary view over 7 days', async () => {
    const S = (await ceo.get(`${API}/attendance?range=7d`)).body.data;
    expect(S.view).toBe('summary');
    const dn = S.summary.find((r) => r.personId === 'dn');
    expect(dn).toMatchObject({ presentDays: 1, late: 0, total: '8h 45m', avgIn: expect.stringMatching(/^9:00\s?am$/i) });
    expect(S.summary.find((r) => r.personId === 'km').late).toBe(1);
  });

  test('CSV export', async () => {
    const res = await ceo.get(`${API}/attendance/export.csv?range=date&date=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('Date,Person,Team,Logged in,Logged out,Breaks,Break time (min),Worked (h),Late');
    expect(res.text).toMatch(new RegExp(`${DAY},Divya Nair,QA,9:00\\s?am,6:30\\s?pm,1,45,8.75,`, 'i'));
    expect(res.text).toMatch(new RegExp(`${DAY},Karan Malhotra,Backend,.*,4.00,Yes`));
  });

  test('bad range → 422', async () => {
    expect((await ceo.get(`${API}/attendance?range=year`)).status).toBe(422);
    expect((await ceo.get(`${API}/attendance?range=date&date=12-11-2026`)).status).toBe(422);
  });
});

describe('Reports', () => {
  let ceo;
  beforeAll(async () => { ceo = await as('ceo@test.io'); });

  test('timeline day + week', async () => {
    const T = (await ceo.get(`${API}/reports/timeline?mode=day&day=${DAY}`)).body.data;
    const dn = T.rows.find((r) => r.personId === 'dn');
    expect(dn).toMatchObject({ total: '8h 45m', totalMs: 8.75 * HOUR });
    expect(dn.segs).toHaveLength(3);
    expect(T.cols).toHaveLength(9);
    expect(T.canNext).toBe(true);
    const Wk = (await ceo.get(`${API}/reports/timeline?mode=week&day=${DAY}&team=QA`)).body.data;
    expect(Wk.rows.map((r) => r.personId)).toEqual(['dn']);
    expect(Wk.cols).toHaveLength(7);
    expect(Wk.rows[0].dayTotals).toEqual([expect.objectContaining({ day: DAY, text: '8h 45m' })]);
  });

  test('hours log + CSV', async () => {
    const H = (await ceo.get(`${API}/reports/hours-log?person=dn&range=date&date=${DAY}`)).body.data;
    const k = Object.fromEntries(H.kpis.map((x) => [x.label, x.value]));
    expect(k).toMatchObject({ 'Total worked': '8h 45m', 'Break time': '45m', 'Days present': 1, 'Late logins': 0 });
    const ev = H.days[0].rows[0].events;
    expect(ev.map((e) => [e.label, e.sub])).toEqual([['Logged in', ''], ['Break', ''], ['Resumed', 'after 45m'], ['Logged out', 'session 9h 30m']]);
    const csv = await ceo.get(`${API}/reports/hours-log/export.csv?person=dn&range=date&date=${DAY}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Date,Person,Event,Time,Note');
    expect(csv.text).toContain('Divya Nair,Resumed');
  });
});
