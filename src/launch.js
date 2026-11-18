'use strict';
// Installs what the game needs and starts it. The only function here that starts the game, `launch`, needs a verified
// Microsoft account (see account.js and auth.js): there is no way to start the game without one from this file.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { install, ruleAllows } = require('./install');
const { ensureJava } = require('./java');
const { ensureFabricProfile } = require('./fabric');
const { ensureMods, installAzureJar, removeAzureJars } = require('./mods');
const { isVerifiedAccount } = require('./account');

const LAUNCHER_NAME = 'AzureLauncher';
const LAUNCHER_VERSION = require('./version').version;

/** Replaces ${name} in one argument; unknown names become empty. */
function fill(arg, vars) {
  return arg.replace(/\$\{([a-z_]+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

/** Turns the version JSON's argument list (strings and rule objects) into plain strings. */
function flatten(list, vars, features) {
  const out = [];
  for (const a of list) {
    if (typeof a === 'string') {
      out.push(fill(a, vars));
    } else if (ruleAllows(a.rules, features)) {
      for (const v of Array.isArray(a.value) ? a.value : [a.value]) out.push(fill(v, vars));
    }
  }
  return out;
}

/**
 * Downloads and checks everything (Java from Mojang, the game, Fabric if asked, mods, the Azure jar after the Legit
 * guard) and returns { command(player, { ram, jvmArgs }) -> { java, args, cwd } }. It starts nothing.
 *   mc: Minecraft version; loader: Fabric Loader version or null (vanilla); mods: pinned mods [{name,file,url,sha512}];
 *   azureJar: path of the Legit jar or null (versions without an Azure build); gameDir: the instance's own folder.
 */
async function prepare({ root, mc, loader = null, mods = [], azureJar = null, gameDir: instanceDir, log = () => {} }) {
  const gameDir = instanceDir || path.join(root, 'game');
  let versionId = mc;
  if (loader) {
    versionId = await ensureFabricProfile(root, mc, loader);
    log('Fabric profile: ' + versionId);
  }
  const inst = await install(root, versionId, log);
  const component = (inst.version.javaVersion && inst.version.javaVersion.component) || 'jre-legacy';
  log('Java runtime: ' + component + ' (Java ' + ((inst.version.javaVersion && inst.version.javaVersion.majorVersion) || 8) + ')');
  const java = await ensureJava(root, component, log);
  if (mods.length) await ensureMods(gameDir, mods, log);
  if (azureJar) log('Azure jar: ' + path.basename(installAzureJar(gameDir, azureJar)));
  else removeAzureJars(gameDir);

  const options = path.join(gameDir, 'options.txt');
  if (!fs.existsSync(options)) fs.writeFileSync(options, 'onboardAccessibility:false\n'); // skip the narrator welcome screen

  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = [...inst.classpath, inst.clientJar].join(sep);
  return {
    gameDir,
    javaMajor: (inst.version.javaVersion && inst.version.javaVersion.majorVersion) || null,
    command(player, { ram = '2G', jvmArgs = [], gameArgs = [] } = {}) {
      const vars = {
        auth_player_name: player.name, auth_uuid: player.uuid.replace(/-/g, ''), auth_access_token: player.accessToken,
        auth_session: 'token:' + player.accessToken + ':' + player.uuid.replace(/-/g, ''),
        auth_xuid: player.xuid || '', clientid: '', user_type: player.userType || 'msa', user_properties: '{}',
        version_name: versionId, version_type: inst.version.type || 'release', game_directory: gameDir,
        assets_root: inst.assetsDir, assets_index_name: inst.assetIndexId, natives_directory: inst.nativesDir,
        game_assets: inst.assetsDir,
        launcher_name: LAUNCHER_NAME, launcher_version: LAUNCHER_VERSION, classpath, classpath_separator: sep,
        library_directory: path.join(root, 'libraries'),
      };
      const features = {};
      const jvm = flatten(inst.version.arguments.jvm, vars, features);
      if (inst.logConfig) jvm.push(fill(inst.logConfig.argument, { path: inst.logConfig.file }));
      const aurora = azureJar ? ['-Daurora.launcher=1'] : [];
      const args = ['-Xmx' + ram, '-Xms1G', ...aurora, ...jvmArgs, ...jvm, inst.version.mainClass, ...flatten(inst.version.arguments.game, vars, features), ...gameArgs];
      return { java, args, cwd: gameDir };
    },
  };
}

/** Shows an argument list without the access token. */
function redact(args, token) {
  return args.map((a) => (token && a === token ? '<token>' : a));
}

/**
 * Starts the game for a verified account. Returns { child, exit } (exit resolves with the exit code).
 * opts: { root, mc, loader, mods, azureJar, gameDir, account, ram, jvmArgs, log, onLine, beforeStart(prepared) }
 */
async function launch(opts) {
  const { account, ram = '2G', jvmArgs = [], gameArgs = [], log = () => {}, onLine = () => {} } = opts;
  if (!isVerifiedAccount(account)) throw new Error('No account: sign in with a Microsoft account that owns Minecraft Java Edition first.');
  const prepared = await prepare(opts);
  if (opts.beforeStart) await opts.beforeStart(prepared); // the mod check: may stop here with an explanation
  const cmd = prepared.command(account.player(), { ram, jvmArgs, gameArgs });
  log('Starting the game');
  const child = spawn(cmd.java, cmd.args, { cwd: cmd.cwd });
  const feed = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => onLine(l));
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const exit = new Promise((resolve) => child.on('close', resolve));
  return { child, exit };
}

module.exports = { launch, prepare, redact };
