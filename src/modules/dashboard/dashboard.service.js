/**
 * GET /dashboard/sales — KPIs, funnel, 6-month trend, sources, agenda and team table.
 * Scope: leads limited by the `leads` scope, follow-ups by the `fu` scope; a `dash` scope of
 * 'own' additionally pins the owner filter (and the team table) to the user's own sales id.
 */
import { db } from '../../db/knex.js';
import { peopleScope, restrictTo } from '../../core/scope.js';
import { scopeOf } from '../../middleware/authorize.js';
import { iso, ymd, DAY } from '../leads/leads.util.js';
import { toFollowUp } from '../followups/followups.mapper.js';
import { dashboardModel, periodLabel } from './dashboard.model.js';

export async function sales(query, user, now = Date.now()) {
  let owner = query.owner;
  const dashOwn = scopeOf(user, 'dash') === 'own';
  if (dashOwn) owner = user.ownerId || user.pid;

  const [{ people: leadPeople }, { people: fuPeople }] = await Promise.all([peopleScope(user, 'leads'), peopleScope(user, 'fu')]);
  const [leadRows, fuRows, ownerRows, stageNames, sourceList] = await Promise.all([
    restrictTo(db('leads'), 'owner_id', leadPeople).select('id', 'owner_id', 'status', 'value', 'source', 'created_at'),
    restrictTo(db('follow_ups as f').leftJoin('leads as l', 'l.id', 'f.lead_id'), 'f.owner_id', fuPeople)
      .select('f.*', 'l.company as lead_company', 'l.contact as lead_contact'),
    db('sales_owners').where({ active: true }).orderBy('name').select('id', 'name'),
    db('lead_stages').orderBy('position').pluck('name'),
    db('lead_sources').orderBy('position').pluck('name'),
  ]);

  const leads = leadRows.map((r) => ({ id: r.id, owner: r.owner_id, status: r.status, value: Number(r.value) || 0, source: r.source, created: new Date(r.created_at).getTime() }));
  const fus = fuRows.map((r) => ({ row: r, owner: r.owner_id, done: r.done, due: new Date(r.due_at).getTime() }));
  const owners = dashOwn ? ownerRows.filter((o) => o.id === owner) : ownerRows;

  const m = dashboardModel({ leads, fus, owners, stageNames, sourceList, now, period: query.period, from: query.from, to: query.to, owner });

  return {
    period: query.period,
    label: periodLabel(query.period, m.pr),
    range: { from: ymd(m.pr[0]), to: ymd(m.pr[1] - DAY) },
    owner: owner || null,
    kpis: {
      newLeads: m.inP.length,
      newLeadsPrev: m.inPrev.length,
      newLeadsDelta: m.delta,
      openLeads: m.open.length,
      openValue: m.openValue,
      won: m.won.length,
      wonValue: m.wonValue,
      lost: m.lost.length,
      winRate: m.winRate,
      followUpsToday: m.fToday.length,
      followUpsOverdue: m.fOver.length,
    },
    funnel: m.funnel,
    months: m.months.map((x) => ({ month: ymd(x.a).slice(0, 7), start: iso(x.a), total: x.total, won: x.won, h: x.h, wonShare: x.wonShare })),
    sources: m.sources,
    agenda: m.agenda.map((f) => toFollowUp(f.row)),
    team: m.team,
  };
}
