/**
 * Lead scoring, freshness and duplicate detection — port of frontend/src/domain/leads.js (leadInsights).
 * Pure functions over plain objects:
 *   lead: { id, status, value, source, email, phone, company, createdMs, lastActMs }
 *   fu:   { id, leadId, done, dueMs, type, title }
 */
import { DAY } from './leads.util.js';

const STAGE_SCORE = { New: 5, Contacted: 15, Qualified: 25, 'Proposal Sent': 30, Negotiation: 35, Won: 40, Lost: 0 };
const SOURCE_SCORE = { Referral: 10, Website: 7, Clutch: 7, LinkedIn: 6, 'Google Ads': 5, Upwork: 4 };

/** Stage weight; custom stages are interpolated by pipeline position between known neighbours. */
export function stageScore(status, names) {
  if (status in STAGE_SCORE) return STAGE_SCORE[status];
  const order = names.filter((k) => k !== 'Lost');
  const i = order.indexOf(status);
  if (i < 0) return 0;
  let a = i - 1;
  while (a >= 0 && !(order[a] in STAGE_SCORE)) a--;
  let b = i + 1;
  while (b < order.length && !(order[b] in STAGE_SCORE)) b++;
  const lo = a >= 0 ? STAGE_SCORE[order[a]] : 0;
  const hi = b < order.length ? STAGE_SCORE[order[b]] : STAGE_SCORE.Won;
  const from = a >= 0 ? a : -1;
  const to = b < order.length ? b : order.length;
  return Math.round(lo + ((hi - lo) * (i - from)) / (to - from));
}

export const normPhone = (p) => {
  const x = (p || '').replace(/\D/g, '').slice(-10);
  return x.length >= 8 ? x : '';
};
export const normCompany = (c) => (c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const normEmail = (e) => (e || '').trim().toLowerCase();
export const isOpenLead = (l) => l.status !== 'Won' && l.status !== 'Lost';

export function leadInsights({ leads, fus, staleDays = 7, now = Date.now(), stageNames }) {
  const nextOf = {};
  fus.forEach((f) => {
    if (!f.done && f.leadId && (!nextOf[f.leadId] || f.dueMs < nextOf[f.leadId].dueMs)) nextOf[f.leadId] = f;
  });

  const touch = {};
  leads.forEach((l) => { touch[l.id] = Math.max(l.createdMs, l.lastActMs || 0); });
  fus.forEach((f) => {
    if (f.done && f.dueMs <= now && touch[f.leadId] !== undefined && f.dueMs > touch[f.leadId]) touch[f.leadId] = f.dueMs;
  });

  const daysSince = (id) => Math.max(0, Math.floor((now - touch[id]) / DAY));
  const staleN = staleDays || 7;

  const scoreOf = {};
  leads.forEach((l) => {
    const dd = daysSince(l.id);
    scoreOf[l.id] = l.status === 'Lost' ? 0 : Math.min(100, Math.round(
      Math.min(30, ((l.value || 0) / 15e5) * 30) + stageScore(l.status, stageNames)
      + (dd <= 2 ? 20 : dd <= 7 ? 12 : dd <= 14 ? 5 : 0) + (SOURCE_SCORE[l.source] || 3) + (nextOf[l.id] ? 5 : 0),
    ));
  });

  const isHot = (l) => isOpenLead(l) && scoreOf[l.id] >= 65;
  const isStale = (l) => isOpenLead(l) && daysSince(l.id) >= staleN;

  const dupOf = {};
  const grp = (f, why) => {
    const g = {};
    leads.forEach((l) => {
      const k = f(l);
      if (k) (g[k] = g[k] || []).push(l);
    });
    Object.values(g).forEach((a) => {
      if (a.length > 1) a.forEach((l) => a.forEach((o) => {
        if (o !== l) {
          const x = (dupOf[l.id] = dupOf[l.id] || {});
          x[o.id] = x[o.id] ? `${x[o.id]} & ${why}` : why;
        }
      }));
    });
  };
  grp((l) => normEmail(l.email), 'email');
  grp((l) => normPhone(l.phone), 'phone');
  grp((l) => normCompany(l.company), 'company name');

  return { touch, scoreOf, nextOf, dupOf, daysSince, isHot, isStale };
}

/** Up to 3 existing leads that look like the lead being entered (lead modal warning). */
export function findDuplicateLeads(form, leads, excludeId) {
  return leads.filter((l) => l.id !== excludeId && (
    (normEmail(form.email) && normEmail(l.email) === normEmail(form.email))
    || (normPhone(form.phone) && normPhone(l.phone) === normPhone(form.phone))
    || (normCompany(form.company).length > 2 && normCompany(l.company) === normCompany(form.company))
  )).slice(0, 3);
}
