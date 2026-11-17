/**
 * Team tasks: work given by a person to someone below them in the "Reports to" hierarchy (or to
 * themself). Independent of projects. Ids: TT1, TT2…
 */
export async function up(knex) {
  await knex.raw('create sequence if not exists team_task_code_seq start 1');
  await knex.schema.createTable('team_tasks', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('notes').notNullable().defaultTo('');
    t.text('priority').notNullable().defaultTo('Medium');
    t.text('status').notNullable().defaultTo('To do');
    t.date('due_date');
    t.text('assignee_id').notNullable().references('users.id').onDelete('CASCADE');
    t.text('created_by').references('users.id').onDelete('SET NULL');
    t.text('update_note').notNullable().defaultTo(''); // the assignee's latest progress note
    t.timestamp('done_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check("priority in ('High', 'Medium', 'Low')", [], 'team_tasks_priority_check');
    t.check("status in ('To do', 'In progress', 'Done')", [], 'team_tasks_status_check');
    t.index(['assignee_id', 'status']);
    t.index(['created_by']);
  });
  await knex.raw('create trigger team_tasks_updated_at before update on team_tasks for each row execute function set_updated_at()');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('team_tasks');
  await knex.raw('drop sequence if exists team_task_code_seq');
}
