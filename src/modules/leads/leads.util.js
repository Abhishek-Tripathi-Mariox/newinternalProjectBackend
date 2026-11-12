/** Small helpers shared by the sales modules (leads, follow-ups, dashboard). Server local time. */

export const MINUTE = 6e4;
export const DAY = 864e5;

/** Start of the local day for a timestamp (ms). */
export function sod(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 'YYYY-MM-DD' → start of that local day (ms), or null. */
export const parseDay = (v) => (v ? sod(new Date(`${v}T12:00`).getTime()) : null);

/** Local calendar day 'YYYY-MM-DD' of a timestamp. */
export function ymd(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const ms = (v) => (v == null ? null : new Date(v).getTime());
export const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** "₹1,23,456" (frontend inr()). */
export const inr = (v) => `₹${Math.round(+v || 0).toLocaleString('en-IN')}`;

/** Frontend money(): compact INR (or USD at 84 ₹/$) used in activity texts. */
export function money(v, currency = 'INR') {
  let n = +v || 0;
  if (currency === 'USD') {
    n /= 84;
    return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
  }
  return n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/** "9 Nov 2026" (frontend fd()). */
export const fd = (t) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** HTML escape (frontend escapeHtml, plus single quotes). */
export const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** CSV with every cell quoted (frontend downloadCsv), UTF-8 BOM. */
export function toCsv(rows) {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  return `\uFEFF${rows.map((r) => r.map(cell).join(',')).join('\n')}`;
}
