/**
 * Projects: the hours budget is stored on the project (it used to be the sum of milestone hours).
 * Milestone hours may not add up to more than it. Existing projects start at their milestone total.
 */
export async function up(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.decimal('budget_hours', 10, 2);
  });
  await knex.raw(`
    update projects p set budget_hours = coalesce((select sum(m.alloc_hours) from milestones m where m.project_id = p.id), 0)
  `);
}

export async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('budget_hours');
  });
}
