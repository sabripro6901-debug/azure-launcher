'use strict';
// The launcher's own version, from package.json (never Electron's).
const version = require('../package.json').version;
module.exports = { version, userAgent: 'AzureLauncher/' + version + ' (Azure Client launcher)' };
