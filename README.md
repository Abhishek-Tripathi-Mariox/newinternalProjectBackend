# Mariox Portal API

REST API for the Mariox internal portal (`../frontend`). Node 20 · Express 5 · PostgreSQL 16 · Knex · Zod.
It implements the same business rules as the frontend prototype (validations, wording, side effects, role permissions).

## Quick start

```bash
cp .env.example .env          # then set real JWT secrets for anything beyond local dev
npm install
npm run db:up                 # PostgreSQL 16 in Docker on localhost:5433 (+ test database)
npm run migrate               # create the schema
npm run seed                  # roles + master lists + the first Super Admin (from SUPER_ADMIN_* in .env)
npm run dev                   # http://localhost:4000  (health: GET /health)
npm test                      # Jest + Supertest, Jest + Supertest against mariox_portal_test
```

There is no demo data. The seed creates one Super Admin from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_NAME`
(empty password → a random one is generated and printed once). Sign in with it, then invite everyone else from
Users & roles; sales owners and team members are created with their user accounts.

| Script | What it does |
|---|---|
| `npm run dev` / `npm start` | API with file watching / production start |
| `npm run migrate` / `migrate:rollback` | Apply / roll back migrations |
| `npm run seed` | Base data + first Super Admin (idempotent — never overwrites existing data or passwords) |
| `npm run db:reset` | **Deletes all data**: roll back everything, migrate, seed |
| `npm test` | Full test suite (serial, real Postgres) |
| `npm run lint` | ESLint |

## Architecture

```
src/
  server.js            listen + graceful shutdown (SIGTERM/SIGINT, closes DB pool)
  app.js               Express app: middleware chain, /health, /api/v1, 404, error handler
  routes.js            mounts every module router (public routes first, then `authenticate`)
  config/              env validated with Zod at boot (fails fast); APP_TZ applied process-wide
  db/
    knex.js            connection pool (session time zone = APP_TZ, NUMERIC → number, DATE → 'YYYY-MM-DD')
    migrations/        schema (30 tables, FKs, CHECK constraints, indexes, updated_at triggers, id sequences)
    seeds/             01_base (roles/perms, stages, sources, services, settings), 02_super_admin (first account)
  core/                errors (AppError + helpers), http (envelope, paging, sort), ids (MX-1001 style codes),
                       scope (all/team/own row filtering), audit, tokens, logger (pino)
  middleware/          requestId, httpLogger, authenticate, authorize, validate, rateLimit, upload, errorHandler
  modules/<name>/      <name>.routes → controller → service → repository, + schemas (Zod) and mapper (DTOs)
