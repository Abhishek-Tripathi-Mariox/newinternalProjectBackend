/** change_requests row → API DTO. Planned tasks are stored as [{t, a, h}] (frontend shape). */
const iso = (t) => (t ? new Date(t).toISOString() : null);

export const fromTasks = (tasks) => (tasks || []).map((t) => ({ title: t.t, assigneeId: t.a || null, hours: Number(t.h) || 0 }));
export const toTasks = (tasks) => (tasks || []).map((t) => ({ t: t.title, a: t.assigneeId || '', h: Number(t.hours) || 0 }));

export function toCr(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    n: r.n,
    title: r.title,
    description: r.description,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    hours: Number(r.hours),
    rate: Number(r.rate),
    amount: Number(r.amount),
    extraDays: r.extra_days,
    priority: r.priority,
    target: r.target,
    status: r.status,
    milestoneId: r.milestone_id || null,
    team: r.team || [],
    tasks: fromTasks(r.tasks),
    note: r.note || '',
    raisedAt: iso(r.raised_at),
    sentAt: iso(r.sent_at),
    decidedAt: iso(r.decided_at),
    doneAt: iso(r.done_at),
    signature: r.sig_name ? { name: r.sig_name, title: r.sig_title || '', at: iso(r.sig_at), via: r.sig_via || '', note: r.sig_note || '' } : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
