/**
 * New permission module `att` (Attendance & reports, view only). Roles that don't have it yet get
 * a default: Super Admin / Admin = all, Project Manager / Team Lead / Sales Manager = team (themself
 * + the people who report to them), every other role = none. Existing values are never overwritten.
 */
const NONE = { v: false, c: false, e: false, d: false, scope: 'all' };
const view = (scope) => ({ v: true, c: false, e: false, d: false, scope });
const DEFAULTS = { 'r-super': view('all'), 'r-admin': view('all'), 'r-pm': view('team'), 'r-tl': view('team'), 'r-sm': view('team') };

export async function up(knex) {
  const roles = await knex('roles').select('id', 'perms');
  for (const r of roles) {
    const perms = r.perms || {};
    if (perms.att) continue;
    await knex('roles').where({ id: r.id }).update({ perms: JSON.stringify({ ...perms, att: DEFAULTS[r.id] || NONE }) });
  }
}

export async function down(knex) {
  const roles = await knex('roles').select('id', 'perms');
  for (const r of roles) {
    const { att, ...rest } = r.perms || {};
    if (att) await knex('roles').where({ id: r.id }).update({ perms: JSON.stringify(rest) });
  }
}
