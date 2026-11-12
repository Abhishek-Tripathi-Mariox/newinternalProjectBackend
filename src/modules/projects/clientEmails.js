/**
 * Emails to the project's client. Off unless CLIENT_EMAILS=true (and SMTP is configured and the
 * project has a client email). Sent after the change is saved; a failed email never undoes it.
 * Replies go to the project's PM, who records the client's decision in the portal.
 */
import { db } from '../../db/knex.js';
import { config } from '../../config/index.js';
import { logger } from '../../core/logger.js';
import { mailEnabled, sendMail } from '../../core/mailer.js';
import { esc, layout } from '../../core/emailLayout.js';
import * as repo from './projects.repository.js';

const fmtMoney = (v, cur) => new Intl.NumberFormat(cur === 'USD' ? 'en-US' : 'en-IN', {
  style: 'currency', currency: cur === 'USD' ? 'USD' : 'INR', maximumFractionDigits: 0,
}).format(cur === 'USD' ? (+v || 0) / 84 : +v || 0);
const fmtDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

let enabled = config.mail.clientEmails;
/** Tests: switch CLIENT_EMAILS on / off without reloading config. */
export const useClientEmails = (on) => { enabled = !!on; };

/** The PM's name + login email (reply-to), or nulls. */
async function pmContact(p) {
  if (!p.pmId) return { name: null, email: null };
  const r = await db('members').leftJoin('users', 'users.member_id', 'members.id').where('members.id', p.pmId).first('members.name', 'users.email');
  return { name: r?.name || null, email: r?.email || null };
}

/**
 * Why a client email would not go out right now, or null when it will.
 * @returns {null|'off'|'no-smtp'|'no-email'}
 */
export function clientMailBlocked(p) {
  if (!enabled) return 'off';
  if (!mailEnabled()) return 'no-smtp';
  if (!p?.clientEmail) return 'no-email';
  return null;
}

/** Short note for the PM's flash message, e.g. " · emailed to a@b.com". */
export function clientMailNote(res) {
  if (!res) return '';
  if (res.sent) return ` · emailed to ${res.to}`;
  if (res.reason === 'no-email') return ' · no email sent (add the client email to the project)';
  if (res.reason === 'failed') return ' · the email to the client failed';
  return ''; // CLIENT_EMAILS off / SMTP not configured: say nothing
}

const row = (label, value) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7080;font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;font-size:13px;font-weight:600">${value}</td></tr>`;
const table = (rows) => `<table style="border-collapse:collapse;margin:0 0 20px;width:100%">${rows.join('')}</table>`;

async function deliver(p, build) {
  const blocked = clientMailBlocked(p);
  if (blocked) return { sent: false, reason: blocked };
  try {
    const pm = await pmContact(p);
    const msg = await build(pm);
    const sent = await sendMail({ to: p.clientEmail, replyTo: pm.email || undefined, ...msg });
    return sent ? { sent: true, to: p.clientEmail } : { sent: false, reason: 'failed' };
  } catch (err) {
    logger.error({ err, projectId: p.id }, 'Client email failed');
    return { sent: false, reason: 'failed' };
  }
}

/** Change request sent to the client for approval. `c` is a CR DTO. */
export async function emailCrToClient(c) {
  const p = await repo.findProject(c.projectId);
  if (!p) return { sent: false, reason: 'no-email' };
  return deliver(p, async (pm) => {
    const cur = await repo.currency();
    const org = config.mail.from.name;
    const who = pm.name || 'your project manager';
    const amount = fmtMoney(c.amount, cur);
    const timeline = c.extraDays ? `+${c.extraDays} day${c.extraDays === 1 ? '' : 's'}` : 'No change to the due date';
    const subject = `Approval needed: ${c.title} (${c.id}) · ${p.name}`;
    const text = [
      `Hi ${p.client},`, '',
      `${who} from ${org} has sent a change request on ${p.name} for your approval.`, '',
      `${c.id} · ${c.title}`,
      c.description ? `\n${c.description}\n` : '',
      `Estimated effort: ${c.hours} hours`, `Cost: ${amount}`, `Timeline: ${timeline}`, '',
      `Please reply to this email to approve it or to ask for changes.`, '',
      `${who}`, org,
    ].join('\n');
    const html = layout({
      heading: 'Change request for your approval',
      intro: `Hi ${esc(p.client)},<br>${esc(who)} from ${esc(org)} has sent a change request on <b>${esc(p.name)}</b> for your approval.`,
      body: table([
        row('Change request', `${esc(c.id)} · ${esc(c.title)}`),
        ...(c.description ? [row('Details', esc(c.description).replace(/\n/g, '<br>'))] : []),
        row('Estimated effort', `${esc(c.hours)} hours`),
        row('Cost', esc(amount)),
        row('Timeline', esc(timeline)),
      ]),
      note: 'Please reply to this email to approve the change or to ask for changes.',
      footer: '',
    });
    return { subject, text, html };
  });
}

/** A milestone is ready for the client's review / approval. `m` is a milestone DTO. */
export async function emailMilestoneToClient(m) {
  const p = await repo.findProject(m.projectId);
  if (!p) return { sent: false, reason: 'no-email' };
  return deliver(p, async (pm) => {
    const org = config.mail.from.name;
    const who = pm.name || 'your project manager';
    const subject = `Ready for your review: ${m.name} · ${p.name}`;
    const text = [
      `Hi ${p.client},`, '',
      `Milestone ${m.n} "${m.name}" on ${p.name} is ready for your review.`,
      `Due: ${fmtDay(m.dueDate)}`, '',
      `Please reply to this email to approve it, or tell us what to change.`, '',
      `${who}`, org,
    ].join('\n');
    const html = layout({
      heading: 'Milestone ready for your review',
      intro: `Hi ${esc(p.client)},<br>A milestone on <b>${esc(p.name)}</b> is ready for your review.`,
      body: table([
        row('Milestone', `${esc(m.n)} · ${esc(m.name)}`),
        row('Due', esc(fmtDay(m.dueDate))),
        row('Project manager', esc(who)),
      ]),
      note: 'Please reply to this email to approve it, or tell us what to change.',
      footer: '',
    });
    return { subject, text, html };
  });
}
