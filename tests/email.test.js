/**
 * Invite / password-reset emails. Uses an in-memory mail transport — nothing is really sent.
 */
import request from 'supertest';
import { resetDb, as, closeDb, app } from './helpers.js';
import { sentMail, useTestTransport } from '../src/core/mailer.js';

const API = '/api/v1';
const tokenFrom = (mail) => new URL(/https?:\/\/\S+/.exec(mail.text)[0]).searchParams.get('token');

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

describe('with email configured', () => {
  beforeEach(() => useTestTransport());

  test('invite is emailed; the token is not returned to the admin; the emailed link works', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.post(`${API}/users`).send({ name: 'Mail Person', email: 'mail.person@test.io', role: 'r-tm', sendInvite: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ emailSent: true, status: 'Invited' });
    expect(res.body.data.inviteToken).toBeUndefined();
    expect(sentMail).toHaveLength(1);
    const [mail] = sentMail;
    expect(mail.to).toBe('mail.person@test.io');
    expect(mail.subject).toMatch(/invited/i);
    expect(mail.text).toContain('/accept-invite?email=mail.person%40test.io&token=');
    expect(mail.html).toContain('Activate account');

    const ok = await request(app).post(`${API}/auth/accept-invite`).send({ email: 'mail.person@test.io', token: tokenFrom(mail), password: 'mailpass123' });
    expect(ok.status).toBe(200);
  });

  test('resend invite and password reset are emailed', async () => {
    const ceo = await as('ceo@test.io');
    const inv = await ceo.post(`${API}/users`).send({ name: 'Second', email: 'second@test.io', role: 'r-tm', sendInvite: true });
    const re = await ceo.post(`${API}/users/${inv.body.data.id}/resend-invite`);
    expect(re.body.data).toMatchObject({ emailSent: true });
    expect(re.body.data.inviteToken).toBeUndefined();
    expect(sentMail.map((m) => m.to)).toEqual(['second@test.io', 'second@test.io']);

    const rp = await ceo.post(`${API}/users/u-dn/reset-password`);
    expect(rp.body.data).toMatchObject({ emailSent: true });
    expect(sentMail[2].text).toContain('/reset-password?email=');
  });

  test('names are HTML-escaped in the email', async () => {
    const ceo = await as('ceo@test.io');
    await ceo.post(`${API}/users`).send({ name: '<b>Evil</b>', email: 'evil@test.io', role: 'r-tm', sendInvite: true });
    expect(sentMail[0].html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    expect(sentMail[0].html).not.toContain('<b>Evil</b>');
  });
});

test('when sending fails the admin gets the link instead', async () => {
  useTestTransport({ fail: true });
  const ceo = await as('ceo@test.io');
  const res = await ceo.post(`${API}/users`).send({ name: 'No Mail', email: 'nomail@test.io', role: 'r-tm', sendInvite: true });
  expect(res.status).toBe(201);
  expect(res.body.data).toMatchObject({ emailSent: false, inviteToken: expect.any(String) });
});
