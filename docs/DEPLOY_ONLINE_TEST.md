# Deploying an online test version (Supabase + Render)

A test deployment for trying the app from anywhere, not the offline-first warehouse setup —
see `docs/CMS_SERVER_SETUP.md` for that. One Render Web Service runs the backend, which
serves the API **and** the built frontend from one URL, exactly like the local CMS server
(`tools/Start-CMS-Server.cmd`). No separate frontend host is needed.

Netlify is not part of this: it hosts static sites and short-lived serverless functions, and
this backend is a persistent Express process with background workers (outbox delivery,
reconciliation, Cloud↔CMS sync — see `backend/src/server.js`) that need a long-running host.

## 1. Create the Supabase project

1. [supabase.com](https://supabase.com) → New project. Pick a region, set a database
   password (save it — you'll need it below), and wait for it to finish provisioning.
2. Project → **Connect** (or Settings → Database) → copy the values under **Connection
   parameters**: Host, Port, Database name, User, Password. Use the **direct connection**,
   not the pooled (pgbouncer, port 6543) one — this is one persistent Render service with a
   normal connection pool, not a swarm of serverless functions, so the direct connection is
   simpler and avoids pgbouncer's prepared-statement quirks.

## 2. Run the migrations against Supabase

From your machine, one time, pointed at Supabase instead of local Postgres:

```bash
cd backend
PGHOST=<supabase host> PGPORT=5432 PGDATABASE=postgres PGUSER=<supabase user> \
  PGPASSWORD=<supabase password> PGSSLMODE=require npm run migrate
```

This creates every table fresh — Supabase starts empty. If you want the full commodity
catalogue from the start, also run:

```bash
PGHOST=... PGPORT=5432 PGDATABASE=postgres PGUSER=... PGPASSWORD=... PGSSLMODE=require \
  node scripts/createAdminUser.mjs <username> <password> admin "Full Name"
```

(Swap in the real `PG*` values both times — this repeats them for clarity, not because
they differ.)

## 3. Deploy to Render

1. Push this repo to GitHub if it isn't already there — Render deploys from a repo, not a
   local folder.
2. [render.com](https://render.com) → New → **Blueprint** → pick the repo. Render reads
   `render.yaml` at the repo root and proposes one Web Service, `envo-wms`.
3. It prompts for the values marked `sync: false` in `render.yaml` — paste in the Supabase
   `PGHOST`, `PGUSER`, `PGPASSWORD` from step 1. Everything else (`JWT_SECRET`, `PORT`,
   `PGSSLMODE`, the `WMS_*` role vars) is already set in the blueprint.
4. Deploy. First build takes a few minutes (`npm install` + the frontend's Vite build).

Render's free plan spins the service down after 15 minutes idle — the first request after
that takes ~30–50s to wake it back up. Normal for a test deployment, not a bug.

## 4. Check it

Open the Render URL (`https://envo-wms-xxxx.onrender.com`, or whatever Render assigns). You
should see the sign-in screen. `https://<that-url>/health` should return
`{"ok":true,...}` — if it returns something else, the frontend build didn't complete; check
the Render build logs.

## What this test deployment deliberately doesn't do

- **No EnVo integration.** `ENVO_API_URL`/`SERVICE_TOKEN` are left unset, so the facility
  stock proxy and request status callbacks won't reach a real EnVo — fine for testing the
  WMS on its own.
- **No CMS/warehouse split.** It runs as the default `cloud` role. If you later want to test
  the offline-capable warehouse side too, that's a second deployment (or a local CMS
  instance) with `WMS_ROLE=cms`, per `docs/CMS_SERVER_SETUP.md`.
- **No scheduled backups.** `BACKUP_DIR` is unset. Supabase's own automatic backups (on paid
  plans) or manual `pg_dump` cover a test environment; `scripts/backup.mjs` is for the local
  warehouse machine.

## Secrets

Nothing here goes in git. `render.yaml` only names which environment variables the service
needs — every actual value (Supabase credentials, the generated `JWT_SECRET`) lives in
Render's dashboard, never in the repo. Use a fresh `JWT_SECRET` for this deployment; don't
reuse a value from your local `.env` — `render.yaml` already generates one automatically.
