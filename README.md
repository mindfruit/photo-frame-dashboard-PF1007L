# Taking over Android photo frames

Turn a cheap Android photo frame into a family dashboard: unlock it, root it, replace the vendor app, and run your own web page full screen.

**TLDR:** buy a $50 frame, point an agent at this repo and let 'er rip!

[![The family dashboard running on the BIUFRAME 10.1" photo frame](docs/images/dashboard-on-frame.jpg)](https://youtu.be/ZLycoUMltNI)

▶️ **Watch the video: [https://youtu.be/ZLycoUMltNI](https://youtu.be/ZLycoUMltNI)**

## Working frames

<a href="https://amzn.to/4zneGNM"><img src="docs/images/devices/B0GHR65YYX.jpg" width="110" alt="10.1&quot; frame from the video (now often ships the PF1007L)" title="10.1&quot; frame from the video (now often ships the PF1007L)"></a>
<a href="https://amzn.to/4B38DQ0"><img src="docs/images/devices/B0FSZ86HTM.jpg" width="110" alt="Runxion 10.1&quot; Frameo" title="Runxion 10.1&quot; Frameo"></a>
<a href="https://amzn.to/4zwU6e0"><img src="docs/images/devices/B0GCCFPHZ4.jpg" width="110" alt="15.6&quot; Frameo" title="15.6&quot; Frameo"></a>
<a href="https://www.amazon.com/dp/B0CQN2PKQR?tag=webo080-20"><img src="docs/images/devices/B0CQN2PKQR.jpg" width="110" alt="Pastigio FRAME156 15.6&quot; Frameo" title="Pastigio FRAME156 15.6&quot; Frameo"></a>
<a href="https://www.amazon.com/dp/B0D8J5PNFH?tag=webo080-20"><img src="docs/images/devices/B0D8J5PNFH.jpg" width="110" alt="Dragon Touch Modern10 Charm" title="Dragon Touch Modern10 Charm"></a>
<a href="https://www.amazon.com/dp/B0C9V811L6?tag=webo080-20"><img src="docs/images/devices/B0C9V811L6.jpg" width="110" alt="Skylight Calendar 15&quot;" title="Skylight Calendar 15&quot;"></a>
<a href="https://www.amazon.es/dp/B0GGB7LWX8"><img src="docs/images/devices/B0GGB7LWX8.jpg" width="110" alt="Humblestead 10.1&quot; (Amazon Spain, PF1007L)" title="Humblestead 10.1&quot; (Amazon Spain, PF1007L)"></a>
<a href="https://www.amazon.ca/dp/B0H4W1YPHH"><img src="docs/images/devices/B0H4W1YPHH.jpg" width="110" alt="Anna Bella 10.1&quot; (Amazon Canada, PF1007L)" title="Anna Bella 10.1&quot; (Amazon Canada, PF1007L)"></a>

Frames confirmed to work (Amazon affiliate links). See the **[device index](docs/devices.md)** for every
frame, which board it has, and where to start.

## Community builds

30 people have shared their hacked frames in [Community builds](docs/community-builds.md): LCARS
interfaces, retro weather channels, chess puzzles, Linux on a frame, family dashboards and more.

<a href="docs/community-builds.md"><img src="docs/images/community/JesseWaites-11.jpg" height="90" alt="Star Trek LCARS interface" title="Star Trek LCARS interface"></a>
<a href="docs/community-builds.md"><img src="docs/images/community/derekparks-dev-14.jpg" height="90" alt="Retro weather-channel display" title="Retro weather-channel display"></a>
<a href="docs/community-builds.md"><img src="docs/images/community/tushargugnani-10.jpg" height="90" alt="Chess puzzles and analytics" title="Chess puzzles and analytics"></a>
<a href="docs/community-builds.md"><img src="docs/images/community/redp314-23.jpg" height="90" alt="Omarchy Linux on an A33 frame" title="Omarchy Linux on an A33 frame"></a>
<a href="docs/community-builds.md"><img src="docs/images/community/rida-18.jpg" height="90" alt="Family dashboard" title="Family dashboard"></a>
<a href="docs/community-builds.md"><img src="docs/images/community/onurceri-36.jpg" height="90" alt="FamilyOS" title="FamilyOS"></a>

Notes and scripts from getting full control of locked-down Android photo frames: getting ADB,
backing up the firmware, getting root, removing the vendor app, and running our own launcher,
browser and kiosk app. These are records of the units their owners tested, not universal flashing
guides.

## Which frame do you have?

Frames sold under the same name, even the same Amazon listing, can have different boards. Check
Settings → About before you follow any guide:

- **PF1007L / AiMOR** (firmware string contains `A33` and `PF1007L`): Allwinner A33. Many viewers of
  the video got this one. Use a **USB-A to USB-C** data cable; USB-C to USB-C gives no power or data.
  Start with [pf1007l-start-here.md](docs/pf1007l-start-here.md). It tests
  ADB over USB, then the network, and only then a boot patch. Its vendor app accepts root shell
  commands from the vendor's server, so read that page before the frame goes online.
- **BIUFRAME / Synergy 10X1** (Rockchip RK3126, ADB prompt on screen): the frame in the video. Follow
  [biuframe-setup-guide.md](docs/biuframe-setup-guide.md). `scripts/biuframe-setup.sh check`
  changes nothing and confirms the hardware matches; `backup` and `apply` do the rest.
- **Skylight Calendar 150-CAL** (Rockchip RK3566): start with [next-session.md](docs/next-session.md),
  then [app-analysis.md](docs/app-analysis.md) for the hidden menu. The manufacturer code is
  intentionally not published; the doc shows where the app checks it.
- **Frameo, Dragon Touch, Joyhong, Uhale, VESWWE, Pastigio and others:** see the
  [device index](docs/devices.md).
- **Something else:** work through the [phase map](#phase-map), create `docs/<device>.md`, and
  [send in what you find](#check-for-updates-and-send-back-what-you-find).

## The dashboard

[`dashboard/`](dashboard) is the family dashboard we run on the BIUFRAME (it uses mock data): a Vite
web app deployed to Cloudflare Workers. `dashboard/kiosk/` is a small full-screen WebView Android app,
built without Gradle, that shows it. Hold two fingers still for 1.5 s to open a menu for the
launcher, Android settings, and reloading. On frames without system navigation, optional floating
**Back** and **Dashboard** buttons help; see the [kiosk guide](dashboard/kiosk/README.md).

## Hosting / moving to another machine

Run the family dashboard from [`dashboard/`](dashboard) on a always-on Mac (this machine today,
or a Mac mini later). Production is the Node server on port **3030** serving the Vite build —
not the Vite dev server.

### Requirements

- **Node 20** (tested on v20.19). No Docker.
- On Node &lt; 22.5 the optional dependency `better-sqlite3` provides SQLite; on Node ≥ 22.5 the
  server prefers built-in `node:sqlite` and falls back to `better-sqlite3` if needed
  (`dashboard/server/db.js`).
- After `npm ci` on a new machine/arch, rebuild the native module:
  `npm rebuild better-sqlite3`.

### Production run (no Vite)

```sh
cd dashboard
npm ci
npm rebuild better-sqlite3   # needed on a new host / after Node upgrades
npm run build                # vite build → dashboard/dist/
PORT=3030 node server/index.js
# or: npm run start          # build then node server/index.js
# or: npm run server         # node server/index.js only (expects dist/ already built)
```

The server listens on `0.0.0.0:${PORT||3030}`, serves `dashboard/dist/` as the static site,
`/admin` as the parent page, `/api/*`, and `/photos/*`. Do **not** run `npm run dev` /
`npm run dev:all` on the hosting machine for day-to-day use — those start Vite on :5173 and
proxy to :3030; frames should hit **:3030** directly.

### What to copy

| Item | Path / how | Notes |
| --- | --- | --- |
| Database | `dashboard/server/data.db` | Stop the server first, then WAL-checkpoint (`PRAGMA wal_checkpoint(TRUNCATE);`) so `-wal`/`-shm` are flushed into `data.db`. Override path with env `DB_FILE` if you use one. |
| Env | `dashboard/server/.env` | Optional. Loaded only for keys not already in the process env. Known keys used here: `CAL_*` (secret iCal URLs imported once), `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN`, plus optional `PORT`, `PHOTOS_DIR`, `DB_FILE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TZ`, `GP_*`. **Never commit `.env`.** |
| Photos | `dashboard/server/photos/` by default | Folder resolution: env `PHOTOS_DIR` (wins) → admin setting `photos_dir` → `server/photos` (`dashboard/server/storage.js`). Copy the folder that is actually in use. |
| Kiosk signing keystore | `~/.android/debug.keystore` | `dashboard/kiosk/build.sh` signs with this path. Copy it only if you want APK upgrades to keep the same signature on the new host; otherwise a fresh debug keystore is fine and you reinstall the APK. |

HA URL + token also live in SQLite settings (`ha_url` / `ha_token`) when configured in Admin.
Google OAuth client id/secret may be in `.env` **or** in settings (`google_client_id` /
`google_client_secret`). Either side is enough as long as one of them is set on the new host.

### LaunchAgent (auto-start on login)

Template: [`dashboard/scripts/com.mindfruit.photoframe.plist.template`](dashboard/scripts/com.mindfruit.photoframe.plist.template).

1. Copy to `~/Library/LaunchAgents/com.mindfruit.photoframe.plist`.
2. Replace `__WORKING_DIRECTORY__` with the absolute path to `…/dashboard` on the new host,
   and `__NODE__` with `$(which node)` (nvm/Homebrew path).
3. Logs go to `~/Library/Logs/photoframe.out.log` and `photoframe.err.log` (edit in the plist).
4. Load: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mindfruit.photoframe.plist`
   (or `launchctl load` on older macOS). Unload before migrating again.

`KeepAlive` + `RunAtLoad` keep the server up after login/reboot.

### Fixed LAN IP

Give the host a DHCP reservation in eero (or your router) so frames keep a stable
`http://<ip>:3030/` URL. Note the reserved IP before you move hardware.

### Repointing frames

Kiosk saved URL is in the app’s SharedPreferences; compile-time fallback is
`MainActivity.DEFAULT_URL` (currently a Vite `:5173` URL in source — change it before a
release build if you want a sensible default).

On a frame with ADB:

```sh
adb shell am start -a android.intent.action.VIEW \
  -d 'http://<new-ip>:3030/?device=frameo' \
  -n com.wesbos.homehq/.MainActivity
```

Or use the kiosk two-finger menu → change dashboard URL. Prefer `?device=NAME` so Admin →
Screens keeps the same screen profile.

### Google Photos picker OAuth

`redirectUri()` in `dashboard/server/google-photos.js` is hard-coded as:

`http://localhost:${PORT||3030}/api/google/callback`

So **Connect Google** must be completed in a browser **on the server host** (localhost). If
you change host name or port, update the authorized redirect URI in the Google Cloud OAuth
client to match, and update any saved client id/secret.

### Home Assistant

HA base URL + long-lived token are stored in settings (and/or `.env` as
`HOME_ASSISTANT_URL` / `HOME_ASSISTANT_TOKEN`). Moving the dashboard host does **not** change
the HA URL if HA stays on the same machine/URL. Re-test Admin → Home Assistant after the move.

### Backups

- Copy `data.db` after a checkpoint (or `sqlite3 data.db ".backup backup.db"`).
- Copy the photos directory (thousands of files).
- Keep `.env` somewhere safe offline; it is gitignored.

### Migrate script

[`dashboard/scripts/migrate-host.sh`](dashboard/scripts/migrate-host.sh) stops the local :3030
listener, checkpoints SQLite, and `rsync`s the repo + `data.db` + `.env` + photos to
`user@host` with checksum verify. It never uses `--delete`. Example:

```sh
cd dashboard
./scripts/migrate-host.sh --dry-run you@mac-mini.local
./scripts/migrate-host.sh you@mac-mini.local ~/Projects/photo-frame-dashboard-PF1007L
```

Then on the remote: `npm ci && npm rebuild better-sqlite3 && npm run build`, install the
LaunchAgent, reserve the IP, repoint frames, and re-do Google Connect in a local browser if needed.

## For agents: start here

You are probably helping someone with a similar device plugged into a Mac over USB. Read this
section, then follow the links for the phase you are in. Do not run anything from a device
section unless the identity checks match exactly.

### Rules we learned the hard way

1. **Ask the owner before every write.** Reads are fine. Writing flash, a partition, `/system`,
   or sending a RAM payload to the SoC needs explicit approval for that specific action.
2. **No writes before a verified backup**: exact byte count, SHA-256, gzip readback, a check for
   `0xCC` filler, and independent re-reads of a few partitions that match.
3. **Don't trust `OKAY`.** Fastboot reported a successful boot write on the Skylight that never
   took effect. Verify writes by reading them back and checking the result on the device.
4. **Stop at the first mismatch** in a hash, model string, offset or size. Report it rather than
   working around it.
5. **One change at a time, undo recorded first.** Keep `.bak` copies next to edited files.
6. **Pin downloads by SHA-256** from official sources (vendor archives, F-Droid, LineageOS, GitHub releases).
7. **Keep dumps private.** They contain Wi-Fi passwords, tokens, serials, MAC addresses and
   copyrighted firmware. Use the ignored `backups/` and `diagnostics/` folders. Leave unique
   identifiers out of anything you commit.
8. **Write notes as you go.** Keep a per-device file in `docs/`, like the ones in the
   [device index](docs/devices.md), with
   observations kept separate from guesses.

### Check for updates, and send back what you find

Many people are working on these frames at the same time. New hardware variants, fixes and
routes arrive as issues and pull requests, often before they are merged. Your local copy may be
out of date.

**Check before you start, and again before each write and at the start of each new session:**

```sh
git fetch origin && git log --oneline HEAD..origin/main   # new commits on main
gh issue list --repo wesbos/photo-frame-dashboard --state all --limit 30
gh pr list --repo wesbos/photo-frame-dashboard --state all --limit 30
gh pr view <number> --repo wesbos/photo-frame-dashboard   # read anything about your device
gh pr diff <number> --repo wesbos/photo-frame-dashboard
```

Without `gh`, use <https://github.com/wesbos/photo-frame-dashboard/issues> and
<https://github.com/wesbos/photo-frame-dashboard/pulls>. Read open PRs about your device, not only
merged docs. If newer information contradicts these docs, tell the owner and follow the newer
information only after its checks pass on your unit. Unmerged PRs are less reviewed, so treat their
scripts with extra care.

**Send a pull request when you learn something new** about a device that is already documented or
about a new one. Examples: a new board or firmware string, a different boot image hash, a cable or
port that does or does not work, a step that failed, a better route, or a correction. Failed
attempts are useful too.

1. Check open issues and PRs first. If one already covers your finding, comment there instead.
2. Create a branch, and add your observations to the device doc in `docs/`. For a new device,
   create `docs/<device>.md`. Keep observations separate from guesses, and say which host OS and
   which unit you used.
3. Remove private data: serials, MAC addresses, Wi-Fi details, eMMC CIDs, tokens, whole-disk
   hashes, dumps and vendor APKs. Firmware strings and boot image hashes are fine.
4. Show the owner the diff, because the PR is published under their GitHub account. Then open it
   with `gh pr create --repo wesbos/photo-frame-dashboard`.

For a PF1007L, include the [report template](docs/pf1007l-start-here.md#report-your-unit).

### Phase map

| Phase                        | What to read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Identify** the hardware | USB IDs (Rockchip is VID `2207`), `adb shell getprop`, chip query in loader mode. See the hardware tables in [biuframe.md](docs/biuframe.md#hardware-and-ports) and [hardware-research.md](docs/hardware-research.md).                                                                                                                                                                                                                                                                                                                                                                           |
| **2. Get ADB**               | Try in this order: **(1) over USB** (`adb devices`; accept any "Allow USB debugging" prompt on the screen), **(2) over the network** (`adb connect <ip>:5555`), **(3) only then** a vendor-app trick or a boot patch. The PF1007L boot patch is written from an SD card, see [pf1007l-start-here.md](docs/pf1007l-start-here.md#test-sequence). Ideally no one needs (3). For a vendor-app trick, decompile the vendor app (jadx) and look for hidden tap counters and code dialogs: [app-analysis.md](docs/app-analysis.md). Gestures that did _not_ work are in [research-log.md](docs/research-log.md#ui-attempts-that-did-not-work).                                                                                                                                                                                                                                                                       |
| **3. Loader mode**           | Skylight: hold Volume − while connecting power. BIUFRAME: reset button at power-on (unconfirmed). Building `rkdeveloptool` on Apple silicon: [research-log.md](docs/research-log.md#loader-mode--successful).                                                                                                                                                                                                                                                                                                                                                                                    |
| **4. Back up**               | If loader reads past 32 MiB return `0xCC` filler, they are not a backup: [loader-research.md](docs/loader-research.md). Patched helper and full capture: `scripts/patch-usb-reader.py`, `scripts/load-usb-reader.py`, `scripts/probe-reader.py`, `scripts/backup-flash.py`, `scripts/inspect-backup.py`. With root, back up over ADB instead: `scripts/biuframe-setup.sh backup`.                                                                                                                                                                                                                |
| **5. Root**                  | First check for a shipped `su` (`adb shell su -c id`). On Android 10+ user builds, try the debug-ramdisk route: [debug-ramdisk-research.md](docs/debug-ramdisk-research.md), `scripts/build-debug-boot.py`. Fastboot write failures: [ram-boot-research.md](docs/ram-boot-research.md).                                                                                                                                                                                                                                                                                                          |
| **6. Make it useful**        | Launcher: [android-launcher.md](docs/android-launcher.md). Old Android (6.x) with a browser, WebView swap, CA roots, swap, nav bar and disabling vendor apps: [biuframe-setup-guide.md](docs/biuframe-setup-guide.md). Kiosk app and launcher database edits: [biuframe.md](docs/biuframe.md#custom-webview-kiosk-app-2026-09-30). A working example of a kiosk app and dashboard is in [`dashboard/`](dashboard). Build with `dashboard/kiosk/build.sh` (macOS/Linux) or `dashboard/kiosk/build.ps1` (Windows), change `DEFAULT_URL` in `MainActivity.java` to your own URL, and target the device's WebView version (see `dashboard/vite.config.js`). |
| **7. Networking**            | USB reverse tethering with gnirehtet: [usb-internet-sharing.md](docs/usb-internet-sharing.md). An app that requires Wi-Fi specifically: [onboarding-network-gate.md](docs/onboarding-network-gate.md). Dead onboard Wi-Fi and a USB dongle: [usb-wifi-dongle.md](docs/usb-wifi-dongle.md).                                                                                                                                                                                                                                                                                                       |
| **8. Vendor updates**        | Connecting the stock app to the internet can auto-install APK updates: [app-updates.md](docs/app-updates.md). Disable vendor updaters (FOTA etc.) before going online.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **9. Security hand-off**     | Tell the owner what they now have: [biuframe-setup-guide.md](docs/biuframe-setup-guide.md#read-this-first).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Other docs

- Skylight Wi-Fi investigation: [live-diagnostics.md](docs/live-diagnostics.md),
  [native-wifi-root-tests.md](docs/native-wifi-root-tests.md),
  [wifi-firmware-candidate.md](docs/wifi-firmware-candidate.md),
  [recovery-wifi-diagnostics.md](docs/recovery-wifi-diagnostics.md),
  [device-test-wifi.md](docs/device-test-wifi.md), [static-iw.md](docs/static-iw.md)
- Skylight boot and recovery: [boot-analysis.md](docs/boot-analysis.md),
  [recovery-analysis.md](docs/recovery-analysis.md)
- Replacing Android: [android-replacement.md](docs/android-replacement.md),
  [android14-dsu.md](docs/android14-dsu.md) (Android 14 GSI trial through DSU)
- [external-networking.md](docs/external-networking.md)

## Privacy

`backups/`, `diagnostics/`, `log/`, loader query output and machine-local settings are excluded by
`.gitignore`. They hold full flash dumps, decompiled vendor code, signing keys, and the unit's
identifiers. Do not commit them, and do not publish dumps or vendor APKs.
