// Progress of the "saving" step of an upload, so the page can show a real percentage after the browser
// has finished sending the bytes (storing in S3 can take a while on a slow link).
// Kept in memory only: a progress entry lives for a few minutes and holds two numbers.
const ID = /^[0-9a-f-]{36}$/;
const MAX_ENTRIES = 500;
const KEEP_MS = 5 * 60 * 1000;

const entries = new Map(); // id -> { total, done, at }

setInterval(() => {
  const old = Date.now() - KEEP_MS;
  for (const [id, e] of entries) if (e.at < old) entries.delete(id);
}, 60 * 1000).unref();

const isValidId = (id) => typeof id === 'string' && ID.test(id);

// Returns { update(doneBytes), finish() }, or a no-op tracker when the id is missing or the table is full.
function start(id, total) {
  const none = { update() {}, finish() {} };
  if (!isValidId(id) || (!entries.has(id) && entries.size >= MAX_ENTRIES)) return none;
  const entry = { total: Math.max(1, total), done: 0, at: Date.now() };
  entries.set(id, entry);
  return {
    update(done) {
      entry.done = Math.min(entry.total, Math.max(entry.done, done)); // never goes backwards
      entry.at = Date.now();
    },
    finish() {
      entry.done = entry.total;
      entry.at = Date.now();
    },
  };
}

// Percent saved so far, or null when nothing is known for this id.
const percent = (id) => {
  const e = isValidId(id) ? entries.get(id) : null;
  return e ? Math.round((e.done / e.total) * 100) : null;
};

module.exports = { start, percent, isValidId };
