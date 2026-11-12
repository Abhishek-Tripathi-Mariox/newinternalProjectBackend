/** Projects: the client's email, used for client emails (CR approvals, milestone reviews) when CLIENT_EMAILS=true. */
export async function up(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.text('client_email');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('client_email');
  });
}
