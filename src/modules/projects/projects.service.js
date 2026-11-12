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
import { emailMilestoneToClient, clientMailNote } from './clientEmails.js';

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

/** saveProj: validation, team allocation split, milestones (as typed in the form, or the 5 template ones). */
export async function create(user, b) {
  if (!b.name.trim() || !b.client.trim()) throw unprocessable('Project name and client are required.');
  const services = (b.services || (b.service ? [b.service] : [])).map((s) => s.trim()).filter(Boolean);
  if (!services.length) throw unprocessable('Pick at least one service.');
  if (!b.startDate || !b.dueDate || b.dueDate < b.startDate) throw unprocessable('Pick a start date and a due date after it.');
  const pm = b.pmId || user.memberId;
  if (!pm) throw unprocessable('Pick a project manager.');
  const err = linkError(b.links);
  if (err) throw unprocessable(err);

  const custom = Array.isArray(b.milestones) && b.milestones.length > 0;
  if (custom && b.milestones.some((m) => m.dueDate < b.startDate)) throw unprocessable('Milestone due dates can’t be before the project start date.');
  const msTotal = custom ? b.milestones.reduce((x, m) => x + (+m.allocHours || 0), 0) : 0;
  const given = Math.max(0, +b.budgetHours || 0);
  if (custom && given > 0 && msTotal > given) throw unprocessable(`Milestone hours (${hh(msTotal)}) are more than the budget (${hh(given)}). Reduce them or raise the budget.`);
  // Team allocation splits the budget; with typed milestones and no budget, their total is the budget.
  const budget = custom ? (given || msTotal) : given;
  const team = Array.from(new Set([pm].concat(b.team.filter((x) => x !== pm))));
  const each = Math.round(budget / team.length / 5) * 5;

  const id = await db.transaction(async (trx) => {
    await assertMembers(team, trx);
    const pid = await nextId(trx, 'project');
    await trx('projects').insert({
      id: pid, name: b.name.trim(), client: b.client.trim(), services, status: b.status, pm_member_id: pm, start_date: b.startDate, due_date: b.dueDate,
      value: +b.value || 0, hue: Math.floor(Math.random() * 360), priority: b.priority || 'Medium', brief: (b.brief || '').trim(),
      client_email: (b.clientEmail || '').trim().toLowerCase() || null,
      budget_hours: budget,
    });
    await trx('project_members').insert(team.map((mid, i) => ({ project_id: pid, member_id: mid, alloc_hours: each, position: i })));
    const ms = custom
      ? b.milestones.map((m, i) => ({ n: i + 1, name: m.name.trim() || `Milestone ${i + 1}`, allocHours: +m.allocHours || 0, dueDate: m.dueDate, team: m.team || [] }))
      : templateMilestones(budget, b.startDate, b.dueDate);
    await trx('milestones').insert(ms.map((m) => ({
      id: `${pid}-M${m.n}`, project_id: pid, n: m.n, name: m.name, alloc_hours: m.allocHours, due_date: m.dueDate, status: 'Not started',
    })));
    for (const m of ms) if (m.team && m.team.length) await repo.setMilestoneTeam(trx, pid, `${pid}-M${m.n}`, m.team);
    const links = cleanLinks(b.links);
    if (links.length) await trx('project_links').insert(links.map((l) => ({ project_id: pid, ...l })));
    return pid;
  });
  return detail(user, id);
}

const PATCH_COLS = { name: 'name', client: 'client', services: 'services', status: 'status', pmId: 'pm_member_id', startDate: 'start_date', dueDate: 'due_date', value: 'value', priority: 'priority', brief: 'brief', clientEmail: 'client_email' };

