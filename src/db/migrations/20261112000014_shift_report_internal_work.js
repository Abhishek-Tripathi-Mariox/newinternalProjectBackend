/** End-of-shift report: internal (non-project) work — [{ cat, h, note }] (meetings, learning, hiring, admin…). */
export async function up(knex) {
  await knex.schema.alterTable('shift_reports', (t) => {
    t.jsonb('internal_rows').notNullable().defaultTo('[]');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('shift_reports', (t) => {
    t.dropColumn('internal_rows');
  });
}
