/**
 * Projects business rules (port of store/slices/delivery.js: saveProj, updProj, setAlloc, addMember,
 * removeMember, setProjLinks, portalOn/Off, updMs, askApproval) + read models (list, detail,
 * overview, capacity). Row scope comes from core/scope.visibleProjectIds; edits are PM-only
 * (frontend isPMof: Super Admin, or a Project Manager who is the project's PM).
 */
import { randomBytes } from 'node:crypto';
import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { visibleProjectIds } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import * as repo from './projects.repository.js';
import { toDocument } from './projects.mapper.js';
import { attachDocuments } from './documents.js';
import { documentsService } from '../documents/documents.service.js';
import { buildModel, projectSummary, overview as overviewOf, capacity as capacityOf, templateMilestones, hh, LINK_OK } from './projects.domain.js';
import { dn } from './dates.js';

/* ───────────── Access helpers (shared with milestones, change requests, portal) ───────────── */

/** Frontend isPMof(): Super Admin, or a Project Manager who manages this project. */
export const isPMof = (user, p) => !!user && (user.isSuper || (user.role.id === 'r-pm' && !!p && !!user.memberId && user.memberId === p.pmId));

export async function canSee(user, projectId) {
  const ids = await visibleProjectIds(user);
  return !ids || ids.includes(projectId);
}

/** Read access: 404 when missing or outside the user's scope (don't leak existence). */
export async function visibleProject(user, id, q = db) {
  const p = await repo.findProject(id, q);
  if (!p || !(await canSee(user, id))) throw notFound('Project');
  return p;
}

/** Write access for PM-only edits: 404 when missing, 403 unless the user is the project's PM. */
export async function pmProject(user, id, q = db) {
  const p = await repo.findProject(id, q);
  if (!p) throw notFound('Project');
  if (!isPMof(user, p)) throw forbidden("Only the project's PM can change this");
  return p;
}

/* ───────────── Read models ───────────── */

async function loadData(user) {
  const ids = await visibleProjectIds(user);
  const [projects, milestones, logs, members, counts] = await Promise.all([
    repo.findProjects(ids), repo.findMilestones(ids), repo.findLogs(ids), repo.findMembers(), repo.healthCounts(ids),
  ]);
  return { ids, projects, milestones, logs, members, ...counts };
}

const SORTS = {
  id: (a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)),
  name: (a, b) => a.name.localeCompare(b.name),
  dueDate: (a, b) => a.dueDate.localeCompare(b.dueDate),
  status: (a, b) => a.status.localeCompare(b.status),
  health: (a, b) => (a.health.score ?? 101) - (b.health.score ?? 101),
  used: (a, b) => a.hours.used - b.hours.used,
  value: (a, b) => a.value - b.value,
};

export async function list(user, query) {
  const data = await loadData(user);
  const M = buildModel(data, query);
  const rows = M.pF.map((p) => ({ ...p, ...projectSummary(p, M) }));
  const sort = query.sort || 'id';
  const desc = sort.startsWith('-');
  const cmp = SORTS[desc ? sort.slice(1) : sort] || SORTS.id;
  rows.sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
  const pg = pageParams(query);
  let page = rows.slice(pg.offset, pg.offset + pg.limit);
  if (query.include?.includes('documents')) {
    const docs = await documentsService.listForMany('project', page.map((p) => p.id));
    page = page.map((p) => ({ ...p, documents: docs[p.id] }));
  }
  return { rows: page, meta: { ...pg.meta(rows.length), period: query.period || 'week', periodLabel: M.periodLabel } };
}

export async function overview(user, query) {
  const data = await loadData(user);
  return overviewOf(buildModel(data, query), data);
}

export async function capacity(user, query) {
  const data = await loadData(user);
  const tasks = await repo.findOpenTasks(data.ids);
  return capacityOf(buildModel(data, query), { projects: data.projects, tasks }, query.week);
}

function milestoneRows(I, M) {
  const T = M.T;
  return I.ms.map((m) => ({
    ...m,
    usedHours: M.g(`ms:${m.id}`).all,
    people: M.msPeople[m.id] || [],
    current: !!I.curM && I.curM.id === m.id,
    overdue: m.status !== 'Done' && !!m.dueDate && dn(m.dueDate) < T,
  }));
}

