require("dotenv").config(); // loads .env (secrets and settings) before anything reads process.env
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const mongoose = require("mongoose");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------------------------------
// CORS: which websites may call this API from a browser.
// Set ALLOWED_CLIENTS (comma separated) in .env; FRONTEND_URL is allowed too. Requests with no Origin
// header (curl, same-origin) pass, because CORS only protects browsers.
// ---------------------------------------------------------------------------------------------------
const allowedOrigins = [
  ...(process.env.ALLOWED_CLIENTS || "").split(","),
  process.env.FRONTEND_URL || "",
]
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

// TEMPORARY testing switch: ALLOW_ALL_ORIGINS=true lets pages from ANY address call the API.
// Never use it on a public server; delete the line from .env when the test is over.
const allowAll = String(process.env.ALLOW_ALL_ORIGINS).toLowerCase() === "true";

const corsOptions = {
  origin: (origin, cb) => cb(null, allowAll || !origin || allowedOrigins.includes(origin)),
};
console.log("Allowed browser origins:", allowedOrigins.join(", ") || "(none)");
if (allowAll) console.warn("WARNING: ALLOW_ALL_ORIGINS=true, every website can call this API. Testing only!");

// ---------------------------------------------------------------------------------------------------
// Proxy and headers
// ---------------------------------------------------------------------------------------------------
// Behind nginx/Render the real visitor IP is in X-Forwarded-For. "trust proxy" makes req.ip use it, which
// the rate limits and lock-outs depend on. 1 = one proxy hop; TRUST_PROXY=false when exposed directly.
const trustProxy =
  process.env.TRUST_PROXY === undefined
    ? 1
    : /^\d+$/.test(process.env.TRUST_PROXY)
      ? Number(process.env.TRUST_PROXY)
      : process.env.TRUST_PROXY === "true";
app.set("trust proxy", trustProxy);
app.disable("x-powered-by"); // do not tell attackers which framework this is

// Basic browser protections on every response.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); // browser must not guess file types (stops script tricks)
  res.setHeader("X-Frame-Options", "DENY"); // nobody can embed the site in a frame (clickjacking)
  res.setHeader("Referrer-Policy", "no-referrer"); // do not leak page addresses (transfer keys) to other sites
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()"); // switch off unused browser features
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); // HTTPS only
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store"); // API answers are never cached
  next();
});
app.use(cors(corsOptions));
app.use(express.static("public")); // css/images used by the classic download page

// ---------------------------------------------------------------------------------------------------
// Database and request parsing
// ---------------------------------------------------------------------------------------------------
require("./config/db")(); // connect to MongoDB
app.use(express.json({ limit: "10kb" })); // small JSON bodies only: a huge body cannot exhaust memory

// The classic download page (/files/:uuid) is an EJS template.
app.set("views", path.join(__dirname, "/views"));
app.set("view engine", "ejs");

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
app.use("/api/transfer", require("./routes/transfer")); // main flow: 6-digit key, QR, link, email
app.use("/api/stats", require("./routes/stats")); // public numbers for the Live stats page
app.use("/api/contact", require("./routes/contact")); // contact form (sends an e-mail, stores nothing)
app.use("/api/auth", require("./routes/auth")); // admin sign-in, token refresh, sign-out
app.use("/api/admin", require("./routes/admin")); // admin settings (needs a valid admin token)
// Classic one-link flow, still reachable at /classic on the frontend.
app.use("/api/files", require("./routes/files"));
app.use("/files", require("./routes/show"));
app.use("/files/download", require("./routes/download"));

// Create the admin user once the database is connected (only when no admin exists yet).
mongoose.connection.once("open", () => require("./services/auth").seedAdmin());

// Background job: deletes expired transfers (files and S3 objects) and marks their records deleted.
require("./services/transferCleanup")();

// ---------------------------------------------------------------------------------------------------
// Classic flow cleanup: every midnight delete files older than 24 hours (disk first, then the record).
// ---------------------------------------------------------------------------------------------------
const File = require("./models/file");

const deleteOldFiles = async () => {
  try {
    const oldTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const oldFiles = await File.find({ createdAt: { $lt: oldTimestamp } });
    await Promise.all(oldFiles.map((f) => fs.promises.unlink(path.join(__dirname, f.path)).catch(() => {})));
    const deleteResult = await File.deleteMany({ createdAt: { $lt: oldTimestamp } });

    // Also sweep files left behind by earlier runs (record gone, file still in uploads/).
    // Only top-level files are touched; uploads/transfers belongs to the transfer cleanup above.
    const uploadsDir = path.join(__dirname, "uploads");
    let swept = 0;
    for (const entry of await fs.promises.readdir(uploadsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      const full = path.join(uploadsDir, entry.name);
      const { mtimeMs } = await fs.promises.stat(full);
      if (mtimeMs < oldTimestamp.getTime()) {
        await fs.promises.unlink(full).catch(() => {});
        swept++;
      }
    }

    console.log(`Deleted ${deleteResult.deletedCount} old files (${swept} orphaned files swept from disk).`);
  } catch (error) {
    console.error("An error occurred during the cleanup job:", error);
  }
};
cron.schedule("0 0 * * *", deleteOldFiles);

// ---------------------------------------------------------------------------------------------------
// Errors and server
// ---------------------------------------------------------------------------------------------------
// Unknown routes and errors answer with short JSON: no stack traces, no file paths.
app.use((req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode;
  if (status && status >= 400 && status < 500) return res.status(status).json({ error: "Invalid request." });
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong." });
});

// A bug in one request must never take the whole server down.
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

const server = app.listen(PORT, () => console.log(`Listening on port ${PORT}.`));
// Cut off slow or stalled clients (slowloris-style) so they cannot hold connections open.
server.headersTimeout = 20 * 1000;
server.requestTimeout = 5 * 60 * 1000; // long enough for a 100 MB upload on a slow link
server.keepAliveTimeout = 5 * 1000;
