/** Hours each person is given within a milestone (their total may not exceed the milestone's hours). */
export async function up(knex) {
  await knex.schema.alterTable('milestone_members', (t) => {
    t.decimal('alloc_hours', 8, 2).notNullable().defaultTo(0);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('milestone_members', (t) => {
    t.dropColumn('alloc_hours');
  });
}
