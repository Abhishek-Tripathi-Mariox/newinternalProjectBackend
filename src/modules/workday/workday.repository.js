/** Knex queries for workday / live / attendance / reports. `q` is the db or a transaction. */
import { db } from '../../db/knex.js';

const toEvent = (r) => ({ id: r.id, t: new Date(r.at).getTime(), k: r.kind, who: r.person_id, meta: r.meta || {} });

/** Serialise writes for one person (check-in/out, breaks, timers) within a transaction. */
export const lockPerson = (q, pid) => q.raw('select pg_advisory_xact_lock(hashtext(?))', [`workday:${pid}`]);

/** Attendance events for people (null = everyone) in [from, to), sorted. */
export async function events(q, pids, from, to) {
  const qb = q('attendance_events').where('at', '>=', new Date(from)).where('at', '<', new Date(to)).orderBy([{ column: 'at' }, { column: 'id' }]);
  if (pids) qb.whereIn('person_id', pids.length ? pids : ['__none__']);
  return (await qb.select('id', 'person_id', 'kind', 'at', 'meta')).map(toEvent);
}

export const insertEvent = (q, pid, kind, t, meta = {}) => q('attendance_events').insert({ person_id: pid, kind, at: new Date(t), meta });

/** Last attendance event per person (ever) → { pid: ms }. */
export async function lastTracked(q = db) {
  const rows = await q('attendance_events').select('person_id').max('at as at').groupBy('person_id');
  return Object.fromEntries(rows.map((r) => [r.person_id, new Date(r.at).getTime()]));
}

export const feed = (q, pid, kind, text, t, leadId = null) => q('activity_feed').insert({ person_id: pid, kind, text, at: new Date(t), lead_id: leadId });

export const touchPresence = (q, pid, t = Date.now()) => q('presence').insert({ person_id: pid, last_activity_at: new Date(t) }).onConflict('person_id').merge();

export async function presenceMap(q = db) {
  const rows = await q('presence').select('person_id', 'last_activity_at');
  return Object.fromEntries(rows.map((r) => [r.person_id, new Date(r.last_activity_at).getTime()]));
}

const TIMER_COLS = ['t.person_id', 't.task_id', 't.project_id', 't.milestone_id', 't.title', 't.started_at', 'p.name as project_name'];
export const timer = (q, pid) => q('active_timers as t').leftJoin('projects as p', 'p.id', 't.project_id').where('t.person_id', pid).first(TIMER_COLS);
export const timers = (q = db) => q('active_timers as t').leftJoin('projects as p', 'p.id', 't.project_id').select(TIMER_COLS);
export const deleteTimer = (q, pid) => q('active_timers').where({ person_id: pid }).del();
export const insertTimer = (q, row) => q('active_timers').insert(row);

/** Delivery members + sales owners (active), like the frontend `people()`. */
export async function people(q = db) {
  const members = await q('members').where({ active: true }).orderBy('name').select('id', 'name', 'role_title', 'team', 'hue', 'shift_hours');
  const owners = await q('sales_owners').where({ active: true }).orderBy('name').select('id', 'name', 'hue');
  return members.map((m) => ({ id: m.id, name: m.name, role: `${m.role_title} · ${m.team}`, team: m.team, hue: m.hue, sales: false, shift: Number(m.shift_hours) || 8 }))
    .concat(owners.map((o) => ({ id: o.id, name: o.name, role: 'Sales', team: 'Sales', hue: o.hue, sales: true, shift: 8 })));
}

export const member = (q, id) => q('members').where({ id }).first();
export const salesOwner = (q, id) => q('sales_owners').where({ id }).first();

export const task = (q, id) => q('tasks').where({ id }).first('id', 'project_id', 'milestone_id', 'title', 'assignee_id', 'status');
export const openTasksFor = (q, pid) => q('tasks as t').join('projects as p', 'p.id', 't.project_id')
  .where('t.assignee_id', pid).whereNot('t.status', 'Done').orderBy('t.id').limit(15)
  .select('t.id', 't.title', 'p.name as project_name');

