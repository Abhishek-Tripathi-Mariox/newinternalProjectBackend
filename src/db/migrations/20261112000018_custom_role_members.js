/**
 * Users with a custom delivery-type role (e.g. "Developer" with timesheet / task / bug access) become
 * delivery members, so they appear in Team & hours and in project / milestone team pickers.
 */
const DELIVERY = ['r-pm', 'r-tl', 'r-tm', 'r-qa'];
const NON_DELIVERY = ['r-super', 'r-admin', 'r-sm', 'r-se', 'r-client'];
const TEAMS = ['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];

export async function up(knex) {
  const roles = await knex('roles').select('id', 'name', 'perms');
  const isDelivery = (r) => DELIVERY.includes(r.id) || (!NON_DELIVERY.includes(r.id)
    && !!(r.perms && ((r.perms.ts && r.perms.ts.v) || (r.perms.tasks && r.perms.tasks.v) || (r.perms.bugs && r.perms.bugs.v))));
  const ids = roles.filter(isDelivery).map((r) => r.id);
  if (!ids.length) return;
  const users = await knex('users').whereIn('role_id', ids).whereNull('member_id').select('id', 'name', 'title', 'dept', 'role_id', 'hue', 'shift_hours', 'status');
  for (const u of users) {
    const { rows } = await knex.raw('select nextval(?) as n', ['member_code_seq']);
    const mid = `m${Number(rows[0].n).toString(36)}`;
    const role = roles.find((r) => r.id === u.role_id);
    await knex('members').insert({
      id: mid, name: u.name, role_title: u.title || (role && role.name) || 'Team member', team: TEAMS.includes(u.dept) ? u.dept : 'Web',
      hue: u.hue ?? 250, shift_hours: u.shift_hours ?? 8, active: u.status !== 'Deactivated',
    });
    await knex('users').where({ id: u.id }).update({ member_id: mid });
  }
}

export async function down() {
  // Members created here stay (they may already have time logs).
}
