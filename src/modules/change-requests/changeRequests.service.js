/**
 * Change requests (port of store/slices/delivery.js saveCr + crAct). Visible via the project scope;
 * every write is PM-only (isPMof). The approval workflow (`applyDecision`) is shared with the
 * public client portal (clientApprove / clientReject).
 */
import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { visibleProjectIds, restrictTo } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import * as prepo from '../projects/projects.repository.js';
import { toDocument } from '../projects/projects.mapper.js';
import { isPMof, canSee } from '../projects/projects.service.js';
import { attachDocuments, removeDocuments } from '../projects/documents.js';
import { crMoney, crRate, money } from '../projects/projects.domain.js';
import { dn, ds, todayN } from '../projects/dates.js';
import { toCr, toTasks } from './changeRequests.mapper.js';
import { printCrHtml } from './print.js';
import { emailCrToClient, clientMailNote } from '../projects/clientEmails.js';
import { documentsService } from '../documents/documents.service.js';

const LOCKED_MSG = 'This change request is approved — only its documents can change.';

/* ───────────── Loading & access ───────────── */

async function loadCr(id, q = db) {
  const r = await q('change_requests').where({ id }).first();
  return r ? toCr(r) : null;
}

/** Read: 404 when missing or outside scope. */
async function visibleCr(user, id) {
  const c = await loadCr(id);
  if (!c || !(await canSee(user, c.projectId))) throw notFound('Change request');
  return c;
}

/** Write: 404 when missing, 403 unless the project's PM (or Super Admin). */
async function pmCr(user, id, trx) {
  const c = await loadCr(id, trx);
  if (!c) throw notFound('Change request');
  await prepo.lockProject(trx, c.projectId); // serialise approvals / edits per project
  const p = await prepo.findProject(c.projectId, trx);
  if (!isPMof(user, p)) throw forbidden("Only the project's PM can change this");
  return { c, p };
}

/** Money picture for a set of CRs (needs CR-milestone logs, project milestones, members). */
async function moneyFor(crs, q = db) {
  if (!crs.length) return [];
  const msIds = crs.map((c) => c.milestoneId).filter(Boolean);
  const [members, milestones, logs] = await Promise.all([
    prepo.findMembers(q),
    prepo.findMilestones(Array.from(new Set(crs.map((c) => c.projectId))), q),
    msIds.length ? q('time_logs').whereIn('milestone_id', msIds).select('member_id', 'milestone_id', 'hours') : [],
  ]);
  const L = logs.map((l) => ({ memberId: l.member_id, milestoneId: l.milestone_id, hours: Number(l.hours) }));
  return crs.map((c) => crMoney(c, { logs: L, milestones, members }));
}

/* ───────────── Reads ───────────── */

