# Launcher audit

Status: **Step 2 in progress (fixing in order of severity).** Resume at the first `[ ]` item. Nothing is pushed, published or deleted.

Scope: the whole launcher at commit `f422687` (app/, src/, config/, package.json, installer settings). `npm test`: 97 pass, 0 fail. `npm audit`: 3 moderate (see L5).

Each item: what it is · where · how bad · how a player notices · planned fix. `[ ]` = to do, `[~]` = in progress, `[x]` = done (with the commit).

---

## High

- [x] **H1. Network calls never time out.** *(Done: 30 s per small request, downloads end after 60 s with no new bytes; `test/net.test.js`.)* `src/net.js:15` (`getJson`), `:47` (`download`), `:79` (`fetchSha1`), `src/channel.js:34` (`fetchText`), `src/auth.js:137` (`api`), `src/modrinth.js:44`, `src/skin.js:13,23`. Node's `fetch` has no default timeout; a stalled connection (Wi-Fi drop mid-download, captive portal, a server that stops answering) waits forever.
  *Player:* the Play button stays on "Checking for Azure updates…" / "Downloading…" for ever; there is no Cancel, only closing the launcher.
  *Fix:* one `fetchWithTimeout` (AbortSignal: 15 s to the first byte, 60 s with no data while streaming) used everywhere; tests with a server that never answers.

- [x] **H2. The instance list can be wiped by a crash or power cut during a save.** *(Done: `src/atomic.js` writes to a temp file, flushes, then renames; used for instances, settings, content, Fabric profile, mod-fix journal, undo and applied files. A damaged instances, settings or content file is kept as `<file>.broken-<time>`, never overwritten. Same files and format as before. `test/atomic.test.js`.)* `src/instances.js:62`, `src/settings.js:62`, `src/content.js:60`, `src/fabric.js:13`, `src/modfix.js:29` write JSON straight over the old file (`writeFileSync`). A half-written `instances.json` fails to parse; `InstanceStore` then starts empty and re-creates only the default instance (`src/instances.js:52-57`).
  *Player:* after a crash or a power cut every instance except the default one is gone from the list (the folders and worlds are still on disk but not shown).
  *Fix:* write to `file.tmp` then rename (as `src/vault.js:45` and `src/queue.js:48` already do), keep one `.bak`, and read the `.bak` when the main file is damaged.

- [x] **H3. Two launchers can run at the same time.** *(Done: `app.requestSingleInstanceLock()` before anything starts; a second start quits and brings the open window to the front. Source test in `test/app.test.js`; not run as two real windows.)* No `app.requestSingleInstanceLock()` anywhere (`app/main.js`, `app/app.js:857`). Both write the same settings, instances, vault and mod queue, and each can start a game.
  *Player:* double-clicking the shortcut twice opens two windows; both can press Play; settings or accounts changed in one are overwritten by the other; mod changes can be applied twice.
  *Fix:* single-instance lock; a second start focuses the open window instead.

