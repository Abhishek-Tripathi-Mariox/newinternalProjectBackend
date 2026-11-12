/** Who works on each milestone (a subset of the project team). */
export async function up(knex) {
  await knex.schema.createTable('milestone_members', (t) => {
    t.text('milestone_id').notNullable().references('milestones.id').onDelete('CASCADE');
    t.text('member_id').notNullable().references('members.id').onDelete('CASCADE');
    t.primary(['milestone_id', 'member_id']);
    t.index(['member_id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('milestone_members');
}
