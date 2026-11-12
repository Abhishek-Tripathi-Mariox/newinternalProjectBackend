import { resetDb, closeDb, as, clearTokens } from './helpers.js';
import { db } from '../src/db/knex.js';

const API = '/api/v1';
const names = (res) => res.body.data.map((x) => x.name);

beforeAll(async () => { await resetDb(); clearTokens(); });
afterAll(closeDb);

describe('reads (any signed-in user)', () => {
  test('stages in pipeline order with usage; sources; services; settings', async () => {
    const dev = await as('dev@test.io');
    const st = await dev.get(`${API}/lead-stages`);
    expect(st.status).toBe(200);
    expect(names(st)).toEqual(['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost']);
    expect(st.body.data[0]).toMatchObject({ name: 'New', isCore: true, usage: 1, hue: 250 });
    expect((await dev.get(`${API}/lead-sources`)).body.data[0]).toMatchObject({ name: 'Website', usage: 1 });
    expect((await dev.get(`${API}/services`)).body.data.find((s) => s.name === 'Mobile App').usage).toBe(2); // 1 lead + 1 project
    expect((await dev.get(`${API}/settings`)).body.data).toEqual({ currency: 'INR', defaultLeadsView: 'Kanban', reminderAlerts: true });
  });
});

describe('lead stages', () => {
  test('writes need leads edit (403); preview applies the previewed role', async () => {
    expect((await (await as('dev@test.io')).post(`${API}/lead-stages`).send({ name: 'Demo' })).status).toBe(403);
    expect((await (await as('ceo@test.io')).post(`${API}/lead-stages`).send({ name: 'Demo' }).set('X-View-As', 'u-vg')).status).toBe(403);
  });

  test('add inserts before Won with a distinct hue; duplicates return the existing one', async () => {
    const sm = await as('sm@test.io');
    const r = await sm.post(`${API}/lead-stages`).send({ name: '  Demo   booked ' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ name: 'Demo booked', isCore: false });
    const list = await sm.get(`${API}/lead-stages`);
    expect(names(list)).toEqual(['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Demo booked', 'Won', 'Lost']);
    const dup = await sm.post(`${API}/lead-stages`).send({ name: 'demo BOOKED' });
    expect(dup.status).toBe(200);
    expect(dup.body.data.name).toBe('Demo booked');
    expect((await sm.post(`${API}/lead-stages`).send({ name: '   ' })).body.error.message).toBe('Enter a name.');
  });

  test('reorder only between New and Won/Lost', async () => {
    const sm = await as('sm@test.io');
    let r = await sm.post(`${API}/lead-stages/Contacted/move`).send({ dir: -1 }); // would pass New → no-op
    expect(names(r).slice(0, 2)).toEqual(['New', 'Contacted']);
    r = await sm.post(`${API}/lead-stages/Demo%20booked/move`).send({ dir: 1 }); // would pass Won → no-op
    expect(names(r).slice(-3)).toEqual(['Demo booked', 'Won', 'Lost']);
    r = await sm.post(`${API}/lead-stages/Demo%20booked/move`).send({ dir: -1 });
    expect(names(r)).toEqual(['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Demo booked', 'Negotiation', 'Won', 'Lost']);
    expect((await sm.post(`${API}/lead-stages/Won/move`).send({ dir: -1 })).status).toBe(422);
    expect((await sm.post(`${API}/lead-stages/Qualified/move`).send({ dir: 2 })).status).toBe(422);
  });

  test('rename cascades to leads; core stages refused; recolour', async () => {
    const sm = await as('sm@test.io');
    const r = await sm.patch(`${API}/lead-stages/Qualified`).send({ name: 'Sales Qualified', hue: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Sales Qualified', hue: 10, usage: 1 });
    expect((await db('leads').where({ id: 'MX-1002' }).first()).status).toBe('Sales Qualified');
    expect((await sm.patch(`${API}/lead-stages/Won`).send({ name: 'Closed' })).body.error.message).toBe('“Won” is a core stage and can\'t be renamed.');
    expect((await sm.patch(`${API}/lead-stages/Contacted`).send({ name: 'negotiation' })).body.error.message).toBe('A stage called “negotiation” already exists.');
    expect((await sm.patch(`${API}/lead-stages/Won`).send({ hue: 120 })).body.data.hue).toBe(120);
    expect((await sm.patch(`${API}/lead-stages/Nope`).send({ hue: 1 })).status).toBe(404);
  });

  test('delete refused for core / in-use stages', async () => {
    const sm = await as('sm@test.io');
    expect((await sm.delete(`${API}/lead-stages/New`)).body.error.message).toBe('“New” is a core stage and can\'t be removed');
    expect((await sm.delete(`${API}/lead-stages/Sales%20Qualified`)).body.error.message).toBe('Can\'t remove stage “Sales Qualified” — 1 lead uses it');
    expect((await sm.delete(`${API}/lead-stages/Demo%20booked`)).status).toBe(204);
    expect(names(await sm.get(`${API}/lead-stages`))).not.toContain('Demo booked');
  });
});

describe('lead sources', () => {
  test('add / rename (cascade) / move / delete rules', async () => {
    const sm = await as('sm@test.io');
    expect((await sm.post(`${API}/lead-sources`).send({ name: 'Trade Show' })).status).toBe(201);
    expect(names(await sm.get(`${API}/lead-sources`)).at(-1)).toBe('Trade Show');
    const r = await sm.patch(`${API}/lead-sources/Referral`).send({ name: 'Partner Referral' });
    expect(r.body.data.name).toBe('Partner Referral');
    expect((await db('leads').where({ id: 'MX-1002' }).first()).source).toBe('Partner Referral');
    expect((await sm.patch(`${API}/lead-sources/Upwork`).send({ name: 'linkedin' })).body.error.message).toBe('A source called “linkedin” already exists.');
    const mv = await sm.post(`${API}/lead-sources/Trade%20Show/move`).send({ dir: -1 });
    expect(names(mv).slice(-2)).toEqual(['Trade Show', 'Email Campaign']);
    expect((await sm.delete(`${API}/lead-sources/Website`)).body.error.message).toBe('Can\'t remove source “Website” — 1 lead uses it');
    expect((await sm.delete(`${API}/lead-sources/Trade%20Show`)).status).toBe(204);
  });

  test('keep at least one source', async () => {
    await db('leads').update({ source: null });
    await db('lead_sources').whereNot({ name: 'Website' }).del();
    const sm = await as('sm@test.io');
    const r = await sm.delete(`${API}/lead-sources/Website`);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Keep at least one source');
  });
});

describe('services', () => {
  test('rename updates text[] on leads and projects; commas cleaned; usage blocks delete', async () => {
    const sm = await as('sm@test.io');
    expect((await sm.post(`${API}/services`).send({ name: 'Cloud, DevOps' })).body.data.name).toBe('Cloud DevOps');
    const r = await sm.patch(`${API}/services/Mobile%20App`).send({ name: 'Mobile Apps' });
    expect(r.status).toBe(200);
    expect((await db('leads').where({ id: 'MX-1001' }).first()).services).toEqual(['Mobile Apps']);
    expect((await db('projects').where({ id: 'PR-101' }).first()).services).toEqual(['Mobile Apps']);
    expect((await sm.delete(`${API}/services/Mobile%20Apps`)).body.error.message).toBe('Can\'t remove service “Mobile Apps” — 2 lead / projects use it');
    expect((await sm.delete(`${API}/services/Cloud%20DevOps`)).status).toBe(204);
    expect((await sm.patch(`${API}/services/Nope`).send({ name: 'X' })).status).toBe(404);
  });
});

describe('settings', () => {
  test('PUT is Super Admin only (not Admin, not while previewing)', async () => {
    expect((await (await as('admin@test.io')).put(`${API}/settings`).send({ currency: 'USD' })).status).toBe(403);
    const ceo = await as('ceo@test.io');
    expect((await ceo.put(`${API}/settings`).send({ currency: 'USD' }).set('X-View-As', 'u-admin')).status).toBe(403);
    const r = await ceo.put(`${API}/settings`).send({ currency: 'USD', reminderAlerts: false });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ currency: 'USD', defaultLeadsView: 'Kanban', reminderAlerts: false });
    expect((await ceo.put(`${API}/settings`).send({ currency: 'EUR' })).status).toBe(422);
    expect((await ceo.put(`${API}/settings`).send({ theme: 'dark' })).status).toBe(422);
  });
});