- [~] **H4. Launcher self-updates trust the GitHub release alone.** *(Code done: after download the launcher fetches `launcher-update.json` + `.sig` from that version's release and refuses the update unless the Ed25519 signature matches `config/launcher-update-key.txt` and the installer's SHA-256 and version match; no install on quit before that; no key built in = every update refused. Signing tool `tools/sign-update.js` (private key only in `%USERPROFILE%\.azure-launcher-update-key`). Tests: `test/updatesig.test.js`, `test/selfupdate.test.js`. Still open: the maintainer runs `keygen` once and approves the new RELEASE.md steps; then `tools/check-package.js` requires the key.)* `src/selfupdate.js:42` (`provider: 'github'`), package.json `signAndEditExecutable` without a certificate. electron-updater checks the installer's SHA-512 against `latest.yml`, but both come from the same GitHub release; there is no Ed25519 check like the Legit jar has (`src/channel.js:40-47`). Anyone with write access to the GitHub repo (a leaked token) can ship code to every player, who would install it silently (auto-update is on by default).
  *Player:* nothing visible until it is abused.
  *Fix:* sign `latest.yml` (or the installer's SHA-512) with the existing Azure release key; verify the signature in the updater before `quitAndInstall`, refuse otherwise. No new dependency.

- [x] **H5. Personal email in the public repo. Decided: keep the Gmail.** `config/launcher.config.json:7` (`contactEmail`), shown on the About card. The maintainer chose to keep it everywhere public (launcher config, About card, README, website legal and privacy pages, Modrinth text). Nothing changed, git history not rewritten.
  *Player:* sees the address on the About page.
  *Fix:* needs your choice: a separate contact address or a contact form link. **Asking before changing.**

## Medium

- [x] **M1. The launcher guard no longer matches the mod's guard.** *(Done: `src/guard.js` has the same OWN_SOUNDS list (name + SHA-256); any other .ogg is refused; .zip/.mrpack/.jar inside the jar are opened and checked the same way (depth 3). `test/guard.test.js`, with a list-match test against the mod repo when `AZURE_MOD_REPO` is set.)* `src/guard.js` has no sound-file allow-list; `tools/check_legit_jar.py` (mod repo) now refuses any `.ogg` that is not on its own-sounds list. The header comment (`src/guard.js:2`) says they are the same check.
  *Player:* nothing, unless a jar with Mojang audio got through (the build guard would still catch it).
  *Fix:* add the same allow-list (name + SHA-256) to `guard.js`, plus a `guard.test.js` (there is none today).

- [x] **M2. Every start re-hashes every game file.** *(Done: `<game folder>/hash-cache.json` remembers each checked file's hash with its size and modified time; an unchanged file is not read again, a changed one is hashed and re-downloaded if wrong. Fabric libraries already checked against their `.sha1` don't ask the server again. A cache only: deleting it is safe. `test/net.test.js`. Start time on a real install not measured yet (with M12).)* `src/net.js:42` hashes an existing file each time; `src/install.js:169` runs it over every asset object (thousands, hundreds of MB), plus libraries, the client jar and the Java runtime check.
  *Player:* "Preparing" takes noticeably long on every Play, much longer on a hard disk.
  *Fix:* full hash on first install, then a small index (path, size, mtime, hash) so unchanged files are not re-read; full re-check only when size or mtime differ, or on "Repair".

- [x] **M3. Java runtime manifest is not hash-checked.** *(Done: the Java file list is downloaded with its SHA-1 from all.json and kept next to the runtime; every start checks each runtime file again (cheap with the M2 hash cache) and downloads a damaged one again; `src/safepath.js` refuses any manifest key, library path, log config, asset hash or Fabric/Mojang version id that would leave its folder. `test/safepath.test.js`.)* `src/java.js:25` fetches `entry.manifest.url` without checking `entry.manifest.sha1` from `all.json`; the files are then checked against that unchecked manifest. A completed runtime is never re-checked after `.azure-complete` is written (`:21`). Manifest keys are joined into paths unchecked (`src/java.js:28`, `path.join(dir, rel)`), so a bad manifest could write outside the runtime folder. The same goes for library `path` (`src/install.js:97,104`) and the Fabric `id`/`inheritsFrom` (`src/install.js` loadVersion). Fix: refuse any manifest-derived path that leaves its folder.
  *Player:* a damaged Java folder (antivirus, disk error) gives a crash before the title screen that never fixes itself.
  *Fix:* verify the manifest's SHA-1; re-verify (cheaply, with M2's index) when the game exits during start; a "Repair Java" path.

- [x] **M4. Starting needs the internet even when everything is installed.** *(Done: a saved Fabric profile for that loader and game version is used without asking the server; a missing or damaged one is fetched; the profile id is checked (M3). Sign-in still needs the internet on every Play (Q1). `test/safepath.test.js`.)* `src/fabric.js:8` re-downloads the Fabric profile on every start (the Mojang manifest and Java `all.json` are only fetched when nothing is cached, and the channel falls back to the installed jar). The Fabric profile id from the server is used in a path unchecked (`src/fabric.js:10-11`).
  *Player:* on a flaky connection Play fails at "Fabric profile" even though nothing changed.
  *Fix:* keep the saved profile and use it when the fetch fails; check the id against `^[A-Za-z0-9._-]+$`. (Sign-in still needs the internet: see Q1.)

