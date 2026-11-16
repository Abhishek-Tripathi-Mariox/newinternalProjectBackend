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
    expect(d.created).toBe(2);
    expect(d.errors.map((e) => e.row)).toEqual([3, 5, 6, 7]);
    expect(d.errors[1].error).toBe('Unknown source "Billboard" — add it under Lead setup first.');
    expect(d.skipped).toEqual([{ row: 4, company: 'Dup Co', duplicateOf: 'MX-1001' }, { row: 9, company: 'Same Phone', duplicateOf: d.ids[1] }]);

    const nova = await db('leads').where({ id: d.ids[0] }).first();
    expect(nova).toMatchObject({ company: 'Nova Labs', source: 'LinkedIn', owner_id: 'ps', status: 'Qualified', services: ['Mobile App', 'Web Development'], notes: 'From expo' });
    expect(Number(nova.value)).toBe(150000);
    expect((await db('leads').where({ id: d.ids[1] }).first()).owner_id).toBe('ps');
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
