# Setting up the CMS server

The warehouse machine. It holds the stock, serves the app to every device, and keeps the
store running when the internet is down. Everything else on the network is just a screen
pointed at it.

One machine, one port. `http://<its-ip>:5100` serves **both** the app and the API.

---

## Part 1 — Try it on your own computer first

Do this before you touch the warehouse machine. Same steps, same result, nothing at risk.

### 1. Prerequisites

- **Node.js 20+** — `node --version`
- **PostgreSQL 14+** — installed and running

### 2. Get the code and its dependencies

```bash
git clone https://github.com/cassieaan-svg/envo-wms.git
cd envo-wms
npm install
```

### 3. Create the database

```bash
createdb envo_wms_cms
```

If `createdb` is not on your PATH (normal on Windows), use the full path:
`"C:\Program Files\PostgreSQL\17\bin\createdb" envo_wms_cms`

### 4. Configure it

Copy `backend/.env.example` to `backend/.env` and set:

```ini
PGHOST=localhost
PGPORT=5432
PGDATABASE=envo_wms_cms
PGUSER=postgres
PGPASSWORD=<your postgres password>

PORT=5100
JWT_SECRET=<any long random string — invent one>

# This machine is the warehouse instance.
WMS_ROLE=cms
WMS_ORIGIN=cms
WMS_INSTANCE_ID=cms-uyo

# Cloud. Leave CLOUD_API_URL blank for now if there is no Cloud server yet —
# the warehouse works without it; only synchronisation waits.
CLOUD_API_URL=
SYNC_TOKEN=<a second long random string, shared with Cloud later>

# The warehouse instance must NOT be able to reach EnVo. Leave these empty.
ENVO_API_URL=
SERVICE_TOKEN=
```

`WMS_ROLE` and `WMS_ORIGIN` must agree or the server refuses to start — that is deliberate.

### 5. Create the tables

```bash
npm run migrate --workspace @envo/wms-backend
```

### 6. Claim the CMS id range — once, before any stock

```bash
cd backend
node scripts/initCmsInstance.mjs            # shows what it would do
node scripts/initCmsInstance.mjs --commit   # applies it
cd ..
```

This gives the warehouse its own numbering (from 1,000,000) so its records can never collide
with Cloud's. It **refuses** if the database already holds transactions — if it refuses, stop
and find out why rather than forcing it.

### 7. Build the app

```bash
npm run build --workspace @envo/wms-frontend
```

The server serves what this produces. **Re-run it after every code update**, or devices keep
getting the old app.

### 8. Create the first user

```bash
npm run create-admin --workspace @envo/wms-backend
```

### 9. Start it

```bash
npm start --workspace @envo/wms-backend
```

You should see `EnVo WMS backend listening on :5100`. Open `http://localhost:5100` — the
sign-in screen, with a green dot and "Connected".

If you see JSON instead of the app, step 7 has not been run.

---

## Part 2 — The warehouse machine

Same nine steps, plus the four below. Do them in this order.

### 10. Give the machine a fixed address

A DHCP reservation on the router, or a static IP. **Do this before setting up any device.**

This is required, not advisory. Devices talk to whichever address they were installed from,
and the app has no setting to change it — that is deliberate, so warehouse staff cannot
break their own device. If this machine's address changes, every device must be uninstalled
and reinstalled at the new address.

Note the address — `ipconfig`, the IPv4 line on the warehouse network. Say `192.168.1.20`.

### 11. Let devices through the firewall

Windows blocks incoming connections by default, so devices will not reach the server without
this. In an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "CMS Warehouse" -Direction Inbound -LocalPort 5100 `
  -Protocol TCP -Action Allow -Profile Private
```

`-Profile Private` restricts it to networks Windows treats as private — make sure the
warehouse network is set to Private, not Public.

Check from another device's browser: `http://192.168.1.20:5100` should show the sign-in
screen. **Do this before setting up any device** — it is the step most likely to be wrong.

### 12. Make it start on boot and stay running

Without this the warehouse stops the first time the machine reboots overnight. Install
[NSSM](https://nssm.cc/), then in an **Administrator** prompt:

```
nssm install CMS-Warehouse "C:\Program Files\nodejs\node.exe" "src\server.js"
nssm set CMS-Warehouse AppDirectory "C:\envo-wms\backend"
nssm set CMS-Warehouse Start SERVICE_AUTO_START
nssm start CMS-Warehouse
```

Set PostgreSQL's service to Automatic as well (it usually already is).

Reboot the machine and confirm the app is reachable without anyone logging in.

### 13. Schedule the backup

Between syncs this machine is the **only** place the warehouse's stock exists. Target is at
most one hour of work lost.

Task Scheduler → Create Task → run whether logged on or not → Trigger: daily, repeat every
1 hour indefinitely → Action:

```
Program:   C:\Program Files\nodejs\node.exe
Arguments: scripts\backup.mjs
Start in:  C:\envo-wms\backend
```

Set `BACKUP_DIR` in `backend/.env` to a **different physical disk** or a network share — a
backup on the same disk does not survive that disk failing.

Test it once by hand first: `node scripts/backup.mjs` should write a `.dump` and report how
many transactions are at risk.

---

## Then set up the devices

See `docs/WAREHOUSE_DEVICE_SETUP.md`. Short version: browse to `http://192.168.1.20:5100`,
install it from the browser menu, sign in.

---

## Updating later

```bash
git pull
npm install
npm run migrate --workspace @envo/wms-backend
npm run build --workspace @envo/wms-frontend
nssm restart CMS-Warehouse
```

Migrations never run by themselves — that step is not optional. Devices will offer
**Update now** the next time they are opened.

---

## When something is wrong

| Symptom | Cause |
|---|---|
| JSON instead of the app | The frontend has not been built — step 7 |
| Devices cannot reach it, the server machine can | Firewall — step 11 — or the network is set to Public |
| Worked yesterday, not today | Machine rebooted and the service is not installed — step 12 |
| Devices worked, now say "server unavailable" | The machine's IP changed — step 10. Restore the old address on the router, or reinstall the app on each device |
| Server will not start, complains about role | `WMS_ROLE` and `WMS_ORIGIN` disagree in `.env` |
| Amber bar, "waiting to reach Cloud" | Normal. The internet is down; the warehouse is fine |

The amber bar is not a fault. It means work is being recorded and held for Cloud. Only the
**red** bar — "Warehouse server unavailable" — means the warehouse cannot record anything.

## Cloud, when there is one

Nothing above depends on a Cloud server. When one exists, set `CLOUD_API_URL` and a matching
`SYNC_TOKEN` on both machines and restart; held work goes up on its own. Once the warehouse
has run on CMS successfully, set `CLOUD_STOCK_AUTHORITY=false` on **Cloud** — that hands
stock authority to the warehouse for good, and is the one step that should be done
deliberately rather than in passing.
