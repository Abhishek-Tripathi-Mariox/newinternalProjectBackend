/**
 * Calendar-day helpers on 'YYYY-MM-DD' strings (the API's day format). Days are converted to an
 * integer day number (days since 1970-01-01, UTC arithmetic) so comparisons and differences
 * never drift with time zones / DST. "Today" is the server's local calendar day, like the
 * frontend's sod(Date.now()).
 */
const DAY_MS = 864e5;
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → day number. */
export const dn = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};

/** Day number → 'YYYY-MM-DD'. */
export const ds = (n) => {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Local calendar day of a Date/timestamp. */
export const localDay = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const todayN = () => dn(localDay());
export const addDaysS = (s, k) => ds(dn(s) + k);
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (n) => new Date(n * DAY_MS).getUTCDay();
export const isSundayN = (n) => weekday(n) === 0;

/**
 * Named period → [from, to) day numbers (port of lib/date range()); null for 'all'.
 * custom: from/to are 'YYYY-MM-DD' (inclusive), either may be blank.
 */
export function periodRange(preset, from, to, T = todayN()) {
  const d = new Date(T * DAY_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const mon = (yy, mm) => Math.round(Date.UTC(yy, mm, 1) / DAY_MS);
  switch (preset) {
    case 'today': return [T, T + 1];
    case 'yesterday': return [T - 1, T];
    case '7d': return [T - 6, T + 1];
    case '30d': return [T - 29, T + 1];
    case '90d': return [T - 89, T + 1];
    case 'month': return [mon(y, m), mon(y, m + 1)];
    case 'lastmonth': return [mon(y, m - 1), mon(y, m)];
    case 'week': {
      const w = (weekday(T) + 6) % 7;
      return [T - w, T + 7 - w];
    }
    case 'custom': return [from ? dn(from) : -Infinity, to ? dn(to) + 1 : Infinity];
    default: return null;
  }
}

/** Working days (Mon–Sat) in [a, b) that are not in the future. */
export function workdaysSoFar(a, b, T = todayN()) {
  let c = 0;
  for (let d = a; d < b && d <= T; d++) if (!isSundayN(d)) c++;
  return c;
}

/** Working days (Mon–Sat) between two days inclusive, minimum 1. */
export function workdaysBetween(a, b) {
  let c = 0;
  for (let d = a; d <= b; d++) if (!isSundayN(d)) c++;
  return Math.max(1, c);
}
