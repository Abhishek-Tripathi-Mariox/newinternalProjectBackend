/** Knex queries for leads, activities, quotes and related rows. */
import { db } from '../../db/knex.js';
import { restrictTo } from '../../core/scope.js';

/** Scoped leads with their last activity time (for insights). `people` null = all owners. */
export function scopedLeads(people, q = db) {
  const query = q('leads as l').select(
    'l.*',
    q('lead_activities as a').max('a.at').whereRaw('a.lead_id = l.id').as('last_act_at'),
  );
  return restrictTo(query, 'l.owner_id', people);
}

/** Follow-ups attached to the given (scoped) leads that matter for insights: open ones + done & due. */
export function insightFollowUps(people, q = db) {
  const query = q('follow_ups as f').join('leads as l', 'l.id', 'f.lead_id')
    .where((w) => w.where('f.done', false).orWhere('f.due_at', '<=', q.fn.now()))
    .select('f.id', 'f.lead_id', 'f.done', 'f.due_at', 'f.type', 'f.title');
  return restrictTo(query, 'l.owner_id', people);
}

export const findLead = (id, q = db) => q('leads').where({ id }).first();
export const lockLead = (id, q) => q('leads').where({ id }).forUpdate().first();

export const stageNames = (q = db) => q('lead_stages').orderBy('position').pluck('name');
export const stageExists = async (name, q = db) => !!(await q('lead_stages').where({ name }).first('name'));
export const sourceNames = (q = db) => q('lead_sources').orderBy('position').pluck('name');
export const sourceExists = async (name, q = db) => !!(await q('lead_sources').where({ name }).first('name'));
export const serviceNames = (q = db) => q('services').orderBy('position').pluck('name');

export const salesOwners = (q = db) => q('sales_owners').orderBy('name').select('id', 'name');
export const ownerById = (id, q = db) => q('sales_owners').where({ id }).first('id', 'name');
export const firstOwner = (q = db) => q('sales_owners').where({ active: true }).orderBy('id').first('id', 'name');

export async function setting(key, fallback, q = db) {
  const r = await q('settings').where({ key }).first('value');
  return r ? r.value : fallback;
}

export const insertLead = (row, q) => q('leads').insert(row).returning('*').then((r) => r[0]);
export const updateLead = (id, patch, q) => q('leads').where({ id }).update(patch).returning('*').then((r) => r[0]);

export const addActivities = (rows, q) => (rows.length ? q('lead_activities').insert(rows) : Promise.resolve());

export const activitiesOf = (leadId, q = db) => q('lead_activities as a')
  .leftJoin('users as u', 'u.id', 'a.actor_user_id')
  .where('a.lead_id', leadId).orderBy([{ column: 'a.at', order: 'asc' }, { column: 'a.id', order: 'asc' }])
  .select('a.*', 'u.name as actor_name');

/** Activities / quotes of many leads in one query each (list ?include=). */
export const activitiesOfMany = (leadIds, q = db) => q('lead_activities as a')
  .leftJoin('users as u', 'u.id', 'a.actor_user_id')
  .whereIn('a.lead_id', leadIds).orderBy([{ column: 'a.at', order: 'asc' }, { column: 'a.id', order: 'asc' }])
  .select('a.*', 'u.name as actor_name');
export const quotesOfMany = (leadIds, q = db) => q('quotes').whereIn('lead_id', leadIds).orderBy('created_at').orderBy('id');

export const quotesOf = (leadId, q = db) => q('quotes').where({ lead_id: leadId }).orderBy('created_at').orderBy('id');
export const findQuote = (leadId, id, q = db) => q('quotes').where({ lead_id: leadId, id }).first();
export const insertQuote = (row, q) => q('quotes').insert(row).returning('*').then((r) => r[0]);
export const updateQuote = (id, patch, q) => q('quotes').where({ id }).update(patch).returning('*').then((r) => r[0]);

export const followUpsOf = (leadId, q = db) => q('follow_ups').where({ lead_id: leadId }).orderBy('due_at');
