/**
 * Leads business rules — port of frontend store/slices/sales.js (setLead, logAct, bulk, saveLead,
 * mergeLead) plus list filters / CSV export from features/leads.
 * Every service function takes `ctx = { user, actor }` (user = whose permissions apply, actor = who
 * is signed in; they differ only in "Preview as").
 */
import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { peopleScope } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import * as repo from './leads.repository.js';
import { toActivity, toInsightFu, toInsightLead, toLead, toQuote } from './leads.mapper.js';
import { findDuplicateLeads, leadInsights } from './leads.insights.js';
import { DAY, iso, parseDay, toCsv, ymd } from './leads.util.js';
import { documentsService } from '../documents/documents.service.js';
import { toFollowUp } from '../followups/followups.mapper.js';

/* ───────────── scope helpers ───────────── */

/** Owner ids the user may see for leads (null = all). */
export async function leadPeople(user) {
  return (await peopleScope(user, 'leads')).people;
}
const inScope = (people, lead) => !people || people.includes(lead.owner_id);

/** Lead visible to the user, else 404. */
async function readable(id, user, q = db) {
  const lead = await repo.findLead(id, q);
  const people = await leadPeople(user);
  if (!lead || !inScope(people, lead)) throw notFound('Lead');
  return lead;
}

/** Lead locked for update in `trx`; 404 if missing, 403 if outside the user's scope. */
async function writable(trx, id, user, people) {
  const lead = await repo.lockLead(id, trx);
  if (!lead) throw notFound('Lead');
  if (!inScope(people === undefined ? await leadPeople(user) : people, lead)) throw forbidden();
  return lead;
}

const actorId = (ctx) => (ctx.actor || ctx.user).id;
const act = (ctx, leadId, kind, text, at = new Date()) => ({ lead_id: leadId, kind, text, actor_user_id: actorId(ctx), at });

async function ownerNameMap(q = db) {
  const rows = await repo.salesOwners(q);
  return Object.fromEntries(rows.map((o) => [o.id, o.name]));
}
const ownerName = (map, id) => map[id] || 'Unassigned';

/* ───────────── insights ───────────── */

/** All scoped leads with computed insights. */
async function scopedWithInsights(user, staleDays = 7, now = Date.now()) {
  const people = await leadPeople(user);
  const [rows, fuRows, stageNames, owners] = await Promise.all([
    repo.scopedLeads(people), repo.insightFollowUps(people), repo.stageNames(), ownerNameMap(),
  ]);
  const ins = leadInsights({ leads: rows.map(toInsightLead), fus: fuRows.map(toInsightFu), staleDays, now, stageNames });
  return { people, rows, ins, stageNames, owners, now };
}

/** Lead DTO + computed fields (score, hot, stale, lastContactAt, nextFollowUp, duplicateOf). */
function decorate(row, { ins, owners, now }) {
  const l = { id: row.id, status: row.status };
  const nf = ins.nextOf[row.id];
  return {
    ...toLead(row),
    ownerName: ownerName(owners, row.owner_id),
    score: ins.scoreOf[row.id],
    hot: ins.isHot(l),
    stale: ins.isStale(l),
    daysSinceContact: ins.daysSince(row.id),
    lastContactAt: iso(ins.touch[row.id]),
    nextFollowUp: nf ? { id: nf.id, type: nf.type, title: nf.title, dueAt: iso(nf.dueMs), overdue: nf.dueMs < now } : null,
    duplicateOf: ins.dupOf[row.id] || null,
  };
}

/* ───────────── list / export ───────────── */

function applyFilters(rows, f, ins) {
  const from = parseDay(f.from);
  const to = f.to ? parseDay(f.to) + DAY : null;
  const q = (f.q || '').toLowerCase();
  return rows.filter((l) => {
    const created = new Date(l.created_at).getTime();
    const s = { id: l.id, status: l.status };
    return (from == null || created >= from) && (to == null || created < to)
      && (!f.status || l.status === f.status)
      && (!f.owner || l.owner_id === f.owner)
      && (!f.source || l.source === f.source)
      && (!f.service || (l.services || []).includes(f.service))
      && (!q || `${l.company} ${l.contact} ${l.email} ${l.id}`.toLowerCase().includes(q))
      && (!f.flag || (f.flag === 'hot' ? ins.isHot(s) : f.flag === 'stale' ? ins.isStale(s) : !!ins.dupOf[l.id]));
  });
}

