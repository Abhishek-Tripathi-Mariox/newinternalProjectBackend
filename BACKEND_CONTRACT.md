# Backend build contract — Mariox Portal API (Node 20 + Express 5 + PostgreSQL 16 + Knex + Zod)

The API serves the React app in `../frontend`. Business rules must match the frontend store actions
(`../frontend/src/store/slices/*.js`, `../frontend/src/domain/*.js`) — same validations, same error
wording, same side effects (activity entries, history lines, audit entries). Read those files for the
rules of your module. The DB schema is fixed: `src/db/migrations/20261112000001_initial_schema.js`
(read it fully). If you truly need a schema change, add a NEW migration file
`src/db/migrations/2026111200001X_<module>_<what>.js` (X = your agent letter's number) — never edit the initial one.

## Already written (use, don't rewrite)
- `src/config/index.js` (`config`), `src/db/knex.js` (`db`, `tx(fn)`), `src/core/logger.js`
- `src/core/errors.js`: `AppError, badRequest, validationError, unauthorized, forbidden, notFound(what), conflict, unprocessable(message)` — throw these; Express 5 forwards async throws to the error handler.
- `src/core/http.js`: `ok(res, data, meta?)`, `created(res, data)`, `noContent(res)`, `pageParams(query)` → `{page,pageSize,limit,offset,meta(total)}`, `sortParam(sort, allowedMap, fallback)`
- `src/core/ids.js`: `nextId(q, kind)` kinds: lead followUp project task bug log user member role
- `src/core/scope.js`: `peopleScope(user, mod)` → `{scope, pid, people|null}`, `visibleProjectIds(user)` → ids|null, `restrictTo(q, col, ids)`
- `src/core/audit.js`: `audit(req, text, kind, q?)` kinds Invite|Role|Access|Profile
- `src/core/tokens.js`: access/refresh token helpers + cookie options
- Middleware: `authenticate` (sets `req.actor`, `req.user`, `req.previewing`), `authorize(mod, act)` (sets `req.scope`), `requireSuperAdmin`, `validate({params,query,body})` (parsed → `req.valid.*`, `req.body`), `upload` (multer, field name `files`), `loginLimiter`.
  `can(user, mod, act)` and `scopeOf(user, mod)` are exported from `middleware/authorize.js`.
  Principal shape: `{ id, name, email, status, role:{id,name,perms}, isSuper, memberId, ownerId, clientOf[], team, dept, shiftHours, pid }`.
- `src/routes.js` mounts every module at a fixed path (see below) — create exactly those files.
- `src/db/seeds/01_base.js` (roles/perms, stages, sources, services, settings).
- Tests: `tests/helpers.js` (`resetDb()`, `as(email)`, `tokenFor`, `closeDb`, fixture documented at the top). Don't edit it; extra fixtures go in your own test files. Run: `npm test -- tests/<yours>` (test DB: `mariox_portal_test`, Postgres in Docker on :5433 — already running).

## Module layout (one folder per module under `src/modules/<name>/`)
```
<name>.routes.js      Express Router: middleware chain per route, no logic
<name>.controller.js  req → service call → ok()/created()/noContent()
<name>.service.js     business rules, permission scoping, transactions (db.transaction), side effects
<name>.repository.js  Knex queries only (optional for small modules)
<name>.schemas.js     Zod schemas for params / query / body
<name>.mapper.js      DB row ↔ API DTO (snake_case → camelCase), optional
```
Route chain: `router.post('/', authorize('leads','c'), validate({ body: createLeadSchema }), ctrl.create)`.

## API conventions
- Base path `/api/v1`. JSON only (except file upload/download and CSV export).
- Success: `{ data }` or `{ data, meta }` (lists: `meta = {page,pageSize,total,pageCount}`); errors: `{ error: { code, message, details?, requestId } }`.
- Status codes: 200 / 201 created / 204 deleted / 400 bad input / 401 / 403 / 404 / 409 conflict / 422 validation (`VALIDATION_ERROR`) or business rule (`RULE_VIOLATION`, message = the frontend's wording, e.g. "Add a title.").
- DTOs: camelCase. Timestamps ISO 8601 strings; calendar days `YYYY-MM-DD`; money/hours numbers. Field names follow the frontend where sensible:
  lead `{id, company, contact, email, phone, services: string[], source, ownerId, firstOwnerId, status, value, notes, createdAt, updatedAt}` (+ `activities`, `quotes`, `documents` on detail);
  follow-up `{id, type, title, leadId, ownerId, dueAt, durationMin, remindMin, priority, meetUrl, attendees, notes, done, notified}`; project `{id, name, client, services, status, pmId, startDate, dueDate, value, hue, priority, brief, portal:{on, token}, team:[{memberId, allocHours}], links}`; etc.
- Lists: `?page=&pageSize=` (default 25, max 100), `?sort=field|-field` (whitelisted), filters as query params, `?q=` text search (ILIKE). Return total counts.
- IDs in URLs are the text codes (`/leads/MX-1001`). Validate them with a regex in params schemas.
- Every write that the frontend records keeps doing it: lead activity rows, bug_events, cr_history, audit_logs, activity_feed (live feed).
- Permissions: guard every route with `authorize(module, act)`; then apply row scope in the service (own/team/all) exactly like the frontend `scopeState()` (`../frontend/src/domain/permissions.js`). Reads outside scope → 404 (don't leak existence); writes outside scope → 403.
- Multi-table writes in a transaction. Never trust client-supplied ids for ownership — derive from `req.user`.
- No business logic in routes/controllers; no `req` in repositories.

## Mount points (create these router files, default export an Express Router)
| File | Mounted at | Owner |
|---|---|---|
| modules/auth/auth.routes.js | /auth (login, refresh, logout, me, change-password, accept-invite) | A |
| modules/users/users.routes.js | /users | A |
| modules/roles/roles.routes.js | /roles | A |
| modules/audit/audit.routes.js | /audit-logs | A |
| modules/people/people.routes.js | / → /members, /sales-owners | A |
| modules/masters/masters.routes.js | / → /lead-stages, /lead-sources, /services, /settings | A |
| modules/leads/leads.routes.js | /leads (incl. quotes, activities, documents, bulk, merge, duplicates, export.csv) | B |
| modules/followups/followups.routes.js | /follow-ups (incl. /due-reminders) | B |
| modules/dashboard/dashboard.routes.js | /dashboard (sales KPIs: period 7/30/90/ytd/custom from–to, owner) | B |
| modules/documents/documents.routes.js | /documents (GET :id/download, PATCH :id kind, DELETE :id — permission via the parent entity) | B |
| modules/projects/projects.routes.js | /projects (incl. members/alloc, links, portal on/off, documents, health/hours summary, capacity) | C |
| modules/projects/milestones.routes.js | /milestones (PATCH name/alloc/status, ask-approval) + GET /projects/:id/milestones lives in projects.routes | C |
| modules/projects/portal.public.routes.js | /public/portal/:token (no auth: view progress, approve/request changes on milestones, approve/reject CRs with typed signature) | C |
| modules/change-requests/changeRequests.routes.js | /change-requests (CRUD + POST :id/actions {act: send/approve/reject/start/done}) | C |
| modules/tasks/tasks.routes.js | /tasks | D |
| modules/bugs/bugs.routes.js | /bugs (+ /bugs/:id/comments, attachments via documents) | D |
| modules/timesheets/timesheets.routes.js | /time-logs (+ /summary, /matrix, /export.csv, /team-hours) | D |
| modules/workday/workday.routes.js | /workday (me, check-in, check-out, breaks, timer, heartbeat, my-day, end-shift) | E |
| modules/workday/live.routes.js | / → /live, /attendance, /reports (Super Admin only, not previewing) | E |
| src/db/seeds/02_super_admin.js | first Super Admin from SUPER_ADMIN_* env | F |
