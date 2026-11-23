const limits = require('../../config/limits');

// Providers are loaded lazily so the S3 SDK is only required when it is actually used.
const providers = {
  local: () => require('./local'),
  s3: () => require('./s3'),
};

// Storage used for NEW uploads, decided by the USE_S3 flag.
const current = () => (limits.useS3 ? 's3' : 'local');

// Storage a transfer was saved with, so flipping the flag never orphans old files.
const get = (name) => providers[name || 'local']();

module.exports = { current, get };
