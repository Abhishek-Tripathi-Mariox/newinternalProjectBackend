import { db } from '../../db/knex.js';
import { whereInRange } from '../timesheets/period.js';
import { config } from '../../config/index.js';

const SEV_RANK = "(case b.severity when 'Critical' then 0 when 'Major' then 1 when 'Minor' then 2 else 3 end)";
const STATUS_RANK = "(case b.status when 'Open' then 0 when 'In progress' then 1 when 'Fixed' then 2 when 'Retest' then 3 when 'Reopened' then 4 else 5 end)";
export const BUG_SORTS = {
  due: 'b.due_date', severity: SEV_RANK, status: STATUS_RANK, reported: 'b.reported_on', created: 'b.created_at', updated: 'b.updated_at', id: 'b.id', title: 'b.title',
};
/** Server timezone, so event timestamps become the same local calendar days as `today`. */
// The configured IANA zone (APP_TZ) — not Intl's resolved name, which can be a legacy alias (Asia/Calcutta) Postgres may not know.
const TZ = config.timeZone;
const OPEN = "b.status not in ('Closed','Fixed')";

const COLS = (q = db) => [
  'b.*', 'p.name as project_name', 'm.name as milestone_name', 'a.name as assignee_name', 'r.name as reporter_name',
  q.raw("(select count(*) from documents d where d.entity_type = 'bug' and d.entity_id = b.id)::int as attachment_count"),
];

/**
 * Base query + row scope { projectIds, people, pid } (null = unrestricted). With a people list, a bug
 * is visible when it is assigned to one of them or was reported by the user (frontend scopeState).
 */
export function scoped(scope, q = db) {
  const b = q('bugs as b')
    .join('projects as p', 'p.id', 'b.project_id')
    .leftJoin('milestones as m', 'm.id', 'b.milestone_id')
    .leftJoin('members as a', 'a.id', 'b.assignee_id')
    .leftJoin('members as r', 'r.id', 'b.reporter');
  if (scope.projectIds) b.whereIn('b.project_id', scope.projectIds.length ? scope.projectIds : ['__none__']);
  if (scope.people) b.where((w) => w.whereIn('b.assignee_id', scope.people.length ? scope.people : ['__none__']).orWhere('b.reporter', scope.pid || '__none__'));
  return b;
}

export const getById = (scope, id, q = db) => scoped(scope, q).where('b.id', id).first(COLS(q));

/** Filters that define the KPI "set" (everything except the quick filter). */
export function applyFilters(b, f, rg) {
  if (f.project) b.where('b.project_id', f.project);
  if (f.projectStatus) b.where('p.status', f.projectStatus);
  if (f.member) b.where('b.assignee_id', f.member);
  if (f.team) b.where('b.dept', f.team);
  if (f.dept) b.where('b.dept', f.dept);
  if (f.sev) b.where('b.severity', f.sev);
  if (f.env) b.where('b.env', f.env);
  if (f.reporter) b.where('b.reporter', f.reporter);
  if (f.status) b.where('b.status', f.status);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    b.where((w) => w.whereILike('b.id', like).orWhereILike('b.title', like).orWhereILike('p.name', like).orWhereILike('a.name', like));
  }
  if (rg) whereInRange(b, 'b.reported_on', rg);
  return b;
}

export function applyQuick(b, quick, today) {
  switch (quick) {
    case 'open': b.whereRaw(OPEN); break;
    case 'overdue': b.whereRaw(OPEN).where('b.due_date', '<', today); break;
    case 'critical': b.whereRaw(OPEN).where('b.severity', 'Critical'); break;
    case 'reopened': b.where('b.status', 'Reopened'); break;
    case 'unassigned': b.whereNull('b.assignee_id'); break;
    case 'closed': b.where('b.status', 'Closed'); break;
    default: break;
  }
  return b;
}

export async function list(scope, f, rg, today, sort, page) {
  const base = applyQuick(applyFilters(scoped(scope), f, rg), f.quick, today);
  const [{ count }] = await base.clone().count('* as count');
  const rows = base.clone().select(COLS()).limit(page.limit).offset(page.offset);
  if (sort) rows.orderByRaw(`${sort[0]} ${sort[1]} nulls last`).orderBy('b.id');
  else rows.orderByRaw(`${SEV_RANK}, b.due_date asc nulls last, b.id`); // bugSort: most severe first, then earliest due
  return { rows: await rows, total: Number(count) };
}

/**
 * KPI block over the filtered set (BugsTab): open, critical, overdue, reopened, unassigned, closed,
 * total, avgDaysToClose (closed date = the bug's last history entry, like bugClosedAt()).
 */
export async function kpis(scope, f, rg, today) {
  const [r] = await applyFilters(scoped(scope), f, rg).select(db.raw(`
    count(*)::int as total,
    count(*) filter (where ${OPEN})::int as open,
    count(*) filter (where ${OPEN} and b.severity = 'Critical')::int as critical,
    count(*) filter (where ${OPEN} and b.due_date < ?)::int as overdue,
    count(*) filter (where b.status = 'Reopened')::int as reopened,
    count(*) filter (where b.assignee_id is null)::int as unassigned,
    count(*) filter (where b.status = 'Closed')::int as closed,
    avg(greatest(0, coalesce((select (max(e.at) at time zone ?)::date from bug_events e where e.bug_id = b.id), ?::date) - b.reported_on))
      filter (where b.status = 'Closed') as avg_close`, [today, TZ, today]));
  return {
    total: r.total, open: r.open, critical: r.critical, overdue: r.overdue, reopened: r.reopened, unassigned: r.unassigned, closed: r.closed,
    avgDaysToClose: r.avg_close == null ? 0 : Math.round(Number(r.avg_close) * 10) / 10,
  };
}

export const events = (id, q = db) => q('bug_events as e').leftJoin('users as u', 'u.id', 'e.actor_user_id')
  .where('e.bug_id', id).orderBy([{ column: 'e.at' }, { column: 'e.id' }]).select('e.*', 'u.name as actor_name');

/** Events of many bugs (list ?include=events). */
export const eventsOfMany = (ids, q = db) => q('bug_events as e').leftJoin('users as u', 'u.id', 'e.actor_user_id')
  .whereIn('e.bug_id', ids).orderBy([{ column: 'e.at' }, { column: 'e.id' }]).select('e.*', 'u.name as actor_name');

export const attachments = (id, q = db) => q('documents').where({ entity_type: 'bug', entity_id: id }).orderBy('created_at');

export const addEvents = (q, bugId, texts, actorId) => (texts.length
  ? q('bug_events').insert(texts.map((text) => ({ bug_id: bugId, text, actor_user_id: actorId })))
  : Promise.resolve());

/** First project member (team order) from a department — the frontend's dept auto-assign. */
export const firstOfTeam = (q, projectId, team) => q('project_members as pm').join('members as mb', 'mb.id', 'pm.member_id')
  .where({ 'pm.project_id': projectId, 'mb.team': team }).orderBy('pm.position').first('mb.id');

/** User who reported the bug (actor of its first history entry). */
export const firstActor = (id, q = db) => q('bug_events').where({ bug_id: id }).orderBy('id').first('actor_user_id');
