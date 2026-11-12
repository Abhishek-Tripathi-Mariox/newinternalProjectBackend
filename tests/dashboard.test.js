import { resetDb, as, closeDb } from './helpers.js';
import { db } from '../src/db/knex.js';

const API = '/api/v1';
const DAY = 864e5;
const sod = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const now = Date.now();
const T = sod(now);
const at = (days) => new Date(T - days * DAY + 10 * 3600e3); // 10:00 local, `days` ago

beforeAll(async () => {
  await resetDb();
  const lead = (id, owner, status, value, source, days) => ({ id, company: `Co ${id}`, contact: 'C', owner_id: owner, first_owner_id: owner, status, value, source, services: ['Mobile App'], created_at: at(days) });
  await db('leads').insert([
    lead('MX-2001', 'ak', 'Won', 500000, 'Referral', 5),
    lead('MX-2002', 'ak', 'Lost', 100000, 'Website', 10),
    lead('MX-2003', 'ps', 'Won', 200000, 'Referral', 3),
    lead('MX-2004', 'ps', 'Proposal Sent', 300000, 'LinkedIn', 40),
  ]);
  await db('leads').whereIn('id', ['MX-1001', 'MX-1002']).update({ created_at: at(0) });
  await db('follow_ups').insert([
    { id: 'F1', type: 'Meeting', title: 'Today', owner_id: 'ak', lead_id: 'MX-1001', due_at: new Date(now + Math.max(1000, (T + DAY - now) / 2)) },
    { id: 'F2', type: 'Call', title: 'Overdue', owner_id: 'ps', due_at: new Date(T - DAY) },
    { id: 'F3', type: 'Call', title: 'Done', owner_id: 'ak', due_at: new Date(T - DAY), done: true },
  ]);
});
afterAll(async () => { await closeDb(); });

test('sales dashboard (30 days) for the CEO', async () => {
  const ceo = await as('ceo@test.io');
  const res = await ceo.get(`${API}/dashboard/sales?period=30`);
  expect(res.status).toBe(200);
  const d = res.body.data;
  expect(d).toMatchObject({ period: '30', label: 'Last 30 days', range: { from: ymd(T - 29 * DAY), to: ymd(T) }, owner: null });
  expect(d.kpis).toEqual({
    newLeads: 5, newLeadsPrev: 1, newLeadsDelta: 400, openLeads: 3, openValue: 1450000, won: 2, wonValue: 700000, lost: 1, winRate: 67,
    followUpsToday: 1, followUpsOverdue: 1,
  });
  expect(d.funnel.map((f) => [f.status, f.count])).toEqual([['New', 1], ['Contacted', 0], ['Qualified', 1], ['Proposal Sent', 0], ['Negotiation', 0], ['Won', 2], ['Lost', 1]]);
  expect(d.funnel.find((f) => f.status === 'Won')).toMatchObject({ pct: 1, value: 700000 });
  expect(d.sources.slice(0, 2)).toEqual([{ source: 'Referral', n: 3, pct: 1 }, { source: 'Website', n: 2, pct: 2 / 3 }]);
  expect(d.months).toHaveLength(6);
  expect(d.months.at(-1).month).toBe(ymd(T).slice(0, 7));
  expect(d.months.reduce((a, m) => a + m.total, 0)).toBe(6);
  expect(d.agenda.map((f) => f.id)).toEqual(['F1']);
  expect(d.team).toEqual([
    { id: 'ak', name: 'Aman Kapoor', open: 1, pipe: 800000, won: 1, wonValue: 500000, pending: 1, overdue: 0 },
    { id: 'ps', name: 'Priya Sharma', open: 2, pipe: 650000, won: 1, wonValue: 200000, pending: 1, overdue: 1 },
  ]);
});

test('owner filter', async () => {
  const sm = await as('sm@test.io');
  const d = (await sm.get(`${API}/dashboard/sales?period=30&owner=ak`)).body.data;
  expect(d.kpis).toMatchObject({ newLeads: 3, newLeadsDelta: null, won: 1, lost: 1, winRate: 50, followUpsToday: 1, followUpsOverdue: 0 });
  expect(d.team.map((t) => t.id)).toEqual(['ak']);
});

test('sales executive (dash own) only sees their own numbers', async () => {
  const se = await as('se@test.io');
  const d = (await se.get(`${API}/dashboard/sales?period=30&owner=ak`)).body.data;
  expect(d.owner).toBe('ps');
  expect(d.kpis).toMatchObject({ newLeads: 2, newLeadsPrev: 1, newLeadsDelta: 100, openLeads: 2, won: 1, wonValue: 200000, followUpsToday: 0, followUpsOverdue: 1 });
  expect(d.team.map((t) => t.id)).toEqual(['ps']);
});

test('custom (reversed) and ytd periods; validation; permissions', async () => {
  const ceo = await as('ceo@test.io');
  let d = (await ceo.get(`${API}/dashboard/sales?period=custom&from=${ymd(T - 4 * DAY)}&to=${ymd(T - 6 * DAY)}`)).body.data;
  expect(d.range).toEqual({ from: ymd(T - 6 * DAY), to: ymd(T - 4 * DAY) });
  expect(d.kpis.newLeads).toBe(1); // MX-2001
  expect(d.label).toContain('–');
  d = (await ceo.get(`${API}/dashboard/sales?period=ytd`)).body.data;
  expect(d.range.from).toBe(`${new Date(T).getFullYear()}-01-01`);
  expect((await ceo.get(`${API}/dashboard/sales?period=12`)).status).toBe(422);
  const dev = await as('dev@test.io');
  expect((await dev.get(`${API}/dashboard/sales`)).status).toBe(403);
});
