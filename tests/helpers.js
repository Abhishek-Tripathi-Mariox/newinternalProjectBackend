/**
 * Shared test harness. Each test file calls `await resetDb()` in beforeAll (or beforeEach) to get a
 * clean, migrated test database with base data + a small fixture, then uses `as(email)` for an
 * authenticated supertest agent.
 *
 * Fixture (password for everyone: "secret123"):
 *   ceo@test.io      Super Admin
 *   admin@test.io    Admin
 *   sm@test.io       Sales Manager      (sales owner 'ak')
 *   se@test.io       Sales Executive    (sales owner 'ps')
 *   pm@test.io       Project Manager    (member 'mj', team PMO)
 *   dev@test.io      Team Member        (member 'vg', team Mobile)
 *   dev2@test.io     Team Member        (member 'si', team Mobile)
 *   qa@test.io       QA Engineer        (member 'dn', team QA)
 *   client@test.io   Client             (client of PR-101)
 *   off@test.io      Team Member, Deactivated
 * Members: mj (PMO), vg + si (Mobile), dn (QA), km (Backend). Sales owners: ak, ps.
 * Project PR-101 "Alpha App" (Running, PM mj, team mj/vg/si/dn) with milestones PR-101-M1..M2;
 * project PR-102 "Beta Web" (Running, PM mj, team mj/km). Leads: MX-1001 (owner ak), MX-1002 (owner ps).
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { db } from '../src/db/knex.js';
import { createApp } from '../src/app.js';
import { seed as seedBase } from '../src/db/seeds/01_base.js';

export const app = createApp();
export const PASSWORD = 'secret123';

const TABLES = ['shift_reports', 'activity_feed', 'presence', 'active_timers', 'attendance_events', 'documents', 'time_logs', 'bug_events', 'bugs',
  'tasks', 'cr_history', 'change_requests', 'milestones', 'project_links', 'project_members', 'projects', 'follow_ups', 'quotes', 'lead_activities',
  'leads', 'settings', 'services', 'lead_sources', 'lead_stages', 'audit_logs', 'refresh_tokens', 'users', 'sales_owners', 'members', 'roles'];

let migrated = false;
export async function resetDb() {
  if (!migrated) { await db.migrate.latest({ directory: './src/db/migrations', loadExtensions: ['.js'] }); migrated = true; }
  await db.raw(`truncate ${TABLES.join(', ')} restart identity cascade`);
  // TRUNCATE … RESTART IDENTITY doesn't touch standalone sequences — reset the human-readable code
  // sequences too so every test run generates the same ids (MX-1003, F1, T1 …).
  await db.raw(`select setval('lead_code_seq', 1001, false), setval('follow_up_code_seq', 1, false), setval('project_code_seq', 101, false),
    setval('task_code_seq', 1, false), setval('bug_code_seq', 1001, false), setval('time_log_code_seq', 1, false),
    setval('user_code_seq', 1000, false), setval('member_code_seq', 1000, false), setval('role_code_seq', 1000, false)`);
  await seedBase(db);
  const hash = await bcrypt.hash(PASSWORD, 4);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local (APP_TZ) day
  await db('members').insert([
    { id: 'mj', name: 'Meera Joshi', role_title: 'Project Manager', team: 'PMO', hue: 300 },
    { id: 'vg', name: 'Vikas Gupta', role_title: 'Android Developer', team: 'Mobile', hue: 150 },
    { id: 'si', name: 'Sneha Iyer', role_title: 'iOS Developer', team: 'Mobile', hue: 190 },
    { id: 'dn', name: 'Divya Nair', role_title: 'QA Engineer', team: 'QA', hue: 30 },
    { id: 'km', name: 'Karan Malhotra', role_title: 'Backend Developer', team: 'Backend', hue: 70 },
  ]);
  await db('sales_owners').insert([{ id: 'ak', name: 'Aman Kapoor', hue: 265 }, { id: 'ps', name: 'Priya Sharma', hue: 340 }]);
  const u = (id, name, email, role_id, extra = {}) => ({ id, name, email, role_id, status: 'Active', password_hash: hash, ...extra });
  await db('users').insert([
    u('u-ceo', 'CEO', 'ceo@test.io', 'r-super', { dept: 'Management' }),
    u('u-admin', 'Ada Admin', 'admin@test.io', 'r-admin', { dept: 'HR' }),
    u('u-ak', 'Aman Kapoor', 'sm@test.io', 'r-sm', { dept: 'Sales', owner_id: 'ak' }),
    u('u-ps', 'Priya Sharma', 'se@test.io', 'r-se', { dept: 'Sales', owner_id: 'ps' }),
    u('u-mj', 'Meera Joshi', 'pm@test.io', 'r-pm', { dept: 'PMO', member_id: 'mj' }),
    u('u-vg', 'Vikas Gupta', 'dev@test.io', 'r-tm', { dept: 'Mobile', member_id: 'vg' }),
    u('u-si', 'Sneha Iyer', 'dev2@test.io', 'r-tm', { dept: 'Mobile', member_id: 'si' }),
    u('u-dn', 'Divya Nair', 'qa@test.io', 'r-qa', { dept: 'QA', member_id: 'dn' }),
    u('u-cl1', 'Alpha Client', 'client@test.io', 'r-client', { client_of: ['PR-101'] }),
    u('u-off', 'Old Dev', 'off@test.io', 'r-tm', { status: 'Deactivated' }),
  ]);
  await db('projects').insert([
    { id: 'PR-101', name: 'Alpha App', client: 'Alpha Retail', services: ['Mobile App'], status: 'Running', pm_member_id: 'mj', start_date: '2026-09-01', due_date: '2026-12-31', value: 1000000, priority: 'High' },
    { id: 'PR-102', name: 'Beta Web', client: 'Beta Health', services: ['Web Development'], status: 'Running', pm_member_id: 'mj', start_date: '2026-10-01', due_date: '2027-01-31', value: 500000 },
  ]);
  await db('project_members').insert([
    { project_id: 'PR-101', member_id: 'mj', alloc_hours: 40, position: 0 }, { project_id: 'PR-101', member_id: 'vg', alloc_hours: 120, position: 1 },
    { project_id: 'PR-101', member_id: 'si', alloc_hours: 120, position: 2 }, { project_id: 'PR-101', member_id: 'dn', alloc_hours: 60, position: 3 },
    { project_id: 'PR-102', member_id: 'mj', alloc_hours: 20, position: 0 }, { project_id: 'PR-102', member_id: 'km', alloc_hours: 100, position: 1 },
  ]);
  await db('milestones').insert([
    { id: 'PR-101-M1', project_id: 'PR-101', n: 1, name: 'Discovery & UI/UX', alloc_hours: 60, due_date: '2026-10-01', status: 'Done' },
    { id: 'PR-101-M2', project_id: 'PR-101', n: 2, name: 'Development · Phase 1', alloc_hours: 200, due_date: '2026-12-01', status: 'In progress' },
    { id: 'PR-102-M1', project_id: 'PR-102', n: 1, name: 'Discovery & UI/UX', alloc_hours: 40, due_date: '2026-11-15', status: 'In progress' },
  ]);
  await db('leads').insert([
    { id: 'MX-1001', company: 'Zenvy Retail', contact: 'Ankit Mehta', email: 'ankit@zenvy.com', phone: '+91 98765 43210', services: ['Mobile App'], source: 'Website', owner_id: 'ak', first_owner_id: 'ak', status: 'New', value: 800000 },
    { id: 'MX-1002', company: 'Kaveri Foods', contact: 'Riya Gupta', email: 'riya@kaveri.com', phone: '+91 91234 56789', services: ['Web Development'], source: 'Referral', owner_id: 'ps', first_owner_id: 'ps', status: 'Qualified', value: 350000 },
  ]);
  await db.raw("select setval('lead_code_seq', 1002), setval('project_code_seq', 102)");
  return { today };
}

const tokens = {};
/** Log in (cached per email) and return an authenticated supertest wrapper: as('pm@test.io').get('/api/v1/projects') */
export async function tokenFor(email) {
  if (!tokens[email]) {
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    tokens[email] = res.body.data.accessToken;
  }
  return tokens[email];
}
export const clearTokens = () => { for (const k of Object.keys(tokens)) delete tokens[k]; };

export async function as(email) {
  const t = await tokenFor(email);
  const wrap = (m) => (url) => request(app)[m](url).set('Authorization', `Bearer ${t}`);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') };
}

export const closeDb = () => db.destroy();
