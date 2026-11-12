const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

export const toBug = (r) => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name ?? undefined,
  milestoneId: r.milestone_id,
  milestoneName: r.milestone_name ?? null,
  title: r.title,
  dept: r.dept,
  env: r.env,
  severity: r.severity,
  priority: r.priority,
  status: r.status,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name ?? null,
  reporter: r.reporter,
  reporterName: r.reporter === 'client' ? 'Client' : r.reporter_name ?? null,
  reportedOn: r.reported_on,
  dueDate: r.due_date,
  build: r.build,
  steps: r.steps,
  expected: r.expected,
  actual: r.actual,
  link: r.link,
  attachmentCount: r.attachment_count == null ? undefined : Number(r.attachment_count),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toEvent = (e) => ({ id: Number(e.id), text: e.text, actorUserId: e.actor_user_id, actorName: e.actor_name ?? null, at: iso(e.at) });

export const BUG_COLUMNS = {
  title: 'title', projectId: 'project_id', milestoneId: 'milestone_id', dept: 'dept', env: 'env', severity: 'severity', priority: 'priority',
  status: 'status', assigneeId: 'assignee_id', reporter: 'reporter', reportedOn: 'reported_on', dueDate: 'due_date', build: 'build', steps: 'steps',
  expected: 'expected', actual: 'actual', link: 'link',
};

export function toRow(dto) {
  const row = {};
  for (const [k, col] of Object.entries(BUG_COLUMNS)) if (dto[k] !== undefined) row[col] = dto[k];
  return row;
}
