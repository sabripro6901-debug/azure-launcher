'use strict';
// Developer hooks (a local Azure jar, extra game arguments, test scripts) are honoured only when the launcher is run
// from source (not packaged) AND AZURE_DEV=1 is set. A packaged build ignores them completely. None of them signs in:
// the account always comes from the real Microsoft sign-in (src/auth.js), from source or packaged.
function devOptions(opts, { isPackaged, env }) {
  if (isPackaged || env !== '1') return { enabled: false };
  return { enabled: true, azureJar: opts.azureJar, gameArgs: opts.gameArgs, onReady: opts.onReady };
}

module.exports = { devOptions };
