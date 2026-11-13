/** DB rows → API DTOs (camelCase, days 'YYYY-MM-DD', timestamps ISO). */
const iso = (t) => (t ? new Date(t).toISOString() : null);
const num = (v) => (v == null ? 0 : Number(v));

export function toProject(r, team = [], links = []) {
  return {
    id: r.id,
    name: r.name,
    client: r.client,
    clientEmail: r.client_email || '',
    services: r.services || [],
    status: r.status,
    pmId: r.pm_member_id,
    startDate: r.start_date,
    dueDate: r.due_date,
    value: num(r.value),
    hue: r.hue,
    priority: r.priority,
    brief: r.brief,
    budgetLimit: r.budget_hours == null ? null : num(r.budget_hours), // hours budget; null = not set (no limit)
    portal: { on: !!r.portal_on, token: r.portal_token || null },
    team: team.map((t) => ({ memberId: t.member_id, allocHours: num(t.alloc_hours), primary: !!t.is_primary })),
    links: links.map((l) => ({ id: Number(l.id), type: l.type, url: l.url })),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toMilestone(r, team = []) {
  return {
    id: r.id,
    projectId: r.project_id,
    n: r.n,
    name: r.name,
    allocHours: num(r.alloc_hours),
    dueDate: r.due_date,
    status: r.status,
    crId: r.cr_id || null,
    team, // member ids working on this milestone
    notes: r.notes || '',
    approval: r.approval_status
      ? { status: r.approval_status, askedAt: iso(r.approval_asked_at), at: iso(r.approval_at), note: r.approval_note || '' }
      : null,
  };
}

export const toMember = (r) => ({
  id: r.id, name: r.name, roleTitle: r.role_title, team: r.team, hue: r.hue, shiftHours: num(r.shift_hours),
  costPerHour: r.cost_per_hour == null ? null : num(r.cost_per_hour), active: r.active,
});

export const toLog = (r) => ({
  id: r.id, memberId: r.member_id, projectId: r.project_id, milestoneId: r.milestone_id, day: r.day, hours: num(r.hours), note: r.note, source: r.source,
});

/** Document DTO — same shape as the shared documents module. */
export { toDocument } from '../documents/documents.service.js';
