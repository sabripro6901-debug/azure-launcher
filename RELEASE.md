# First release - what you do by hand, in order

Done so far: the Mojang approval (step 2.5), and step 3 (`launcherUpdate.owner` and `build.publish.owner` are
`sabripro6901-debug`, the launcher is version 1.0.0). The repo is github.com/sabripro6901-debug/azure-launcher (public,
one clean first commit). No launcher release has been published yet.
Only this launcher repo is ever pushed. The mod repo never gets a remote.

## 1. Release the mod first (so the channel has a clean Legit jar)

The jar on the channel today (1.2.15) was built before the Legit hardening and fails the guard, so the CI check in step 6
would fail. In the mod repo (`aurora-client`):

1. Bump `mod_version` in `gradle.properties`.
2. Build the public edition: `gradlew build -Plegit`.
3. Guard the Legit jar: `python tools/check_legit_jar.py build/libs/azure-client-legit-<version>.jar` must print `OK`.
4. Publish the Legit jar and the signed `latest.json` the way you always do (`tools/ship.py` / `tools/publish.py`, from the folder above the mod repo).
5. In this launcher repo: `node tools/verify-channel.js` must end with `CHANNEL-OK`.

## 2. Register your own Microsoft (Azure) app

1. Go to https://portal.azure.com -> Microsoft Entra ID -> App registrations -> New registration.
2. Name: `Azure Launcher`. Supported account types: **Personal Microsoft accounts only**.
3. Open the app -> Authentication -> add a platform **Mobile and desktop applications** with the redirect
   `https://login.microsoftonline.com/common/oauth2/nativeclient`, and set **Allow public client flows = Yes** (the launcher signs in with a device code).
4. Copy the **Application (client) ID**.
5. **Done (2026-11-17):** Mojang approved this client ID. Signing in with the installed launcher works, and the account
   is stored encrypted (`%APPDATA%\azure-launcher\vault\*.bin`, Windows-encrypted, no token in plain text anywhere).
   For a new client ID this step would be: ask for approval through Mojang's app-approval form (linked from the
   Minecraft Wiki page on Microsoft authentication); until then sign-in ends with an "invalid app registration" error.

## 3. Fill in `config/launcher.config.json`

```json
{
  "azureClientId": "<the Application (client) ID from step 2>",
  "launcherUpdate": { "owner": "<your GitHub user or organisation>", "repo": "azure-launcher" }
}
```

Leave the other keys as they are (`minecraftVersion`, `fabricLoader`, `updateChannel.base`, `mods`).
Also set the same owner/repo in `package.json` under `build.publish` (`owner`, `repo`). `npm test` fails if the two differ.
`config/release-key.txt` is the public key of your release channel; do not change it.
`config/launcher-update-key.txt` is the public key launcher updates are checked against; do not change it either
(installed launchers only accept updates signed with the matching private key).

### Launcher update key (done once, 2026-11-19)

`node tools/sign-update.js keygen` made the key pair. The private key is `%USERPROFILE%\.azure-launcher-update-key`
on this PC only: never in this repo, in GitHub (not even as an Actions secret), in CI or in any upload. **Keep an
offline backup of it** (a USB stick kept somewhere safe): without it no launcher update can ever be signed again,
and installed launchers would need a manual reinstall. Running `keygen` again refuses to replace it.

## 4. Create the GitHub repo and push (launcher only)

1. On GitHub create a new **public** repository named `azure-launcher` (public, so the launcher can read its releases without a token). Do not add a README or license there.
2. In this folder:
   ```
   git remote add origin https://github.com/<owner>/azure-launcher.git
   git push -u origin main
   ```
3. In the repo settings -> Actions -> General: workflow permissions **Read repository contents** (the workflow asks for nothing more), and allow actions you trust. The workflow needs no secrets; do not add any.

## 5. Check CI

Actions -> "Build launcher" -> Run workflow. It runs `npm ci`, the tests, `tools/verify-channel.js`, builds the unsigned
installer, checks what is inside the app, and uploads the installer as a build artifact. It must be green.

## 6. Release

1. Set `version` in `package.json` (first release: `0.1.0` is fine; each later one must be higher or nobody updates).
2. `git commit -am "Release 0.1.0"`, then `git tag v0.1.0`, then `git push origin main v0.1.0`.
3. When the workflow for the tag is green, download the artifact `azure-launcher-windows` and unzip it into a folder.
4. Sign it on this PC: `node tools/sign-update.js sign <that folder>`. It writes `launcher-update.json` and
   `launcher-update.json.sig` next to the installer (it signs the installer's version and SHA-256 with the private key).
5. GitHub -> Releases -> Draft a new release for tag `v0.1.0`. Attach all five files:
   `Azure-Launcher-Setup-0.1.0.exe`, `Azure-Launcher-Setup-0.1.0.exe.blockmap`, `latest.yml`, `launcher-update.json`,
   `launcher-update.json.sig`. Publish it as a normal release (not a pre-release, not a draft).
   The launcher updates itself from these files: without `latest.yml` nobody gets the update, and without the two
   signed files (or with an installer that isn't the signed one) every launcher refuses it.

## 7. Try it like a player

1. Download the installer from the release page on another PC (or after uninstalling here). Windows SmartScreen will warn because the installer is unsigned: More info -> Run anyway.
2. Open the launcher, sign in with a Microsoft account that owns Minecraft Java Edition, launch the game.
3. While the game is running, check that Windows showed no firewall prompt.

## Later

- Code signing (removes the SmartScreen warning): buy a certificate, then add it as a GitHub secret of **this** repo only and tell electron-builder to use it. Not needed for a first release.
- Next launcher release: bump `version`, tag, push the tag, download the artifact, sign it (`node tools/sign-update.js sign <folder>`), attach the five files. Installed launchers pick it up on their own, check the signature, and install it when closed.
- Next Azure (mod) release: step 1 only. Launchers fetch the new Legit jar from the signed channel at launch.
