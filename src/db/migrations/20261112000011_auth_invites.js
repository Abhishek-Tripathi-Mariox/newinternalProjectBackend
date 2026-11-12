/**
 * Auth: one-time invite and password-reset tokens.
 * Only the sha256 of each token is stored; the raw token is returned once by the API
 * (there is no e-mail service yet, so an admin passes it on to the person).
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.text('invite_token_hash').unique();
    t.timestamp('invite_expires_at', { useTz: true });
    t.text('reset_token_hash').unique();
    t.timestamp('reset_expires_at', { useTz: true });
  });
}

export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('invite_token_hash');
    t.dropColumn('invite_expires_at');
    t.dropColumn('reset_token_hash');
    t.dropColumn('reset_expires_at');
  });
}
