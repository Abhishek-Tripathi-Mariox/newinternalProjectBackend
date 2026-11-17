/** Documents can be attached to team tasks too (entity_type 'team_task'). */
export async function up(knex) {
  await knex.raw('alter table documents drop constraint if exists documents_entity_type_check');
  await knex.raw("alter table documents add constraint documents_entity_type_check check (entity_type in ('lead', 'project', 'bug', 'cr', 'team_task'))");
}

export async function down(knex) {
  await knex('documents').where({ entity_type: 'team_task' }).del();
  await knex.raw('alter table documents drop constraint if exists documents_entity_type_check');
  await knex.raw("alter table documents add constraint documents_entity_type_check check (entity_type in ('lead', 'project', 'bug', 'cr'))");
}
