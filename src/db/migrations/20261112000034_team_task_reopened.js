/** Team tasks: new status "Reopened" (a Done task sent back, with the reason in its timeline). */
export async function up(knex) {
  await knex.raw('alter table team_tasks drop constraint if exists team_tasks_status_check');
  await knex.raw("alter table team_tasks add constraint team_tasks_status_check check (status in ('To do', 'In progress', 'Reopened', 'Done'))");
}

export async function down(knex) {
  await knex.raw("update team_tasks set status = 'To do' where status = 'Reopened'");
  await knex.raw('alter table team_tasks drop constraint if exists team_tasks_status_check');
  await knex.raw("alter table team_tasks add constraint team_tasks_status_check check (status in ('To do', 'In progress', 'Done'))");
}
