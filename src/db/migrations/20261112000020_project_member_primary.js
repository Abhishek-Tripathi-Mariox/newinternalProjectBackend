/** Project team: mark someone as a primary developer (one or more per project). */
export async function up(knex) {
  await knex.schema.alterTable('project_members', (t) => {
    t.boolean('is_primary').notNullable().defaultTo(false);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('project_members', (t) => {
    t.dropColumn('is_primary');
  });
}
