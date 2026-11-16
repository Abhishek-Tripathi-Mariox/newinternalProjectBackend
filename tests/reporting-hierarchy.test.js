import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb } from './helpers.js';
import { sod, ymd } from '../src/modules/workday/time.js';

const API = '/api/v1';
const TODAY = ymd(sod(Date.now()));

beforeAll(async () => {
  await resetDb();
  // vg (dev) reports to mj (PM); si reports to vg → mj sees vg and si, vg sees si.
  await db('users').where({ id: 'u-vg' }).update({ reports_to: 'u-mj' });
  await db('users').where({ id: 'u-si' }).update({ reports_to: 'u-vg' });
  const at = new Date();
  await db('attendance_events').insert(['mj', 'vg', 'si', 'dn'].map((p) => ({ person_id: p, kind: 'login', at })));
  await db('shift_reports').insert(['vg', 'si', 'dn'].map((p) => ({
    person_id: p, day: TODAY, is_sales: false, done: `${p} work`, blockers: '', plan: '', outcome: '', calls: 0, meetings: 0,
    rows: JSON.stringify([]), pm_rows: JSON.stringify([]), internal_rows: JSON.stringify([{ cat: 'Learning', h: 1, note: `${p} internal` }]), submitted_at: at,
  })));
});
afterAll(closeDb);

const whos = (rows, k) => [...new Set(rows.map((r) => r[k]))].sort();

describe('"Reports to" hierarchy', () => {
  test('session user lists everyone below them (direct + indirect)', async () => {
    const me = (await (await as('pm@test.io')).get(`${API}/auth/me`)).body.data;
    expect(me.reportees.map((r) => r.pid).sort()).toEqual(['si', 'vg']);
    const dev = (await (await as('dev@test.io')).get(`${API}/auth/me`)).body.data;
    expect(dev.reportees.map((r) => r.pid)).toEqual(['si']);
    const qa = (await (await as('qa@test.io')).get(`${API}/auth/me`)).body.data;
    expect(qa.reportees).toEqual([]);
  });

  test('manager sees own + team attendance and shift reports (with internal work)', async () => {
    const pm = await as('pm@test.io');
    const ev = (await pm.get(`${API}/attendance/events?from=${TODAY}&to=${TODAY}`)).body.data;
    expect(whos(ev, 'personId')).toEqual(['mj', 'si', 'vg']);
    const reps = (await pm.get(`${API}/shift-reports`)).body.data;
    expect(whos(reps, 'who')).toEqual(['si', 'vg']);
    expect(reps.find((r) => r.who === 'si').internal).toEqual([{ cat: 'Learning', h: 1, note: 'si internal' }]);
    // narrowed to one team member; someone outside the team falls back to their own data
    expect(whos((await pm.get(`${API}/shift-reports?person=si`)).body.data, 'who')).toEqual(['si']);
    expect(whos((await pm.get(`${API}/shift-reports?person=dn`)).body.data, 'who')).toEqual([]);
  });

  test('someone with no team still sees only their own', async () => {
    const qa = await as('qa@test.io');
    expect(whos((await qa.get(`${API}/shift-reports`)).body.data, 'who')).toEqual(['dn']);
    expect(whos((await qa.get(`${API}/attendance/events?from=${TODAY}&to=${TODAY}`)).body.data, 'personId')).toEqual(['dn']);
  });

  test('live state stays the caller\'s own', async () => {
    const st = (await (await as('pm@test.io')).get(`${API}/live/state`)).body.data;
    expect(Object.keys(st.att)).toEqual(['mj']);
  });
});
