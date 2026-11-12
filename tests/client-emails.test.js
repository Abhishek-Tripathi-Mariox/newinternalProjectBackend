/**
 * CLIENT_EMAILS: emails to the project's client when a CR is sent for approval or a milestone is
 * sent for review. Uses the in-memory mail transport — nothing is really sent.
 */
import { resetDb, as, closeDb } from './helpers.js';
import { sentMail, useTestTransport } from '../src/core/mailer.js';
import { useClientEmails } from '../src/modules/projects/clientEmails.js';

const API = '/api/v1';
const cr = (title, send) => ({
  projectId: 'PR-101', title, description: 'Line one\nLine <two>', requestedBy: 'Client', requestedByName: '',
  hours: 10, rate: 1500, extraDays: 3, priority: 'Medium', target: 'new', team: [], tasks: [], send,
});

beforeAll(async () => {
  await resetDb();
  const pm = await as('pm@test.io');
  await pm.patch(`${API}/projects/PR-101`).send({ clientEmail: 'Buyer@Alpha.io' });
  await pm.post(`${API}/projects/PR-101/portal`).send({ on: true });
});
afterAll(async () => { useClientEmails(false); await closeDb(); });
beforeEach(() => useTestTransport());

describe('client email on projects', () => {
  test('is saved lower-case, validated, and can be cleared', async () => {
    const pm = await as('pm@test.io');
    let res = await pm.get(`${API}/projects/PR-101`);
    expect(res.body.data.clientEmail).toBe('buyer@alpha.io');
    res = await pm.patch(`${API}/projects/PR-102`).send({ clientEmail: 'not-an-email' });
    expect(res.status).toBe(422);
    res = await pm.patch(`${API}/projects/PR-102`).send({ clientEmail: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.clientEmail).toBe('');
  });
});

describe('CLIENT_EMAILS=false', () => {
  beforeAll(() => useClientEmails(false));

  test('sending a CR changes its status but emails nobody', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/change-requests`).send(cr('Quiet CR', true));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('Sent to client');
    expect(res.body.data.clientEmail).toEqual({ sent: false, reason: 'off' });
    expect(sentMail).toHaveLength(0);
  });
});

describe('CLIENT_EMAILS=true', () => {
  beforeAll(() => useClientEmails(true));

  test('CR "Send to client" emails the client, reply-to the PM', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/change-requests`).send(cr('Wallet & cashback', true));
    expect(res.body.data.clientEmail).toEqual({ sent: true, to: 'buyer@alpha.io' });
    expect(sentMail).toHaveLength(1);
    const [m] = sentMail;
    expect(m.to).toBe('buyer@alpha.io');
    expect(m.replyTo).toBe('pm@test.io');
    expect(m.subject).toContain('Wallet & cashback');
    expect(m.text).toContain('Estimated effort: 10 hours');
    expect(m.html).toContain('Wallet &amp; cashback');
    expect(m.html).toContain('Line &lt;two&gt;');
  });

  test('a draft is not emailed; sending it later (edit or action) is', async () => {
    const pm = await as('pm@test.io');
    const d1 = (await pm.post(`${API}/change-requests`).send(cr('Draft one', false))).body.data;
    const d2 = (await pm.post(`${API}/change-requests`).send(cr('Draft two', false))).body.data;
    expect(sentMail).toHaveLength(0);

    const up = await pm.patch(`${API}/change-requests/${d1.id}`).send({ send: true });
    expect(up.body.data.clientEmail.sent).toBe(true);

    const act = await pm.post(`${API}/change-requests/${d2.id}/actions`).send({ act: 'send' });
    expect(act.body.data.message).toBe(`${d2.id} sent to client · emailed to buyer@alpha.io`);
    expect(sentMail.map((x) => x.subject)).toEqual([expect.stringContaining('Draft one'), expect.stringContaining('Draft two')]);
  });

  test('editing a sent CR and re-sending emails the updated CR again', async () => {
    const pm = await as('pm@test.io');
    const c = (await pm.post(`${API}/change-requests`).send(cr('Resend me', true))).body.data;
    const quiet = await pm.patch(`${API}/change-requests/${c.id}`).send({ hours: 12 });
    expect(quiet.status).toBe(200);
    expect(sentMail).toHaveLength(1); // plain save: no email
    const re = await pm.patch(`${API}/change-requests/${c.id}`).send({ title: 'Resend me v2', send: true });
    expect(re.status).toBe(200);
    expect(re.body.data).toMatchObject({ status: 'Sent to client', title: 'Resend me v2', clientEmail: { sent: true, to: 'buyer@alpha.io' } });
    expect(sentMail).toHaveLength(2);
    expect(sentMail[1].text).toContain('Estimated effort: 12 hours');
    expect(re.body.data.history.map((x) => x.text)).toContain('Updated and re-sent to client');
  });

  test('milestone "ask approval" emails the client', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/milestones/PR-101-M2/ask-approval`);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Sent to the client for approval · emailed to buyer@alpha.io');
    expect(sentMail[0].subject).toMatch(/Ready for your review/);
  });

  test('no client email on the project → status still changes, the PM is told', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/change-requests`).send({ ...cr('No address', true), projectId: 'PR-102' });
    expect(res.status).toBe(201);
    expect(res.body.data.clientEmail).toEqual({ sent: false, reason: 'no-email' });
    expect(sentMail).toHaveLength(0);
  });

  test('an SMTP failure never blocks sending the CR', async () => {
    useTestTransport({ fail: true });
    const pm = await as('pm@test.io');
    const res = await pm.post(`${API}/change-requests`).send(cr('SMTP down', true));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('Sent to client');
    expect(res.body.data.clientEmail).toEqual({ sent: false, reason: 'failed' });
  });
});
