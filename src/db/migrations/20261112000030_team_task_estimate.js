/** Team tasks: estimated time in hours (optional). */
export async function up(knex) {
  await knex.schema.alterTable('team_tasks', (t) => { t.decimal('estimate_hours', 6, 2).nullable(); });
}

export async function down(knex) {
  await knex.schema.alterTable('team_tasks', (t) => { t.dropColumn('estimate_hours'); });
}
