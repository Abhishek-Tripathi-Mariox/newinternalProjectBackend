/**
 * Public client portal (no auth): a project is reachable only by the token of a portal that is ON.
 * Ports ClientPortalPreview (what the client sees), clientDecide (milestones) and crAct
 * clientApprove / clientReject (change requests). Client decisions land in activity_feed (kind 'appr').
 */
import { db } from '../../db/knex.js';
import { notFound, unprocessable } from '../../core/errors.js';
import * as repo from './projects.repository.js';
import { buildModel, REVIEW_LINKS } from './projects.domain.js';
import { toCr } from '../change-requests/changeRequests.mapper.js';
import { applyDecision } from '../change-requests/changeRequests.service.js';

async function projectByToken(token, q = db) {
  const row = await repo.findProjectByToken(token, q);
  if (!row) throw notFound('Portal');
  return repo.findProject(row.id, q);
}

export async function view(token) {
  const p = await projectByToken(token);
  const [ms, logs, members, counts, crRows] = await Promise.all([
    repo.findMilestones([p.id]), repo.findLogs([p.id]), repo.findMembers(), repo.healthCounts([p.id]),
    db('change_requests').where({ project_id: p.id }).whereNot({ status: 'Draft' }).orderBy('raised_at', 'desc'),
  ]);
  const M = buildModel({ projects: [p], milestones: ms, logs, members, ...counts });
  const I = M.info(p);
  const done = I.ms.filter((m) => m.status === 'Done').length;
  const pm = members.find((m) => m.id === p.pmId);
  const crs = crRows.map(toCr);
  return {
    project: { id: p.id, name: p.name, client: p.client, pmName: pm ? pm.name : '—', startDate: p.startDate, dueDate: p.dueDate },
    progress: { pct: I.ms.length ? Math.round((done / I.ms.length) * 100) : 0, done, total: I.ms.length },
    schedule: I.health.label === 'Late' ? 'Behind schedule' : 'On schedule',
    links: p.links.filter((l) => REVIEW_LINKS.includes(l.type)).map(({ type, url }) => ({ type, url })),
    milestones: I.ms.map((m) => ({
      id: m.id, n: m.n, name: m.name, dueDate: m.dueDate, status: m.status,
      state: m.status === 'Done' ? 'Complete' : I.curM && I.curM.id === m.id ? 'In progress' : 'Upcoming',
      approval: m.approval ? { status: m.approval.status, at: m.approval.at, note: m.approval.note } : null,
    })),
    changeRequests: crs.map((c) => ({
      id: c.id, title: c.title, description: c.description, status: c.status,
      statusLabel: c.status === 'Sent to client' ? 'Waiting for your approval' : c.status,
      amount: c.amount, hours: c.hours, extraDays: c.extraDays,
      signature: c.signature ? { name: c.signature.name, at: c.signature.at } : null,
      awaitingDecision: c.status === 'Sent to client',
    })),
  };
}

const feed = (trx, text) => trx('activity_feed').insert({ person_id: null, kind: 'appr', text });

/** clientDecide: approve → Done; request changes (note required) → In progress. */
export async function decideMilestone(token, mid, { approve, note }) {
  const n = (note || '').trim();
  if (!approve && !n) throw unprocessable('Add a note so the team knows what to change');
  return db.transaction(async (trx) => {
    const p = await projectByToken(token, trx);
    const m = await trx('milestones').where({ id: mid, project_id: p.id }).forUpdate().first();
    if (!m) throw notFound('Milestone');
    if (m.approval_status !== 'Pending') throw unprocessable('This milestone is not waiting for your approval.');
    const st = approve ? 'Approved' : 'Changes requested';
    await trx('milestones').where({ id: mid }).update({ status: approve ? 'Done' : 'In progress', approval_status: st, approval_at: trx.fn.now(), approval_note: n });
    await feed(trx, `${p.client || 'Client'} · ${st.toLowerCase()} · ${m.name}`);
    return { id: mid, status: approve ? 'Done' : 'In progress', approval: st, message: approve ? 'Milestone approved' : 'Change request sent to the team' };
  });
}

/** clientApprove (typed name ≥ 3 + agree) / clientReject (note required). */
export async function decideCr(token, crId, { approve, name, agree, note }) {
  const nt = (note || '').trim();
  if (approve) {
    if ((name || '').trim().length < 3) throw unprocessable('Type your full name to sign the approval');
    if (!agree) throw unprocessable('Tick the box to confirm you approve the cost and timeline');
  } else if (!nt) throw unprocessable('Add a note so the team knows why');
  return db.transaction(async (trx) => {
    const ref = await repo.findProjectByToken(token, trx);
    if (!ref) throw notFound('Portal');
    await repo.lockProject(trx, ref.id);
    const p = await repo.findProject(ref.id, trx);
    const row = await trx('change_requests').where({ id: crId, project_id: p.id }).first();
    if (!row || row.status === 'Draft') throw notFound('Change request');
    const c = toCr(row);
    if (c.status !== 'Sent to client') throw unprocessable('This change request is not waiting for your approval.');
    const message = await applyDecision(trx, c, p, approve ? 'approve' : 'reject', { note: nt, signer: { name }, via: 'portal' });
    await feed(trx, `${p.client || 'Client'} · ${approve ? 'approved' : 'rejected'} · ${c.id} ${c.title}`);
    const out = toCr(await trx('change_requests').where({ id: crId }).first());
    return { id: out.id, status: out.status, signature: out.signature ? { name: out.signature.name, at: out.signature.at } : null, message };
  });
}
