import { resetDb, as, closeDb, app } from './helpers.js';
import request from 'supertest';
import { db } from '../src/db/knex.js';

const API = '/api/v1';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

describe('leads: list, scope, permissions', () => {
  test('401 without a token', async () => {
    const res = await request(app).get(`${API}/leads`);
    expect(res.status).toBe(401);
  });

  test('CEO sees all leads with computed insights', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get(`${API}/leads`);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, total: 2 });
    const l = res.body.data.find((x) => x.id === 'MX-1001');
    expect(l).toMatchObject({ company: 'Zenvy Retail', ownerId: 'ak', ownerName: 'Aman Kapoor', status: 'New', value: 800000, services: ['Mobile App'], duplicateOf: null, nextFollowUp: null });
    // value 8L → 16, New 5, touched today 20, Website 7 = 48
    expect(l.score).toBe(48);
    expect(l.hot).toBe(false);
    expect(l.stale).toBe(false);
    expect(typeof l.lastContactAt).toBe('string');
  });

  test('sales executive only sees own leads; others 404 on read, 403 on write', async () => {
    const se = await as('se@test.io');
    const res = await se.get(`${API}/leads`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1002']);
    expect((await se.get(`${API}/leads/MX-1001`)).status).toBe(404);
    expect((await se.patch(`${API}/leads/MX-1001/status`).send({ status: 'Contacted' })).status).toBe(403);
    expect((await se.delete(`${API}/leads/MX-1002`)).status).toBe(403); // no delete permission
  });

  test('roles without leads access get 403', async () => {
    const dev = await as('dev@test.io');
    expect((await dev.get(`${API}/leads`)).status).toBe(403);
  });

  test('bad id → 422', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.get(`${API}/leads/nope`)).status).toBe(422);
  });
});

describe('leads: create / update', () => {
  test('validation messages match the frontend', async () => {
    const sm = await as('sm@test.io');
    let res = await sm.post(`${API}/leads`).send({ company: ' ', contact: 'X', services: ['Mobile App'] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'RULE_VIOLATION', message: 'Company and contact person are required.' });
    res = await sm.post(`${API}/leads`).send({ company: 'Acme', contact: 'X', services: [] });
    expect(res.body.error.message).toBe('Pick at least one service.');
  });

  test('sales executive creates leads for themselves', async () => {
    const se = await as('se@test.io');
    const res = await se.post(`${API}/leads`).send({ company: ' Orbit Fintech ', contact: 'Omar Khan', email: 'omar@orbit.io', phone: '98111 22233', services: 'AI / ML, Mobile App', ownerId: 'ak', value: '150000' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 'MX-1003', company: 'Orbit Fintech', ownerId: 'ps', firstOwnerId: 'ps', status: 'New', source: 'Website', services: ['AI / ML', 'Mobile App'], value: 150000 });
    expect(res.body.data.activities).toEqual([]);
  });

  test('PATCH updates fields; status / owner changes add activities', async () => {
    const sm = await as('sm@test.io');
    let res = await sm.patch(`${API}/leads/MX-1001`).send({ phone: '+91 90000 00000', notes: 'Hot prospect' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ phone: '+91 90000 00000', notes: 'Hot prospect' });

    res = await sm.patch(`${API}/leads/MX-1001/status`).send({ status: 'Contacted' });
    expect(res.body.data.status).toBe('Contacted');
    expect(res.body.data.activities.at(-1)).toMatchObject({ kind: 'status', text: 'Stage: New → Contacted', actorUserId: 'u-ak' });

    res = await sm.patch(`${API}/leads/MX-1001/status`).send({ status: 'Bogus' });
    expect(res.status).toBe(422);

    res = await sm.patch(`${API}/leads/MX-1001/owner`).send({ ownerId: 'ps' });
    expect(res.body.data).toMatchObject({ ownerId: 'ps', firstOwnerId: 'ak' });
    expect(res.body.data.activities.at(-1)).toMatchObject({ kind: 'owner', text: 'Transferred Aman Kapoor → Priya Sharma' });
    await sm.patch(`${API}/leads/MX-1001/owner`).send({ ownerId: 'ak' });
    const lead = await db('leads').where({ id: 'MX-1001' }).first();
    expect(lead.first_owner_id).toBe('ak');
  });

  test('log an activity', async () => {
    const sm = await as('sm@test.io');
    const res = await sm.post(`${API}/leads/MX-1001/activities`).send({ kind: 'call', text: 'Called Ankit Mehta' });
    expect(res.status).toBe(201);
    expect(res.body.data.at(-1)).toMatchObject({ kind: 'call', text: 'Called Ankit Mehta' });
    expect((await sm.post(`${API}/leads/MX-1001/activities`).send({ kind: 'status', text: 'x' })).status).toBe(422);
  });
});

