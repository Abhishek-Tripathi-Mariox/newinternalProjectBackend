/**
 * Calendar-day helpers shared by tasks, bugs and timesheets (port of the frontend lib/date range()).
 * Days are 'YYYY-MM-DD' strings in the server's local timezone, which compare correctly as text.
 */
const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day of a Date (default now). */
export const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const parse = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12); // noon: safe across DST changes
};

/** day ± n days. */
export const addDays = (day, n) => {
  const d = parse(day);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

/** Whole days from a to b (b - a). */
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);

export const today = () => ymd();

/** Monday-start week containing `day`: [start, endExclusive). */
export function weekOf(day = today()) {
  const w = (parse(day).getDay() + 6) % 7;
  return [addDays(day, -w), addDays(day, 7 - w)];
}

/** Calendar month containing `day`: [start, endExclusive). */
export function monthOf(day = today()) {
  const d = parse(day);
  return [ymd(new Date(d.getFullYear(), d.getMonth(), 1, 12)), ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1, 12))];
}

export const PERIOD_PRESETS = ['today', 'yesterday', 'week', '7d', 'month', 'lastmonth', '30d', '90d', 'all', 'custom'];

/**
 * Period preset → [fromDay, toDayExclusive] (either end may be null = open), or null for all time.
 * Same presets as the frontend PROJECT_PERIOD_PRESETS. 'custom' uses from / to (inclusive).
 */
export function range(preset, from, to) {
  const T = today();
  switch (preset) {
    case 'today': return [T, addDays(T, 1)];
    case 'yesterday': return [addDays(T, -1), T];
    case '7d': return [addDays(T, -6), addDays(T, 1)];
    case '30d': return [addDays(T, -29), addDays(T, 1)];
    case '90d': return [addDays(T, -89), addDays(T, 1)];
    case 'week': return weekOf(T);
    case 'month': return monthOf(T);
    case 'lastmonth': {
      const [start] = monthOf(T);
      return [monthOf(addDays(start, -1))[0], start];
    }
    case 'custom': return [from || null, to ? addDays(to, 1) : null];
    default:
      // No preset but explicit dates → treat as custom.
      if (from || to) return [from || null, to ? addDays(to, 1) : null];
      return null;
  }
}

/** Apply [from, toExclusive) to a date column. */
export function whereInRange(q, column, rg) {
  if (!rg) return q;
  if (rg[0]) q.where(column, '>=', rg[0]);
  if (rg[1]) q.where(column, '<', rg[1]);
  return q;
}

/** Working days (Mon–Sat) in [a, b) that are not in the future (frontend workdaysSoFar). */
export function workdaysSoFar(a, b) {
  const T = today();
  let c = 0;
  for (let d = a; d < b && d <= T; d = addDays(d, 1)) if (parse(d).getDay() !== 0) c++;
  return c;
}