- [x] **M5. Closing the launcher window while playing quits the launcher.** *(Done: `app/background.js`: closing the window during a game (or while it is being prepared) hides it and shows a tray icon (Open Azure Launcher / Close the launcher when the game ends); the game is never stopped; the launcher closes by itself once the game has exited, or stays if opened again from the tray. The hide-while-playing setting also gets the tray icon. `test/background.test.js`. Real click-through with a running game: with M12.)* `app/app.js:873` (`window-all-closed` → `app.quit()`), the game is a piped child (`src/launch.js:100`).
  *Player:* play time is not saved, "Restart now" from the in-game Mod Manager and the crash rollback stop working, and a waiting launcher update installs mid-session.
  *Fix:* while a game runs, closing the window hides it (with a one-time note) and the launcher quits after the game ends.

- [ ] **M6. Natives are re-extracted into a shared folder on every start.** `src/install.js:124-130`, folder `versions/<mc>/natives` shared by every instance of that version.
  *Player:* with a game of the same version still open (or an antivirus holding a DLL) the start fails with a generic "The game couldn't start."
  *Fix:* extract only missing or changed files; skip files that are in use when they are already identical.

- [ ] **M7. Install errors all say "The game couldn't start."** `app/messages.js:13`, `app/app.js:68-73`: disk full (`ENOSPC`), file in use (`EBUSY`/`EPERM`), no internet during install, Mojang down: the same text.
  *Player:* no idea what to do.
  *Fix:* map these codes to clear messages ("Your disk is full…", "Close the game or program using … and try again", "Can't reach Mojang…").

- [ ] **M8. No French text.** `app/renderer/index.html:2` (`lang="en"`), every string is English in the renderer files.
  *Player:* French players get an English-only launcher (the Azure Client mod itself is translated).
  *Fix:* a small string table (en, fr) with the language picked from the system and a Settings choice; tests that every key exists in both.

- [ ] **M9. Changing the game folder mid-way or without moving data.** `app/app.js:58` (`rootDir()` read on every call), `app/app.js:817` (`settings:set` allowed while a game is preparing or running); a new folder starts empty (`src/settings.js:39`).
  *Player:* changing the folder while a game starts mixes two folders; after changing it, all worlds and mods "disappear" (they are still in the old folder).
  *Fix:* refuse the change while not idle; ask "Move everything to the new folder?" (copy, check, then switch) or keep the old one.

- [ ] **M10. Big modpacks are read into memory twice.** `src/mrpack.js:42` and `:96` read the whole pack (up to 400 MB) once to parse and again for overrides.
  *Player:* importing a large pack can freeze or crash the launcher on a PC with little memory.
  *Fix:* read the zip's central directory and inflate only the needed entries (fflate's streaming `Unzip`), one pass.

- [ ] **M11. Secure storage missing breaks the whole window.** `src/vault.js:53` throws when an account file exists but `safeStorage` is unavailable (rare: damaged profile or DPAPI failure); `app:state` (`app/app.js:536-541`) calls `auth.listAccounts()` without a try, so the page gets no state at all.
  *Player:* on a PC without working Windows DPAPI (rare: roaming or broken profiles) the launcher opens on a blank or broken page.
  *Fix:* `listAccounts` returns `[]` with a flag; the Accounts page explains it.

- [ ] **M12. Versions other than 1.21.11 are not tested.** Nothing exercises 1.13, 1.16, 1.20 or the newest version's install (argument formats, natives classifiers, Java 8/16/17/21 selection).
- [ ] **M13. A running instance can be deleted.** `instances:select` has no running check, and the delete guard (`app/app.js:602`) compares against the selected instance, not the running one. Select another instance while playing, then delete the running one: its folder is wiped under the game. *(Found by the independent review.)*
  *Player:* an instance on one of these versions might not start.
  *Fix:* recorded version JSONs for each and a test that `prepare()` builds the right Java, classpath, natives and arguments (no game start, no account).

## Low

- [ ] **L1. Signed release list can be replayed.** `src/channel.js:40-47` accepts any correctly signed `latest.json`, even an older one; the jar version is not compared with the installed one.
  *Fix:* refuse a release older than the installed one (version compare) unless the user picks it.

- [ ] **L2. A damaged `fabric.mod.json` crashes the guard.** `src/guard.js:80` (`JSON.parse` without try): callers catch it today, but the guard should answer with a problem, not throw.

- [ ] **L3. Half downloads are left behind.** `src/net.js:49-50`: when the stream fails, `dest.part` is not removed (it is overwritten on the next try).

