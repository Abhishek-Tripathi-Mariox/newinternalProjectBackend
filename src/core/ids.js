/**
 * Human-readable IDs matching the frontend (MX-1043, PR-112, BUG-1030, F50, T165 …).
 * Each uses a Postgres sequence created in the initial migration, so concurrent inserts never collide.
 */
const SEQ = {
  lead: ['lead_code_seq', (n) => `MX-${n}`],
  followUp: ['follow_up_code_seq', (n) => `F${n}`],
  projectFollowUp: ['project_follow_up_code_seq', (n) => `PF${n}`],
  project: ['project_code_seq', (n) => `PR-${n}`],
  task: ['task_code_seq', (n) => `T${n}`],
  bug: ['bug_code_seq', (n) => `BUG-${n}`],
  log: ['time_log_code_seq', (n) => `L${n}`],
  user: ['user_code_seq', (n) => `u-${n.toString(36)}`],
  member: ['member_code_seq', (n) => `m${n.toString(36)}`],
  role: ['role_code_seq', (n) => `r-${n.toString(36)}`],
};

/** Next id of a kind, e.g. await nextId(trx, 'lead') → 'MX-1043'. */
export async function nextId(q, kind) {
  const [seq, fmt] = SEQ[kind];
  const { rows } = await q.raw('select nextval(?) as n', [seq]);
  return fmt(Number(rows[0].n));
}
