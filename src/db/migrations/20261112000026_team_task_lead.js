/** Team tasks can optionally be about a sales lead (sales team's follow-up work). */
export async function up(knex) {
  await knex.schema.alterTable('team_tasks', (t) => {
    t.text('lead_id').references('leads.id').onDelete('SET NULL');
    t.index(['lead_id']);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('team_tasks', (t) => { t.dropColumn('lead_id'); });
}