describe('leads: filters, duplicates, bulk, merge, CSV', () => {
  beforeAll(async () => {
    const sm = await as('sm@test.io');
    // Duplicate of MX-1002 by email + phone
    await sm.post(`${API}/leads`).send({ company: 'Kaveri Foods Pvt', contact: 'Riya G', email: 'RIYA@kaveri.com', phone: '9123456789', services: ['Web Development'], source: 'Referral', ownerId: 'ps', notes: 'From expo' });
    await db('leads').where({ id: 'MX-1004' }).update({ created_at: new Date(Date.now() - 40 * 864e5) });
  });

  test('flag=dup, q, status, owner, source, service and date filters', async () => {
    const ceo = await as('ceo@test.io');
    let res = await ceo.get(`${API}/leads?flag=dup`);
    expect(res.body.data.map((l) => l.id).sort()).toEqual(['MX-1002', 'MX-1004']);
    expect(res.body.data.find((l) => l.id === 'MX-1002').duplicateOf).toEqual({ 'MX-1004': 'email & phone' });

    res = await ceo.get(`${API}/leads?q=zenvy`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1001']);
    res = await ceo.get(`${API}/leads?status=Contacted`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1001']);
    res = await ceo.get(`${API}/leads?owner=ps&source=Website`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1003']);
    res = await ceo.get(`${API}/leads?service=AI%20%2F%20ML`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1003']);
    const d = new Date(Date.now() - 40 * 864e5);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    res = await ceo.get(`${API}/leads?from=${day}&to=${day}`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1004']);
    res = await ceo.get(`${API}/leads?flag=stale&staleDays=30`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1004']);
  });

  test('sort and pagination', async () => {
    const ceo = await as('ceo@test.io');
    let res = await ceo.get(`${API}/leads?sort=value`);
    expect(res.body.data[0].value).toBe(0);
    res = await ceo.get(`${API}/leads?sort=-score&pageSize=2&page=2`);
    expect(res.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 4, pageCount: 2 });
    expect(res.body.data).toHaveLength(2);
    res = await ceo.get(`${API}/leads?sort=company`);
    expect(res.body.data.map((l) => l.company)[0]).toBe('Kaveri Foods');
  });

  test('duplicates lookup', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get(`${API}/leads/duplicates?email=riya@kaveri.com&excludeId=MX-1004`);
    expect(res.body.data.map((l) => l.id)).toEqual(['MX-1002']);
    const se = await as('se@test.io');
    const r2 = await se.get(`${API}/leads/duplicates?company=Zenvy%20Retail`);
    expect(r2.body.data).toEqual([]); // MX-1001 belongs to ak
  });

  test('CSV export: BOM, frontend columns, filters and scope', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.get(`${API}/leads/export.csv?owner=ps`).buffer(true).parse((r, cb) => { let s = ''; r.setEncoding('utf8'); r.on('data', (c) => { s += c; }); r.on('end', () => cb(null, s)); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/mariox-leads-\d{4}-\d{2}-\d{2}\.csv/);
    const text = res.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\n');
    expect(lines[0]).toBe('"ID","Company","Contact","Email","Phone","Service","Source","Owner","Stage","Value (INR)","Score","Created","Last contact"');
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.startsWith('"MX-1003"'))).toContain('"AI / ML, Mobile App","Website","Priya Sharma","New","150000"');

    const se = await as('se@test.io');
    const r2 = await se.get(`${API}/leads/export.csv`).buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => cb(null, s)); });
    expect(r2.body).not.toContain('MX-1001');
  });

  test('bulk status / owner', async () => {
    const sm = await as('sm@test.io');
    let res = await sm.post(`${API}/leads/bulk`).send({ ids: ['MX-1003', 'MX-1004'], status: 'Qualified' });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('2 leads moved to Qualified');
    const acts = await db('lead_activities').where({ lead_id: 'MX-1004', kind: 'status' });
    expect(acts.map((a) => a.text)).toEqual(['Stage: New → Qualified']);
    res = await sm.post(`${API}/leads/bulk`).send({ ids: ['MX-1003'], owner: 'ak' });
    expect(res.body.data.message).toBe('1 leads assigned to Aman Kapoor');
    res = await sm.post(`${API}/leads/bulk`).send({ ids: ['MX-1003'] });
    expect(res.status).toBe(422);
    const se = await as('se@test.io');
    expect((await se.post(`${API}/leads/bulk`).send({ ids: ['MX-1001'], status: 'Lost' })).status).toBe(403);
    await sm.post(`${API}/leads/bulk`).send({ ids: ['MX-1003'], owner: 'ps' });
  });

  test('merge moves follow-ups, quotes, documents and activities', async () => {
    const sm = await as('sm@test.io');
    await db('follow_ups').insert({ id: 'F900', type: 'Call', title: 'Ring', lead_id: 'MX-1004', owner_id: 'ps', due_at: new Date(Date.now() + 864e5) });
    await db('quotes').insert({ id: 'Q-1004-1', lead_id: 'MX-1004', items: JSON.stringify([{ d: 'Site', q: 1, r: 1000 }]), net: 1000, total: 1180 });
    await db('lead_activities').insert({ lead_id: 'MX-1004', kind: 'note', text: 'old note' });
    await db('documents').insert({ entity_type: 'lead', entity_id: 'MX-1004', name: 'x.pdf', size: 1, storage_path: 'nowhere/x.pdf' });

    const res = await sm.post(`${API}/leads/merge`).send({ keepId: 'MX-1002', dropId: 'MX-1004' });
    expect(res.status).toBe(200);
    const k = res.body.data;
    expect(k.notes).toBe('From expo');
    expect(k.quotes.map((q) => q.id)).toEqual(['Q-1004-1']);
    expect(k.followUps.map((f) => f.id)).toEqual(['F900']);
    expect(k.documents.map((d) => d.name)).toEqual(['x.pdf']);
    expect(k.activities.map((a) => a.text)).toEqual(expect.arrayContaining(['old note', 'Merged MX-1004 (Kaveri Foods Pvt) into this lead']));
    expect(await db('leads').where({ id: 'MX-1004' }).first()).toBeUndefined();
    expect((await sm.post(`${API}/leads/merge`).send({ keepId: 'MX-1002', dropId: 'MX-1002' })).status).toBe(422);
    await db('documents').where({ entity_id: 'MX-1002' }).del();
  });
});

