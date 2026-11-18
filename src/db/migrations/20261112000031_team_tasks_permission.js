/**
 * New permission module `tt` (Team tasks). Defaults keep today's behaviour: Super Admin / Admin =
 * everything, scope All (see every task, give tasks to anyone); every other staff role = everything,
 * scope Team (themself + the people who report to them); Client = none. Existing values are kept.
 */
const P = (v, c, e, d, scope) => ({ v: !!v, c: !!c, e: !!e, d: !!d, scope });
const NONE = P(0, 0, 0, 0, 'all');
const pick = (id) => (id === 'r-client' ? NONE : id === 'r-super' || id === 'r-admin' ? P(1, 1, 1, 1, 'all') : P(1, 1, 1, 1, 'team'));

export async function up(knex) {
  const roles = await knex('roles').select('id', 'perms');
  for (const r of roles) {
    const perms = r.perms || {};
    if (perms.tt) continue;
    await knex('roles').where({ id: r.id }).update({ perms: JSON.stringify({ ...perms, tt: pick(r.id) }) });
  }
}

export async function down(knex) {
  const roles = await knex('roles').select('id', 'perms');
  for (const r of roles) {
    const { tt, ...rest } = r.perms || {};
    if (tt) await knex('roles').where({ id: r.id }).update({ perms: JSON.stringify(rest) });
  }
}
