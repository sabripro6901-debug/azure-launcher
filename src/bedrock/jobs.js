'use strict';
// Starts a job in a worker thread. Progress arrives through onProgress({ done, total, phase }); the promise gives the
// job's result, or rejects with a BedrockError (a refusal with a player-readable message) or a plain Error (a failure,
// with its code kept, for example EPERM).
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { BedrockError } = require('./archive');

function runJob(name, args, onProgress = null) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: { name, args } });
    const end = (fn, v) => { if (!finished) { finished = true; fn(v); } };
    w.on('message', (m) => {
      if (m.type === 'progress') { if (onProgress) onProgress({ done: m.done, total: m.total, phase: m.phase }); }
      else if (m.type === 'done') end(resolve, m.result);
      else if (m.type === 'error') {
        if (m.bedrock) end(reject, new BedrockError(m.code, m.message));
        else { const e = new Error(m.message); e.code = m.code; end(reject, e); }
      }
    });
    w.on('error', (e) => end(reject, e));
    w.on('exit', (code) => { if (code !== 0) end(reject, new Error('The Bedrock worker stopped (' + code + ')')); });
  });
}

module.exports = { runJob };