function sortRows(rows, sort, { ins, owners, stageNames }) {
  const desc = !sort || sort.startsWith('-');
  const k = sort ? sort.replace(/^-/, '') : 'created';
  const keyOf = {
    score: (l) => ins.scoreOf[l.id],
    created: (l) => new Date(l.created_at).getTime(),
    updated: (l) => new Date(l.updated_at).getTime(),
    value: (l) => Number(l.value),
    company: (l) => l.company.toLowerCase(),
    contact: (l) => l.contact.toLowerCase(),
    status: (l) => stageNames.indexOf(l.status),
    owner: (l) => ownerName(owners, l.owner_id).toLowerCase(),
    next: (l) => (ins.nextOf[l.id] ? ins.nextOf[l.id].dueMs : Infinity),
    lastContact: (l) => ins.touch[l.id],
    id: (l) => Number(l.id.slice(3)),
  }[k] || ((l) => new Date(l.created_at).getTime());
  const d = desc ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    if (x > y) return d;
    if (x < y) return -d;
    return b.id.localeCompare(a.id, 'en', { numeric: true });
  });
}

const groupBy = (rows, key, ids, map) => {
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const r of rows) (out[r[key]] ||= []).push(map(r));
  return out;
};

/** ?include=activities,quotes,documents → embed those arrays (one query per kind for the whole page). */
async function embed(items, include = []) {
  if (!include.length || !items.length) return items;
  const ids = items.map((l) => l.id);
  const [acts, quotes, docs] = await Promise.all([
    include.includes('activities') ? repo.activitiesOfMany(ids).then((r) => groupBy(r, 'lead_id', ids, toActivity)) : null,
    include.includes('quotes') ? repo.quotesOfMany(ids).then((r) => groupBy(r, 'lead_id', ids, toQuote)) : null,
    include.includes('documents') ? documentsService.listForMany('lead', ids) : null,
  ]);
  return items.map((l) => ({
    ...l,
    ...(acts && { activities: acts[l.id] }),
    ...(quotes && { quotes: quotes[l.id] }),
    ...(docs && { documents: docs[l.id] }),
  }));
}

export async function list(query, ctx) {
  const S = await scopedWithInsights(ctx.user, query.staleDays);
  const shown = sortRows(applyFilters(S.rows, query, S.ins), query.sort, S);
  const p = pageParams(query);
  const items = shown.slice(p.offset, p.offset + p.limit).map((r) => decorate(r, S));
  return { items: await embed(items, query.include), meta: p.meta(shown.length) };
}

/** CSV with the same columns as the frontend exportLeadsCsv (filters + scope applied, no paging). */
export async function exportCsv(query, ctx) {
  const S = await scopedWithInsights(ctx.user, query.staleDays);
  let shown = sortRows(applyFilters(S.rows, query, S.ins), query.sort, S);
  if (query.ids) { const want = new Set(query.ids); shown = shown.filter((l) => want.has(l.id)); }
  const cols = ['ID', 'Company', 'Contact', 'Email', 'Phone', 'Service', 'Source', 'Owner', 'Stage', 'Value (INR)', 'Score', 'Created', 'Last contact'];
  const rows = shown.map((l) => [
    l.id, l.company, l.contact, l.email, l.phone, (l.services || []).join(', '), l.source, ownerName(S.owners, l.owner_id), l.status, Number(l.value),
    S.ins.scoreOf[l.id], ymd(l.created_at), ymd(S.ins.touch[l.id] ?? l.created_at),
  ]);
  return { csv: toCsv([cols, ...rows]), filename: `mariox-leads-${ymd(Date.now())}.csv`, count: shown.length };
}

/* ───────────── detail ───────────── */

export async function get(id, ctx) {
  await readable(id, ctx.user);
  const S = await scopedWithInsights(ctx.user);
  const row = S.rows.find((r) => r.id === id);
  const [acts, quotes, docs, fus] = await Promise.all([
    repo.activitiesOf(id), repo.quotesOf(id), documentsService.listFor('lead', id), repo.followUpsOf(id),
  ]);
  return {
    ...decorate(row, S),
    activities: acts.map(toActivity),
    quotes: quotes.map(toQuote),
    documents: docs,
    followUps: fus.map((f) => toFollowUp(f, row)),
  };
}

