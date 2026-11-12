import { db } from '../../db/knex.js';
import { notFound } from '../../core/errors.js';

const memberDto = (m) => ({
  id: m.id, name: m.name, roleTitle: m.role_title, team: m.team, hue: m.hue, shiftHours: Number(m.shift_hours),
  costPerHour: m.cost_per_hour === null ? null : Number(m.cost_per_hour), active: m.active, userId: m.user_id || null,
});
const ownerDto = (o) => ({ id: o.id, name: o.name, hue: o.hue, active: o.active, userId: o.user_id || null });

const membersQ = () => db('members as m').leftJoin('users as u', 'u.member_id', 'm.id').select('m.*', 'u.id as user_id');

/** Delivery members for dropdowns / Team & hours (not paginated — the directory is small). */
export async function listMembers(f) {
  const q = membersQ().orderBy('m.name');
  if (f.team) q.where('m.team', f.team);
  if (f.active !== undefined) q.where('m.active', f.active);
  if (f.q) q.whereILike('m.name', `%${f.q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
  return (await q).map(memberDto);
}

export async function getMember(id) {
  const m = await membersQ().where('m.id', id).first();
  if (!m) throw notFound('Member');
  return memberDto(m);
}

/** Shift length / hourly cost. The linked user's shift is kept in step. */
export async function updateMember(id, body) {
  await db.transaction(async (trx) => {
    const m = await trx('members').where({ id }).first('id');
    if (!m) throw notFound('Member');
    const patch = {};
    if (body.shiftHours !== undefined) patch.shift_hours = body.shiftHours;
    if (body.costPerHour !== undefined) patch.cost_per_hour = body.costPerHour;
    if (!Object.keys(patch).length) return;
    await trx('members').where({ id }).update(patch);
    if (patch.shift_hours !== undefined) await trx('users').where({ member_id: id }).update({ shift_hours: patch.shift_hours });
  });
  return getMember(id);
}

export async function listOwners(f) {
  const q = db('sales_owners as o').leftJoin('users as u', 'u.owner_id', 'o.id').select('o.*', 'u.id as user_id').orderBy('o.name');
  if (f.active !== undefined) q.where('o.active', f.active);
  return (await q).map(ownerDto);
}
