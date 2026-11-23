// Single place for every transfer limit. Change the values in .env, not here.
const MB = 1024 * 1024;

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const defaultExpiryMinutes = positive(process.env.TRANSFER_EXPIRY_MINUTES, 10);

// Expiry choices shown to the sender, e.g. TRANSFER_EXPIRY_OPTIONS_MINUTES=5,10,30,60
const expiryOptionsMinutes = [
  ...new Set([
    ...String(process.env.TRANSFER_EXPIRY_OPTIONS_MINUTES || '5,10,30')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
    defaultExpiryMinutes,
  ]),
].sort((a, b) => a - b);

const list = (value, fallback) =>
  String(value === undefined ? fallback : value)
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);

module.exports = {
  // ---- abuse protection (all tunable in .env) ----
  // Total bytes SendAnyFile may hold on disk at once (transfers + classic). 0 turns the cap off.
  maxStorageBytes: Number(process.env.MAX_STORAGE_MB ?? 5120) * MB,
  maxConcurrentUploads: positive(process.env.MAX_CONCURRENT_UPLOADS, 4),
  uploadsPerHour: positive(process.env.UPLOADS_PER_HOUR, 20),
  classicUploadsPerHour: positive(process.env.CLASSIC_UPLOADS_PER_HOUR, 10),
  // Each file can be downloaded this many times (the sender picks 1..maxDownloads; default 1).
  maxDownloads: Math.min(Math.floor(positive(process.env.MAX_DOWNLOADS, 5)), 5),
  defaultDownloads: Math.min(Math.floor(positive(process.env.DEFAULT_DOWNLOADS, 1)), 5),
  maxConcurrentZips: positive(process.env.MAX_CONCURRENT_ZIPS, 4),
  emailsPerHour: positive(process.env.EMAILS_PER_HOUR, 10),
  emailsPerRecipientPerHour: positive(process.env.EMAILS_PER_RECIPIENT_PER_HOUR, 3),
  emailsPerDay: positive(process.env.EMAILS_PER_DAY, 300),
  keyFailuresPerIp: positive(process.env.KEY_FAILS_PER_IP, 10),
  keyFailuresGlobalPerMinute: positive(process.env.KEY_FAILS_GLOBAL_PER_MIN, 120),
  // Executable/script types that are mostly used to spread malware. Edit the list in .env.
  blockedExtensions: list(
    process.env.BLOCKED_EXTENSIONS,
    'exe,scr,bat,cmd,com,msi,msp,vbs,vbe,jse,wsf,ps1,jar,pif,lnk,hta,cpl,dll,reg'
  ),

  maxFiles: positive(process.env.MAX_FILES, 5),
  maxFileSize: positive(process.env.MAX_FILE_SIZE_MB, 20) * MB,
  maxTotalSize: positive(process.env.MAX_TOTAL_SIZE_MB, 100) * MB,
  defaultExpiryMinutes,
  expiryOptionsMinutes,
  // Longest expiry a sender may pick (custom values allowed up to this), default 24 hours.
  maxExpiryMinutes: Math.max(positive(process.env.MAX_EXPIRY_MINUTES, 24 * 60), defaultExpiryMinutes),
  // USE_S3=true stores new transfers in S3, anything else uses local disk.
  useS3: String(process.env.USE_S3).toLowerCase() === 'true',
};
