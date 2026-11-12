/** Project third parties + encrypted credentials: access rules, encryption at rest, reveal audit. */
import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb } from './helpers.js';

const API = '/api/v1/project-integrations';
const razorpay = {
  projectId: 'PR-101', name: 'Razorpay', category: 'Payment gateway', status: 'Received', url: 'https://dashboard.razorpay.com',
  notes: 'Client account', credentials: [{ label: 'Key ID', env: 'Live', value: 'rzp_live_ABC' }, { label: 'Key secret', env: 'Live', value: 's3cr3t!' }],
};

beforeAll(async () => { await resetDb(); });
afterAll(closeDb);

describe('project third parties & credentials', () => {
  let integ;

  test('PM adds a third party; values are encrypted at rest and never listed', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(API).send(razorpay);
    expect(res.status).toBe(201);
    integ = res.body.data;
    expect(integ).toMatchObject({ projectId: 'PR-101', name: 'Razorpay', category: 'Payment gateway', status: 'Received' });
    expect(integ.credentials.map((c) => c.label)).toEqual(['Key ID', 'Key secret']);
    expect(JSON.stringify(res.body)).not.toContain('s3cr3t!');

    const rows = await db('project_credentials').select('value_enc');
    expect(rows.every((r) => r.value_enc.startsWith('v1:') && !r.value_enc.includes('s3cr3t'))).toBe(true);

    const list = await pm.get(API).query({ projectId: 'PR-101' });
    expect(list.body.data).toMatchObject({ canManage: true, canReveal: true, credentialsEnabled: true });
    expect(JSON.stringify(list.body)).not.toContain('rzp_live_ABC');
  });

  test('team member on the project can reveal (logged) but not edit', async () => {
    const dev = await as('dev@test.io'); // vg is on PR-101
    const list = await dev.get(API).query({ projectId: 'PR-101' });
    expect(list.body.data).toMatchObject({ canManage: false, canReveal: true });
    const secret = integ.credentials[1];
    const r = await dev.post(`${API}/${integ.id}/credentials/${secret.id}/reveal`);
    expect(r.status).toBe(200);
    expect(r.body.data.value).toBe('s3cr3t!');
    expect(r.headers['cache-control']).toBe('no-store');
    const log = await db('audit_logs').where({ kind: 'Credentials' });
    expect(log.map((l) => l.text)).toEqual(['Viewed Razorpay · Key secret (Live) on PR-101 Alpha App']);
    expect(log[0].actor_name).toBe('Vikas Gupta');

    expect((await dev.patch(`${API}/${integ.id}`).send({ status: 'Live' })).status).toBe(403);
    expect((await dev.delete(`${API}/${integ.id}`)).status).toBe(403);
  });

  test('people off the project and clients cannot see anything', async () => {
    const client = await as('client@test.io');
    expect((await client.get(API).query({ projectId: 'PR-101' })).status).toBe(403);
    const dev = await as('dev@test.io');
    expect((await dev.get(API).query({ projectId: 'PR-102' })).status).toBe(404);
  });

  test('edit: keep values when blank, replace when given, delete missing rows', async () => {
    const pm = await as('pm@test.io');
    const [keyId, secret] = integ.credentials;
    const res = await pm.patch(`${API}/${integ.id}`).send({
      status: 'Live',
      credentials: [{ id: keyId.id, label: 'Key ID', env: 'Live', value: '' }, { label: 'Webhook secret', env: 'Test', value: 'wh_123' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('Live');
    expect(res.body.data.credentials.map((c) => [c.label, c.env])).toEqual([['Key ID', 'Live'], ['Webhook secret', 'Test']]);
    expect(await db('project_credentials').where({ id: secret.id }).first()).toBeUndefined();
    const kept = await pm.post(`${API}/${integ.id}/credentials/${keyId.id}/reveal`);
    expect(kept.body.data.value).toBe('rzp_live_ABC');

    const bad = await pm.patch(`${API}/${integ.id}`).send({ credentials: [{ label: 'New one', env: 'Live' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe('Enter a value for "New one".');
  });

  test('delete removes the third party and its credentials', async () => {
    const pm = await as('pm@test.io');
    expect((await pm.delete(`${API}/${integ.id}`)).status).toBe(204);
    expect(await db('project_credentials')).toHaveLength(0);
  });
});
