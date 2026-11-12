/** Quote totals and the printable quotation — port of frontend/src/domain/quotes.js. */
import { DAY, escapeHtml as esc, fd, inr } from './leads.util.js';

/** { sub, disc, net, tax (18% GST), total } for { items:[{d,q,r}], disc, gst }. */
export function qTotals(q) {
  const sub = (q.items || []).reduce((a, i) => a + (+i.q || 0) * (+i.r || 0), 0);
  const disc = (sub * (+q.disc || 0)) / 100;
  const tax = q.gst ? (sub - disc) * 0.18 : 0;
  return { sub, disc, net: sub - disc, tax, total: sub - disc + tax };
}

/**
 * Printable HTML quotation. Every value is escaped; unlike the frontend there is no auto-print
 * script, so the page can be served with a strict CSP (the browser's print dialog does the rest).
 * @param {{company,contact,email,phone}} l lead
 * @param {{id, items, disc, gst, valid, terms, createdMs}} q quote
 * @param {string} ownerName account manager
 */
export function printQuote(l, q, ownerName) {
  const t = qTotals(q);
  const rows = q.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.d)}</td><td class=r>${esc(i.q)}</td><td class=r>${inr(i.r)}</td><td class=r>${inr((+i.q || 0) * (+i.r || 0))}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(q.id)} · ${esc(l.company)}</title><style>body{font:13px/1.55 -apple-system,Helvetica,Arial,sans-serif;color:#1d2230;margin:48px}h1{font-size:26px;margin:2px 0 0}table{width:100%;border-collapse:collapse;margin-top:28px}th{text-align:left;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#667;border-bottom:1.5px solid #1d2230;padding:8px 6px}td{padding:10px 6px;border-bottom:1px solid #e4e4e8;vertical-align:top}.r{text-align:right}.top{display:flex;justify-content:space-between;gap:24px}.m{color:#667}.tot td{border:0;padding:4px 6px}.g td{font-size:16px;font-weight:700;border-top:1.5px solid #1d2230;padding-top:10px}@media print{body{margin:16px}}</style></head><body>`
    + `<div class=top><div><div class=m>QUOTATION</div><h1>Mariox Software</h1></div><div class=r><b>${esc(q.id)}</b><br><span class=m>Date</span> ${fd(q.createdMs)}<br><span class=m>Valid until</span> ${fd(q.createdMs + q.valid * DAY)}</div></div>`
    + `<div class=top style="margin-top:32px"><div><div class=m>Prepared for</div><b>${esc(l.company)}</b><br>${esc(l.contact)}<br>${esc(l.email)}<br>${esc(l.phone)}</div><div class=r><div class=m>Account manager</div><b>${esc(ownerName)}</b></div></div>`
    + `<table><thead><tr><th>#</th><th>Description</th><th class=r>Qty</th><th class=r>Rate</th><th class=r>Amount</th></tr></thead><tbody>${rows}</tbody></table>`
    + `<table style="width:320px;margin-left:auto;margin-top:12px"><tr class=tot><td>Subtotal</td><td class=r>${inr(t.sub)}</td></tr>${t.disc ? `<tr class=tot><td>Discount (${esc(q.disc)}%)</td><td class=r>− ${inr(t.disc)}</td></tr>` : ''}${q.gst ? `<tr class=tot><td>GST 18%</td><td class=r>${inr(t.tax)}</td></tr>` : ''}<tr class="tot g"><td>Total</td><td class=r>${inr(t.total)}</td></tr></table>`
    + (q.terms ? `<div style="margin-top:36px"><div class=m>Terms</div>${esc(q.terms)}</div>` : '')
    + '</body></html>';
}
