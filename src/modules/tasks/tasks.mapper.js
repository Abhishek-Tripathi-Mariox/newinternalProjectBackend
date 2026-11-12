const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

/** DB row → task DTO. */
export const toTask = (r) => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name ?? undefined,
  milestoneId: r.milestone_id,
  milestoneName: r.milestone_name ?? null,
  milestoneN: r.milestone_n ?? null,
  title: r.title,
  description: r.description,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name ?? null,
  status: r.status,
  priority: r.priority,
  dueDate: r.due_date,
  estimateHours: Number(r.estimate_hours) || 0,
  checklist: r.checklist || [],
  crId: r.cr_id,
  log: r.log || [],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** API field → column for writes. */
export const TASK_COLUMNS = {
  title: 'title', description: 'description', projectId: 'project_id', milestoneId: 'milestone_id', assigneeId: 'assignee_id', status: 'status',
  priority: 'priority', dueDate: 'due_date', estimateHours: 'estimate_hours', checklist: 'checklist',
};

export function toRow(dto) {
  const row = {};
  for (const [k, col] of Object.entries(TASK_COLUMNS)) {
    if (dto[k] === undefined) continue;
    row[col] = k === 'checklist' ? JSON.stringify(dto[k]) : dto[k];
  }
  return row;
}
