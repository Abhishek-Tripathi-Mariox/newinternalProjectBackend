/** Milestones: free-text notes (scope, decisions, client feedback…). Projects with a 0h budget and no milestone hours get "no budget set". */
export async function up(knex) {
  await knex.schema.alterTable('milestones', (t) => {
    t.text('notes').notNullable().defaultTo('');
  });
  await knex.raw(`
    update projects p set budget_hours = null
    where budget_hours = 0 and coalesce((select sum(m.alloc_hours) from milestones m where m.project_id = p.id), 0) = 0
  `);
}

export async function down(knex) {
  await knex.schema.alterTable('milestones', (t) => {
    t.dropColumn('notes');
  });
}
