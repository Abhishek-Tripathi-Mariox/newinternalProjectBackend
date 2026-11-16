/** Projects: why it is on hold / delayed — reason category + note + when it was written. */
export async function up(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.text('status_reason').notNullable().defaultTo(''); // '' | Client end | Third party | Internal / team | Payment pending | Scope change | Other
    t.text('status_note').notNullable().defaultTo('');
    t.timestamp('status_note_at', { useTz: true });
  });
}

export async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('status_reason');
    t.dropColumn('status_note');
    t.dropColumn('status_note_at');
  });
}
