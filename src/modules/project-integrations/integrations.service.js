/**
 * Project third parties + credentials.
 *  - See the list (names, labels, no values): anyone who can see the project (never clients).
 *  - Reveal a value: Super Admin, the project's PM, or a member of the project team — every reveal is
 *    written to the activity log.
 *  - Add / edit / delete: Super Admin or the project's PM.
 * Values are encrypted with CREDENTIALS_KEY (core/secretBox) and never returned in lists.
 */
import { db } from '../../db/knex.js';
import { visibleProjectIds } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { open, seal, secretsEnabled } from '../../core/secretBox.js';
import { isPMof } from '../projects/projects.service.js';
import * as prepo from '../projects/projects.repository.js';

const iso = (t) => (t ? new Date(t).toISOString() : null);

async function project(user, projectId, q = db) {
  if (user.role?.id === 'r-client') throw forbidden();
  const ids = await visibleProjectIds(user);
  const p = await prepo.findProject(projectId, q);
  if (!p || (ids && !ids.includes(p.id))) throw notFound('Project');
  return p;
}

const canReveal = (user, p) => isPMof(user, p) || (!!user.memberId && (p.pmId === user.memberId || p.team.some((t) => t.memberId === user.memberId)));
const needPM = (user, p) => { if (!isPMof(user, p)) throw forbidden("Only the project's PM can change third parties and credentials."); };

async function integration(user, id, q = db) {
  const row = await q('project_integrations').where({ id }).first();
  if (!row) throw notFound('Third party');
  const p = await project(user, row.project_id, q);
  return { row, p };
}

function toDto(r, creds, names) {
  return {
    id: Number(r.id), projectId: r.project_id, name: r.name, category: r.category, status: r.status, url: r.url, notes: r.notes,
    credentials: creds.filter((c) => String(c.integration_id) === String(r.id)).map((c) => ({
      id: Number(c.id), label: c.label, env: c.env, updatedAt: iso(c.updated_at), updatedBy: names[c.updated_by] || null,
    })),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

async function load(projectId, q = db, only) {
  const qb = q('project_integrations').where({ project_id: projectId }).orderBy('id');
  if (only) qb.where({ id: only });
  const rows = await qb;
  const creds = rows.length
    ? await q('project_credentials').whereIn('integration_id', rows.map((r) => r.id)).orderBy([{ column: 'position' }, { column: 'id' }])
    : [];
  const uids = [...new Set(creds.map((c) => c.updated_by).filter(Boolean))];
  const names = uids.length ? Object.fromEntries((await q('users').whereIn('id', uids).select('id', 'name')).map((u) => [u.id, u.name])) : {};
  return rows.map((r) => toDto(r, creds, names));
}

export async function list(user, projectId) {
  const p = await project(user, projectId);
  return {
    items: await load(p.id),
    canManage: isPMof(user, p),
    canReveal: canReveal(user, p),
    credentialsEnabled: secretsEnabled(),
  };
}

/** Apply a credential list to an integration: new ones need a value; existing keep theirs unless a new one is given. */
async function writeCreds(trx, integrationId, list, user, { replace }) {
  const existing = await trx('project_credentials').where({ integration_id: integrationId });
  const keep = new Set();
  for (const [i, c] of list.entries()) {
    const value = c.value ?? '';
    if (c.id) {
      const cur = existing.find((x) => Number(x.id) === c.id);
      if (!cur) throw unprocessable('A credential in the list no longer exists — reload and try again.');
      keep.add(Number(cur.id));
      const patch = { label: c.label, env: c.env, position: i };
      if (value !== '') Object.assign(patch, { value_enc: seal(value), updated_by: user.id });
      await trx('project_credentials').where({ id: cur.id }).update(patch);
    } else {
      if (value === '') throw unprocessable(`Enter a value for "${c.label}".`);
      await trx('project_credentials').insert({ integration_id: integrationId, label: c.label, env: c.env, value_enc: seal(value), updated_by: user.id, position: i });
    }
  }
  if (replace) {
    const drop = existing.filter((x) => !keep.has(Number(x.id))).map((x) => x.id);
    if (drop.length) await trx('project_credentials').whereIn('id', drop).del();
  }
}

export async function create(user, b) {
  const p = await project(user, b.projectId);
  needPM(user, p);
  const id = await db.transaction(async (trx) => {
    const [row] = await trx('project_integrations').insert({
      project_id: p.id, name: b.name, category: b.category, status: b.status, url: b.url, notes: b.notes.trim(), created_by: user.id,
    }).returning('id');
    await writeCreds(trx, row.id, b.credentials || [], user, { replace: false });
    return row.id;
  });
  return (await load(p.id, db, id))[0];
}

export async function update(user, id, b) {
  const { row, p } = await integration(user, id);
  needPM(user, p);
  await db.transaction(async (trx) => {
    const patch = {};
    for (const k of ['name', 'category', 'status', 'url']) if (b[k] !== undefined) patch[k] = b[k];
    if (b.notes !== undefined) patch.notes = b.notes.trim();
    if (Object.keys(patch).length) await trx('project_integrations').where({ id }).update(patch);
    if (b.credentials) await writeCreds(trx, id, b.credentials, user, { replace: true });
  });
  return (await load(row.project_id, db, id))[0];
}

export async function remove(user, id) {
  const { p } = await integration(user, id);
  needPM(user, p);
  await db('project_integrations').where({ id }).del();
}

/** Decrypt one credential for someone allowed to see it, and log who looked. */
export async function reveal(req, id, credId) {
  const user = req.user;
  const { row, p } = await integration(user, id);
  if (!canReveal(user, p)) throw forbidden('Only the PM and the project team can see credentials.');
  const c = await db('project_credentials').where({ id: credId, integration_id: id }).first();
  if (!c) throw notFound('Credential');
  const value = open(c.value_enc);
  await audit(req, `Viewed ${row.name} · ${c.label} (${c.env}) on ${p.id} ${p.name}`, 'Credentials');
  return { id: Number(c.id), value };
}