/** updProj (PM only). A new PM joins the team (first position) if not on it yet. */
export async function update(user, id, b) {
  await db.transaction(async (trx) => {
    const p = await pmProject(user, id, trx);
    const start = b.startDate || p.startDate;
    const due = b.dueDate || p.dueDate;
    if (due < start) throw unprocessable('Pick a start date and a due date after it.');
    const row = {};
    for (const [k, col] of Object.entries(PATCH_COLS)) if (b[k] !== undefined) row[col] = typeof b[k] === 'string' ? b[k].trim() : b[k];
    if (row.client_email === '') row.client_email = null;
    if (b.budgetHours !== undefined) {
      const total = await msTotal(trx, id);
      if (b.budgetHours < total) throw unprocessable(`The budget can’t be less than the milestone hours (${hh(total)}). Reduce milestone hours first.`);
      row.budget_hours = b.budgetHours;
    }
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
  const budget = p.budgetHours != null ? p.budgetHours : ms.reduce((x, m) => x + m.allocHours, 0);
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
    // Leaving the project also takes them off its milestones.
    await trx('milestone_members').where({ member_id: memberId }).whereIn('milestone_id', trx('milestones').where({ project_id: id }).select('id')).del();
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

/** Sum of a project's milestone hours (optionally leaving one milestone out). */
async function msTotal(q, projectId, exceptId) {
  const qb = q('milestones').where({ project_id: projectId });
  if (exceptId) qb.whereNot({ id: exceptId });
  const { s } = await qb.sum('alloc_hours as s').first();
  return Number(s) || 0;
}

/** Milestone hours may not exceed the project's hours budget. */
async function assertWithinBudget(q, p, total) {
  if (p.budgetHours == null || total <= p.budgetHours + 1e-9) return;
  throw unprocessable(`Milestone hours would be ${hh(total)} — more than the project budget (${hh(p.budgetHours)}). Increase the project hours first (Edit project → Budget).`);
}

/** addMilestone (PM only): appended after the last one. */
export async function addMilestone(user, pid, b) {
  return db.transaction(async (trx) => {
    const p = await pmProject(user, pid, trx);
    await repo.lockProject(trx, p.id);
    if (b.dueDate < p.startDate) throw unprocessable('The due date can’t be before the project start date.');
    await assertWithinBudget(trx, p, (await msTotal(trx, p.id)) + Math.max(0, +b.allocHours || 0));
    const rows = await trx('milestones').where({ project_id: p.id }).select('id', 'n');
    const n = rows.reduce((x, r) => Math.max(x, r.n), 0) + 1;
    const ids = new Set(rows.map((r) => r.id));
    let k = n;
    while (ids.has(`${p.id}-M${k}`)) k += 1;
    const id = `${p.id}-M${k}`;
    await trx('milestones').insert({ id, project_id: p.id, n, name: b.name.trim() || `Milestone ${n}`, alloc_hours: Math.max(0, +b.allocHours || 0), due_date: b.dueDate, status: 'Not started' });
    if (b.team && b.team.length) await repo.setMilestoneTeam(trx, p.id, id, b.team);
    return repo.findMilestone(id, trx);
  });
}

/**
 * deleteMilestone (PM only). Not allowed once hours are logged on it, or for a change-request milestone.
 * Its tasks / bugs stay on the project (milestone cleared); the rest are renumbered 1..n.
 */
export async function deleteMilestone(user, mid) {
  return db.transaction(async (trx) => {
    const { m, p } = await pmMilestone(user, mid, trx);
    await repo.lockProject(trx, p.id);
    if (m.crId) throw unprocessable('This milestone belongs to a change request and can’t be deleted.');
    const logged = await trx('time_logs').where({ milestone_id: mid }).first('id');
    if (logged) throw unprocessable('Hours are logged on this milestone, so it can’t be deleted. Rename it or set its hours to 0 instead.');
    await trx('change_requests').where({ milestone_id: mid }).update({ milestone_id: null });
    await trx('change_requests').where({ project_id: p.id, target: mid }).update({ target: 'new' }); // CRs not yet approved
    await trx('milestones').where({ id: mid }).del();
    const rest = await trx('milestones').where({ project_id: p.id }).orderBy('n').select('id', 'n');
    // Two passes so the (project_id, n) unique constraint never clashes mid-way.
    for (const r of rest) await trx('milestones').where({ id: r.id }).update({ n: r.n + 10000 });
    for (const [i, r] of rest.entries()) await trx('milestones').where({ id: r.id }).update({ n: i + 1 });
    return { id: mid, deleted: true, milestones: await repo.findMilestones([p.id], trx) };
  });
}

/** updMs (PM only). A blank name falls back to "Milestone n". */
export async function updateMilestone(user, mid, b) {
  return db.transaction(async (trx) => {
    const { m, p } = await pmMilestone(user, mid, trx);
    const row = {};
    if (b.allocHours !== undefined) {
      await repo.lockProject(trx, p.id);
      await assertWithinBudget(trx, p, (await msTotal(trx, p.id, mid)) + Math.max(0, +b.allocHours || 0));
    }
    if (b.name !== undefined) row.name = b.name.trim() || `Milestone ${m.n}`;
    if (b.allocHours !== undefined) row.alloc_hours = Math.max(0, +b.allocHours || 0);
    if (b.status !== undefined) row.status = b.status;
    if (b.dueDate !== undefined) row.due_date = b.dueDate;
    if (Object.keys(row).length) await trx('milestones').where({ id: mid }).update(row);
    if (b.team !== undefined) await repo.setMilestoneTeam(trx, p.id, mid, b.team);
    return repo.findMilestone(mid, trx);
  });
}

/** askApproval (PM only): portal must be on; milestone goes In review with approval Pending. */
export async function askApproval(user, mid) {
  const out = await db.transaction(async (trx) => {
    const { m, p } = await pmMilestone(user, mid, trx);
    if (!p.portal.on) throw unprocessable('Turn on the client portal first.');
    if (m.status === 'Done') throw unprocessable('This milestone is already done.');
    if (m.approval && m.approval.status === 'Pending') throw unprocessable('Already waiting for the client’s approval.');
    await trx('milestones').where({ id: mid }).update({ status: 'In review', approval_status: 'Pending', approval_asked_at: trx.fn.now(), approval_at: null, approval_note: null });
    return { ...(await repo.findMilestone(mid, trx)), message: 'Sent to the client for approval' };
  });
  const clientEmail = await emailMilestoneToClient(out);
  return { ...out, clientEmail, message: out.message + clientMailNote(clientEmail) };
}
