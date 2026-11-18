/**
 * Base reference data: roles (same permission matrix as the frontend), master lists and settings.
 * Idempotent — safe to run on every deploy (upserts, never deletes).
 */
const MODS = ['dash', 'leads', 'fu', 'projects', 'tasks', 'bugs', 'ts', 'team', 'users', 'att', 'tt'];
/** Attendance & reports is view-only. */
const VIEW = (scope) => P(1, 0, 0, 0, scope);
const P = (v, c, e, d, scope = 'all') => ({ v: !!v, c: !!c, e: !!e, d: !!d, scope });
const NONE = P(0, 0, 0, 0);
const ALL = P(1, 1, 1, 1);
/** Team tasks: every staff role gives tasks down its "Reports to" team (Admin / Super Admin: anyone). */
const TT = P(1, 1, 1, 1, 'team');
const mk = (o) => Object.fromEntries(MODS.map((k) => [k, o[k] || (k === 'tt' ? TT : NONE)]));

export const ROLES = [
  { id: 'r-super', name: 'Super Admin', description: 'Full access to everything, including roles', hue: 265, locked: true, perms: mk(Object.fromEntries(MODS.map((k) => [k, ALL]))) },
  { id: 'r-admin', name: 'Admin', description: 'Everything except deleting users', hue: 220, perms: mk({ ...Object.fromEntries(MODS.map((k) => [k, ALL])), users: P(1, 1, 1, 0), att: VIEW('all') }) },
  { id: 'r-sm', name: 'Sales Manager', description: 'Owns the pipeline and the sales team', hue: 150, perms: mk({ dash: P(1), leads: ALL, fu: ALL, projects: P(1), att: VIEW('team') }) },
  { id: 'r-se', name: 'Sales Executive', description: 'Works their own leads and follow-ups', hue: 190, perms: mk({ dash: P(1, 0, 0, 0, 'own'), leads: P(1, 1, 1, 0, 'own'), fu: P(1, 1, 1, 1, 'own') }) },
  { id: 'r-pm', name: 'Project Manager', description: 'Runs projects, milestones, tasks and the team', hue: 300, perms: mk({ projects: P(1, 1, 1, 0), tasks: ALL, bugs: ALL, ts: P(1, 1, 1, 0), team: P(1, 0, 1, 0), fu: P(1, 1, 1, 0, 'own'), att: VIEW('team') }) },
  { id: 'r-tl', name: 'Team Lead', description: 'Leads a team, assigns tasks, reviews hours', hue: 70, perms: mk({ projects: P(1, 0, 0, 0, 'team'), tasks: P(1, 1, 1, 0, 'team'), bugs: P(1, 1, 1, 0, 'team'), ts: P(1, 1, 1, 0, 'team'), team: P(1, 0, 0, 0, 'team'), att: VIEW('team') }) },
  { id: 'r-tm', name: 'Team Member', description: 'Developers and designers', hue: 250, perms: mk({ projects: P(1, 0, 0, 0, 'own'), tasks: P(1, 0, 1, 0, 'own'), bugs: P(1, 1, 1, 0, 'own'), ts: P(1, 1, 1, 0, 'own') }) },
  { id: 'r-qa', name: 'QA Engineer', description: 'Reports, retests and closes bugs', hue: 25, perms: mk({ projects: P(1, 0, 0, 0, 'team'), tasks: P(1, 0, 0, 0, 'team'), bugs: ALL, ts: P(1, 1, 1, 0, 'own') }) },
  { id: 'r-client', name: 'Client', description: 'External · sees their project, reports bugs', hue: 45, perms: mk({ projects: P(1, 0, 0, 0, 'own'), bugs: P(1, 1, 0, 0, 'own'), tt: NONE }) },
];

export const STAGES = [['New', 250, true], ['Contacted', 220], ['Qualified', 190], ['Proposal Sent', 295], ['Negotiation', 70], ['Won', 150, true], ['Lost', 25, true]];
export const SOURCES = ['Website', 'LinkedIn', 'Upwork', 'Clutch', 'Referral', 'Google Ads', 'IndiaMART', 'Email Campaign'];
export const SERVICES = ['Mobile App', 'Web Development', 'UI/UX Design', 'Custom Software', 'E-commerce', 'AI / ML', 'Digital Marketing'];
export const SETTINGS = { currency: 'INR', defaultLeadsView: 'Kanban', reminderAlerts: true };

export async function seed(knex) {
  await knex('roles')
    .insert(ROLES.map((r) => ({ ...r, locked: !!r.locked, perms: JSON.stringify(r.perms) })))
    .onConflict('id').merge(['name', 'description', 'hue', 'locked', 'perms']);
  await knex('lead_stages').insert(STAGES.map(([name, hue, core], i) => ({ name, hue, position: i, is_core: !!core }))).onConflict('name').ignore();
  await knex('lead_sources').insert(SOURCES.map((name, i) => ({ name, position: i }))).onConflict('name').ignore();
  await knex('services').insert(SERVICES.map((name, i) => ({ name, position: i }))).onConflict('name').ignore();
  await knex('settings').insert(Object.entries(SETTINGS).map(([key, value]) => ({ key, value: JSON.stringify(value) }))).onConflict('key').ignore();
}
