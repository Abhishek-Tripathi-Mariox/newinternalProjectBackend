/** Team tasks can optionally be about a project (still independent of project tasks). */
export async function up(knex) {
  await knex.schema.alterTable('team_tasks', (t) => {
    t.text('project_id').references('projects.id').onDelete('SET NULL');
    t.index(['project_id']);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('team_tasks', (t) => { t.dropColumn('project_id'); });
}
