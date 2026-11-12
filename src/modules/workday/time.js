import { config } from '../../config/index.js';
/**
 * Time-zone aware day helpers for attendance, live status and reports.
 *
 * Every "day" here is the start of a calendar day in the business time zone, as an epoch-ms
 * number (like the frontend's `sod()`), and calendar days on the wire are 'YYYY-MM-DD' strings.
 * The zone comes from the APP_TZ env var (IANA name), default 'Asia/Kolkata'. We deliberately do
 * NOT rely on the process TZ, so the API behaves the same on a UTC server/container.
 */
export const TZ = config.timeZone;

export const MINUTE = 6e4;
export const HOUR = 36e5;
export const DAY = 864e5;
const NOON = 432e5;
/** Late = first login after 10:30 local. */
export const LATE_MS = 630 * MINUTE;

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(t) {
  const o = {};
  for (const p of dtf.formatToParts(new Date(t))) o[p.type] = p.value;
  return o;
}

/** Zone offset (ms) at instant t. */
function offset(t) {
  const p = parts(t);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** 'YYYY-MM-DD' of instant t in the business zone. */
export function ymd(t) {
  const p = parts(t);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Start-of-day instant for a 'YYYY-MM-DD' string in the business zone. */
export function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - offset(guess - offset(guess));
}

export const sod = (t) => parseDay(ymd(t));
export const addDays = (day, n) => sod(day + n * DAY + NOON);
export const weekday = (t) => WD.indexOf(parts(t).weekday);
export const isSunday = (t) => weekday(t) === 0;

/** First day of the month `delta` months from the month containing `day`. */
export function monthStart(day, delta = 0) {
  const p = parts(day);
  return parseDay(new Date(Date.UTC(+p.year, +p.month - 1 + delta, 1)).toISOString().slice(0, 10));
}

/** "3:30 pm" (en-IN, business zone). */
export const clock = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
/** Locale date in the business zone, e.g. fmtDate(t, { weekday: 'short', day: 'numeric', month: 'short' }). */
export const fmtDate = (t, o) => new Date(t).toLocaleDateString('en-IN', { ...o, timeZone: TZ });

/** Duration "45m" / "2h 05m". */
export function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / MINUTE));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
/** "7.5h". */
export const h1 = (x) => `${Math.round((+x || 0) * 10) / 10}h`;
export const iso = (t) => (t == null ? null : new Date(t).toISOString());
