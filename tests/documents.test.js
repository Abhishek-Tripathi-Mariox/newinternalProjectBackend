import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resetDb, as, closeDb } from './helpers.js';
import { db } from '../src/db/knex.js';
import { config } from '../src/config/index.js';
import { documentsService, docKind } from '../src/modules/documents/documents.service.js';
import { storage } from '../src/core/storage/index.js';

const API = '/api/v1';
const root = path.resolve(config.uploads.dir);
const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

/** Simulate a file the upload middleware already streamed to storage. */
async function fakeUpload(name, content) {
  const key = `test/${randomUUID()}${path.extname(name)}`;
  await storage.put(key, Buffer.from(content), { contentType: 'application/pdf' });
  return { originalname: name, size: Buffer.byteLength(content), mimetype: 'application/pdf', key };
}

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

describe('docKind', () => {
  test('ports the frontend guesses', () => {
    expect(docKind('Acme_SOW_v2.pdf')).toBe('SOW');
    expect(docKind('Mutual NDA.docx')).toBe('NDA');
    expect(docKind('quotation-final.pdf')).toBe('Proposal');
    expect(docKind('Master Service Agreement.pdf')).toBe('Contract / MSA');
    expect(docKind('home-wireframes.fig')).toBe('Wireframes');
    expect(docKind('photo.png')).toBe('Other');
  });
});

describe('lead documents', () => {
  let docId;

  test('upload to a lead, then list on the lead detail', async () => {
    const sm = await as('sm@test.io');
    const res = await sm.post(`${API}/leads/MX-1001/documents`)
      .attach('files', Buffer.from('%PDF-1.4 sow'), 'Zenvy SOW.pdf')
      .attach('files', Buffer.from('hello'), 'notes.txt');
    expect(res.status).toBe(201);
    expect(res.body.data.map((d) => [d.name, d.kind])).toEqual([['Zenvy SOW.pdf', 'SOW'], ['notes.txt', 'Other']]);
    docId = res.body.data[0].id;
    expect(res.body.data[0]).toMatchObject({ entityType: 'lead', entityId: 'MX-1001', size: 12, uploadedBy: 'u-ak', url: `/api/v1/documents/${docId}/download` });
    const lead = await sm.get(`${API}/leads/MX-1001`);
    expect(lead.body.data.documents).toHaveLength(2);
  });

  test('no files → 422; blocked type → 400; out-of-scope lead → 403 and files are cleaned up', async () => {
    const sm = await as('sm@test.io');
    expect((await sm.post(`${API}/leads/MX-1001/documents`)).status).toBe(422);
    expect((await sm.post(`${API}/leads/MX-1001/documents`).attach('files', Buffer.from('x'), 'evil.html')).status).toBe(400);
    const se = await as('se@test.io');
    const before = await db('documents').count('* as n').first();
    const res = await se.post(`${API}/leads/MX-1001/documents`).attach('files', Buffer.from('x'), 'a.pdf');
    expect(res.status).toBe(403);
    expect((await db('documents').count('* as n').first()).n).toBe(before.n);
  });

  test('download streams the file; scope is checked through the lead', async () => {
    const sm = await as('sm@test.io');
    const res = await sm.get(`${API}/documents/${docId}/download`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('%PDF-1.4 sow');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Zenvy SOW.pdf"/);
    const se = await as('se@test.io');
    expect((await se.get(`${API}/documents/${docId}/download`)).status).toBe(404);
    const dev = await as('dev@test.io');
    expect((await dev.get(`${API}/documents/${docId}/download`)).status).toBe(403);
    expect((await sm.get(`${API}/documents/not-a-uuid/download`)).status).toBe(422);
    expect((await sm.get(`${API}/documents/${randomUUID()}/download`)).status).toBe(404);
  });

  test('PATCH kind and DELETE (removes the file)', async () => {
    const sm = await as('sm@test.io');
    let res = await sm.patch(`${API}/documents/${docId}`).send({ kind: 'Contract / MSA' });
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('Contract / MSA');
    expect((await sm.patch(`${API}/documents/${docId}`).send({ kind: 'Random' })).status).toBe(422);
    const se = await as('se@test.io');
    expect((await se.delete(`${API}/documents/${docId}`)).status).toBe(403);

    const row = await db('documents').where({ id: docId }).first();
    const file = path.resolve(root, row.storage_path);
    expect(fs.existsSync(file)).toBe(true);
    res = await sm.delete(`${API}/documents/${docId}`);
    expect(res.status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('deleting a lead removes its documents and files', async () => {
    const ceo = await as('ceo@test.io');
    const row = await db('documents').where({ entity_id: 'MX-1001' }).first();
    const file = path.resolve(root, row.storage_path);
    expect((await ceo.delete(`${API}/leads/MX-1001`)).status).toBe(204);
    expect(await db('documents').where({ entity_id: 'MX-1001' })).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('project / bug documents via documentsService.attach', () => {
  test('client downloads their project file only', async () => {
    const [d1] = await documentsService.attach('project', 'PR-101', [await fakeUpload('Alpha FRD.pdf', 'frd')], { id: 'u-mj' });
    const [d2] = await documentsService.attach('project', 'PR-102', [await fakeUpload('Beta.pdf', 'beta')], { id: 'u-mj' });
    expect(d1.kind).toBe('FRD');
    const client = await as('client@test.io');
    const r1 = await client.get(`${API}/documents/${d1.id}/download`).buffer(true).parse(binary);
    expect(r1.status).toBe(200);
    expect(r1.body.toString()).toBe('frd');
    expect((await client.get(`${API}/documents/${d2.id}/download`)).status).toBe(404);
    expect((await client.delete(`${API}/documents/${d1.id}`)).status).toBe(403);
    const pm = await as('pm@test.io');
    expect((await pm.get(`${API}/documents/${d2.id}/download`)).status).toBe(200);
  });

  test('bug attachment needs bugs access and project visibility', async () => {
    await db('bugs').insert([
      { id: 'BUG-1', project_id: 'PR-101', title: 'Crash', dept: 'Mobile', env: 'Production', severity: 'Major', reporter: 'dn', reported_on: '2026-11-01' },
      { id: 'BUG-2', project_id: 'PR-102', title: 'Slow', dept: 'Backend', env: 'Production', severity: 'Minor', reporter: 'km', reported_on: '2026-11-01' },
    ]);
    const trx = await db.transaction();
    const [d1] = await documentsService.attach('bug', 'BUG-1', [await fakeUpload('trace.log', 'stack')], { id: 'u-dn' }, trx);
    const [d2] = await documentsService.attach('bug', 'BUG-2', [await fakeUpload('slow.log', 'slow')], { id: 'u-dn' }, trx);
    await trx.commit();
    const qa = await as('qa@test.io'); // bugs: all; projects: team (on PR-101 only)
    expect((await qa.get(`${API}/documents/${d1.id}/download`)).status).toBe(200);
    expect((await qa.get(`${API}/documents/${d2.id}/download`)).status).toBe(404);
    const client = await as('client@test.io');
    expect((await client.get(`${API}/documents/${d1.id}/download`)).status).toBe(200);
    const sm = await as('sm@test.io'); // no bugs permission
    expect((await sm.get(`${API}/documents/${d1.id}/download`)).status).toBe(403);
    const pm = await as('pm@test.io');
    expect((await pm.delete(`${API}/documents/${d2.id}`)).status).toBe(204);
  });
});

afterAll(() => { fs.rmSync(path.join(root, 'test'), { recursive: true, force: true }); });
