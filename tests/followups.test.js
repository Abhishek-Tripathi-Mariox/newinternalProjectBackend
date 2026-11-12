import { resetDb, as, closeDb } from './helpers.js';
import { db } from '../src/db/knex.js';

const API = '/api/v1';
const MIN = 6e4;
const DAY = 864e5;
const sod = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

beforeAll(async () => {
  await resetDb();
  await db.raw("select setval('follow_up_code_seq', 1, false)"); // not reset by resetDb()
});
afterAll(async () => { await closeDb(); });

describe('follow-ups CRUD', () => {
  test('validation messages', async () => {
    const sm = await as('sm@test.io');
    let res = await sm.post(`${API}/follow-ups`).send({ type: 'Call', title: '  ', dueAt: new Date().toISOString() });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'RULE_VIOLATION', message: 'Add a title.' });
    res = await sm.post(`${API}/follow-ups`).send({ type: 'Call', title: 'Ring', date: '2026-11-20' });
    expect(res.body.error.message).toBe('Pick a date and time.');
    res = await sm.post(`${API}/follow-ups`).send({ type: 'Call', title: 'Ring', dueAt: 'garbage' });
    expect(res.body.error.message).toBe('Pick a date and time.');
    res = await sm.post(`${API}/follow-ups`).send({ type: 'Meeting', title: 'x', dueAt: new Date().toISOString(), meetUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(422);
  });

  test('create applies type defaults and builds a calendar link', async () => {
    const sm = await as('sm@test.io');
    const res = await sm.post(`${API}/follow-ups`).send({
      type: 'Call', title: 'Pricing discussion', leadId: 'MX-1001', ownerId: 'ak', date: '2026-11-20', time: '15:30', attendees: 'ankit@zenvy.com',
    });
    expect(res.status).toBe(201);
    const f = res.body.data;
    expect(f).toMatchObject({ id: 'F1', type: 'Call', durationMin: 15, remindMin: 10, priority: 'Medium', ownerId: 'ak', leadId: 'MX-1001', done: false, notified: false, lead: { company: 'Zenvy Retail' } });
    expect(f.dueAt).toBe(new Date('2026-11-20T15:30').toISOString());
    expect(f.calendarUrl).toContain('https://calendar.google.com/calendar/render?action=TEMPLATE&text=Pricing%20discussion%20%C2%B7%20Zenvy%20Retail');
    expect(f.calendarUrl).toContain('&add=ankit%40zenvy.com');
    expect(f.calendarUrl).toContain(encodeURIComponent('Lead: Zenvy Retail (Ankit Mehta)'));

    const t = await sm.post(`${API}/follow-ups`).send({ type: 'Task', title: 'Draft SOW', dueAt: new Date(Date.now() + 3 * DAY).toISOString(), durationMin: 5 });
    expect(t.body.data).toMatchObject({ durationMin: 5, remindMin: 60, leadId: null, ownerId: 'ak' });
  });

  test('sales executive: owner forced to self, cannot touch others', async () => {
    const se = await as('se@test.io');
    let res = await se.post(`${API}/follow-ups`).send({ type: 'Reminder', title: 'Mine', dueAt: new Date(Date.now() + DAY).toISOString() });
    expect(res.body.data).toMatchObject({ ownerId: 'ps', remindMin: 0 });
    res = await se.post(`${API}/follow-ups`).send({ type: 'Reminder', title: 'Theirs', ownerId: 'ak', dueAt: new Date(Date.now() + DAY).toISOString() });
    expect(res.status).toBe(403);
    expect((await se.get(`${API}/follow-ups/F1`)).status).toBe(404);
    expect((await se.patch(`${API}/follow-ups/F1`).send({ title: 'x' })).status).toBe(403);
    const list = await se.get(`${API}/follow-ups`);
    expect(list.body.data.map((f) => f.ownerId)).toEqual(['ps']);
  });

  test('PM (fu own, no sales profile) cannot own a follow-up; dev has no access', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/follow-ups`).send({ type: 'Call', title: 'x', dueAt: new Date().toISOString() });
    expect(res.body.error.message).toBe('Pick a valid owner.');
    const dev = await as('dev@test.io');
    expect((await dev.get(`${API}/follow-ups`)).status).toBe(403);
  });

  test('update resets notified; toggle done; delete', async () => {
    const sm = await as('sm@test.io');
    await db('follow_ups').where({ id: 'F1' }).update({ notified: true });
    let res = await sm.patch(`${API}/follow-ups/F1`).send({ title: 'Pricing call', priority: 'High' });
    expect(res.body.data).toMatchObject({ title: 'Pricing call', priority: 'High', notified: false, type: 'Call' });
    expect((await sm.patch(`${API}/follow-ups/F1`).send({ title: '' })).body.error.message).toBe('Add a title.');
    res = await sm.patch(`${API}/follow-ups/F1/toggle-done`);
    expect(res.body.data.done).toBe(true);
    res = await sm.patch(`${API}/follow-ups/F1/toggle-done`);
    expect(res.body.data.done).toBe(false);
    const se = await as('se@test.io');
    expect((await se.delete(`${API}/follow-ups/F2`)).status).toBe(403);
    expect((await sm.delete(`${API}/follow-ups/F2`)).status).toBe(204);
    expect((await sm.get(`${API}/follow-ups/F2`)).status).toBe(404);
  });
});

describe('follow-ups list tabs & filters', () => {
  beforeAll(async () => {
    await db('follow_ups').del();
    const now = Date.now();
    const T = sod(now);
    const laterToday = now + Math.max(1000, (T + DAY - now) / 2);
    const rows = [
      { id: 'F10', type: 'Meeting', title: 'Demo', lead_id: 'MX-1001', owner_id: 'ak', due_at: new Date(laterToday), meet_url: 'https://meet.google.com/abc' },
      { id: 'F11', type: 'Call', title: 'Overdue call', lead_id: 'MX-1002', owner_id: 'ps', due_at: new Date(T - DAY), priority: 'High' },
      { id: 'F12', type: 'Task', title: 'Upcoming task', owner_id: 'ak', due_at: new Date(T + 3 * DAY) },
      { id: 'F13', type: 'Call', title: 'Done call', lead_id: 'MX-1001', owner_id: 'ak', due_at: new Date(T - 2 * DAY), done: true },
    ];
    await db('follow_ups').insert(rows);
  });

  test('tabs with counts', async () => {
    const sm = await as('sm@test.io');
    const ids = async (qs) => (await sm.get(`${API}/follow-ups?${qs}`)).body.data.map((f) => f.id);
    expect(await ids('tab=today')).toEqual(['F10']);
    expect(await ids('tab=upcoming')).toEqual(['F12']);
    expect(await ids('tab=overdue')).toEqual(['F11']);
    expect(await ids('tab=completed')).toEqual(['F13']);
    expect(await ids('tab=all')).toEqual(['F13', 'F11', 'F10', 'F12']);
    const res = await sm.get(`${API}/follow-ups`);
    expect(res.body.meta.counts).toEqual({ today: 1, upcoming: 1, overdue: 1, completed: 1, all: 4 });
    expect(res.body.meta.total).toBe(4);
  });

  test('filters: type, owner, priority, meet, q (title or company), date range', async () => {
    const sm = await as('sm@test.io');
    const ids = async (qs) => (await sm.get(`${API}/follow-ups?${qs}`)).body.data.map((f) => f.id);
    expect(await ids('type=Call')).toEqual(['F13', 'F11']);
    expect(await ids('owner=ps')).toEqual(['F11']);
    expect(await ids('priority=High')).toEqual(['F11']);
    expect(await ids('meet=yes')).toEqual(['F10']);
    expect(await ids('q=kaveri')).toEqual(['F11']);
    expect(await ids('q=upcoming')).toEqual(['F12']);
    const d = new Date(sod(Date.now()) + 3 * DAY);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(await ids(`from=${day}&to=${day}`)).toEqual(['F12']);
    expect((await sm.get(`${API}/follow-ups?tab=nope`)).status).toBe(422);
  });

  test('lead detail and lead list show the next follow-up', async () => {
    const sm = await as('sm@test.io');
    const lead = (await sm.get(`${API}/leads/MX-1001`)).body.data;
    expect(lead.nextFollowUp).toMatchObject({ id: 'F10', type: 'Meeting', overdue: false });
    expect(lead.followUps.map((f) => f.id)).toEqual(['F13', 'F10']);
  });
});

describe('due reminders', () => {
  beforeAll(async () => {
    const now = Date.now();
    await db('follow_ups').insert([
      { id: 'F20', type: 'Meeting', title: 'In 5 min', owner_id: 'ps', due_at: new Date(now + 5 * MIN), remind_min: 10 },
      { id: 'F21', type: 'Meeting', title: 'In 30 min', owner_id: 'ps', due_at: new Date(now + 30 * MIN), remind_min: 10 },
      { id: 'F22', type: 'Call', title: 'Started 2 min ago', owner_id: 'ak', due_at: new Date(now - 2 * MIN), remind_min: 5 },
      { id: 'F23', type: 'Call', title: 'Started 10 min ago', owner_id: 'ak', due_at: new Date(now - 10 * MIN), remind_min: 5 },
      { id: 'F24', type: 'Reminder', title: 'No reminder', owner_id: 'ak', due_at: new Date(now + MIN), remind_min: 0 },
    ]);
  });

  test('window [due − remind, due + 5 min) and scope', async () => {
    const sm = await as('sm@test.io');
    let res = await sm.get(`${API}/follow-ups/due-reminders`);
    expect(res.body.data.map((f) => f.id)).toEqual(['F22', 'F20']);
    const se = await as('se@test.io');
    res = await se.get(`${API}/follow-ups/due-reminders`);
    expect(res.body.data.map((f) => f.id)).toEqual(['F20']);

    res = await se.post(`${API}/follow-ups/due-reminders/ack`).send({ ids: ['F20', 'F22'] });
    expect(res.body.data.ids).toEqual(['F20']); // F22 is not theirs
    res = await sm.get(`${API}/follow-ups/due-reminders`);
    expect(res.body.data.map((f) => f.id)).toEqual(['F22']);
  });

  test('reminderAlerts setting off → no reminders', async () => {
    await db('settings').where({ key: 'reminderAlerts' }).update({ value: JSON.stringify(false) });
    const sm = await as('sm@test.io');
    expect((await sm.get(`${API}/follow-ups/due-reminders`)).body.data).toEqual([]);
    await db('settings').where({ key: 'reminderAlerts' }).update({ value: JSON.stringify(true) });
  });
});
