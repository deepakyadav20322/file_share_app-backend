// Runtime options that can be changed from /admin/config without a restart.
//
// To add an option: add ONE entry to DEFINITIONS and read it with `await settings.get('yourKey')`.
// The admin page builds its form from this list, and saving is validated against it.
const Setting = require('../models/setting');

const DEFINITIONS = [
  {
    key: 'emailEnabled',
    type: 'boolean',
    default: true,
    group: 'Features',
    label: 'Send by email',
    description: 'Let visitors e-mail the share link from the result screen. When off, the button is hidden and the API refuses.',
  },
  {
    key: 'contactEnabled',
    type: 'boolean',
    default: true,
    group: 'Features',
    label: 'Contact form',
    description: 'Accept messages from the Contact page.',
  },
  {
    key: 'uploadsEnabled',
    type: 'boolean',
    default: true,
    group: 'Features',
    label: 'Accept new transfers',
    description: 'Turn off for maintenance. Existing transfers keep working and downloads are not affected.',
  },
];

const byKey = Object.fromEntries(DEFINITIONS.map((d) => [d.key, d]));
const defaults = () => Object.fromEntries(DEFINITIONS.map((d) => [d.key, d.default]));

// Returns the cleaned value, or undefined when it does not fit the definition.
const clean = (def, value) => {
  if (def.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (def.type === 'number') {
    return Number.isInteger(value) && value >= (def.min ?? -Infinity) && value <= (def.max ?? Infinity) ? value : undefined;
  }
  if (def.type === 'string') return typeof value === 'string' && value.length <= (def.max ?? 200) ? value.trim() : undefined;
  return undefined;
};

let cache = { at: 0, values: null };
const TTL = 5000; // other server instances pick up a change within 5 seconds

async function load(force = false) {
  if (!force && cache.values && Date.now() - cache.at < TTL) return cache.values;
  try {
    const doc = await Setting.findOne({ key: 'app' }).lean();
    const values = defaults();
    for (const d of DEFINITIONS) {
      const v = doc?.values ? clean(d, doc.values[d.key]) : undefined;
      if (v !== undefined) values[d.key] = v;
    }
    cache = { at: Date.now(), values };
  } catch (e) {
    // Database hiccup: keep serving the last known values (or defaults) rather than failing requests.
    if (!cache.values) cache = { at: Date.now() - TTL + 1000, values: defaults() };
  }
  return cache.values;
}

const get = async (key) => (await load())[key];

// Validates a { key: value } object. Unknown keys and wrongly typed values are errors.
function validate(input) {
  const changes = {};
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { changes, errors: ['values must be an object'] };
  for (const [key, value] of Object.entries(input)) {
    const def = Object.prototype.hasOwnProperty.call(byKey, key) ? byKey[key] : null;
    if (!def) { errors.push(`Unknown option: ${key}`); continue; }
    const v = clean(def, value);
    if (v === undefined) errors.push(`Invalid value for ${def.label}`);
    else changes[key] = v;
  }
  return { changes, errors };
}

// Saves only the options whose value really changed; returns { values, diff }.
async function save(changes) {
  const before = await load(true);
  const diff = Object.entries(changes)
    .filter(([k, v]) => before[k] !== v)
    .map(([key, to]) => ({ key, from: before[key], to }));
  if (diff.length) {
    await Setting.updateOne(
      { key: 'app' },
      { $set: Object.fromEntries(diff.map((d) => [`values.${d.key}`, d.to])) },
      { upsert: true }
    );
  }
  return { values: await load(true), diff };
}

module.exports = { DEFINITIONS, get, load, validate, save };
