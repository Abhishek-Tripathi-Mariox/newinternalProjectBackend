/** Printable CR approval record (port of domain/projects.js printCr). Every user value is HTML-escaped. */
import { escapeHtml as esc, inr, dateTime } from '../projects/projects.domain.js';

/**
 * @param c   CR DTO (with `history`)
 * @param ctx { project, members }
 */
export function printCrHtml(c, { project = {}, members = [] }) {
  const p = project || {};
  const d = (x) => (x ? dateTime(x) : '—');
  const sig = c.signature || {};
  const nm = (id) => (members.find((x) => x.id === id) || {}).name || '—';
  let hsh = 0;
  const sigAt = sig.at ? new Date(sig.at).getTime() : '';
  `${c.id}|${sig.name || ''}|${sigAt}|${c.amount}`.split('').forEach((ch) => { hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0; });
  const ref = `MX-${c.id.replace(/\W/g, '')}-${hsh.toString(36).toUpperCase()}`;
  const tasks = (c.tasks || []).map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(nm(t.assigneeId))}</td><td class=r>${+t.hours || 0}h</td></tr>`).join('');
  const hist = (c.history || []).map((x) => `<tr><td style="white-space:nowrap">${d(x.at)}</td><td>${esc(x.text)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.id)} approval · ${esc(p.client)}</title><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&display=swap" rel="stylesheet"><style>body{font:13px/1.55 -apple-system,Helvetica,Arial,sans-serif;color:#1d2230;margin:48px}h1{font-size:24px;margin:2px 0 0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#667;margin:28px 0 6px}table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid #e4e4e8;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#667;border-bottom:1.5px solid #1d2230}.r{text-align:right}.m{color:#667}.top{display:flex;justify-content:space-between;gap:24px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}.grid div{background:#f5f5f2;border-radius:8px;padding:10px 12px}.grid b{display:block;font-size:16px}.sig{border:1.5px solid #1d2230;border-radius:10px;padding:18px 20px;margin-top:10px;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.sn{font-family:Caveat,cursive;font-size:34px;line-height:1.1}@media print{body{margin:18px}}</style></head><body>`
    + `<div class=top><div><div class=m>CHANGE REQUEST · APPROVAL RECORD</div><h1>${esc(c.title)}</h1><div class=m>${esc(p.name)} · ${esc(p.client)}</div></div><div class=r><b>${esc(c.id)}</b><br><span class=m>Mariox Software</span></div></div>`
    + `<div class=grid><div><span class=m>Estimated hours</span><b>${c.hours}h</b></div><div><span class=m>Rate</span><b>${inr(c.rate)}/h</b></div><div><span class=m>Change value</span><b>${inr(c.amount)}</b></div><div><span class=m>Timeline impact</span><b>${c.extraDays ? `+${c.extraDays} days` : 'None'}</b></div></div>`
    + `<h2>Scope</h2><div>${esc(c.description || '—')}</div>${tasks ? `<h2>Work breakdown</h2><table><thead><tr><th>Task</th><th>Assigned to</th><th class=r>Hours</th></tr></thead><tbody>${tasks}</tbody></table>` : ''}`
    + `<h2>Approval</h2><div class=sig><div><div class=m>Approved by</div><div class=sn>${esc(sig.name || '—')}</div><div>${esc(sig.name || '')}${sig.title ? `, ${esc(sig.title)}` : ''} · ${esc(p.client)}</div></div><div><div class=m>Date & time</div><b>${d(sig.at || c.decidedAt)}</b><div class=m style="margin-top:8px">Method</div><b>${esc(sig.via || '—')}</b>${sig.note ? `<div class=m style="margin-top:8px">Comment</div>${esc(sig.note)}` : ''}</div></div>`
    + `<div class=m style="margin-top:8px;font-size:11.5px">Verification reference ${ref} · The client typed their name and confirmed they approve this change and its cost.</div>`
    + (hist ? `<h2>History</h2><table><tbody>${hist}</tbody></table>` : '')
    + '</body></html>';
}
