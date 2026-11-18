import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb } from './helpers.js';

const API = '/api/v1/team-tasks';

beforeAll(async () => {
  await resetDb();
  // mj (PM) → vg (dev) → si (dev2); dn (QA) reports to nobody.
  await db('users').where({ id: 'u-vg' }).update({ reports_to: 'u-mj' });
  await db('users').where({ id: 'u-si' }).update({ reports_to: 'u-vg' });
});
afterAll(closeDb);

describe('team tasks', () => {
  let tid;

  test('assignees = self + everyone below (direct and indirect)', async () => {
    const r = (await (await as('pm@test.io')).get(`${API}/assignees`)).body.data;
    expect(r.map((x) => x.id).sort()).toEqual(['u-mj', 'u-si', 'u-vg']);
    const qa = (await (await as('qa@test.io')).get(`${API}/assignees`)).body.data;
    expect(qa.map((x) => x.id)).toEqual(['u-dn']);
  });

  test('a manager gives a task to someone two levels down', async () => {
    const res = await (await as('pm@test.io')).post(API).send({ title: 'Prepare release notes', notes: 'For v2', priority: 'High', dueDate: '2026-12-01', estimateHours: 4.5, assigneeId: 'u-si' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Prepare release notes', status: 'To do', assigneeId: 'u-si', createdBy: 'u-mj', dueDate: '2026-12-01', estimateHours: 4.5, canEdit: true });
    tid = res.body.data.id;
    expect(tid).toMatch(/^TT\d+$/);
  });

  test('cannot give tasks upward or sideways', async () => {
    const dev2 = await as('dev2@test.io');
    expect((await dev2.post(API).send({ title: 'x', assigneeId: 'u-vg' })).status).toBe(403);
    expect((await (await as('qa@test.io')).post(API).send({ title: 'x', assigneeId: 'u-si' })).status).toBe(403);
    expect((await dev2.post(API).send({ title: 'Self note', assigneeId: 'u-si' })).status).toBe(201);
  });

  test('visibility: assignee, creator, managers above; not outsiders', async () => {
    const ids = async (email) => (await (await as(email)).get(API)).body.data.map((t) => t.id);
    expect(await ids('dev2@test.io')).toContain(tid);
    expect(await ids('dev@test.io')).toContain(tid); // vg is above si
    expect(await ids('pm@test.io')).toContain(tid);
    expect(await ids('qa@test.io')).not.toContain(tid);
    expect(await ids('ceo@test.io')).toContain(tid);
    expect((await (await as('qa@test.io')).get(`${API}/${tid}`)).status).toBe(404);
  });

  test('assignee updates status + progress note but not the task itself', async () => {
    const dev2 = await as('dev2@test.io');
    const r = await dev2.patch(`${API}/${tid}`).send({ status: 'Done', updateNote: 'Shared on Slack' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'Done', updateNote: 'Shared on Slack', canEdit: false, canUpdateStatus: true });
    expect(r.body.data.doneAt).toBeTruthy();
    expect((await dev2.patch(`${API}/${tid}`).send({ title: 'Changed' })).status).toBe(403);
    expect((await dev2.delete(`${API}/${tid}`)).status).toBe(403);
  });

  test('manager edits, reassigns within their team, deletes', async () => {
    const pm = await as('pm@test.io');
    const r = await pm.patch(`${API}/${tid}`).send({ title: 'Release notes v2', assigneeId: 'u-vg', status: 'In progress' });
    expect(r.body.data).toMatchObject({ title: 'Release notes v2', assigneeId: 'u-vg', status: 'In progress', doneAt: null });
    expect((await pm.patch(`${API}/${tid}`).send({ assigneeId: 'u-dn' })).status).toBe(403);
    expect((await pm.delete(`${API}/${tid}`)).status).toBe(204);
  });

  test('optional project link (must be a project you can see)', async () => {
    const pm = await as('pm@test.io');
    const r = await pm.post(API).send({ title: 'Fix Alpha login copy', assigneeId: 'u-vg', projectId: 'PR-101' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ projectId: 'PR-101', projectName: 'Alpha App' });
    expect((await pm.patch(`${API}/${r.body.data.id}`).send({ projectId: null })).body.data.projectId).toBeNull();
    expect((await pm.post(API).send({ title: 'x', assigneeId: 'u-vg', projectId: 'PR-999' })).status).toBe(422);
    // dev (Team Member, own scope) is not on PR-102
    expect((await (await as('dev@test.io')).post(API).send({ title: 'x', assigneeId: 'u-si', projectId: 'PR-102' })).status).toBe(422);
  });

  test('optional lead link for the sales team (must be a lead you can see)', async () => {
    await db('users').where({ id: 'u-ps' }).update({ reports_to: 'u-ak' });
    const sm = await as('sm@test.io');
    const r = await sm.post(API).send({ title: 'Send proposal to Zenvy', assigneeId: 'u-ps', leadId: 'MX-1001' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ leadId: 'MX-1001', leadName: 'Zenvy Retail', assigneeId: 'u-ps' });
    expect((await (await as('se@test.io')).get(API)).body.data.map((t) => t.id)).toContain(r.body.data.id);
    // Sales Executive (own leads) can't link someone else's lead; a dev without Leads access can't link any
    expect((await (await as('se@test.io')).post(API).send({ title: 'x', assigneeId: 'u-ps', leadId: 'MX-1001' })).status).toBe(422);
    expect((await (await as('dev@test.io')).post(API).send({ title: 'x', assigneeId: 'u-vg', leadId: 'MX-1002' })).status).toBe(422);
  });

  test('attachments: managers and the assignee add; the assignee removes only their own; outsiders get nothing', async () => {
    const pm = await as('pm@test.io');
    const t = (await pm.post(API).send({ title: 'With files', assigneeId: 'u-si' })).body.data;
    expect(t.attachments).toEqual([]);
    const dev2 = await as('dev2@test.io'); // assignee
    const own = await dev2.post(`${API}/${t.id}/attachments`).field('title', 'My progress notes').attach('files', Buffer.from('hello'), 'notes.txt');
    expect(own.status).toBe(201);
    expect(own.body.data.attachments[0]).toMatchObject({ title: 'My progress notes', uploadedBy: 'u-si', uploaderName: expect.any(String) });
    const [mine] = own.body.data.attachments;
    expect((await (await as('qa@test.io')).post(`${API}/${t.id}/attachments`).attach('files', Buffer.from('x'), 'x.txt')).status).toBe(404);
    expect((await dev2.delete(`/api/v1/documents/${mine.id}`)).status).toBe(204);
    let r = await pm.post(`${API}/${t.id}/attachments`).attach('files', Buffer.from('spec'), 'spec.pdf');
    expect(r.status).toBe(201);
    const [spec] = r.body.data.attachments;
    // vg is above si → a manager of this task too
    r = await (await as('dev@test.io')).post(`${API}/${t.id}/attachments`).attach('files', Buffer.from('more'), 'more.txt');
    expect(r.body.data.attachments.map((a) => a.name)).toEqual(['spec.pdf', 'more.txt']);
    expect((await dev2.get(`/api/v1/documents/${spec.id}/download`)).status).toBe(200);
    expect((await (await as('qa@test.io')).get(`/api/v1/documents/${spec.id}/download`)).status).toBe(404);
    expect((await dev2.delete(`/api/v1/documents/${spec.id}`)).status).toBe(403);
    expect((await pm.delete(`/api/v1/documents/${spec.id}`)).status).toBe(204);
    // deleting the task removes its files
    expect((await pm.delete(`${API}/${t.id}`)).status).toBe(204);
    expect(Number((await db('documents').where({ entity_type: 'team_task', entity_id: t.id }).count({ n: '*' }).first()).n)).toBe(0);
  });

  test('role permission (Team tasks): View / Create / Edit / Delete and scope', async () => {
    const setTT = async (roleId, tt) => {
      const r = await db('roles').where({ id: roleId }).first('perms');
      await db('roles').where({ id: roleId }).update({ perms: JSON.stringify({ ...r.perms, tt }) });
    };
    const pm = await as('pm@test.io');
    const t = (await pm.post(API).send({ title: 'Perm probe', assigneeId: 'u-si' })).body.data;
    const vg = await as('dev@test.io'); // r-tm, manager of si
    try {
      // No View → the whole module is closed.
      await setTT('r-tm', { v: false, c: false, e: false, d: false, scope: 'team' });
      expect((await vg.get(API)).status).toBe(403);
      // View only: sees the team's task but can't give, edit or delete.
      await setTT('r-tm', { v: true, c: false, e: false, d: false, scope: 'team' });
      const seen = (await vg.get(API)).body.data.find((x) => x.id === t.id);
      expect(seen).toMatchObject({ canEdit: false, canDelete: false });
      expect((await vg.post(API).send({ title: 'x', assigneeId: 'u-vg' })).status).toBe(403);
      expect((await vg.get(`${API}/assignees`)).body.data).toEqual([]);
      expect((await vg.patch(`${API}/${t.id}`).send({ title: 'nope' })).status).toBe(403);
      expect((await vg.delete(`${API}/${t.id}`)).status).toBe(403);
      // Own scope: the team's task disappears; can only give tasks to themself.
      await setTT('r-tm', { v: true, c: true, e: true, d: true, scope: 'own' });
      expect((await vg.get(API)).body.data.some((x) => x.id === t.id)).toBe(false);
      expect((await vg.post(API).send({ title: 'x', assigneeId: 'u-si' })).status).toBe(403);
      expect((await vg.post(API).send({ title: 'Mine', assigneeId: 'u-vg' })).status).toBe(201);
      // The assignee still updates status with View only.
      await setTT('r-tm', { v: true, c: false, e: false, d: false, scope: 'own' });
      const si = await as('dev2@test.io');
      expect((await si.patch(`${API}/${t.id}`).send({ status: 'In progress' })).status).toBe(200);
      // All scope: QA sees every task and can give tasks to anyone.
      await setTT('r-qa', { v: true, c: true, e: true, d: true, scope: 'all' });
      const qa = await as('qa@test.io');
      expect((await qa.get(API)).body.data.some((x) => x.id === t.id)).toBe(true);
      expect((await qa.post(API).send({ title: 'From QA', assigneeId: 'u-mj' })).status).toBe(201);
    } finally {
      await setTT('r-tm', { v: true, c: true, e: true, d: true, scope: 'team' });
      await setTT('r-qa', { v: true, c: true, e: true, d: true, scope: 'team' });
    }
  });

  test('clients are blocked', async () => {
    expect((await (await as('client@test.io')).get(API)).status).toBe(403);
  });
});