- [ ] **L4. Some IPC handlers throw instead of answering.** `app/app.js:813-814` (`accounts:select`/`remove` with an unknown id), `:595` (`instances:update` without a patch).
  *Player:* a rare "Error invoking remote method" in the console; the click does nothing.
  *Fix:* answer `{ ok:false, message }` like the other handlers.

- [ ] **L5. `npm audit`: 3 moderate.** `uuid` (missing bounds check when a buffer is passed) via `@azure/msal-node` via `prismarine-auth`. The launcher never passes a buffer; no fix is available upstream yet.
  *Fix:* note in AUDIT; re-check on each release.

- [ ] **L6. Uninstall leaves everything.** package.json `deleteAppDataOnUninstall: false`: games, worlds and the encrypted account tokens stay.
  *Fix:* an uninstaller question "Also remove your worlds and settings?" (default no).

- [ ] **L7. "Fabric refused" kill timer can hit a later game.** `app/app.js:265-268`: `setTimeout(() => child.kill(), 2500)` reads `child` when it fires.
  *Fix:* capture the process at the time.

- [ ] **L8. Untested modules.** `src/guard.js`, `src/java.js`, `src/fabric.js`, `src/skin.js` have no tests.

- [ ] **L9. Paths with accents on old versions.** A Windows user name with accents puts the game folder on a non-ASCII path; old LWJGL builds (1.16 and older) can fail to load natives from it. Needs a test machine path; fix by using a short ASCII natives path when needed.
- [ ] **L10. Other small findings (independent review).** A damaged `queue.js` or modfix journal (`src/queue.js:126,128`, `src/modfix.js` writeJournal) reads as empty, so a rollback is lost (same fix as H2). A cached `versions/<id>/<id>.json` is not re-hashed (`src/install.js:60-80`). `unzipSync` has no entry or size cap for the jar in `src/guard.js:64` and natives in `src/install.js:125` (both signed or hash-checked). `src/mods.js:15` joins `m.file` from `instances.json` without a name check. The access token is on the game's command line (`src/launch.js:100`), standard for launchers.

## Questions (need your decision before any change)

- **Q1. Playing without internet. Decided: keep it as it is.** Every Play refreshes the token and re-checks ownership online (`src/auth.js:227-240`); with no internet the game does not start. Nothing is built for this.
  *Possible later feature (not planned, not built):* offline singleplayer with a recently verified account (the last ownership check younger than a set time, the token still valid, singleplayer only), only if the maintainer asks for it.
- **Q2. H5 contact address. Decided: keep the Gmail.**

## Checked and fine

- Electron: `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`, navigation and new windows blocked, permissions denied, strict CSP (`app/app.js:845-858`, `app/renderer/index.html:5`).
- IPC: every handler checks the sender is our own page (`app/app.js:449-453`); the preload exposes only fixed calls (`app/preload.js`).
- Paths: instance ids, world names, files to reveal and pack paths are all checked against traversal (`src/instances.js:39-45`, `app/app.js:646-663`, `src/mrpack.js:32-37`, `:125-129`).
- Zips: imported jars and packs are only read in memory with size and entry caps; nothing from them is run by the launcher or extracted by name (mods in a pack's `overrides/mods` are run by the game without a hash or Modrinth check: a known trade-off) (`src/modmeta.js`, `src/mrpack.js`, `src/install.js:128`).
- Downloads: Mojang, Fabric, Modrinth and pack files are hash-checked (SHA-1/SHA-512); Fabric libraries without a hash use the published `.sha1` from the same server (protects against corruption, not a bad server) or are refused (`src/net.js`, `src/install.js:155`).
- Tokens: encrypted with Windows DPAPI, fail closed, redacted from every log and error, `debug` logging off, not in JSON dumps (`src/vault.js`, `src/auth.js:18-24`, `src/account.js`).
- The Legit jar: Ed25519-signed list, SHA-256, size and guard before it is used; the installed jar stays on any failure (`src/channel.js`).
- Rules: no offline launch path in the shipped code (`app/devgate.js`, `src/launch.js:95`); no personal paths (the dev tools live in the ignored `dev-local/`).
- The renderer never uses `innerHTML`; the log view is capped at 1,500 lines.
- Installs per user (no admin), arguments passed as an array (spaces in paths are safe).
