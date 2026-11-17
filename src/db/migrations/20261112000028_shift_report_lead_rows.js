/** Sales end-of-shift: what was done per lead today ({lead, kind, note, next}). */
export async function up(knex) {
  await knex.schema.alterTable('shift_reports', (t) => {
    t.jsonb('lead_rows').notNullable().defaultTo('[]');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('shift_reports', (t) => { t.dropColumn('lead_rows'); });
}
