# Setting up a warehouse device

> The CMS server serves **both the app and the API on one port**, so a device only ever
> needs one address: `http://<cms-ip>:5100`. Setting up the server itself is a separate
> document — see `docs/CMS_SERVER_SETUP.md`.

The warehouse app runs on any device on the store's network — a laptop, a desktop at the
issuing counter, or a tablet. It talks to the **CMS server** over the LAN, and it keeps
working when the internet is down.

The one thing worth understanding before anything else:

| | What it means | What still works |
|---|---|---|
| **Internet down** | Cloud and EnVo cannot be reached | **Everything.** Receiving, dispatch, requests already received, adjustments, printing. Work is recorded and sent to Cloud on its own when the internet returns. |
| **CMS server down** | The warehouse server itself is not reachable | **Nothing.** The app will say so plainly. Start the CMS server; nothing has been lost. |

Those two are different problems and the app never confuses them.

## 1. Find the CMS server address

On the CMS server machine, at a command prompt:

```bash
ipconfig
```

Take the IPv4 address on the warehouse network — something like `192.168.1.20`. The server
address is that plus the port: `192.168.1.20:5100`.

**The CMS machine must have a DHCP reservation or a static IP.** This is not optional. A
device talks to whichever address it was installed from, and there is no way to re-point it
from the app — deliberately, so that warehouse staff cannot break their own device. If the
CMS machine's address changes, every device has to be uninstalled and reinstalled at the new
address. Set the reservation on the router before you set up a single device.

## 2. Install the app on the device

Open **Edge** or **Chrome** and go to the server address:

```
http://192.168.1.20:5100
```

Then:

- **Edge** — the ⋯ menu → **Apps** → **Install this site as an app**
- **Chrome** — the ⋮ menu → **Cast, save and share** → **Install page as app**
  (older versions: the install icon at the right of the address bar)

Name it **CMS Warehouse**. It gets its own icon in the Start menu and taskbar, and opens in
its own window with no address bar — it behaves like any other installed program.

> Installing is not required. The app works in a normal browser tab. Installing gives it an
> icon, its own window, and a shell that loads even with no internet.

## 3. Sign in

The sign-in screen shows a green dot and **Connected** when it can reach the CMS server. If
it cannot, it says so plainly and shows the server address it tried — check that before
assuming a password is wrong.

Normal username and password. Authentication is handled by the **CMS server**, not by Cloud,
so **signing in works with the internet down** and keeps working for as long as the store
needs it to.

---

## Day-to-day

### The bar at the top of the screen

Nothing is shown when everything is normal.

- **Amber — "Working — waiting to reach Cloud"**
  The internet is down. Everything is being recorded normally. The held work sends itself
  when the connection is back. **Carry on as usual.**

- **Red — "Warehouse server unavailable"**
  The CMS server cannot be reached. Check it is switched on and running, and that this
  device is on the warehouse network. Nothing has been lost.

### Printing

Printing is done by the device, not by Cloud, so it works with the internet down. The first
copy of a waybill is the **Original**; each further copy is marked **REPRINT #1**, **#2** and
so on, both beside the voucher number and as a watermark across the sheet. Reprinting never
moves stock and never creates a second dispatch.

### Updates

When a new version is installed on the server, the app offers **Update now**. It waits to be
asked, so it will not reload while someone is part-way through keying a dispatch.

---

## Optional: a desktop shortcut instead of installing

If a device cannot install the app — an old browser, or a locked-down profile —
`tools/CMS-Warehouse.cmd` opens it in its own window using whichever of Edge or Chrome is
present. Edit the address at the top of the file, then right-click it → **Send to → Desktop**.

This is a fallback. Installing the app properly (step 2) is better: it survives reboots,
appears in the Start menu, and caches the shell so it opens without the internet.

## What is deliberately NOT installed on the device

There is no database on the tablet, and no queue of transactions in the browser. Stock lives
in one place — the CMS server — and every device reads and writes it over the LAN. That is
what makes two people picking at the same time safe, and it is why the app is honest when the
server is unreachable instead of pretending to accept work it cannot record.
