/** project_follow_ups row (joined with project + owner names) → DTO, with a Google Calendar link. */
const iso = (t) => (t ? new Date(t).toISOString() : null);
const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function calendarLink(f, project) {
  const details = [f.notes, f.meet ? `Google Meet: ${f.meet}` : '', project ? `Project: ${project}` : ''].filter(Boolean).join('\n');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(f.title + (project ? ` · ${project}` : ''))}`
    + `&dates=${stamp(f.due)}/${stamp(f.due + (f.dur || 30) * 6e4)}`
    + `&details=${encodeURIComponent(details)}`
    + (f.meet ? `&location=${encodeURIComponent(f.meet)}` : '')
    + (f.attendees ? `&add=${encodeURIComponent(f.attendees)}` : '');
}

export function toProjectFollowUp(r) {
  const due = new Date(r.due_at).getTime();
  return {
    id: r.id,
    projectId: r.project_id,
    project: r.project_name != null ? { id: r.project_id, name: r.project_name, client: r.project_client } : null,
    type: r.type,
    title: r.title,
    ownerId: r.owner_member_id,
    ownerName: r.owner_name || null,
    dueAt: iso(r.due_at),
    durationMin: r.duration_min,
    remindMin: r.remind_min,
    priority: r.priority,
    meetUrl: r.meet_url,
    attendees: r.attendees,
    notes: r.notes,
    done: r.done,
    notified: r.notified,
    overdue: !r.done && due < Date.now(),
    createdBy: r.created_by,
    calendarUrl: calendarLink({ title: r.title, due, dur: r.duration_min, notes: r.notes, meet: r.meet_url, attendees: r.attendees }, r.project_name),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
