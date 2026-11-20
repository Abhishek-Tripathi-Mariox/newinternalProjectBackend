/**
 * Team task timeline: one row per thing that happened — created, status change (with the reason
 * when reopened), progress note, comment, files added / removed, edits, reassignment.
 */
export async function up(knex) {
  await knex.schema.createTable('team_task_events', (t) => {
    t.bigIncrements('id').primary();
    t.text('task_id').notNullable().references('team_tasks.id').onDelete('CASCADE');
    t.text('user_id').references('users.id').onDelete('SET NULL');
    t.text('kind').notNullable(); // created | status | note | comment | attach | detach | edit | assign
    t.text('from_val');
    t.text('to_val');
    t.text('text');
    t.jsonb('meta').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['task_id', 'created_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('team_task_events');
}