export const projects = (q = db) => q('projects').select('id', 'name', 'client', 'status', 'pm_member_id');
export const projectTeam = (q = db) => q('project_members').select('project_id', 'member_id');
export const milestonesOf = (q, projectIds) => q('milestones').whereIn('project_id', projectIds.length ? projectIds : ['__none__']).orderBy(['project_id', 'n']).select('id', 'project_id', 'n', 'status');

export const logsOn = (q, day, pid = null) => {
  const qb = q('time_logs').where({ day });
  if (pid) qb.where({ member_id: pid });
  return qb.orderBy('created_at').select('id', 'member_id', 'project_id', 'milestone_id', 'hours', 'note');
};
export const insertLog = (q, row) => q('time_logs').insert(row);
export const deleteLogsOn = (q, pid, day) => q('time_logs').where({ member_id: pid, day }).del();

export const reportsIn = (q, pids, fromDay, toDay) => q('shift_reports').whereIn('person_id', pids.length ? pids : ['__none__'])
  .where('day', '>=', fromDay).where('day', '<', toDay).select('*');
export const upsertReport = (q, row) => q('shift_reports').insert(row).onConflict(['person_id', 'day']).merge();

/** Lead activity since `from` (owner = lead owner) plus live-feed lines that reference a lead (owner = who did it). */
export async function leadActsSince(q, from) {
  const acts = await q('lead_activities as a').join('leads as l', 'l.id', 'a.lead_id').where('a.at', '>=', new Date(from))
    .select('a.at', 'a.kind', 'a.text', 'l.id as lead_id', 'l.company', 'l.owner_id');
  const fd = await q('activity_feed as f').join('leads as l', 'l.id', 'f.lead_id').where('f.at', '>=', new Date(from))
    .select('f.at', 'f.kind', 'f.text', 'l.id as lead_id', 'l.company', 'f.person_id');
  return acts.map((a) => ({ t: new Date(a.at).getTime(), kind: a.kind, text: a.text, leadId: a.lead_id, company: a.company, owner: a.owner_id, fromFeed: false }))
    .concat(fd.map((a) => ({ t: new Date(a.at).getTime(), kind: a.kind, text: a.text, leadId: a.lead_id, company: a.company, owner: a.person_id, fromFeed: true })));
}

export const teamFeedSince = (q, from) => q('activity_feed').whereNull('lead_id').where('at', '>=', new Date(from)).orderBy('at', 'desc').limit(500)
  .select('person_id', 'kind', 'text', 'at');

export const followUpsFor = (q, owners) => q('follow_ups').whereIn('owner_id', owners.length ? owners : ['__none__']).select('owner_id', 'due_at', 'done');
export const newLeadsSince = (q, owner, from) => q('leads').where({ owner_id: owner }).where('created_at', '>=', new Date(from)).count('* as n').first();

export const approvalsSince = (q, from) => q('milestones as m').join('projects as p', 'p.id', 'm.project_id')
  .whereNotNull('m.approval_at').whereNotNull('m.approval_status').where('m.approval_at', '>=', new Date(from))
  .select('m.name', 'm.approval_status', 'm.approval_at', 'p.client');
export const changesRequested = (q = db) => q('milestones as m').join('projects as p', 'p.id', 'm.project_id')
  .where('m.approval_status', 'Changes requested').whereNot('m.status', 'Done').orderBy('m.approval_at', 'desc').limit(3)
  .select('m.name', 'm.approval_note', 'p.id as project_id', 'p.name as project_name', 'p.client');
export const crsAwaiting = (q = db) => q('change_requests as c').join('projects as p', 'p.id', 'c.project_id')
  .where('c.status', 'Sent to client').select('c.id', 'c.title', 'c.hours', 'c.amount', 'c.sent_at', 'c.raised_at', 'p.id as project_id', 'p.client');

/** Members on a Running project with no time logged on `day`. */
export const missingTimesheets = (q, day) => q('members as m').where('m.active', true)
  .whereExists(function running() {
    this.select(1).from('project_members as pm').join('projects as p', 'p.id', 'pm.project_id').whereRaw('pm.member_id = m.id').where('p.status', 'Running');
  })
  .whereNotExists(function logged() { this.select(1).from('time_logs as l').whereRaw('l.member_id = m.id').where('l.day', day); })
  .orderBy('m.name').select('m.id', 'm.name');
