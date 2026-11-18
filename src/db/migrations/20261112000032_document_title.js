/** Documents: optional title typed when the file is attached (e.g. "Login screen bug"). */
export async function up(knex) {
  await knex.schema.alterTable('documents', (t) => { t.string('title', 200).nullable(); });
}

export async function down(knex) {
  await knex.schema.alterTable('documents', (t) => { t.dropColumn('title'); });
}
