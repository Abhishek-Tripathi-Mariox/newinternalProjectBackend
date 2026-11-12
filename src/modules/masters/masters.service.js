import { db } from '../../db/knex.js';
import { notFound, unprocessable } from '../../core/errors.js';

/** Stages the app logic depends on — never removable / renameable / movable. */
export const CORE_STAGES = ['New', 'Won', 'Lost'];

const clean = (x) => String(x ?? '').trim().replace(/\s+/g, ' ');
const cleanService = (x) => clean(x).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** A random hue as far as possible from the ones already in use (best of 24 tries) — frontend distinctHue. */
export function distinctHue(used) {
  let best = Math.floor(Math.random() * 360);
  let bestD = -1;
  for (let i = 0; i < 24; i++) {
    const h = Math.floor(Math.random() * 360);
    const d = used.length ? Math.min(...used.map((u) => hueDist(u, h))) : 360;
    if (d > bestD) { best = h; bestD = d; }
  }
  return best;
}

const inUseMsg = (what, name, n, noun = 'lead') => `Can't remove ${what} “${name}” — ${n} ${noun}${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} it`;
const count = async (q) => Number((await q.count('* as n'))[0].n);

/**
 * The three lists share add / rename / move / remove; they differ in table, wording, name cleaning,
 * how usage is counted and how a rename reaches the rows that use the value.
 */
const KINDS = {
  stage: { table: 'lead_stages', what: 'stage', Label: 'Stage', clean, usage: (q, n) => count(q('leads').where({ status: n })) },
  source: { table: 'lead_sources', what: 'source', Label: 'Source', clean, usage: (q, n) => count(q('leads').where({ source: n })) },
  service: {
    table: 'services', what: 'service', Label: 'Service', clean: cleanService, noun: 'lead / project',
    usage: async (q, n) => (await count(q('leads').whereRaw('? = any(services)', [n]))) + (await count(q('projects').whereRaw('? = any(services)', [n]))),
  },
};

const stageDto = (r, usage) => ({ name: r.name, hue: r.hue, position: r.position, isCore: r.is_core, usage });
const itemDto = (r, usage) => ({ name: r.name, position: r.position, usage });

export async function list(kind) {
  const k = KINDS[kind];
  const rows = await db(k.table).orderBy('position').orderBy('name');
  const out = [];
  for (const r of rows) out.push(kind === 'stage' ? stageDto(r, await k.usage(db, r.name)) : itemDto(r, await k.usage(db, r.name)));
  return out;
}

async function rowOf(trx, kind, name, lock = false) {
  const k = KINDS[kind];
  const r = await trx(k.table).where({ name }).modify((q) => lock && q.forUpdate()).first();
  if (!r) throw notFound(k.Label);
  return r;
}

/**
 * Add a value. Blank → rule error; an existing name (case-insensitive) is returned as-is
 * (`created: false`). New stages go just before Won with a hue distinct from the others.
 */
export async function add(kind, raw) {
  const k = KINDS[kind];
  const name = k.clean(raw);
  if (!name) throw unprocessable('Enter a name.');
  return db.transaction(async (trx) => {
    await trx.raw(`lock table ${k.table} in share row exclusive mode`);
    const ex = await trx(k.table).whereRaw('lower(name) = lower(?)', [name]).first();
    if (ex) return { created: false, item: kind === 'stage' ? stageDto(ex, await k.usage(trx, ex.name)) : itemDto(ex, await k.usage(trx, ex.name)) };
    const rows = await trx(k.table).orderBy('position');
    if (kind === 'stage') {
      const won = rows.find((r) => r.name === 'Won');
      const at = won ? won.position : (rows.length ? rows[rows.length - 1].position + 1 : 0);
      await trx(k.table).where('position', '>=', at).increment('position', 1);
      const [r] = await trx(k.table).insert({ name, hue: distinctHue(rows.map((x) => x.hue)), position: at, is_core: false }).returning('*');
      return { created: true, item: stageDto(r, 0) };
    }
    const pos = rows.length ? rows[rows.length - 1].position + 1 : 0;
    const [r] = await trx(k.table).insert({ name, position: pos }).returning('*');
    return { created: true, item: itemDto(r, 0) };
  });
}