tests/                 one file per module + helpers.js (fixture DB, login helper)
```

**Request pipeline:** request id → structured log → helmet → CORS (allow-list, credentials) → gzip → JSON/urlencoded (1 MB) →
cookies → rate limit (600/min/IP; login 10 per 15 min per IP+email) → `authenticate` → `authorize(module, action)` →
`validate({ params, query, body })` → controller → service → central error handler.

**Auth:** short-lived JWT access token (15 min, `Authorization: Bearer`) + opaque refresh token in an httpOnly cookie
(`mx_refresh`, path `/api/v1/auth`), stored only as a SHA-256 hash and rotated on every refresh; re-using a revoked token
revokes all of that user's sessions. Passwords use bcrypt. The user and role are re-read on every request, so
deactivation and role changes apply immediately (access tokens already issued for deactivated users are rejected).

**Permissions:** the same role matrix as the frontend — module (`dash leads fu projects tasks bugs ts team users`) ×
action (view/create/edit/delete) × scope (all/team/own). Routes check module + action; services filter rows by scope.
Reads outside scope return 404, writes 403. Live now / Attendance / Reports are Super Admin only.
A Super Admin can send `X-View-As: <userId>` to see exactly what that user sees ("Preview as"); audit entries still name the real admin.

**Responses:** `{ data }` or `{ data, meta }` (lists: `page, pageSize, total, pageCount`); errors
`{ error: { code, message, details?, requestId } }` with 400/401/403/404/409/413/422/429/500. Business-rule errors use the
frontend's wording (e.g. `422 RULE_VIOLATION "Add a task title."`). Postgres unique/FK/check errors map to 409/422.
Timestamps are ISO 8601, calendar days `YYYY-MM-DD`, money in INR.

## Endpoints (`/api/v1`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me`, `POST /auth/change-password`, `/auth/accept-invite`, `/auth/reset-password` |
| Users | `GET/POST /users`, `GET/PATCH/DELETE /users/:id`, `POST /users/:id/{deactivate,reactivate,resend-invite,reset-password,force-logout}` |
| Roles & audit | `GET/POST /roles`, `GET/PATCH/DELETE /roles/:id`, `POST /roles/:id/duplicate`, `GET /audit-logs` |
| People & lists | `GET /members`, `GET/PATCH /members/:id`, `GET /sales-owners`; `/lead-stages`, `/lead-sources`, `/services` (`GET, POST, PATCH /:name, POST /:name/move, DELETE /:name`); `GET/PUT /settings` |
| Leads | `GET/POST /leads`, `GET/PATCH/DELETE /leads/:id`, `PATCH /leads/:id/{status,owner}`, `POST /leads/:id/activities`, `POST /leads/bulk`, `POST /leads/merge`, `GET /leads/duplicates`, `GET /leads/export.csv`, `POST /leads/:id/documents` |
| Quotes | `GET/POST /leads/:id/quotes`, `PATCH /leads/:id/quotes/:qid`, `POST …/:qid/send`, `POST …/:qid/status`, `GET …/:qid/print` |
| Follow-ups | `GET/POST /follow-ups`, `GET/PATCH/DELETE /follow-ups/:id`, `PATCH /follow-ups/:id/toggle-done`, `GET /follow-ups/due-reminders`, `POST /follow-ups/due-reminders/ack` |
| Dashboard | `GET /dashboard/sales?period=7\|30\|90\|ytd\|custom&from=&to=&owner=` |
| Documents | `GET /documents/:id/download`, `PATCH /documents/:id`, `DELETE /documents/:id` (multipart uploads: field `files`, max 10 × 10 MB) |
| Projects | `GET/POST /projects`, `GET /projects/overview`, `GET /projects/capacity`, `GET/PATCH /projects/:id`, `GET /projects/:id/milestones`, `POST /projects/:id/members`, `PUT/DELETE /projects/:id/members/:memberId`, `PUT /projects/:id/links`, `POST /projects/:id/portal`, `POST /projects/:id/documents` |
| Milestones | `GET /milestones?projectId=&status=` (all milestones of visible projects, paginated ≤ 100), `PATCH /milestones/:id`, `POST /milestones/:id/ask-approval` |
| Change requests | `GET/POST /change-requests`, `GET/PATCH/DELETE /change-requests/:id`, `POST /change-requests/:id/actions` (`send/approve/reject/start/done`), `POST …/:id/documents`, `GET …/:id/print` |
| Client portal (public) | `GET /public/portal/:token`, `POST /public/portal/:token/milestones/:id/decision`, `POST /public/portal/:token/change-requests/:id/decision` |
| Tasks | `GET/POST /tasks`, `GET/PATCH/DELETE /tasks/:id`, `PATCH /tasks/:id/checklist` |
| Bugs | `GET/POST /bugs`, `GET/PATCH/DELETE /bugs/:id`, `POST /bugs/:id/comments`, `POST /bugs/:id/attachments` |
| Timesheets | `GET/POST /time-logs`, `DELETE /time-logs/:id`, `GET /time-logs/{summary,matrix,team-hours,export.csv}` |
| My workday | `GET /workday/me`, `GET /workday/state` (caller's live state, same shape as `/live/state`), `POST /workday/{check-in,check-out,break,break/end,timer/start,timer/stop,heartbeat}`, `GET/POST /workday/end-shift` |
| Raw workday data (any staff; Super Admin not previewing = everyone, others = own pid) | `GET /live/state` → `{date, att, timers, idle, feed}`, `GET /attendance/events?from=&to=&person=` → `[{at, personId, kind, meta}]` (default today, ≤ 400 days), `GET /shift-reports?from=&to=&person=` → `[{id, who, d, t, sales, done, blockers, plan, outcome, calls, meetings, rows[{p,ms,h,note}], pm[{p,st,note}]}]` |
| CEO views | `GET /live`, `POST /live/:pid/{check-in,check-out,break,resume,timer/start,timer/stop}`, `GET /attendance`, `GET /attendance/export.csv`, `GET /reports/timeline`, `GET /reports/hours-log`, `GET /reports/hours-log/export.csv` |

Lists accept `?page=&pageSize=` (max 100), `?sort=field` / `-field`, and module filters (see each `*.schemas.js`).
List embeds (`?include=`, one batched query per child kind, unknown names → 422): `GET /leads?include=activities,quotes,documents`,
`GET /projects?include=documents`, `GET /bugs?include=events,attachments` (use `quick=all` for every bug),
`GET /change-requests?include=history,documents`. Follow-ups: `tab=all` returns every follow-up.

## Configuration (`.env`)

`DATABASE_URL`, `TEST_DATABASE_URL`, `PORT`, `CORS_ORIGINS` (comma list), `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`
(≥ 32 chars), `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL_DAYS`, `BCRYPT_ROUNDS`, `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `APP_TZ`
(business time zone, default `Asia/Kolkata` — "today", late-after-10:30, timesheet days), `LOG_LEVEL`.
Blank values (`KEY=`) count as unset.

### Email (SMTP)

Invites, re-sent invites and password resets are emailed (HTML + text) with a one-time link to `APP_URL/accept-invite` or
`APP_URL/reset-password`. Settings: `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (587, STARTTLS; 465 = TLS),
`SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`, `FROM_NAME`, `APP_URL` (frontend base URL; defaults to the first CORS origin).
For Google Workspace use an **App Password** (Google account → Security → 2-Step Verification → App passwords).

When an email is sent, the API response has `emailSent: true` and **no** token (only the recipient can use it). If SMTP isn't
configured or sending fails, the response has `emailSent: false` plus the token, and the UI shows the link for the admin to
share. The SMTP login is checked on startup (logged, never blocks the API). Code: `src/core/mailer.js`,
`src/modules/users/users.emails.js`. Tests never send mail (`tests/email.test.js` uses an in-memory transport).

### File storage (S3)

Every upload (lead/project/CR documents, bug attachments) is streamed straight to S3 — no temp files — under
`documents/YYYY/MM/<uuid><ext>`; the database stores only the object key. Code: `src/core/storage/` (drivers `s3`, `local`),
`middleware/upload.js` (streaming multer engine), `modules/documents`.

| Variable | Production (AWS) | Local dev (MinIO, `npm run storage:up`) |
| --- | --- | --- |
| `STORAGE_DRIVER` | `s3` | `s3` |
| `S3_BUCKET` / `S3_REGION` | your bucket / its region | `mariox-portal-documents` / `ap-south-1` |
| `S3_ENDPOINT` | *(empty)* | `http://localhost:9000` |
| `S3_FORCE_PATH_STYLE` | `false` | `true` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | IAM user keys, or leave both empty to use the instance/task role | `mariox` / `mariox_dev_password` |
| `S3_CREATE_BUCKET` | `false` | `true` |
| `S3_SSE` | `AES256` (or `aws:kms` + `S3_KMS_KEY_ID`) | `none` |
| `S3_DOWNLOAD_MODE` | `proxy` (API streams the file) or `redirect` (302 to a presigned URL, `S3_PRESIGN_TTL_SECONDS`) | `proxy` |
| `S3_PREFIX` | optional key prefix, e.g. `prod/` | — |

Minimum IAM permissions on `arn:aws:s3:::<bucket>/*`: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`. With
`s3:ListBucket` on the bucket the startup check uses HeadBucket; without it the API checks access by writing and deleting a
tiny `_healthcheck/…` object. Keep the bucket private (Block Public Access on) — files are only served through the API.
Tests use the `local` driver (temp dir); `TEST_STORAGE=s3` runs them against S3, and `tests/storage.s3.test.js` checks the
S3 driver against MinIO when it is running.

## Notes and known limits

- **Lead list scoring** (hot / stale / duplicates) is computed in memory over the leads a user can see — fine for
  thousands of leads; move to SQL if the pipeline grows far beyond that.
- **Rules the frontend left to its buttons are enforced here** — e.g. change-request actions must follow
  Draft → Sent → Approved → In progress → Done.
