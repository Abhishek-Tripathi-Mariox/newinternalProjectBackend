/** DB rows ↔ API DTOs for leads, activities and quotes. */
import { iso, ms } from './leads.util.js';
import { qTotals } from './quotes.domain.js';

export const toLead = (r) => ({
  id: r.id,
  company: r.company,
  contact: r.contact,
  email: r.email,
  phone: r.phone,
  services: r.services || [],
  source: r.source,
  ownerId: r.owner_id,
  firstOwnerId: r.first_owner_id,
  status: r.status,
  value: Number(r.value) || 0,
  notes: r.notes,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** Plain object for leadInsights(). */
export const toInsightLead = (r) => ({
  id: r.id, status: r.status, value: Number(r.value) || 0, source: r.source, email: r.email, phone: r.phone, company: r.company,
  createdMs: ms(r.created_at), lastActMs: ms(r.last_act_at),
});

export const toInsightFu = (r) => ({ id: r.id, leadId: r.lead_id, done: r.done, dueMs: ms(r.due_at), type: r.type, title: r.title });

export const toActivity = (r) => ({ id: Number(r.id), kind: r.kind, text: r.text, actorUserId: r.actor_user_id, actorName: r.actor_name || null, at: iso(r.at) });

/** Quote row → internal model used by qTotals/printQuote. */
export const quoteModel = (r) => ({
  id: r.id, items: r.items || [], disc: Number(r.discount_pct) || 0, gst: r.gst, valid: r.valid_days, terms: r.terms, createdMs: ms(r.created_at),
});

export function toQuote(r) {
  const t = qTotals(quoteModel(r));
  return {
    id: r.id,
    leadId: r.lead_id,
    status: r.status,
    items: r.items || [],
    discountPct: Number(r.discount_pct) || 0,
    gst: r.gst,
    validDays: r.valid_days,
    terms: r.terms,
    sub: t.sub,
    discount: t.disc,
    tax: t.tax,
    net: Number(r.net),
    total: Number(r.total),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    validUntil: iso(ms(r.created_at) + r.valid_days * 864e5),
    sentAt: iso(r.sent_at),
    viewedAt: iso(r.viewed_at),
    acceptedAt: iso(r.accepted_at),
    declinedAt: iso(r.declined_at),
  };
}