describe('quotes', () => {
  test('validation, totals, send → Proposal Sent, accept → Won', async () => {
    const sm = await as('sm@test.io');
    await db('leads').where({ id: 'MX-1001' }).update({ company: 'Zenvy <script>alert(1)</script>' });
    let res = await sm.post(`${API}/leads/MX-1001/quotes`).send({ items: [{ d: ' ', q: 1, r: 100 }, { d: 'Design', q: 1, r: 0 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Add at least one line with a description and a rate.');

    res = await sm.post(`${API}/leads/MX-1001/quotes`).send({ items: [{ d: 'App build', q: 2, r: 100000 }, { d: '', q: 1, r: 5 }], discountPct: 10, gst: true, validDays: 0, terms: '50% advance' });
    expect(res.status).toBe(201);
    const q = res.body.data;
    expect(q).toMatchObject({ id: 'Q-1001-1', status: 'Draft', sub: 200000, discount: 20000, net: 180000, tax: 32400, total: 212400, validDays: 15, items: [{ d: 'App build', q: 2, r: 100000 }] });

    res = await sm.patch(`${API}/leads/MX-1001/quotes/Q-1001-1`).send({ discountPct: 0 });
    expect(res.body.data).toMatchObject({ net: 200000, total: 236000, terms: '50% advance' });

    res = await sm.post(`${API}/leads/MX-1001/quotes/Q-1001-1/send`);
    expect(res.body.data).toMatchObject({ status: 'Sent' });
    let lead = (await sm.get(`${API}/leads/MX-1001`)).body.data;
    expect(lead.status).toBe('Proposal Sent');
    expect(lead.activities.slice(-4).map((a) => a.text)).toEqual([
      'Created quote Q-1001-1 · ₹2.1 L', 'Updated quote Q-1001-1 · ₹2.4 L', 'Sent quote Q-1001-1 to ankit@zenvy.com', 'Stage: Contacted → Proposal Sent',
    ]);

    res = await sm.post(`${API}/leads/MX-1001/quotes/Q-1001-1/status`).send({ status: 'Accepted' });
    expect(res.body.data).toMatchObject({ leadStatus: 'Won', quote: { status: 'Accepted' } });
    lead = (await sm.get(`${API}/leads/MX-1001`)).body.data;
    expect(lead).toMatchObject({ status: 'Won', value: 200000 });
    expect(lead.activities.slice(-2).map((a) => a.text)).toEqual(['Quote Q-1001-1 accepted', 'Stage: Proposal Sent → Won']);

    expect((await sm.post(`${API}/leads/MX-1001/quotes/Q-1001-1/status`).send({ status: 'Draft' })).status).toBe(422);
    expect((await sm.post(`${API}/leads/MX-1001/quotes/Q-1001-9/send`)).status).toBe(404);
  });

  test('create with send=true, and second quote numbering', async () => {
    const se = await as('se@test.io');
    const res = await se.post(`${API}/leads/MX-1003/quotes`).send({ items: [{ d: 'MVP', q: 1, r: 50000 }], gst: false, send: true });
    expect(res.body.data).toMatchObject({ id: 'Q-1003-1', status: 'Sent', total: 50000 });
    const lead = (await se.get(`${API}/leads/MX-1003`)).body.data;
    expect(lead.status).toBe('Proposal Sent'); // was Qualified
    expect((await se.post(`${API}/leads/MX-1001/quotes`).send({ items: [{ d: 'x', q: 1, r: 1 }] })).status).toBe(403);
  });

  test('print returns escaped HTML', async () => {
    const sm = await as('sm@test.io');
    const res = await sm.get(`${API}/leads/MX-1001/quotes/Q-1001-1/print`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Zenvy &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('Aman Kapoor');
    expect(res.text).toContain('₹2,36,000');
  });
});

describe('leads: delete', () => {
  test('sales manager deletes a lead', async () => {
    const sm = await as('sm@test.io');
    expect((await sm.delete(`${API}/leads/MX-1003`)).status).toBe(204);
    expect((await sm.get(`${API}/leads/MX-1003`)).status).toBe(404);
    expect(await db('quotes').where({ lead_id: 'MX-1003' })).toEqual([]);
  });
});
