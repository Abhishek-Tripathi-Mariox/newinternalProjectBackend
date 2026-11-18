/** Projects: expected delivery date — when the team now expects to deliver (vs. the contracted due date). */
export async function up(knex) {
  await knex.schema.alterTable('projects', (t) => { t.date('expected_delivery_date').nullable(); });
}

export async function down(knex) {
  await knex.schema.alterTable('projects', (t) => { t.dropColumn('expected_delivery_date'); });
}
