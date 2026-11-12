/**
 * Initial schema for the Mariox internal portal.
 *
 * Conventions
 * - Primary keys are human-readable text codes that match the frontend (MX-1001, PR-101, T12,
 *   BUG-1001, CR-101-1, u-ceo, rj …). New codes come from sequences (see src/core/ids.js).
 * - Money is NUMERIC(14,2) in INR, hours NUMERIC(7,2); timestamps are TIMESTAMPTZ; calendar
 *   days are DATE.
 * - Status-like columns are TEXT + CHECK constraints (easy to extend in a later migration,
 *   unlike Postgres enums). Lead stages / sources / services are lookup tables because users
 *   can add their own from the app.
 * - Every mutable table has created_at / updated_at; updated_at is maintained by a trigger.
 */

/** CHECK (col in (...)) for a fixed list of allowed values (constants from this file, never user input). */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const statuses = (t, col, values) => t.check(`"${col}" in (${values.map(lit).join(', ')})`, [], `${t._tableName}_${col}_check`);

export async function up(knex) {
  await knex.raw('create extension if not exists citext');
  await knex.raw(`
    create or replace function set_updated_at() returns trigger as $$
    begin new.updated_at = now(); return new; end; $$ language plpgsql;
  `);

  const seqs = {
    lead_code_seq: 1001, follow_up_code_seq: 1, project_code_seq: 101, task_code_seq: 1, bug_code_seq: 1001,
    time_log_code_seq: 1, user_code_seq: 1000, member_code_seq: 1000, role_code_seq: 1000,
  };
  for (const [name, start] of Object.entries(seqs)) await knex.raw(`create sequence if not exists ${name} start ${start}`);

  const stamps = (t) => {
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  };

  /* ───────────── People, roles, auth ───────────── */

  await knex.schema.createTable('roles', (t) => {
    t.text('id').primary();
    t.text('name').notNullable().unique();
    t.text('description').notNullable().defaultTo('');
    t.integer('hue').notNullable().defaultTo(265);
    t.boolean('locked').notNullable().defaultTo(false);
    // { [module]: { v, c, e, d, scope: 'all'|'team'|'own' } } — modules: dash leads fu projects tasks bugs ts team users
    t.jsonb('perms').notNullable().defaultTo('{}');
    stamps(t);
  });

  await knex.schema.createTable('members', (t) => {
    t.text('id').primary(); // delivery staff "person id" (rj, an, …)
    t.text('name').notNullable();
    t.text('role_title').notNullable().defaultTo('');
    t.text('team').notNullable();
    t.integer('hue').notNullable().defaultTo(265);
    t.decimal('shift_hours', 4, 2).notNullable().defaultTo(8);
    t.decimal('cost_per_hour', 10, 2); // null → team default
    t.boolean('active').notNullable().defaultTo(true);
    stamps(t);
    statuses(t, 'team', ['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO']);
  });

  await knex.schema.createTable('sales_owners', (t) => {
    t.text('id').primary(); // sales "person id" (ak, ps, …) — owners of leads / follow-ups
    t.text('name').notNullable();
    t.integer('hue').notNullable().defaultTo(265);
    t.boolean('active').notNullable().defaultTo(true);
    stamps(t);
  });

  await knex.schema.createTable('users', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.specificType('email', 'citext').notNullable().unique();
    t.text('phone').notNullable().defaultTo('');
    t.text('title').notNullable().defaultTo('');
    t.text('role_id').notNullable().references('roles.id').onUpdate('CASCADE');
    t.text('dept').notNullable().defaultTo('');
    t.text('reports_to').references('users.id').onDelete('SET NULL');
    t.date('join_date');
    t.text('status').notNullable().defaultTo('Invited');
    t.timestamp('invited_at', { useTz: true });
    t.timestamp('last_active_at', { useTz: true });
    t.integer('hue').notNullable().defaultTo(265);
    t.text('password_hash'); // null until the invite is accepted
    t.text('member_id').unique().references('members.id').onDelete('SET NULL');
    t.text('owner_id').unique().references('sales_owners.id').onDelete('SET NULL');
    t.specificType('client_of', 'text[]').notNullable().defaultTo('{}'); // project ids (client users)
    t.decimal('shift_hours', 4, 2).notNullable().defaultTo(8);
    stamps(t);
    statuses(t, 'status', ['Active', 'Invited', 'Deactivated']);
    t.index(['role_id']);
  });

  await knex.schema.createTable('refresh_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.text('token_hash').notNullable().unique(); // sha256 of the opaque token — the token itself is never stored
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true });
    t.text('user_agent');
    t.text('ip');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id']);
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id');
    t.text('actor_user_id').references('users.id').onDelete('SET NULL');
    t.text('actor_name').notNullable();
    t.text('text').notNullable();
    t.text('kind').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    statuses(t, 'kind', ['Invite', 'Role', 'Access', 'Profile']);
    t.index(['created_at']);
  });

  /* ───────────── Master lists & settings ───────────── */

  await knex.schema.createTable('lead_stages', (t) => {
    t.text('name').primary();
    t.integer('hue').notNullable().defaultTo(265);
    t.integer('position').notNullable();
    t.boolean('is_core').notNullable().defaultTo(false); // New / Won / Lost
    stamps(t);
  });
  await knex.schema.createTable('lead_sources', (t) => {
    t.text('name').primary();
    t.integer('position').notNullable();
    stamps(t);
  });
  await knex.schema.createTable('services', (t) => {
    t.text('name').primary();
    t.integer('position').notNullable();
    stamps(t);
  });
  await knex.schema.createTable('settings', (t) => {
    t.text('key').primary(); // currency, defaultLeadsView, reminderAlerts …
    t.jsonb('value').notNullable();
    stamps(t);
  });

  /* ───────────── Sales ───────────── */

  await knex.schema.createTable('leads', (t) => {
    t.text('id').primary();
    t.text('company').notNullable();
    t.text('contact').notNullable();
    t.text('email').notNullable().defaultTo('');
    t.text('phone').notNullable().defaultTo('');
    t.specificType('services', 'text[]').notNullable().defaultTo('{}');
    t.text('source').references('lead_sources.name').onUpdate('CASCADE');
    t.text('owner_id').notNullable().references('sales_owners.id');
    t.text('first_owner_id').references('sales_owners.id');
    t.text('status').notNullable().defaultTo('New').references('lead_stages.name').onUpdate('CASCADE');
    t.decimal('value', 14, 2).notNullable().defaultTo(0);
    t.text('notes').notNullable().defaultTo('');
    stamps(t);
    t.index(['owner_id']);
    t.index(['status']);
    t.index(['source']);
    t.index(['created_at']);
  });
  await knex.raw('create index leads_services_gin on leads using gin (services)');
  await knex.raw("create index leads_search_idx on leads using gin (to_tsvector('simple', company || ' ' || contact || ' ' || email || ' ' || id))");

  await knex.schema.createTable('lead_activities', (t) => {
    t.bigIncrements('id');
    t.text('lead_id').notNullable().references('leads.id').onDelete('CASCADE');
    t.text('kind').notNullable(); // status owner call email whatsapp meeting note quote
    t.text('text').notNullable();
    t.text('actor_user_id').references('users.id').onDelete('SET NULL');
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    statuses(t, 'kind', ['status', 'owner', 'call', 'email', 'whatsapp', 'meeting', 'note', 'quote']);
    t.index(['lead_id', 'at']);
  });

  await knex.schema.createTable('quotes', (t) => {
    t.text('id').primary(); // Q-1004-1
    t.text('lead_id').notNullable().references('leads.id').onDelete('CASCADE');
    t.text('status').notNullable().defaultTo('Draft');
    t.jsonb('items').notNullable(); // [{ d: description, q: qty, r: rate }]
    t.decimal('discount_pct', 5, 2).notNullable().defaultTo(0);
    t.boolean('gst').notNullable().defaultTo(true);
    t.integer('valid_days').notNullable().defaultTo(15);
    t.text('terms').notNullable().defaultTo('');
    t.decimal('net', 14, 2).notNullable().defaultTo(0);
    t.decimal('total', 14, 2).notNullable().defaultTo(0);
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('viewed_at', { useTz: true });
    t.timestamp('accepted_at', { useTz: true });
    t.timestamp('declined_at', { useTz: true });
    stamps(t);
    statuses(t, 'status', ['Draft', 'Sent', 'Viewed', 'Accepted', 'Declined']);
    t.index(['lead_id']);
  });

  await knex.schema.createTable('follow_ups', (t) => {
    t.text('id').primary(); // F12
    t.text('type').notNullable();
    t.text('title').notNullable();
    t.text('lead_id').references('leads.id').onDelete('CASCADE');
    t.text('owner_id').notNullable().references('sales_owners.id');
    t.timestamp('due_at', { useTz: true }).notNullable();
    t.integer('duration_min').notNullable().defaultTo(0);
    t.integer('remind_min').notNullable().defaultTo(0);
    t.text('priority').notNullable().defaultTo('Medium');
    t.text('meet_url').notNullable().defaultTo('');
    t.text('attendees').notNullable().defaultTo('');
    t.text('notes').notNullable().defaultTo('');
    t.boolean('done').notNullable().defaultTo(false);
    t.boolean('notified').notNullable().defaultTo(false);
    stamps(t);
    statuses(t, 'type', ['Meeting', 'Call', 'Task', 'Reminder']);
    statuses(t, 'priority', ['High', 'Medium', 'Low']);
    t.index(['owner_id', 'due_at']);
    t.index(['lead_id']);
    t.index(['due_at']);
  });

  /* ───────────── Delivery ───────────── */

  await knex.schema.createTable('projects', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('client').notNullable();
    t.specificType('services', 'text[]').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('Planning');
    t.text('pm_member_id').references('members.id');
    t.date('start_date').notNullable();
    t.date('due_date').notNullable();
    t.decimal('value', 14, 2).notNullable().defaultTo(0);
    t.integer('hue').notNullable().defaultTo(265);
    t.text('priority').notNullable().defaultTo('Medium');
    t.text('brief').notNullable().defaultTo('');
    t.boolean('portal_on').notNullable().defaultTo(false);
    t.text('portal_token').unique();
    stamps(t);
    statuses(t, 'status', ['Running', 'On hold', 'Completed', 'Planning', 'Cancelled']);
    statuses(t, 'priority', ['High', 'Medium', 'Low']);
    t.index(['status']);
    t.index(['pm_member_id']);
  });

  await knex.schema.createTable('project_members', (t) => {
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('member_id').notNullable().references('members.id');
    t.decimal('alloc_hours', 8, 2).notNullable().defaultTo(0);
    t.integer('position').notNullable().defaultTo(0); // PM first, like the frontend team list
    t.primary(['project_id', 'member_id']);
    t.index(['member_id']);
  });

  await knex.schema.createTable('project_links', (t) => {
    t.bigIncrements('id');
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('type').notNullable();
    t.text('url').notNullable();
    t.check("url ~* '^https{0,1}://'", [], 'project_links_url_check'); // {0,1} not ? — knex treats ? as a binding
    t.index(['project_id']);
  });

  await knex.schema.createTable('milestones', (t) => {
    t.text('id').primary(); // PR-101-M1 or PR-101-CR-101-1
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.integer('n').notNullable();
    t.text('name').notNullable();
    t.decimal('alloc_hours', 8, 2).notNullable().defaultTo(0);
    t.date('due_date');
    t.text('status').notNullable().defaultTo('Not started');
    t.text('cr_id'); // FK added after change_requests exists
    t.text('approval_status'); // client portal approval
    t.timestamp('approval_asked_at', { useTz: true });
    t.timestamp('approval_at', { useTz: true });
    t.text('approval_note');
    stamps(t);
    statuses(t, 'status', ['Not started', 'In progress', 'In review', 'Done']);
    t.check("approval_status is null or approval_status in ('Pending','Approved','Changes requested')", [], 'milestones_approval_check');
    t.unique(['project_id', 'n']);
  });

  await knex.schema.createTable('change_requests', (t) => {
    t.text('id').primary(); // CR-101-1
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.integer('n').notNullable();
    t.text('title').notNullable();
    t.text('description').notNullable().defaultTo('');
    t.text('requested_by').notNullable().defaultTo('Client'); // Client | Internal
    t.text('requested_by_name').notNullable().defaultTo('');
    t.decimal('hours', 8, 2).notNullable();
    t.decimal('rate', 10, 2).notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.integer('extra_days').notNullable().defaultTo(0);
    t.text('priority').notNullable().defaultTo('Medium');
    t.text('target').notNullable().defaultTo('new'); // 'new' or an existing milestone id
    t.text('status').notNullable().defaultTo('Draft');
    t.text('milestone_id').references('milestones.id').onDelete('SET NULL');
    t.specificType('team', 'text[]').notNullable().defaultTo('{}');
    t.jsonb('tasks').notNullable().defaultTo('[]'); // planned work breakdown [{ t, a, h }]
    t.text('note');
    t.timestamp('raised_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('decided_at', { useTz: true });
    t.timestamp('done_at', { useTz: true });
    // Approval record (typed signature in the client portal, or recorded by the PM)
    t.text('sig_name');
    t.text('sig_title');
    t.timestamp('sig_at', { useTz: true });
    t.text('sig_via');
    t.text('sig_note');
    stamps(t);
    statuses(t, 'status', ['Draft', 'Sent to client', 'Approved', 'In progress', 'Done', 'Rejected']);
    statuses(t, 'requested_by', ['Client', 'Internal']);
    t.unique(['project_id', 'n']);
  });
  await knex.schema.alterTable('milestones', (t) => { t.foreign('cr_id').references('change_requests.id').onDelete('SET NULL'); });

  await knex.schema.createTable('cr_history', (t) => {
    t.bigIncrements('id');
    t.text('cr_id').notNullable().references('change_requests.id').onDelete('CASCADE');
    t.text('text').notNullable();
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['cr_id', 'at']);
  });

  await knex.schema.createTable('tasks', (t) => {
    t.text('id').primary();
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('milestone_id').references('milestones.id').onDelete('SET NULL');
    t.text('title').notNullable();
    t.text('description').notNullable().defaultTo('');
    t.text('assignee_id').references('members.id').onDelete('SET NULL');
    t.text('status').notNullable().defaultTo('To do');
    t.text('priority').notNullable().defaultTo('Medium');
    t.date('due_date');
    t.decimal('estimate_hours', 7, 2).notNullable().defaultTo(0);
    t.jsonb('checklist').notNullable().defaultTo('[]'); // [{ t, done }]
    t.text('cr_id').references('change_requests.id').onDelete('SET NULL');
    t.jsonb('log').notNullable().defaultTo('[]'); // [{ d, t }]
    stamps(t);
    statuses(t, 'status', ['To do', 'In progress', 'Blocked', 'In review', 'Done']);
    statuses(t, 'priority', ['High', 'Medium', 'Low']);
    t.index(['project_id']);
    t.index(['assignee_id']);
    t.index(['status']);
  });

  await knex.schema.createTable('bugs', (t) => {
    t.text('id').primary();
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('milestone_id').references('milestones.id').onDelete('SET NULL');
    t.text('title').notNullable();
    t.text('dept').notNullable();
    t.text('env').notNullable();
    t.text('severity').notNullable();
    t.text('priority').notNullable().defaultTo('Medium');
    t.text('status').notNullable().defaultTo('Open');
    t.text('assignee_id').references('members.id').onDelete('SET NULL');
    t.text('reporter').notNullable(); // member id or 'client'
    t.date('reported_on').notNullable();
    t.date('due_date');
    t.text('build').notNullable().defaultTo('');
    t.text('steps').notNullable().defaultTo('');
    t.text('expected').notNullable().defaultTo('');
    t.text('actual').notNullable().defaultTo('');
    t.text('link').notNullable().defaultTo('');
    stamps(t);
    statuses(t, 'status', ['Open', 'In progress', 'Fixed', 'Retest', 'Reopened', 'Closed']);
    statuses(t, 'severity', ['Critical', 'Major', 'Minor', 'Trivial']);
    statuses(t, 'priority', ['High', 'Medium', 'Low']);
    t.index(['project_id']);
    t.index(['assignee_id']);
    t.index(['status']);
  });

  await knex.schema.createTable('bug_events', (t) => {
    t.bigIncrements('id');
    t.text('bug_id').notNullable().references('bugs.id').onDelete('CASCADE');
    t.text('text').notNullable(); // "Status → Fixed", "Comment: …"
    t.text('actor_user_id').references('users.id').onDelete('SET NULL');
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['bug_id', 'at']);
  });

  await knex.schema.createTable('time_logs', (t) => {
    t.text('id').primary();
    t.text('member_id').notNullable().references('members.id');
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('milestone_id').references('milestones.id').onDelete('SET NULL');
    t.date('day').notNullable();
    t.decimal('hours', 5, 2).notNullable();
    t.text('note').notNullable().defaultTo('');
    t.text('source').notNullable().defaultTo('manual'); // manual | timer | shift-report | seed
    stamps(t);
    t.check('hours > 0 and hours <= 24', [], 'time_logs_hours_check');
    t.index(['member_id', 'day']);
    t.index(['project_id', 'day']);
    t.index(['milestone_id']);
  });

  /* ───────────── Files ───────────── */

  await knex.schema.createTable('documents', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('entity_type').notNullable(); // lead | project | bug | cr
    t.text('entity_id').notNullable();
    t.text('name').notNullable();
    t.bigInteger('size').notNullable();
    t.text('mime').notNullable().defaultTo('');
    t.text('kind').notNullable().defaultTo('Other'); // SOW, FRD, NDA, Proposal …
    t.text('storage_path').notNullable();
    t.text('uploaded_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    statuses(t, 'entity_type', ['lead', 'project', 'bug', 'cr']);
    t.index(['entity_type', 'entity_id']);
  });

  /* ───────────── Workday: attendance, live status, reports ───────────── */

  await knex.schema.createTable('attendance_events', (t) => {
    t.bigIncrements('id');
    t.text('person_id').notNullable(); // member id or sales-owner id
    t.text('kind').notNullable();
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.jsonb('meta').notNullable().defaultTo('{}'); // break: { type, planMin, note }
    statuses(t, 'kind', ['login', 'logout', 'break', 'resume']);
    t.index(['person_id', 'at']);
    t.index(['at']);
  });

  await knex.schema.createTable('active_timers', (t) => {
    t.text('person_id').primary(); // one running timer per person
    t.text('task_id').references('tasks.id').onDelete('CASCADE');
    t.text('project_id').notNullable().references('projects.id').onDelete('CASCADE');
    t.text('milestone_id').references('milestones.id').onDelete('SET NULL');
    t.text('title').notNullable();
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('presence', (t) => {
    t.text('person_id').primary();
    t.timestamp('last_activity_at', { useTz: true }).notNullable().defaultTo(knex.fn.now()); // idle 30m+ = no activity
  });

  await knex.schema.createTable('activity_feed', (t) => {
    t.bigIncrements('id');
    t.text('person_id'); // null = client
    t.text('kind').notNullable(); // in out start stop break call email whatsapp meeting quote appr …
    t.text('text').notNullable();
    t.text('lead_id').references('leads.id').onDelete('SET NULL');
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['at']);
  });

  await knex.schema.createTable('shift_reports', (t) => {
    t.bigIncrements('id');
    t.text('person_id').notNullable();
    t.date('day').notNullable();
    t.boolean('is_sales').notNullable().defaultTo(false);
    t.text('done').notNullable().defaultTo('');
    t.text('blockers').notNullable().defaultTo('');
    t.text('plan').notNullable().defaultTo('');
    t.text('outcome').notNullable().defaultTo('');
    t.integer('calls').notNullable().defaultTo(0);
    t.integer('meetings').notNullable().defaultTo(0);
    t.jsonb('rows').notNullable().defaultTo('[]'); // [{ p, ms, h, note }]
    t.jsonb('pm_rows').notNullable().defaultTo('[]'); // [{ p, st, note }]
    t.timestamp('submitted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['person_id', 'day']);
  });

  // updated_at triggers
  const withStamps = ['roles', 'members', 'sales_owners', 'users', 'lead_stages', 'lead_sources', 'services', 'settings', 'leads', 'quotes',
    'follow_ups', 'projects', 'milestones', 'change_requests', 'tasks', 'bugs', 'time_logs'];
  for (const tbl of withStamps) {
    await knex.raw(`create trigger ${tbl}_updated_at before update on ${tbl} for each row execute function set_updated_at()`);
  }
}

export async function down(knex) {
  const tables = ['shift_reports', 'activity_feed', 'presence', 'active_timers', 'attendance_events', 'documents', 'time_logs', 'bug_events',
    'bugs', 'tasks', 'cr_history', 'milestones', 'change_requests', 'project_links', 'project_members', 'projects', 'follow_ups', 'quotes',
    'lead_activities', 'leads', 'settings', 'services', 'lead_sources', 'lead_stages', 'audit_logs', 'refresh_tokens', 'users', 'sales_owners',
    'members', 'roles'];
  for (const t of tables) await knex.raw(`drop table if exists ${t} cascade`);
  for (const s of ['lead_code_seq', 'follow_up_code_seq', 'project_code_seq', 'task_code_seq', 'bug_code_seq', 'time_log_code_seq', 'user_code_seq', 'member_code_seq', 'role_code_seq']) {
    await knex.raw(`drop sequence if exists ${s}`);
  }
  await knex.raw('drop function if exists set_updated_at() cascade');
}
