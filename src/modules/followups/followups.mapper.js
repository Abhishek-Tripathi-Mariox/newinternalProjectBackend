/** Follow-up row → DTO, plus the Google Calendar link (port of features/followups/calendarLink.js). */
import { iso } from '../leads/leads.util.js';

const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * Google Calendar "create event" URL.
 * @param {{title:string, due:number, dur?:number, notes?:string, meet?:string, attendees?:string}} fu
 * @param {{company:string, contact:string}|null} lead
 */
export function calendarLink(fu, lead) {
  const details = [fu.notes, fu.meet ? `Google Meet: ${fu.meet}` : '', lead ? `Lead: ${lead.company} (${lead.contact})` : ''].filter(Boolean).join('\n');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(fu.title + (lead ? ` · ${lead.company}` : ''))}`
    + `&dates=${stamp(fu.due)}/${stamp(fu.due + (fu.dur || 30) * 6e4)}`
    + `&details=${encodeURIComponent(details)}`
    + (fu.meet ? `&location=${encodeURIComponent(fu.meet)}` : '')
    + (fu.attendees ? `&add=${encodeURIComponent(fu.attendees)}` : '');
}

/**
 * @param {object} r follow_ups row (optionally joined with lead_company / lead_contact)
 * @param {{company:string, contact:string}|null} [lead] lead (else taken from the joined columns)
 */
export function toFollowUp(r, lead) {
  const l = lead || (r.lead_company != null ? { id: r.lead_id, company: r.lead_company, contact: r.lead_contact } : null);
  const due = new Date(r.due_at).getTime();
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    leadId: r.lead_id,
    lead: l ? { id: l.id || r.lead_id, company: l.company, contact: l.contact } : null,
    ownerId: r.owner_id,
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
    calendarUrl: calendarLink({ title: r.title, due, dur: r.duration_min, notes: r.notes, meet: r.meet_url, attendees: r.attendees }, l),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
