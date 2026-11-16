/** CSV lead import: owners / sources / stages by name, duplicates, row errors, own scope. */
import { db } from '../src/db/knex.js';
import { resetDb, as, closeDb } from './helpers.js';

const API = '/api/v1/leads/import';
beforeAll(async () => { await resetDb(); });
afterAll(closeDb);

const row = (o) => ({ company: 'Acme', contact: 'Ravi', email: '', phone: '', services: 'Mobile App', source: '', owner: '', status: '', value: '', notes: '', ...o });

describe('lead import', () => {
  test('creates valid rows, reports bad ones with row numbers, skips duplicates', async () => {
    const sm = await as('sm@test.io');
    const res = await sm.post(API).send({
      rows: [
        row({ company: 'Nova Labs', contact: 'Asha', email: 'asha@nova.io', services: 'Mobile App; Web Development', source: 'linkedin', owner: 'Priya Sharma', status: 'qualified', value: '₹1,50,000', notes: 'From expo' }),
        row({ company: '', contact: 'X' }),
        row({ company: 'Dup Co', email: 'ANKIT@zenvy.com' }), // email of MX-1001
        row({ company: 'Bad Src', source: 'Billboard' }),
        row({ company: 'Bad Stage', status: 'Thinking' }),
        row({ company: 'Bad Owner', owner: 'nobody@x.io' }),
        row({ company: 'By Email', owner: 'se@test.io', phone: '+91 99999 11111' }),
        row({ company: 'Same Phone', phone: '9999911111' }), // duplicate of the row above
        { company: '', contact: '', email: '', phone: '', services: '', source: '', owner: '', status: '', value: '', notes: '' }, // blank line ignored
      ],
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    // row 3 (no company) → company = contact; rows 5–7 import with warnings; rows 4 and 9 are duplicates
    expect(d.created).toBe(6);
    expect(d.errors).toEqual([]);
    expect(d.warnings.map((w) => w.row)).toEqual([5, 6, 7]);
    expect(d.warnings[0].warning).toBe('Source "Billboard" isn\'t in Lead setup — used Website.');
    expect(d.skipped.map((x) => x.row)).toEqual([4, 9]);

    const nova = await db('leads').where({ id: d.ids[0] }).first();
    expect(nova).toMatchObject({ company: 'Nova Labs', source: 'LinkedIn', owner_id: 'ps', status: 'Qualified', services: ['Mobile App', 'Web Development'], notes: 'From expo' });
    expect(Number(nova.value)).toBe(150000);
    expect(await db('leads').where({ id: d.ids[1] }).first()).toMatchObject({ company: 'X', contact: 'X' });
    expect(await db('leads').where({ id: d.ids[3] }).first()).toMatchObject({ status: 'New', notes: 'Imported status: Thinking' });
  });

  test('owner names match without spaces; only a missing name or a bad email fails a row', async () => {
    const sm = await as('sm@test.io');
    const res = await sm.post(API).send({
      rows: [
        row({ company: '', contact: 'Monika Joshi', services: '', owner: 'PriyaSharma', email: 'monika@x.io' }),
        row({ company: '', contact: '', phone: '9876500000' }),
        row({ company: 'Bad Mail', email: 'not-an-email' }),
      ],
    });
    const d = res.body.data;
    expect(d.created).toBe(1);
    expect(await db('leads').where({ id: d.ids[0] }).first()).toMatchObject({ company: 'Monika Joshi', owner_id: 'ps', services: [] });
    expect(d.errors.map((e) => [e.row, e.error])).toEqual([[3, 'Add a company or a contact name.'], [4, '"not-an-email" is not a valid email.']]);
  });

  test('a sales executive imports only for themselves', async () => {
    const se = await as('se@test.io');
    const res = await se.post(API).send({ rows: [row({ company: 'Mine', owner: 'Aman Kapoor', email: 'mine@x.io' })] });
    expect(res.body.data.created).toBe(1);
    expect((await db('leads').where({ id: res.body.data.ids[0] }).first()).owner_id).toBe('ps');
  });

  test('roles that cannot create leads are refused', async () => {
    const dev = await as('dev@test.io');
    expect((await dev.post(API).send({ rows: [row({})] })).status).toBe(403);
  });
});
