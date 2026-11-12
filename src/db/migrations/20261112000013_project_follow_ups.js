/**
 * Project follow-ups: meetings, calls, tasks and reminders tied to a project (client syncs, demos,
 * UAT calls…). Separate from the sales `follow_ups` (those belong to leads / sales owners); owners
 * here are delivery members. Ids: PF1, PF2…
 */
export async function up(knex) {
  await knex.raw('create sequence if not exists project_follow_up_code_seq start 1');
  await knex.schema.createTable('project_follow_ups', (t) => {
    t.text('id').primary();
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('type').notNullable();
    t.text('title').notNullable();
    t.text('owner_member_id').notNullable().references('members.id');
    t.timestamp('due_at', { useTz: true }).notNullable();
    t.integer('duration_min').notNullable().defaultTo(0);
    t.integer('remind_min').notNullable().defaultTo(0);
    t.text('priority').notNullable().defaultTo('Medium');
    t.text('meet_url').notNullable().defaultTo('');
    t.text('attendees').notNullable().defaultTo('');
    t.text('notes').notNullable().defaultTo('');
    t.boolean('done').notNullable().defaultTo(false);
    t.boolean('notified').notNullable().defaultTo(false);
    t.text('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check("type in ('Meeting', 'Call', 'Task', 'Reminder')", [], 'project_follow_ups_type_check');
    t.check("priority in ('High', 'Medium', 'Low')", [], 'project_follow_ups_priority_check');
    t.index(['project_id', 'due_at']);
    t.index(['owner_member_id', 'due_at']);
    t.index(['due_at']);
  });
  await knex.raw('create trigger project_follow_ups_updated_at before update on project_follow_ups for each row execute function set_updated_at()');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('project_follow_ups');
  await knex.raw('drop sequence if exists project_follow_up_code_seq');
}