export async function milestones(user, id) {
  const p = await visibleProject(user, id);
  const [ms, logs] = await Promise.all([repo.findMilestones([id]), repo.findLogs([id])]);
  const M = buildModel({ projects: [p], milestones: ms, logs, members: await repo.findMembers() });
  return milestoneRows(M.info(p), M);
}

/**
 * GET /milestones — milestones of every project the user can see (or one, via projectId; 404 when
 * not visible), ordered by project then n. Same DTO as /projects/:id/milestones minus the
 * hour/people roll-ups: {id, projectId, n, name, allocHours, dueDate, status, crId, approval}.
 */
export async function allMilestones(user, query) {
  let ids = await visibleProjectIds(user);
  if (query.projectId) {
    if (ids && !ids.includes(query.projectId)) throw notFound('Project');
    ids = [query.projectId];
  }
  const rows = (await repo.findMilestones(ids)).filter((m) => !query.status || m.status === query.status);
  const pg = pageParams(query);
  return { rows: rows.slice(pg.offset, pg.offset + pg.limit), meta: pg.meta(rows.length) };
}

export async function detail(user, id, query = {}) {
  const p = await visibleProject(user, id);
  const [ms, logs, members, counts, docs, crs] = await Promise.all([
    repo.findMilestones([id]), repo.findLogs([id]), repo.findMembers(), repo.healthCounts([id]), repo.findDocuments('project', id),
    db('change_requests').where({ project_id: id }).select('status', 'amount', 'hours'),
  ]);
  const M = buildModel({ projects: [p], milestones: ms, logs, members, ...counts }, query);
  const I = M.info(p);
  const MEM = M.MEM;
  const allocTotal = p.team.reduce((x, t) => x + t.allocHours, 0);

  const team = p.team.map((t) => {
    const taken = M.g(`pm:${p.id}:${t.memberId}`).all;
    const m = MEM[t.memberId] || {};
    return { memberId: t.memberId, name: m.name || '—', team: m.team || null, roleTitle: m.roleTitle || '', allocHours: t.allocHours, takenHours: taken, remainingHours: t.allocHours - taken, isPM: t.memberId === p.pmId };
  });

  const byStatus = {};
  crs.forEach((c) => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const approved = crs.filter((c) => ['Approved', 'In progress', 'Done'].includes(c.status));

  // Day-wise work: the chosen day (default: latest day with logs) and the 21 most recent days.
  const totals = {};
  logs.forEach((l) => { totals[l.day] = (totals[l.day] || 0) + l.hours; });
  const days = Object.keys(totals).sort().reverse();
  const day = query.day || days[0] || null;
  const byM = {};
  logs.filter((l) => l.day === day).forEach((l) => (byM[l.memberId] = byM[l.memberId] || []).push(l));
  const people = Object.keys(byM)
    .map((mid) => ({ memberId: mid, name: (MEM[mid] || {}).name || '—', hours: byM[mid].reduce((x, l) => x + l.hours, 0), entries: byM[mid].map(({ id: lid, milestoneId, hours, note }) => ({ id: lid, milestoneId, hours, note })) }))
    .sort((a, b) => b.hours - a.hours);

  return {
    ...p,
    ...projectSummary(p, M),
    milestones: milestoneRows(I, M),
    team,
    allocTotal,
    allocOverBudget: allocTotal > I.budget,
    documents: docs.map(toDocument),
    changeRequests: { total: crs.length, byStatus, open: crs.filter((c) => c.status !== 'Done' && c.status !== 'Rejected').length, approvedValue: approved.reduce((x, c) => x + Number(c.amount), 0), approvedHours: approved.reduce((x, c) => x + Number(c.hours), 0) },
    recentLogs: logs.slice(0, 20),
    dayWork: { day, total: people.reduce((x, r) => x + r.hours, 0), people, recentDays: days.slice(0, 21).map((d) => ({ day: d, total: totals[d] })) },
  };
}

/* ───────────── Writes ───────────── */

const linkError = (links) => {
  const bad = links.find((l) => l.url.trim() && !LINK_OK.test(l.url.trim()));
  return bad ? `Links must start with https:// (check the ${bad.type} link).` : null;
};
const cleanLinks = (links) => links.filter((l) => l.url.trim()).map((l) => ({ type: l.type, url: l.url.trim() }));

async function assertMembers(ids, q) {
  const uniq = Array.from(new Set(ids));
  const found = await q('members').whereIn('id', uniq).pluck('id');
  const missing = uniq.filter((x) => !found.includes(x));
  if (missing.length) throw unprocessable(`Unknown team member: ${missing.join(', ')}`);
}

/** saveProj: validation, team allocation split, 5 template milestones. */
export async function create(user, b) {
  if (!b.name.trim() || !b.client.trim()) throw unprocessable('Project name and client are required.');
  const services = (b.services || (b.service ? [b.service] : [])).map((s) => s.trim()).filter(Boolean);
  if (!services.length) throw unprocessable('Pick at least one service.');
  if (!b.startDate || !b.dueDate || b.dueDate < b.startDate) throw unprocessable('Pick a start date and a due date after it.');
  const pm = b.pmId || user.memberId;
  if (!pm) throw unprocessable('Pick a project manager.');
  const err = linkError(b.links);
  if (err) throw unprocessable(err);

  const budget = Math.max(0, +b.budgetHours || 0);
  const team = Array.from(new Set([pm].concat(b.team.filter((x) => x !== pm))));
  const each = Math.round(budget / team.length / 5) * 5;

  const id = await db.transaction(async (trx) => {
    await assertMembers(team, trx);
    const pid = await nextId(trx, 'project');
    await trx('projects').insert({
      id: pid, name: b.name.trim(), client: b.client.trim(), services, status: b.status, pm_member_id: pm, start_date: b.startDate, due_date: b.dueDate,
      value: +b.value || 0, hue: Math.floor(Math.random() * 360), priority: b.priority || 'Medium', brief: (b.brief || '').trim(),
    });
    await trx('project_members').insert(team.map((mid, i) => ({ project_id: pid, member_id: mid, alloc_hours: each, position: i })));
    await trx('milestones').insert(templateMilestones(budget, b.startDate, b.dueDate).map((m) => ({
      id: `${pid}-M${m.n}`, project_id: pid, n: m.n, name: m.name, alloc_hours: m.allocHours, due_date: m.dueDate, status: 'Not started',
    })));
    const links = cleanLinks(b.links);
    if (links.length) await trx('project_links').insert(links.map((l) => ({ project_id: pid, ...l })));
    return pid;
  });
  return detail(user, id);
}

const PATCH_COLS = { name: 'name', client: 'client', services: 'services', status: 'status', pmId: 'pm_member_id', startDate: 'start_date', dueDate: 'due_date', value: 'value', priority: 'priority', brief: 'brief' };

/** updProj (PM only). A new PM joins the team (first position) if not on it yet. */
export async function update(user, id, b) {
  await db.transaction(async (trx) => {
    const p = await pmProject(user, id, trx);
    const start = b.startDate || p.startDate;
    const due = b.dueDate || p.dueDate;
    if (due < start) throw unprocessable('Pick a start date and a due date after it.');
    const row = {};
    for (const [k, col] of Object.entries(PATCH_COLS)) if (b[k] !== undefined) row[col] = typeof b[k] === 'string' ? b[k].trim() : b[k];
    if (b.pmId && b.pmId !== p.pmId) {
      await assertMembers([b.pmId], trx);
      if (!p.team.some((t) => t.memberId === b.pmId)) {
        const { min } = await trx('project_members').where({ project_id: id }).min('position as min').first();
        await trx('project_members').insert({ project_id: id, member_id: b.pmId, alloc_hours: 0, position: (min ?? 1) - 1 });
      }
    }
    await trx('projects').where({ id }).update(row);
  });
  return detail(user, id);
}

async function teamState(id, q = db) {
  const p = await repo.findProject(id, q);
  const ms = await repo.findMilestones([id], q);
  const budget = ms.reduce((x, m) => x + m.allocHours, 0);
  const allocTotal = p.team.reduce((x, t) => x + t.allocHours, 0);
  return { team: p.team, budgetHours: budget, allocTotal, allocOverBudget: allocTotal > budget };
}

/** setAlloc (PM only). Warns when this change takes the team over the hours budget. */
export async function setAlloc(user, id, memberId, allocHours) {
  return db.transaction(async (trx) => {
    const p = await pmProject(user, id, trx);
    const cur = p.team.find((t) => t.memberId === memberId);
    if (!cur) throw notFound('Team member');
    const before = await teamState(id, trx);
    const nv = Math.max(0, +allocHours || 0);
    const nt = before.allocTotal - cur.allocHours + nv;
    await trx('project_members').where({ project_id: id, member_id: memberId }).update({ alloc_hours: nv });
    const out = await teamState(id, trx);
    if (nt > before.budgetHours && before.allocTotal <= before.budgetHours) out.warning = `Over budget: team now ${hh(nt)} of ${hh(before.budgetHours)}`;
    return out;
  });
}

/** addMember (PM only): joins with 0 allocated hours (or the given amount). No-op if already on the team. */
export async function addMember(user, id, { memberId, allocHours }) {
  return db.transaction(async (trx) => {
    const p = await pmProject(user, id, trx);
    const m = await trx('members').where({ id: memberId }).first('id');
    if (!m) throw notFound('Member');
    let added = false;
    if (!p.team.some((t) => t.memberId === memberId)) {
      const { max } = await trx('project_members').where({ project_id: id }).max('position as max').first();
      await trx('project_members').insert({ project_id: id, member_id: memberId, alloc_hours: Math.max(0, +allocHours || 0), position: (max ?? -1) + 1 });
      added = true;
    }
    return { added, ...(await teamState(id, trx)) };
  });
}

export async function removeMember(user, id, memberId) {
  return db.transaction(async (trx) => {
    await pmProject(user, id, trx);
    const n = await trx('project_members').where({ project_id: id, member_id: memberId }).del();
    if (!n) throw notFound('Team member');
    return teamState(id, trx);
  });
}

/** setProjLinks (PM only): replace the list; blank URLs dropped, others must be http(s). */
export async function setLinks(user, id, links) {
  const err = linkError(links);
  if (err) throw unprocessable(err);
  return db.transaction(async (trx) => {
    await pmProject(user, id, trx);
    await trx('project_links').where({ project_id: id }).del();
    const clean = cleanLinks(links);
    if (clean.length) await trx('project_links').insert(clean.map((l) => ({ project_id: id, ...l })));
    return (await repo.findProject(id, trx)).links;
  });
}

/** portalOn / portalOff (PM only). Turning on keeps an existing token, else generates one. */
export async function setPortal(user, id, on) {
  return db.transaction(async (trx) => {
    const p = await pmProject(user, id, trx);
    const token = p.portal.token || randomBytes(9).toString('base64url');
    await trx('projects').where({ id }).update(on ? { portal_on: true, portal_token: token } : { portal_on: false });
    return { on, token: on ? token : p.portal.token, message: on ? 'Client portal link is live' : 'Client portal link turned off' };
  });
}

export async function addDocuments(user, id, files, kind) {
  await visibleProject(user, id);
  return db.transaction((trx) => attachDocuments('project', id, files, user, trx, kind));
}

/* ───────────── Milestones ───────────── */

async function pmMilestone(user, mid, q) {
  const m = await repo.findMilestone(mid, q);
  if (!m) throw notFound('Milestone');
  const p = await repo.findProject(m.projectId, q);
  if (!isPMof(user, p)) {
    if (!(await canSee(user, p.id))) throw notFound('Milestone');
    throw forbidden("Only the project's PM can change this");
  }
  return { m, p };
}

/** updMs (PM only). A blank name falls back to "Milestone n". */
export async function updateMilestone(user, mid, b) {
  return db.transaction(async (trx) => {
    const { m } = await pmMilestone(user, mid, trx);
    const row = {};
    if (b.name !== undefined) row.name = b.name.trim() || `Milestone ${m.n}`;
    if (b.allocHours !== undefined) row.alloc_hours = Math.max(0, +b.allocHours || 0);
    if (b.status !== undefined) row.status = b.status;
    if (b.dueDate !== undefined) row.due_date = b.dueDate;
    await trx('milestones').where({ id: mid }).update(row);
    return repo.findMilestone(mid, trx);
  });
}

/** askApproval (PM only): portal must be on; milestone goes In review with approval Pending. */
export async function askApproval(user, mid) {
  return db.transaction(async (trx) => {
    const { m, p } = await pmMilestone(user, mid, trx);
    if (!p.portal.on) throw unprocessable('Turn on the client portal first.');
    if (m.status === 'Done') throw unprocessable('This milestone is already done.');
    if (m.approval && m.approval.status === 'Pending') throw unprocessable('Already waiting for the client’s approval.');
    await trx('milestones').where({ id: mid }).update({ status: 'In review', approval_status: 'Pending', approval_asked_at: trx.fn.now(), approval_at: null, approval_note: null });
    return { ...(await repo.findMilestone(mid, trx)), message: 'Sent to the client for approval' };
  });
}
