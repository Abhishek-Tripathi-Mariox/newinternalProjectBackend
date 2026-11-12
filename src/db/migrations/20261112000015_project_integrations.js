/**
 * Third parties used on a project (payment gateway, SMS, maps, cloud…) and their credentials.
 * Credential values are encrypted by the API (AES-256-GCM, CREDENTIALS_KEY) — never stored in plain text.
 */
export async function up(knex) {
  await knex.schema.createTable('project_integrations', (t) => {
    t.bigIncrements('id');
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('category').notNullable().defaultTo('Other');
    t.text('status').notNullable().defaultTo('Pending from client');
    t.text('url').notNullable().defaultTo(''); // dashboard / console link
    t.text('notes').notNullable().defaultTo('');
    t.text('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['project_id']);
  });
  await knex.schema.createTable('project_credentials', (t) => {
    t.bigIncrements('id');
    t.bigInteger('integration_id').notNullable().references('project_integrations.id').onDelete('CASCADE');
    t.text('label').notNullable(); // e.g. "API key", "Secret", "Login email", "Password"
    t.text('env').notNullable().defaultTo('Live'); // Test / Live / Both
    t.text('value_enc').notNullable();
    t.text('updated_by').references('users.id').onDelete('SET NULL');
    t.integer('position').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['integration_id']);
  });
  for (const tbl of ['project_integrations', 'project_credentials']) {
    await knex.raw(`create trigger ${tbl}_updated_at before update on ${tbl} for each row execute function set_updated_at()`);
  }
  // Reveals of credentials are written to the admin activity log.
  await knex.raw('alter table audit_logs drop constraint if exists audit_logs_kind_check');
  await knex.raw("alter table audit_logs add constraint audit_logs_kind_check check (kind in ('Invite', 'Role', 'Access', 'Profile', 'Credentials'))");
}

export async function down(knex) {
  await knex.raw("delete from audit_logs where kind = 'Credentials'");
  await knex.raw('alter table audit_logs drop constraint if exists audit_logs_kind_check');
  await knex.raw("alter table audit_logs add constraint audit_logs_kind_check check (kind in ('Invite', 'Role', 'Access', 'Profile'))");
  await knex.schema.dropTableIfExists('project_credentials');
  await knex.schema.dropTableIfExists('project_integrations');
}
