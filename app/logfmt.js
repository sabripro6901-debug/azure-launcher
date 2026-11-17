'use strict';
// The game writes its log as log4j XML (Mojang's log config). The Home page shows plain text: this takes the message out
// of each event (also when a message runs over several lines) and drops the XML around it. Lines that are not XML (stack
// traces, crash text) pass through.
function createLogParser() {
  let inMessage = false;
  return function plainLog(line) {
    let s = String(line);
    if (inMessage) {
      const end = s.indexOf(']]>');
      if (end < 0) return s;
      inMessage = false;
      s = s.slice(0, end);
      return s.trim() ? s : null;
    }
    const start = s.indexOf('<![CDATA[');
    if (start >= 0) {
      s = s.slice(start + 9);
      const end = s.indexOf(']]>');
      if (end >= 0) return s.slice(0, end);
      inMessage = true;
      return s;
    }
    if (/^\s*<\/?log4j:/.test(s) || !s.trim()) return null;
    return s.replace(/^\s+/, '');
  };
}

/** Coarse progress from the launch log: { done, total } for lines like "libraries 25/160", else null. */
function progressOf(message) {
  const m = /(\d+)\/(\d+)\s*$/.exec(message);
  return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
}

module.exports = { createLogParser, progressOf };