/** Rename and update every row that uses the value (FK cascade for stages/sources, text[] for services). */
export async function rename(kind, from, raw) {
  const k = KINDS[kind];
  const to = k.clean(raw);
  if (!to) throw unprocessable('Enter a name.');
  if (kind === 'stage' && CORE_STAGES.includes(from)) throw unprocessable(`“${from}” is a core stage and can't be renamed.`);
  return db.transaction(async (trx) => {
    await rowOf(trx, kind, from, true);
    if (to === from) return to;
    if (await trx(k.table).whereRaw('lower(name) = lower(?)', [to]).whereNot({ name: from }).first('name')) {
      throw unprocessable(`A ${k.what} called “${to}” already exists.`);
    }
    await trx(k.table).where({ name: from }).update({ name: to }); // leads.status / leads.source follow via ON UPDATE CASCADE
    if (kind === 'service') {
      for (const t of ['leads', 'projects']) {
        await trx(t).whereRaw('? = any(services)', [from]).update({ services: trx.raw('array_replace(services, ?, ?)', [from, to]) });
      }
    }
    return to;
  });
}

export async function setHue(name, hue) {
  await db.transaction(async (trx) => {
    await rowOf(trx, 'stage', name, true);
    await trx('lead_stages').where({ name }).update({ hue });
  });
}

/** PATCH a stage: rename and/or recolour. Returns the stage after the change. */
export async function patchStage(name, body) {
  let cur = name;
  if (body.name !== undefined) cur = await rename('stage', name, body.name);
  if (body.hue !== undefined) await setHue(cur, body.hue);
  if (body.name === undefined && body.hue === undefined) await rowOf(db, 'stage', name);
  return (await list('stage')).find((s) => s.name === cur);
}

/**
 * Move one step up (-1) / down (+1). Custom stages move only between New and Won/Lost;
 * core stages don't move. Sources / services move freely (dropdown order).
 */
export async function move(kind, name, dir) {
  const k = KINDS[kind];
  await db.transaction(async (trx) => {
    await trx.raw(`lock table ${k.table} in share row exclusive mode`);
    const rows = await trx(k.table).orderBy('position').orderBy('name');
    const i = rows.findIndex((r) => r.name === name);
    if (i < 0) throw notFound(k.Label);
    if (kind === 'stage' && CORE_STAGES.includes(name)) throw unprocessable(`“${name}” is a core stage and can't be moved.`);
    const j = i + dir;
    if (j < 0 || j >= rows.length || (kind === 'stage' && CORE_STAGES.includes(rows[j].name))) return; // already at the edge: no-op like the frontend
    [rows[i], rows[j]] = [rows[j], rows[i]];
    for (let n = 0; n < rows.length; n++) if (rows[n].position !== n) await trx(k.table).where({ name: rows[n].name }).update({ position: n });
  });
  return list(kind);
}

export async function remove(kind, name) {
  const k = KINDS[kind];
  if (kind === 'stage' && CORE_STAGES.includes(name)) throw unprocessable(`“${name}” is a core stage and can't be removed`);
  await db.transaction(async (trx) => {
    await trx.raw(`lock table ${k.table} in share row exclusive mode`);
    await rowOf(trx, kind, name);
    const n = await k.usage(trx, name);
    if (n) throw unprocessable(inUseMsg(k.what, name, n, k.noun));
    if (kind !== 'stage' && (await count(trx(k.table))) <= 1) throw unprocessable(`Keep at least one ${k.what}`);
    await trx(k.table).where({ name }).del();
  });
}

/* ---- settings ---- */
export async function getSettings() {
  const rows = await db('settings').select('key', 'value');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function putSettings(patch) {
  await db.transaction(async (trx) => {
    for (const [key, value] of Object.entries(patch)) {
      await trx('settings').insert({ key, value: JSON.stringify(value) }).onConflict('key').merge(['value']);
    }
  });
  return getSettings();
}
