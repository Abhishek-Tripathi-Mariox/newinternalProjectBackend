import request from 'supertest';
import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb, app } from './helpers.js';

const pub = (path) => request(app).get(`/api/v1/public/portal${path}`);
const post = (path, body) => request(app).post(`/api/v1/public/portal${path}`).send(body);

let token;
beforeAll(async () => {
  await resetDb();
  const pm = await as('pm@test.io');
  await pm.put('/api/v1/projects/PR-101/links').send({ links: [{ type: 'Figma', url: 'https://figma.com/a' }, { type: 'Repository', url: 'https://github.com/a' }] });
  token = (await pm.post('/api/v1/projects/PR-101/portal').send({ on: true })).body.data.token;
  await pm.post('/api/v1/milestones/PR-101-M2/ask-approval');
  // one draft (hidden from the client) and one sent CR
  await pm.post('/api/v1/change-requests').send({ projectId: 'PR-101', title: 'Draft idea', hours: 4 });
  await pm.post('/api/v1/change-requests').send({ projectId: 'PR-101', title: 'Dark mode', hours: 20, rate: 2000, extraDays: 3, tasks: [{ title: 'Theme', assigneeId: 'si', hours: 20 }], send: true });
});
afterAll(closeDb);

describe('public client portal', () => {
  test('unknown or OFF token → 404, no auth needed for ON token', async () => {
    expect((await pub('/nope-token-123')).status).toBe(404);
    const res = await pub(`/${token}`);
    expect(res.status).toBe(200);
    const v = res.body.data;
    expect(v.project).toMatchObject({ id: 'PR-101', name: 'Alpha App', client: 'Alpha Retail', pmName: 'Meera Joshi' });
    expect(v.progress).toEqual({ pct: 50, done: 1, total: 2 });
    expect(v.schedule).toBe('On schedule');
    expect(v.links).toEqual([{ type: 'Figma', url: 'https://figma.com/a' }]);
    expect(v.milestones.map((m) => [m.id, m.state, m.approval ? m.approval.status : null])).toEqual([['PR-101-M1', 'Complete', null], ['PR-101-M2', 'In progress', 'Pending']]);
    expect(v.changeRequests.map((c) => [c.id, c.statusLabel])).toEqual([['CR-101-2', 'Waiting for your approval']]);
  });

  test('milestone: changes requested needs a note; then approve', async () => {
    let res = await post(`/${token}/milestones/PR-101-M2/decision`, { approve: false, note: ' ' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Add a note so the team knows what to change');
    res = await post(`/${token}/milestones/PR-101-M2/decision`, { approve: false, note: 'Logo too small' });
    expect(res.body.data).toMatchObject({ status: 'In progress', approval: 'Changes requested', message: 'Change request sent to the team' });
    expect((await post(`/${token}/milestones/PR-101-M2/decision`, { approve: true })).status).toBe(422); // no longer pending

    const pm = await as('pm@test.io');
    await pm.post('/api/v1/milestones/PR-101-M2/ask-approval');
    res = await post(`/${token}/milestones/PR-101-M2/decision`, { approve: true });
    expect(res.body.data).toMatchObject({ status: 'Done', approval: 'Approved' });
    const feed = await db('activity_feed').where({ kind: 'appr' }).orderBy('id');
    expect(feed.map((f) => [f.person_id, f.text])).toEqual([
      [null, 'Alpha Retail · changes requested · Development · Phase 1'],
      [null, 'Alpha Retail · approved · Development · Phase 1'],
    ]);
    expect((await post(`/${token}/milestones/PR-102-M1/decision`, { approve: true })).status).toBe(404); // other project's milestone
  });

  test('CR: signature rules, approve applies side effects', async () => {
    const cases = [
      [{ approve: true, name: 'Al', agree: true }, 'Type your full name to sign the approval'],
      [{ approve: true, name: 'Ankit Mehta', agree: false }, 'Tick the box to confirm you approve the cost and timeline'],
      [{ approve: false, note: '' }, 'Add a note so the team knows why'],
    ];
    for (const [body, msg] of cases) {
      const res = await post(`/${token}/change-requests/CR-101-2/decision`, body);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toBe(msg);
    }
    expect((await post(`/${token}/change-requests/CR-101-1/decision`, { approve: true, name: 'Ankit Mehta', agree: true })).status).toBe(404); // draft

    const res = await post(`/${token}/change-requests/CR-101-2/decision`, { approve: true, name: 'Ankit Mehta', agree: true, note: 'Looks good' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'Approved', signature: { name: 'Ankit Mehta' } });
    const cr = await db('change_requests').where({ id: 'CR-101-2' }).first();
    expect(cr.sig_via).toBe('Typed signature in client portal');
    const hist = await db('cr_history').where({ cr_id: 'CR-101-2' }).orderBy(['at', 'id']).pluck('text');
    expect(hist.slice(-3)).toEqual([
      'Client comment · Looks good',
      'Approved by Ankit Mehta · Typed signature in client portal',
      '+20h added to the budget · +₹40,000 contract value · due date moved by 3 days · 1 task created on the board',
    ]);
    expect(Number((await db('projects').where({ id: 'PR-101' }).first()).value)).toBe(1040000);
    expect(await db('activity_feed').where({ kind: 'appr' }).orderBy('id', 'desc').first()).toMatchObject({ text: 'Alpha Retail · approved · CR-101-2 Dark mode' });
    expect((await post(`/${token}/change-requests/CR-101-2/decision`, { approve: false, note: 'x' })).status).toBe(422);
  });

  test('client reject in portal', async () => {
    const pm = await as('pm@test.io');
    const c = (await pm.post('/api/v1/change-requests').send({ projectId: 'PR-101', title: 'Chatbot', hours: 50, send: true })).body.data;
    const res = await post(`/${token}/change-requests/${c.id}/decision`, { approve: false, note: 'Not now' });
    expect(res.body.data.status).toBe('Rejected');
    const hist = await db('cr_history').where({ cr_id: c.id }).orderBy(['at', 'id']).pluck('text');
    expect(hist.at(-1)).toBe('Rejected by client in portal · Not now');
  });

  test('portal turned off → token stops working', async () => {
    const pm = await as('pm@test.io');
    await pm.post('/api/v1/projects/PR-101/portal').send({ on: false });
    expect((await pub(`/${token}`)).status).toBe(404);
    expect((await post(`/${token}/milestones/PR-101-M1/decision`, { approve: true })).status).toBe(404);
  });
});