/* ───────────── create / update ───────────── */

function checkLeadForm(m) {
  if (!m.company.trim() || !m.contact.trim()) throw unprocessable('Company and contact person are required.');
  if (!m.services.length) throw unprocessable('Pick at least one service.');
}

async function checkOwner(id, q) {
  if (!(await repo.ownerById(id, q))) throw unprocessable('Pick a valid owner.');
}
async function checkSource(name, q) {
  if (name && !(await repo.sourceExists(name, q))) throw unprocessable('Pick a valid source.');
}
async function checkStage(name, q) {
  if (!(await repo.stageExists(name, q))) throw unprocessable('Pick a valid stage.');
}

export async function create(body, ctx) {
  const { user } = ctx;
  checkLeadForm(body);
  return db.transaction(async (trx) => {
    const { scope } = await peopleScope(user, 'leads');
    let owner = body.ownerId || user.ownerId;
    // A Sales Executive (own scope) always creates leads for themselves.
    if (scope === 'own') {
      if (!user.ownerId) throw forbidden('Your account has no sales profile');
      owner = user.ownerId;
    }
    if (!owner) owner = (await repo.firstOwner(trx))?.id;
    await checkOwner(owner, trx);
    const source = body.source || (await repo.sourceNames(trx))[0] || null;
    await checkSource(source, trx);
    const row = await repo.insertLead({
      id: await nextId(trx, 'lead'),
      company: body.company.trim(),
      contact: body.contact.trim(),
      email: body.email.trim(),
      phone: body.phone.trim(),
      services: body.services,
      source,
      owner_id: owner,
      first_owner_id: owner,
      status: 'New',
      value: +body.value || 0,
      notes: body.notes,
    }, trx);
    return row.id;
  }).then((id) => get(id, ctx));
}

/** Apply a stage change; records "Stage: A → B". */
async function setStatusTx(trx, lead, to, ctx) {
  if (lead.status === to) return lead;
  await checkStage(to, trx);
  const row = await repo.updateLead(lead.id, { status: to }, trx);
  await repo.addActivities([act(ctx, lead.id, 'status', `Stage: ${lead.status} → ${to}`)], trx);
  return row;
}

/** Apply an owner transfer; keeps first_owner and records "Transferred A → B". */
async function setOwnerTx(trx, lead, to, ctx, owners) {
  if (lead.owner_id === to) return lead;
  if (!owners[to]) throw unprocessable('Pick a valid owner.');
  const row = await repo.updateLead(lead.id, { owner_id: to, first_owner_id: lead.first_owner_id || lead.owner_id }, trx);
  await repo.addActivities([act(ctx, lead.id, 'owner', `Transferred ${ownerName(owners, lead.owner_id)} → ${ownerName(owners, to)}`)], trx);
  return row;
}

export async function update(id, body, ctx) {
  await db.transaction(async (trx) => {
    let lead = await writable(trx, id, ctx.user);
    const m = {
      company: body.company ?? lead.company, contact: body.contact ?? lead.contact, services: body.services ?? lead.services,
    };
    checkLeadForm(m);
    if (body.source !== undefined) await checkSource(body.source, trx);
    const patch = {};
    if (body.company !== undefined) patch.company = body.company.trim();
    if (body.contact !== undefined) patch.contact = body.contact.trim();
    if (body.email !== undefined) patch.email = body.email.trim();
    if (body.phone !== undefined) patch.phone = body.phone.trim();
    if (body.services !== undefined) patch.services = body.services;
    if (body.source !== undefined) patch.source = body.source;
    if (body.value !== undefined) patch.value = +body.value || 0;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (Object.keys(patch).length) lead = await repo.updateLead(id, patch, trx);
    if (body.status !== undefined) lead = await setStatusTx(trx, lead, body.status, ctx);
    if (body.ownerId !== undefined) await setOwnerTx(trx, lead, body.ownerId, ctx, await ownerNameMap(trx));
  });
  return get(id, ctx);
}