export async function list(user, query) {
  const ids = await visibleProjectIds(user);
  const base = () => {
    const qb = restrictTo(db('change_requests'), 'project_id', ids);
    if (query.status) qb.where({ status: query.status });
    if (query.project) qb.where({ project_id: query.project });
    if (query.q) qb.where((w) => w.whereILike('title', `%${query.q}%`).orWhereILike('id', `%${query.q}%`));
    return qb;
  };
  const pg = pageParams(query);
  const [{ n }] = await base().count('* as n');
  const rows = (await base().orderBy([{ column: 'raised_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(pg.limit).offset(pg.offset)).map(toCr);
  const inc = query.include || [];
  const crIds = rows.map((c) => c.id);
  const [m, hist, docs] = await Promise.all([
    moneyFor(rows),
    inc.includes('history') && crIds.length ? db('cr_history').whereIn('cr_id', crIds).orderBy(['at', 'id']).select('cr_id', 'text', 'at') : null,
    inc.includes('documents') ? documentsService.listForMany('cr', crIds) : null,
  ]);
  const histOf = {};
  (hist || []).forEach((h) => (histOf[h.cr_id] ||= []).push({ at: new Date(h.at).toISOString(), text: h.text }));
  return {
    rows: rows.map((c, i) => ({
      ...c,
      money: m[i],
      ...(inc.includes('history') && { history: histOf[c.id] || [] }),
      ...(docs && { documents: docs[c.id] }),
    })),
    meta: pg.meta(Number(n)),
  };
}

async function full(c, q = db) {
  const [history, docs, tasks, [mo]] = await Promise.all([
    q('cr_history').where({ cr_id: c.id }).orderBy(['at', 'id']).select('text', 'at'),
    prepo.findDocuments('cr', c.id, q),
    q('tasks').where({ cr_id: c.id }).orderBy('created_at').select('id', 'title', 'assignee_id', 'status', 'estimate_hours'),
    moneyFor([c], q),
  ]);
  return {
    ...c,
    history: history.map((h) => ({ at: new Date(h.at).toISOString(), text: h.text })),
    documents: docs.map(toDocument),
    boardTasks: tasks.map((t) => ({ id: t.id, title: t.title, assigneeId: t.assignee_id, status: t.status, estimateHours: Number(t.estimate_hours) })),
    money: mo,
  };
}

export async function detail(user, id) {
  return full(await visibleCr(user, id));
}

export async function printHtml(user, id) {
  const c = await full(await visibleCr(user, id));
  const [project, members] = await Promise.all([prepo.findProject(c.projectId), prepo.findMembers()]);
  return printCrHtml(c, { project, members });
}

/* ───────────── saveCr ───────────── */

/** History writer: lines get strictly increasing timestamps so their order is stable. */
function historian(trx, crId) {
  const base = Date.now();
  let k = 0;
  const lines = [];
  return {
    add: (text) => lines.push({ cr_id: crId, text, at: new Date(base + k++) }),
    flush: () => (lines.length ? trx('cr_history').insert(lines.splice(0)) : null),
  };
}

async function validateTarget(trx, projectId, target) {
  if (target && target !== 'new') {
    const m = await trx('milestones').where({ id: target, project_id: projectId }).first('id');
    if (!m) throw unprocessable('Pick a milestone of this project.');
  }
}

async function assertMembers(trx, ids) {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (!uniq.length) return;
  const found = await trx('members').whereIn('id', uniq).pluck('id');
  const missing = uniq.filter((x) => !found.includes(x));
  if (missing.length) throw unprocessable(`Unknown team member: ${missing.join(', ')}`);
}

/** Normalise the editable fields exactly like saveCr. */
function editable(m) {
  if (!m.title.trim()) throw unprocessable('Give the change request a title.');
  if (!(+m.hours > 0)) throw unprocessable('Estimate the hours this change needs.');
  const tks = (m.tasks || []).filter((t) => t.title.trim()).map((t) => ({ title: t.title.trim(), assigneeId: t.assigneeId || '', hours: +t.hours || 0 }));
  const team = Array.from(new Set((m.team || []).concat(tks.map((t) => t.assigneeId).filter(Boolean))));
  return {
    title: m.title.trim(), description: m.description.trim(), requested_by: m.requestedBy, requested_by_name: m.requestedByName.trim(),
    hours: +m.hours, rate: +m.rate || 0, amount: Math.round(+m.hours * (+m.rate || 0)), extra_days: Math.max(0, Math.round(+m.extraDays || 0)),
    priority: m.priority, target: m.target || 'new', team, tasks: JSON.stringify(toTasks(tks)),
  };
}

const estimateLine = (row, cur) => `Estimated ${row.hours}h · ${money(row.amount, cur)}${row.extra_days ? ` · +${row.extra_days} days` : ' · no change to due date'}`;

export async function create(user, b) {
  const id = await db.transaction(async (trx) => {
    const p = await prepo.findProject(b.projectId, trx);
    if (!p || !(await canSee(user, p.id))) throw notFound('Project');
    if (!isPMof(user, p)) throw forbidden("Only the project's PM can change this");
    await prepo.lockProject(trx, p.id);
    const rate = b.rate === undefined ? crRate(await prepo.findMilestones([p.id], trx), p) : b.rate;
    const row = editable({ ...b, rate });
    await validateTarget(trx, p.id, row.target);
    await assertMembers(trx, row.team);
    const { max } = await trx('change_requests').where({ project_id: p.id }).max('n as max').first();
    const n = (max || 0) + 1;
    const crId = `CR-${p.id.slice(3)}-${n}`;
    const now = new Date();
    const send = !!b.send;
    await trx('change_requests').insert({
      id: crId, project_id: p.id, n, ...row, status: send ? 'Sent to client' : 'Draft', raised_at: now, sent_at: send ? now : null,
    });
    const cur = await prepo.currency(trx);
    const h = historian(trx, crId);
    h.add(b.requestedBy === 'Client' ? `Raised by ${b.requestedByName.trim() || p.client}` : `Draft created by ${b.requestedByName.trim() || 'PM'}`);
    h.add(estimateLine(row, cur));
    if (send) h.add('Sent to client for approval');
    await h.flush();
    return crId;
  });
  const dto = await detail(user, id);
  return b.send ? withClientEmail(dto) : dto;
}

/** After a CR is sent to the client: email them (when CLIENT_EMAILS=true) and report it on the DTO. */
async function withClientEmail(dto, message) {
  const clientEmail = await emailCrToClient(dto);
  return { ...dto, clientEmail, ...(message !== undefined ? { message: message + clientMailNote(clientEmail) } : {}) };
}

/**
 * saveCr (edit). Draft and "Sent to client" CRs can be edited; `send` sends a draft, or re-sends an
 * already-sent CR after edits (client emailed again when CLIENT_EMAILS=true). Once approved / rejected
 * the CR is locked — only documents can change.
 */
export async function update(user, id, b) {
  let sentNow = false;
  await db.transaction(async (trx) => {
    const { c } = await pmCr(user, id, trx);
    const locked = !['Draft', 'Sent to client'].includes(c.status);
    const { send, ...fields } = b;
    if (locked) {
      if (Object.keys(fields).length || send) throw unprocessable(LOCKED_MSG);
      return;
    }
    const row = editable({ ...c, ...fields });
    await validateTarget(trx, c.projectId, row.target);
    await assertMembers(trx, row.team);
    const h = historian(trx, id);
    h.add(estimateLine(row, await prepo.currency(trx)));
    if (send && c.status === 'Draft') {
      Object.assign(row, { status: 'Sent to client', sent_at: new Date() });
      h.add('Sent to client for approval');
      sentNow = true;
    } else if (send && c.status === 'Sent to client') {
      row.sent_at = new Date();
      h.add('Updated and re-sent to client');
      sentNow = true;
    }
    await trx('change_requests').where({ id }).update(row);
    await h.flush();
  });
  const dto = await detail(user, id);
  return sentNow ? withClientEmail(dto) : dto;
}

export async function remove(user, id) {
  const removeFiles = await db.transaction(async (trx) => {
    const { c } = await pmCr(user, id, trx);
    if (!['Draft', 'Rejected'].includes(c.status)) throw unprocessable('Only draft or rejected change requests can be deleted.');
    const cleanup = await removeDocuments('cr', id, trx);
    await trx('change_requests').where({ id }).del();
    return cleanup;
  });
  await removeFiles();
}

export async function addDocuments(user, id, files, kind) {
  return db.transaction(async (trx) => {
    await pmCr(user, id, trx);
    return attachDocuments('cr', id, files, user, trx, kind);
  });
}

/* ───────────── crAct ───────────── */

const ALLOWED_FROM = {
  send: ['Draft'],
  approve: ['Draft', 'Sent to client'],
  reject: ['Draft', 'Sent to client'],
  start: ['Approved'],
  done: ['Approved', 'In progress'],
};

/**
 * Apply an action to a CR inside `trx` (shared by the PM endpoint and the client portal).
 * act: send | approve | reject | start | done; via: 'pm' | 'portal'. Returns the flash message.
 */
export async function applyDecision(trx, c, p, act, { note, signer, via = 'pm' } = {}) {
  const nt = (note || '').trim();
  const now = new Date();
  const h = historian(trx, c.id);
  const row = {};
  let msg = '';
  if (!ALLOWED_FROM[act].includes(c.status)) throw unprocessable(`Can't ${act} a change request that is ${c.status}.`);

  if (act === 'send') {
    Object.assign(row, { status: 'Sent to client', sent_at: now });
    h.add('Sent to client for approval');
    msg = `${c.id} sent to client`;
  } else if (act === 'approve') {
    const pmName = (await trx('members').where({ id: p.pmId }).first('name'))?.name || 'PM';
    const sig = {
      name: signer.name.trim(), title: (signer.title || '').trim() || null, at: now, note: nt,
      via: via === 'portal' ? 'Typed signature in client portal' : `Recorded by ${pmName} (client approved by email / call)`,
    };
    Object.assign(row, { status: 'Approved', decided_at: now, sig_name: sig.name, sig_title: sig.title, sig_at: now, sig_via: sig.via, sig_note: nt || null });
    if (nt) h.add(`Client comment · ${nt}`);

    // Milestone: a new CR milestone, or extra hours on the target milestone.
    const ms = await trx('milestones').where({ project_id: p.id }).select('id', 'n', 'due_date');
    const T = todayN();
    let msId;
    let msDue;
    if (!c.target || c.target === 'new' || !ms.some((m) => m.id === c.target)) {
      msId = `${p.id}-${c.id}`;
      msDue = ds(Math.max(dn(p.dueDate), T) + (c.extraDays || 0));
      await trx('milestones').insert({
        id: msId, project_id: p.id, n: ms.reduce((x, m) => Math.max(x, m.n), 0) + 1, name: `CR: ${c.title}`, alloc_hours: c.hours, due_date: msDue, status: 'Not started', cr_id: c.id,
      });
    } else {
      msId = c.target;
      await trx('milestones').where({ id: msId }).increment('alloc_hours', c.hours);
      msDue = ms.find((m) => m.id === msId).due_date || p.dueDate;
    }
    row.milestone_id = msId;
    // The approved CR's hours are added to the project's hours budget.
    await trx('projects').where({ id: p.id }).whereNotNull('budget_hours').increment('budget_hours', c.hours);

    // Project: value, due date, team and allocations.
    const tk = (c.tasks || []).filter((t) => t.title);
    const addA = {};
    tk.forEach((t) => { if (t.assigneeId) addA[t.assigneeId] = (addA[t.assigneeId] || 0) + (+t.hours || 0); });
    const newTeam = Array.from(new Set((c.team || []).concat(Object.keys(addA))));
    const onTeam = new Set(p.team.map((t) => t.memberId));
    const joiners = newTeam.filter((mid) => !onTeam.has(mid));
    if (joiners.length) {
      const { max } = await trx('project_members').where({ project_id: p.id }).max('position as max').first();
      const pos = (max ?? -1) + 1;
      await trx('project_members').insert(joiners.map((mid, i) => ({ project_id: p.id, member_id: mid, alloc_hours: 0, position: pos + i })));
    }
    for (const [mid, hrs] of Object.entries(addA)) {
      await trx('project_members').where({ project_id: p.id, member_id: mid }).increment('alloc_hours', hrs);
    }
    await trx('projects').where({ id: p.id }).update({
      value: trx.raw('value + ?', [c.amount || 0]),
      due_date: ds(dn(p.dueDate) + (c.extraDays || 0)),
    });

    // Board tasks from the work breakdown.
    for (const t of tk) {
      await trx('tasks').insert({
        id: await nextId(trx, 'task'), project_id: p.id, milestone_id: msId, title: t.title, description: `From ${c.id} · ${c.title}`,
        assignee_id: t.assigneeId || null, status: 'To do', priority: c.priority || 'Medium', due_date: msDue, estimate_hours: +t.hours || 0,
        checklist: JSON.stringify([]), cr_id: c.id, log: JSON.stringify([{ d: now.toISOString(), t: `Created from ${c.id}` }]),
      });
    }
    const cur = await prepo.currency(trx);
    h.add(`Approved by ${sig.name} · ${sig.via}`);
    h.add(`+${c.hours}h added to the budget · +${money(c.amount || 0, cur)} contract value${c.extraDays ? ` · due date moved by ${c.extraDays} days` : ''}${tk.length ? ` · ${tk.length} task${tk.length > 1 ? 's' : ''} created on the board` : ''}`);
    msg = `${c.id} approved · ${tk.length ? `${tk.length} tasks created, ` : ''}hours, value and timeline updated`;
  } else if (act === 'reject') {
    Object.assign(row, { status: 'Rejected', decided_at: now, note: nt });
    h.add((via === 'portal' ? 'Rejected by client in portal' : 'Marked rejected') + (nt ? ` · ${nt}` : ''));
    msg = `${c.id} rejected`;
  } else if (act === 'start') {
    row.status = 'In progress';
    h.add('Work started');
    if (c.milestoneId) await trx('milestones').where({ id: c.milestoneId }).whereNotNull('cr_id').update({ status: 'In progress' });
    msg = `Work started on ${c.id}`;
  } else if (act === 'done') {
    Object.assign(row, { status: 'Done', done_at: now });
    h.add('Marked done');
    if (c.milestoneId) await trx('milestones').where({ id: c.milestoneId }).whereNotNull('cr_id').update({ status: 'Done' });
    msg = `${c.id} marked done`;
  }
  await trx('change_requests').where({ id: c.id }).update(row);
  await h.flush();
  return msg;
}

/** POST :id/actions (PM). Approval recorded by the PM needs the client signer's name. */
export async function act(user, id, { act: action, note, signer }) {
  if (action === 'approve' && (!signer || (signer.name || '').trim().length < 3)) {
    throw unprocessable('Enter the name of the client person who approved (needed for the approval record).');
  }
  const message = await db.transaction(async (trx) => {
    const { c, p } = await pmCr(user, id, trx);
    return applyDecision(trx, c, p, action, { note, signer, via: 'pm' });
  });
  const dto = await detail(user, id);
  return action === 'send' ? withClientEmail(dto, message) : { ...dto, message };
}