export async function setStatus(id, status, ctx) {
  await db.transaction(async (trx) => setStatusTx(trx, await writable(trx, id, ctx.user), status, ctx));
  return get(id, ctx);
}

export async function setOwner(id, ownerId, ctx) {
  await db.transaction(async (trx) => setOwnerTx(trx, await writable(trx, id, ctx.user), ownerId, ctx, await ownerNameMap(trx)));
  // A transfer can move the lead out of the user's own scope — return the plain lead then.
  try {
    return await get(id, ctx);
  } catch {
    return toLead(await repo.findLead(id));
  }
}

export async function addActivity(id, { kind, text }, ctx) {
  await db.transaction(async (trx) => {
    await writable(trx, id, ctx.user);
    await repo.addActivities([act(ctx, id, kind, text)], trx);
  });
  return (await repo.activitiesOf(id)).map(toActivity);
}

/** Apply owner or status to many leads (frontend bulk). */
export async function bulk({ ids, owner, status }, ctx) {
  const unique = Array.from(new Set(ids));
  await db.transaction(async (trx) => {
    const people = await leadPeople(ctx.user);
    const owners = await ownerNameMap(trx);
    if (owner && !owners[owner]) throw unprocessable('Pick a valid owner.');
    if (status) await checkStage(status, trx);
    for (const id of unique) {
      const lead = await writable(trx, id, ctx.user, people);
      if (owner) await setOwnerTx(trx, lead, owner, ctx, owners);
      else await setStatusTx(trx, lead, status, ctx);
    }
  });
  const owners = owner ? await ownerNameMap() : {};
  return {
    ids: unique,
    count: unique.length,
    message: `${unique.length} leads ${owner ? `assigned to ${ownerName(owners, owner)}` : `moved to ${status}`}`,
  };
}

/** Merge dropId into keepId: contact info, notes, documents, quotes, activity, follow-ups (frontend mergeLead). */
export async function merge({ keepId, dropId }, ctx) {
  await db.transaction(async (trx) => {
    const people = await leadPeople(ctx.user);
    const k = await writable(trx, keepId, ctx.user, people);
    const d = await writable(trx, dropId, ctx.user, people);
    await repo.updateLead(keepId, {
      email: k.email || d.email,
      phone: k.phone || d.phone,
      notes: [k.notes, d.notes].filter(Boolean).join('\n\n'),
    }, trx);
    await trx('follow_ups').where({ lead_id: dropId }).update({ lead_id: keepId });
    await trx('quotes').where({ lead_id: dropId }).update({ lead_id: keepId });
    await trx('lead_activities').where({ lead_id: dropId }).update({ lead_id: keepId });
    await trx('activity_feed').where({ lead_id: dropId }).update({ lead_id: keepId });
    await documentsService.reassign('lead', dropId, keepId, trx);
    await repo.addActivities([act(ctx, keepId, 'note', `Merged ${d.id} (${d.company}) into this lead`)], trx);
    await trx('leads').where({ id: dropId }).del();
  });
  return get(keepId, ctx);
}

/** Up to 3 visible leads that look like the given details (lead modal warning). */
export async function duplicates(query, ctx) {
  const people = await leadPeople(ctx.user);
  const rows = await repo.scopedLeads(people);
  return findDuplicateLeads(query, rows, query.excludeId).map(toLead);
}

export async function remove(id, ctx) {
  let unlinkFiles;
  await db.transaction(async (trx) => {
    await writable(trx, id, ctx.user);
    unlinkFiles = await documentsService.removeForEntity('lead', id, trx);
    await trx('leads').where({ id }).del();
  });
  await unlinkFiles();
}

/* ───────────── documents ───────────── */

export async function uploadDocuments(id, files, ctx) {
  try {
    if (!files || !files.length) throw unprocessable('Choose at least one file.');
    return await db.transaction(async (trx) => {
      await writable(trx, id, ctx.user);
      return documentsService.attach('lead', id, files, ctx.actor || ctx.user, trx);
    });
  } catch (e) {
    await documentsService.discard(files);
    throw e;
  }
}

export const _internal = { readable, writable, act, ownerNameMap, ownerName, setStatusTx };
