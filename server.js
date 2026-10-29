const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const Stripe = require("stripe");
const Mux = require("@mux/ts").default;
const { Resend } = require("resend");
const { createPostgresDatabase, migratePostgres } = require("./backend/postgres");
const { connectRedisSessionStore } = require("./backend/redis-sessions");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "videohub_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;
const CATEGORIES = new Set(["Music", "Gaming", "Learning", "Technology", "Cooking", "Education", "Podcast", "Sports", "Comedy", "Other"]);
const MEDIA_TYPES = new Map([
  [".mp4", new Set(["video/mp4"])],
  [".webm", new Set(["video/webm"])],
  [".mov", new Set(["video/quicktime"])],
  [".ogv", new Set(["video/ogg"])],
]);
const DEMO_MEDIA = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

function getProductionConfigErrors(env) {
  const required = [
    ["DATABASE_URL", /^postgres(?:ql)?:\/\/.+/],
    ["REDIS_URL", /^rediss?:\/\/.+/],
    ["PUBLIC_APP_URL", /^https:\/\/.+/],
    ["MUX_TOKEN_ID", /.+/],
    ["MUX_TOKEN_SECRET", /.+/],
    ["MUX_WEBHOOK_SECRET", /.+/],
    ["MUX_SIGNING_KEY", /.+/],
    ["MUX_PRIVATE_KEY", /.+/],
    ["RESEND_API_KEY", /.+/],
    ["EMAIL_FROM", /.+/],
    ["STRIPE_MODE", /^(test|live)$/],
    ["STRIPE_SECRET_KEY", /^sk_(test|live)_.+/],
    ["STRIPE_PRICE_ID", /^price_.+/],
    ["STRIPE_WEBHOOK_SECRET", /^whsec_.+/],
  ];
  const errors = required
    .filter(([name, pattern]) => !pattern.test(env[name] || ""))
    .map(([name]) => name);
  const mode = env.STRIPE_MODE;
  const stripeKey = env.STRIPE_SECRET_KEY || "";
  if ((mode === "test" || mode === "live") && stripeKey && !stripeKey.startsWith(`sk_${mode}_`)) {
    errors.push("STRIPE_SECRET_KEY (must match STRIPE_MODE)");
  }
  return errors;
}

function createDatabase(filename) {
  const Database = require("better-sqlite3");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      membership_status TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'unlisted', 'private')),
      filename TEXT,
      source_url TEXT,
      stream_url TEXT,
      thumbnail_url TEXT,
      mux_upload_id TEXT UNIQUE,
      mux_asset_id TEXT UNIQUE,
      mux_playback_id TEXT UNIQUE,
      mux_live_stream_id TEXT UNIQUE,
      mux_playback_policy TEXT,
      processing_status TEXT NOT NULL DEFAULT 'ready',
      is_live INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS videos_catalog_idx ON videos(visibility, created_at DESC);
    CREATE INDEX IF NOT EXISTS videos_channel_idx ON videos(channel_id);
    CREATE TABLE IF NOT EXISTS account_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify_email', 'password_reset')),
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_tokens_expiry_idx ON account_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS provider_events (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY(provider, event_id)
    );
    CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_video_idx ON comments(video_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS watch_history (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      watched_at TEXT NOT NULL,
      PRIMARY KEY(user_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS saved_videos (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, video_id)
    );
  `);
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has("email_verified")) {
    db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1");
  }
  const videoColumns = new Set(db.prepare("PRAGMA table_info(videos)").all().map((column) => column.name));
  for (const [name, declaration] of [
    ["mux_upload_id", "TEXT"],
    ["mux_asset_id", "TEXT"],
    ["mux_playback_id", "TEXT"],
    ["mux_live_stream_id", "TEXT"],
    ["mux_playback_policy", "TEXT"],
    ["processing_status", "TEXT NOT NULL DEFAULT 'ready'"],
  ]) {
    if (!videoColumns.has(name)) db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${declaration}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_upload_idx ON videos(mux_upload_id) WHERE mux_upload_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_asset_idx ON videos(mux_asset_id) WHERE mux_asset_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_playback_idx ON videos(mux_playback_id) WHERE mux_playback_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_live_idx ON videos(mux_live_stream_id) WHERE mux_live_stream_id IS NOT NULL;
  `);

  const count = db.prepare("SELECT COUNT(*) AS count FROM videos").get().count;
  if (count === 0) {
    const now = new Date().toISOString();
    const seed = db.prepare(`
      INSERT INTO videos (id, channel_id, channel_name, title, description, category, visibility, source_url, thumbnail_url, created_at, views, likes)
      VALUES (?, ?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?)
    `);
    const samples = [
      ["welcome-garden", "channel-field-notes", "Field Notes", "A quiet morning in the greenhouse", "A sample video to get started. Create an account to publish your own work.", "Learning", DEMO_MEDIA, null, "2025-08-04T12:00:00.000Z", 12400, 760],
      ["welcome-music", "channel-soft-signal", "Soft Signal", "Focus music for a rainy afternoon", "A sample music listing. The same sample clip is used as placeholder media.", "Music", DEMO_MEDIA, null, "2025-08-02T12:00:00.000Z", 32100, 1890],
      ["welcome-cooking", "channel-good-table", "Good Table", "One-pan dinner with crispy potatoes", "A sample cooking listing. Upload a video to replace the demo catalog with your own.", "Cooking", DEMO_MEDIA, null, "2025-07-28T12:00:00.000Z", 8700, 390],
      ["welcome-tech", "channel-plain-tech", "Plain English Tech", "What actually happens when you hit save?", "A sample technology listing for the local demo catalog.", "Technology", DEMO_MEDIA, null, "2025-07-21T12:00:00.000Z", 19400, 1020],
    ];
    const seedMany = db.transaction((items) => items.forEach((item) => seed.run(...item)));
    seedMany(samples.map((item) => [...item.slice(0, 8), item[8] || now, item[9], item[10]]));
  }
  return db;
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    channelName: row.channel_name,
    emailVerified: Boolean(row.email_verified),
    membershipStatus: row.membership_status,
    isPremium: row.membership_status === "active" || row.membership_status === "trialing",
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function runTransaction(db, callback) {
  if (db.isPostgres) return db.transaction(callback)();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = await callback();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeVideo(row) {
  const muxCdnUrl = row.mux_playback_id && row.mux_playback_policy === "public"
    ? `https://stream.mux.com/${encodeURIComponent(row.mux_playback_id)}.m3u8`
    : null;
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    title: row.title,
    description: row.description,
    category: row.category,
    visibility: row.visibility,
    mediaUrl: muxCdnUrl || (row.filename ? `/media/${encodeURIComponent(row.filename)}` : row.source_url),
    streamUrl: muxCdnUrl || row.stream_url,
    muxPlaybackId: row.mux_playback_id || null,
    thumbnailUrl: row.thumbnail_url,
    isLive: Boolean(row.is_live),
    processingStatus: row.processing_status || "ready",
    createdAt: row.created_at,
    views: row.views,
    likes: row.likes,
  };
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const dataDirectory = options.dataDirectory || path.resolve(__dirname, env.DATA_DIR || "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  const uploadDirectory = options.uploadDirectory || path.join(dataDirectory, "uploads");
  fs.mkdirSync(uploadDirectory, { recursive: true });
  const databasePath = options.databasePath || path.join(dataDirectory, "videohub.sqlite");
  const db = options.db || (env.NODE_ENV === "production" ? null : createDatabase(databasePath));
  const sessionStore = options.sessionStore || null;
  if (env.NODE_ENV === "production" && (!db || !db.isPostgres || !sessionStore)) {
    throw new Error("Production requires PostgreSQL and a shared Redis session store.");
  }
  const webRoot = options.webRoot || path.join(__dirname, "build");
  const app = express();
  const stripeKey = env.STRIPE_SECRET_KEY || "";
  const stripePrice = env.STRIPE_PRICE_ID || "";
  const stripeMode = env.STRIPE_MODE || (stripeKey.startsWith("sk_live_") ? "live" : "test");
  const stripeKeyMatchesMode = (stripeMode === "live" && stripeKey.startsWith("sk_live_"))
    || (stripeMode === "test" && stripeKey.startsWith("sk_test_"));
  const stripeClient = options.stripeClient || (stripeKeyMatchesMode ? new Stripe(stripeKey) : null);
  const stripeReady = Boolean(stripeClient && stripeKeyMatchesMode && stripePrice && (env.NODE_ENV !== "production" || (env.STRIPE_WEBHOOK_SECRET || "").startsWith("whsec_")));
  const muxClient = options.muxClient || (env.MUX_TOKEN_ID && env.MUX_TOKEN_SECRET ? new Mux({
    tokenId: env.MUX_TOKEN_ID,
    tokenSecret: env.MUX_TOKEN_SECRET,
    webhookSecret: env.MUX_WEBHOOK_SECRET,
    jwtSigningKey: env.MUX_SIGNING_KEY,
    jwtPrivateKey: env.MUX_PRIVATE_KEY,
  }) : null);
  const resendClient = options.resendClient || (env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null);
  const appUrl = (env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
  const mailReady = Boolean(resendClient && env.EMAIL_FROM && appUrl);
  const requireEmailVerification = env.REQUIRE_EMAIL_VERIFICATION === "true" || env.NODE_ENV === "production";
  const loginAttempts = new Map();
  const actionAttempts = new Map();

  app.locals.db = db;
  app.locals.sessionStore = sessionStore;
  app.locals.uploadDirectory = uploadDirectory;
  app.locals.dataDirectory = dataDirectory;
  app.locals.stripeReady = stripeReady;
  app.locals.muxReady = Boolean(muxClient);
  app.locals.emailReady = mailReady;

  app.disable("x-powered-by");
  if (env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.path === "/api/billing/webhook" || req.path === "/api/media/mux/webhook" || !req.path.startsWith("/api/")) return next();
    const origin = req.get("origin");
    if (!origin) return next();
    try {
      const parsed = new URL(origin);
      if (parsed.host !== req.get("host") || !["http:", "https:"].includes(parsed.protocol)) {
        return res.status(403).json({ error: "Cross-origin requests are not allowed." });
      }
    } catch {
      return res.status(403).json({ error: "Invalid request origin." });
    }
    return next();
  });

  app.post("/api/billing/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    const signingSecret = env.STRIPE_WEBHOOK_SECRET || "";
    const signature = req.get("stripe-signature");
    if (!stripeClient || !signingSecret.startsWith("whsec_") || !signature) {
      return res.status(503).json({ error: "Stripe webhook is not configured for the selected billing mode." });
    }
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, signature, signingSecret);
    } catch (error) {
      console.warn("Stripe webhook signature validation failed.", error.message);
      return res.status(400).json({ error: "Invalid Stripe webhook signature." });
    }
    try {
      const duplicate = await db.prepare("SELECT 1 FROM provider_events WHERE provider = 'stripe' AND event_id = ?").get(event.id);
      if (duplicate) return res.json({ received: true, duplicate: true });
      if (event.type === "checkout.session.completed") {
        const checkout = event.data.object;
        const userId = checkout.metadata && checkout.metadata.userId;
        if (userId && checkout.customer) {
          let membershipStatus = "free";
          if (checkout.subscription) {
            const subscription = await stripeClient.subscriptions.retrieve(String(checkout.subscription));
            membershipStatus = subscription.status;
          }
          await db.prepare("UPDATE users SET stripe_customer_id = ?, membership_status = ? WHERE id = ?")
            .run(String(checkout.customer), membershipStatus, userId);
        }
      } else if (event.type.startsWith("customer.subscription.")) {
        const subscription = event.data.object;
        const user = await db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(String(subscription.customer));
        if (user) {
          await db.prepare("UPDATE users SET membership_status = ? WHERE id = ?").run(subscription.status, user.id);
        }
      }
      await db.prepare("INSERT INTO provider_events (provider, event_id, processed_at) VALUES ('stripe', ?, ?)").run(event.id, new Date().toISOString());
      return res.json({ received: true });
    } catch (error) {
      console.error("Could not apply Stripe webhook event.", error);
      return res.status(500).json({ error: "Could not process the billing event." });
    }
  });

  app.post("/api/media/mux/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    if (!muxClient || !env.MUX_WEBHOOK_SECRET) return res.status(503).json({ error: "Mux webhooks are not configured." });
    let event;
    try {
      event = await muxClient.webhooks.unwrap(req.body, { "mux-signature": req.get("mux-signature") }, env.MUX_WEBHOOK_SECRET);
    } catch (error) {
      console.warn("Mux webhook signature validation failed.", error.message);
      return res.status(400).json({ error: "Invalid Mux webhook signature." });
    }
    try {
      if (await db.prepare("SELECT 1 FROM provider_events WHERE provider = 'mux' AND event_id = ?").get(event.id)) {
        return res.json({ received: true, duplicate: true });
      }
      const object = event.data || {};
      const videoId = object.passthrough;
      if (typeof videoId === "string") {
        if (event.type === "video.asset.ready") {
          const row = await db.prepare("SELECT visibility, mux_playback_id, mux_playback_policy FROM videos WHERE id = ?").get(videoId);
          if (!row) {
            await db.prepare("INSERT INTO provider_events (provider, event_id, processed_at) VALUES ('mux', ?, ?)").run(event.id, new Date().toISOString());
            return res.json({ received: true });
          }
          const policy = row.visibility === "public" ? "public" : "signed";
          let asset = (await muxClient.video.assets.retrieve(object.id)).data;
          let playback = (asset.playback_ids || []).find((id) => id.policy === policy);
          if (!playback) playback = (await muxClient.video.assets.createPlaybackId(object.id, { policy })).data;
          for (const id of asset.playback_ids || []) {
            if (id.id !== playback.id) await muxClient.video.assets.deletePlaybackId(object.id, id.id);
          }
          await db.prepare(`
            UPDATE videos SET mux_asset_id = ?, mux_playback_id = ?, mux_playback_policy = ?, processing_status = 'ready'
            WHERE id = ?
          `).run(object.id, playback.id, policy, videoId);
        } else if (event.type === "video.asset.errored") {
          await db.prepare("UPDATE videos SET processing_status = 'errored' WHERE id = ?").run(videoId);
        } else if (event.type === "video.upload.asset_created") {
          await db.prepare("UPDATE videos SET mux_asset_id = ?, processing_status = 'preparing' WHERE id = ?")
            .run(object.asset_id, videoId);
        } else if (event.type === "video.live_stream.active") {
          await db.prepare("UPDATE videos SET mux_live_stream_id = ?, mux_asset_id = ?, is_live = 1, processing_status = 'live' WHERE id = ?")
            .run(object.id, object.active_asset_id || null, videoId);
        } else if (event.type === "video.live_stream.idle") {
          await db.prepare("UPDATE videos SET is_live = 0, processing_status = 'processing' WHERE id = ?").run(videoId);
        }
      }
      await db.prepare("INSERT INTO provider_events (provider, event_id, processed_at) VALUES ('mux', ?, ?)").run(event.id, new Date().toISOString());
      return res.json({ received: true });
    } catch (error) {
      console.error("Could not apply Mux webhook event.", error);
      return res.status(500).json({ error: "Could not process the media event." });
    }
  });

  app.use(express.json({ limit: "100kb" }));
  app.use((req, res, next) => {
    if (!req.body || typeof req.body !== "object") req.body = {};
    next();
  });
  app.use(async (req, res, next) => {
    const cookieHeader = req.get("cookie") || "";
    const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (cookie) {
      try {
        const token = decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1));
        const tokenHash = hashToken(token);
        let session;
        if (sessionStore) {
          const stored = await sessionStore.load(tokenHash);
          if (stored && stored.expiresAt > Date.now()) session = await db.prepare("SELECT * FROM users WHERE id = ?").get(stored.userId);
          if (!session && stored) await sessionStore.revoke(tokenHash, stored.userId);
        } else {
          session = await db.prepare(`
            SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
          `).get(tokenHash, Date.now());
        }
        if (session) req.sessionTokenHash = tokenHash;
        if (session) req.user = session;
      } catch (error) {
        console.warn("Ignoring an invalid session cookie.", error.message);
        if (error.name !== "SyntaxError" && error.name !== "TypeError") return next(error);
      }
    }
    return next();
  });

  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to use this feature." });
    if (requireEmailVerification && !req.user.email_verified) return res.status(403).json({ error: "Verify your email address before using this feature." });
    next();
  };

  async function rateLimitAction(req, action, limit = 5) {
    if (sessionStore) return sessionStore.rateLimit(action, req.ip, limit, 60 * 60 * 1000);
    const key = `${action}:${req.ip}`;
    const now = Date.now();
    const current = actionAttempts.get(key);
    if (!current || current.resetAt <= now) {
      actionAttempts.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
      return false;
    }
    current.count += 1;
    return current.count > limit;
  }

  async function issueAccountToken(user, purpose) {
    if (!mailReady) throw new Error("Email delivery is not configured.");
    const token = crypto.randomBytes(32).toString("base64url");
    const lifetime = purpose === "verify_email" ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
    await db.prepare("DELETE FROM account_tokens WHERE expires_at <= ?").run(Date.now());
    const tokenHash = hashToken(token);
    await db.prepare("INSERT INTO account_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash, user.id, purpose, Date.now() + lifetime, new Date().toISOString());
    const link = `${appUrl}/${purpose === "verify_email" ? "verify-email" : "reset-password"}?token=${encodeURIComponent(token)}`;
    const subject = purpose === "verify_email" ? "Verify your VoxBox email" : "Reset your VoxBox password";
    const action = purpose === "verify_email" ? "Verify email" : "Reset password";
    const result = await resendClient.emails.send({
      from: env.EMAIL_FROM,
      to: user.email,
      subject,
      html: `<p>${action} for your VoxBox account:</p><p><a href="${link}">${action}</a></p><p>This link expires in ${purpose === "verify_email" ? "24 hours" : "30 minutes"}.</p>`,
      text: `${action}: ${link}`,
    });
    if (result.error) {
      await db.prepare("DELETE FROM account_tokens WHERE token_hash = ?").run(tokenHash);
      throw new Error(`Email provider rejected the message: ${result.error.message || "unknown error"}`);
    }
    await db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND purpose = ? AND token_hash != ?").run(user.id, purpose, tokenHash);
  }

  async function setSession(res, userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_AGE_SECONDS * 1000;
    if (sessionStore) await sessionStore.create(hashToken(token), userId, expiresAt);
    else await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), userId, expiresAt);
    const secure = env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_AGE_SECONDS}${secure}`);
  }

  async function queryVideoList({ category, search, sort, ownerId, channelIds, watchedIds, limit = 100 }) {
    const clauses = [];
    const values = [];
    if (ownerId) {
      clauses.push("owner_id = ?");
      values.push(ownerId);
    } else if (channelIds) {
      if (!channelIds.length) return [];
      clauses.push(`channel_id IN (${channelIds.map(() => "?").join(",")})`);
      values.push(...channelIds);
      clauses.push("visibility = 'public'");
    } else {
      clauses.push("visibility = 'public'");
    }
    if (category && category !== "All") {
      clauses.push("category = ?");
      values.push(category);
    }
    if (search) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR channel_name LIKE ? ESCAPE '\\')");
      const escaped = search.replace(/[\\%_]/g, "\\$&");
      values.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    if (sort === "live") clauses.push("is_live = 1 AND (stream_url IS NOT NULL OR mux_live_stream_id IS NOT NULL)");
    const orderBy = sort === "recent" || sort === "live"
      ? "created_at DESC"
      : "views DESC, created_at DESC";
    values.push(Math.max(1, Math.min(Number(limit) || 100, 100)));
    const rows = await db.prepare(`SELECT * FROM videos WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`).all(...values);
    return rows.map(normalizeVideo);
  }

  app.get("/api/health", async (req, res) => {
    try {
      await db.prepare("SELECT 1 AS ok").get();
      if (sessionStore) await sessionStore.ping();
      return res.json({ status: "ok", billingConfigured: stripeReady, muxConfigured: Boolean(muxClient), emailConfigured: mailReady });
    } catch (error) {
      console.error("Application health check failed.", error.message);
      return res.status(503).json({ status: "degraded" });
    }
  });
  app.get("/api/auth/me", (req, res) => res.json({ user: safeUser(req.user) }));

  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";
      const channelName = typeof req.body.channelName === "string" ? req.body.channelName.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
      if (password.length < 10 || Buffer.byteLength(password, "utf8") > 128) return res.status(400).json({ error: "Password must be 10–128 bytes long." });
      if (channelName.length < 2 || channelName.length > 60) return res.status(400).json({ error: "Channel name must be 2–60 characters." });
      if (requireEmailVerification && !mailReady) return res.status(503).json({ error: "Account email verification is not configured. Contact the site administrator." });
      if (await db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return res.status(409).json({ error: "An account with this email already exists." });
      const userId = crypto.randomUUID();
      const salt = crypto.randomBytes(16);
      const passwordHash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      await db.prepare(`
        INSERT INTO users (id, email, password_salt, password_hash, channel_name, email_verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(userId, email, salt.toString("hex"), passwordHash.toString("hex"), channelName, requireEmailVerification ? 0 : 1, new Date().toISOString());
      const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
      if (requireEmailVerification) {
        try {
          await issueAccountToken(user, "verify_email");
        } catch (error) {
          console.error("Could not send the account verification email.", error.message);
          return res.status(503).json({ error: "Your account was created, but the verification email could not be sent. Try resending it shortly." });
        }
        return res.status(201).json({ verificationRequired: true });
      }
      await setSession(res, userId);
      return res.status(201).json({ user: safeUser(user) });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") return res.status(409).json({ error: "An account with this email already exists." });
      return next(error);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const ip = req.ip;
      let attempts;
      if (sessionStore) {
        if (await sessionStore.rateLimit("login", ip, 10, 15 * 60 * 1000)) {
          return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
        }
      } else {
        attempts = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
        if (attempts.resetAt < Date.now()) {
          attempts.count = 0;
          attempts.resetAt = Date.now() + 15 * 60 * 1000;
        }
        if (attempts.count >= 10) return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
      }
      const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";
      const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
      if (!user) {
        if (attempts) {
          attempts.count += 1;
          loginAttempts.set(ip, attempts);
        }
        return res.status(401).json({ error: "Email or password is incorrect." });
      }
      const actual = await scrypt(password, Buffer.from(user.password_salt, "hex"), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const expected = Buffer.from(user.password_hash, "hex");
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        if (attempts) {
          attempts.count += 1;
          loginAttempts.set(ip, attempts);
        }
        return res.status(401).json({ error: "Email or password is incorrect." });
      }
      if (!sessionStore) loginAttempts.delete(ip);
      else await sessionStore.clearRateLimit("login", ip);
      if (requireEmailVerification && !user.email_verified) {
        return res.status(403).json({ error: "Verify your email before signing in. You can request a new verification link." });
      }
      await setSession(res, user.id);
      return res.json({ user: safeUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/verify-email", async (req, res) => {
    const token = typeof req.body.token === "string" ? req.body.token : "";
    if (token.length < 32 || token.length > 128) return res.status(400).json({ error: "This verification link is invalid or expired." });
    const row = await db.prepare("SELECT user_id FROM account_tokens WHERE token_hash = ? AND purpose = 'verify_email' AND expires_at > ?")
      .get(hashToken(token), Date.now());
    if (!row) return res.status(400).json({ error: "This verification link is invalid or expired." });
    const consumed = await runTransaction(db, async () => {
      const deletion = await db.prepare("DELETE FROM account_tokens WHERE token_hash = ? AND purpose = 'verify_email'").run(hashToken(token));
      if (!deletion.changes) return false;
      await db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(row.user_id);
      return true;
    });
    if (!consumed) return res.status(400).json({ error: "This verification link is invalid or expired." });
    return res.json({ verified: true });
  });

  app.post("/api/auth/resend-verification", async (req, res) => {
    if (await rateLimitAction(req, "verify")) return res.status(429).json({ error: "Please wait before requesting another email." });
    if (!mailReady) return res.status(503).json({ error: "Account email delivery is temporarily unavailable." });
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const user = await db.prepare("SELECT * FROM users WHERE email = ? AND email_verified = 0").get(email);
    if (user) {
      try {
        await issueAccountToken(user, "verify_email");
      } catch (error) {
        console.error("Could not resend the account verification email.", error.message);
      }
    }
    return res.status(202).json({ message: "If the account needs verification, an email request will be processed." });
  });

  app.post("/api/auth/forgot-password", async (req, res) => {
    if (await rateLimitAction(req, "password-reset")) return res.status(429).json({ error: "Please wait before requesting another reset email." });
    if (!mailReady) return res.status(503).json({ error: "Account email delivery is temporarily unavailable." });
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (user) {
      try {
        await issueAccountToken(user, "password_reset");
      } catch (error) {
        console.error("Could not send the password recovery email.", error.message);
      }
    }
    return res.status(202).json({ message: "If an account matches that address, a password reset email request will be processed." });
  });

  app.post("/api/auth/reset-password", async (req, res, next) => {
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (token.length < 32 || token.length > 128) return res.status(400).json({ error: "This reset link is invalid or expired." });
    if (password.length < 10 || Buffer.byteLength(password, "utf8") > 128) return res.status(400).json({ error: "Password must be 10–128 bytes long." });
    try {
      const tokenHash = hashToken(token);
      const row = await db.prepare("SELECT user_id FROM account_tokens WHERE token_hash = ? AND purpose = 'password_reset' AND expires_at > ?")
        .get(tokenHash, Date.now());
      if (!row) return res.status(400).json({ error: "This reset link is invalid or expired." });
      const salt = crypto.randomBytes(16);
      const passwordHash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const updated = await runTransaction(db, async () => {
        const lockToken = db.isPostgres ? " FOR UPDATE" : "";
        const stillValid = await db.prepare(`SELECT 1 FROM account_tokens WHERE token_hash = ? AND purpose = 'password_reset' AND expires_at > ?${lockToken}`).get(tokenHash, Date.now());
        if (!stillValid) return false;
        await db.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?")
          .run(salt.toString("hex"), passwordHash.toString("hex"), row.user_id);
        if (!sessionStore) await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
        await db.prepare("DELETE FROM account_tokens WHERE user_id = ?").run(row.user_id);
        return true;
      });
      if (!updated) return res.status(400).json({ error: "This reset link is invalid or expired." });
      if (sessionStore) await sessionStore.revokeUser(row.user_id);
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${env.NODE_ENV === "production" ? "; Secure" : ""}`);
      return res.json({ reset: true });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    if (req.user) {
      if (sessionStore) await sessionStore.revokeUser(req.user.id);
      else await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.user.id);
    }
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${env.NODE_ENV === "production" ? "; Secure" : ""}`);
    return res.json({ success: true });
  });

  app.get("/api/videos", async (req, res) => {
    const category = typeof req.query.category === "string" ? req.query.category : "";
    if (category && category !== "All" && category !== "Live" && !CATEGORIES.has(category)) return res.status(400).json({ error: "Unknown video category." });
    const sort = req.query.sort === "live" ? "live" : req.query.sort === "recent" ? "recent" : "popular";
    const videos = await queryVideoList({ category, search: typeof req.query.search === "string" ? req.query.search.trim().slice(0, 120) : "", sort });
    return res.json({ videos });
  });

  app.get("/api/recommendations", requireUser, async (req, res) => {
    const watched = (await db.prepare("SELECT video_id FROM watch_history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 100").all(req.user.id)).map((row) => row.video_id);
    const subscriptions = (await db.prepare("SELECT channel_id FROM subscriptions WHERE user_id = ?").all(req.user.id)).map((row) => row.channel_id);
    const interests = new Map();
    const addInterest = (rows, weight) => rows.forEach((row) => interests.set(row.category, (interests.get(row.category) || 0) + weight));
    addInterest(await db.prepare("SELECT videos.category FROM likes JOIN videos ON videos.id = likes.video_id WHERE likes.user_id = ?").all(req.user.id), 4);
    addInterest(await db.prepare("SELECT videos.category FROM watch_history JOIN videos ON videos.id = watch_history.video_id WHERE watch_history.user_id = ? ORDER BY watched_at DESC LIMIT 30").all(req.user.id), 2);
    const candidates = (await queryVideoList({ sort: "popular", limit: 100 })).map((video) => {
      const isSubscribed = subscriptions.includes(video.channelId);
      const wasWatched = watched.includes(video.id);
      const categoryAffinity = interests.get(video.category) || 0;
      const popularity = Math.log10(Number(video.views) + 1);
      return { ...video, recommendationScore: (isSubscribed ? 8 : 0) + categoryAffinity + popularity - (wasWatched ? 6 : 0) };
    });
    candidates.sort((a, b) => b.recommendationScore - a.recommendationScore);
    return res.json({ videos: candidates.slice(0, 50).map(({ recommendationScore, ...video }) => video) });
  });

  app.get("/api/history", requireUser, async (req, res) => {
    const rows = await db.prepare(`
      SELECT videos.* FROM watch_history
      JOIN videos ON videos.id = watch_history.video_id
      WHERE watch_history.user_id = ? AND videos.visibility != 'private'
      ORDER BY watch_history.watched_at DESC LIMIT 100
    `).all(req.user.id);
    return res.json({ videos: rows.map(normalizeVideo) });
  });

  app.get("/api/subscriptions", requireUser, async (req, res) => {
    const channels = (await db.prepare("SELECT channel_id FROM subscriptions WHERE user_id = ?").all(req.user.id)).map((row) => row.channel_id);
    return res.json({ videos: await queryVideoList({ channelIds: channels, sort: "recent" }) });
  });

  app.get("/api/channels/:id", async (req, res) => {
    const userChannel = await db.prepare("SELECT id, channel_name FROM users WHERE id = ?").get(req.params.id);
    const videoChannel = await db.prepare(`
      SELECT channel_id, channel_name FROM videos WHERE channel_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(req.params.id);
    const channel = userChannel
      ? { id: userChannel.id, name: userChannel.channel_name }
      : videoChannel && { id: videoChannel.channel_id, name: videoChannel.channel_name };
    if (!channel) return res.status(404).json({ error: "Channel not found." });
    const subscriberCount = (await db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE channel_id = ?").get(channel.id)).count;
    const videoCount = (await db.prepare("SELECT COUNT(*) AS count FROM videos WHERE channel_id = ? AND visibility = 'public'").get(channel.id)).count;
    return res.json({ channel: { id: channel.id, name: channel.name, subscriberCount, videoCount } });
  });

  app.get("/api/channels/:id/videos", async (req, res) => {
    const exists = await db.prepare("SELECT 1 FROM users WHERE id = ?").get(req.params.id)
      || await db.prepare("SELECT 1 FROM videos WHERE channel_id = ?").get(req.params.id);
    if (!exists) return res.status(404).json({ error: "Channel not found." });
    return res.json({ videos: await queryVideoList({ channelIds: [req.params.id], sort: "recent" }) });
  });

  app.get("/api/saved", requireUser, async (req, res) => {
    const rows = await db.prepare(`
      SELECT videos.* FROM saved_videos JOIN videos ON videos.id = saved_videos.video_id
      WHERE saved_videos.user_id = ? AND videos.visibility != 'private'
      ORDER BY saved_videos.created_at DESC LIMIT 100
    `).all(req.user.id);
    return res.json({ videos: rows.map(normalizeVideo) });
  });

  app.get("/api/videos/:id", async (req, res, next) => {
    try {
    const video = await db.prepare("SELECT * FROM videos WHERE id = ? AND (visibility IN ('public', 'unlisted') OR owner_id = ?)").get(req.params.id, req.user && req.user.id || "");
    if (!video) return res.status(404).json({ error: "Video not found." });
    const owner = video.owner_id === (req.user && req.user.id);
    if (video.visibility === "private" && !owner) return res.status(404).json({ error: "Video not found." });
    const commentRows = await db.prepare(`
      SELECT comments.id, comments.text, comments.created_at, users.channel_name
      FROM comments JOIN users ON users.id = comments.user_id
      WHERE comments.video_id = ? ORDER BY comments.created_at DESC LIMIT 100
    `).all(video.id);
    const subscribed = owner ? false : Boolean(req.user && await db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?").get(req.user.id, video.channel_id));
    const liked = Boolean(req.user && await db.prepare("SELECT 1 FROM likes WHERE user_id = ? AND video_id = ?").get(req.user.id, video.id));
    const saved = Boolean(req.user && await db.prepare("SELECT 1 FROM saved_videos WHERE user_id = ? AND video_id = ?").get(req.user.id, video.id));
    const channel = await db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE channel_id = ?").get(video.channel_id);
    let playbackUrl = null;
    if (video.mux_playback_id && (video.processing_status === "ready" || video.processing_status === "live" || video.processing_status === "idle")) {
      playbackUrl = `https://stream.mux.com/${encodeURIComponent(video.mux_playback_id)}.m3u8`;
      if (video.mux_playback_policy === "signed") {
        if (!muxClient || !env.MUX_SIGNING_KEY || !env.MUX_PRIVATE_KEY) return res.status(503).json({ error: "Signed playback is not configured." });
        const token = await muxClient.jwt.signPlaybackId(video.mux_playback_id, { type: "video", expiration: "1h" });
        playbackUrl += `?token=${encodeURIComponent(token)}`;
      }
    }
    return res.json({
      video: { ...normalizeVideo(video), playbackUrl, subscribers: channel.count },
      comments: commentRows.map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at, channelName: row.channel_name })),
      liked,
      saved,
      subscribed,
      isOwner: owner,
    });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/videos/:id/playback", async (req, res, next) => {
    const video = await db.prepare("SELECT * FROM videos WHERE id = ?").get(req.params.id);
    if (!video || (video.visibility === "private" && (!req.user || req.user.id !== video.owner_id))) {
      return res.status(404).json({ error: "Video not found." });
    }
    if (!video.mux_playback_id || !["ready", "live", "idle"].includes(video.processing_status)) {
      return res.status(409).json({ error: "This video is not ready to play yet." });
    }
    let url = `https://stream.mux.com/${encodeURIComponent(video.mux_playback_id)}.m3u8`;
    if (video.mux_playback_policy === "signed") {
      if (!muxClient || !env.MUX_SIGNING_KEY || !env.MUX_PRIVATE_KEY) {
        return res.status(503).json({ error: "Signed playback is not configured." });
      }
      try {
        const token = await muxClient.jwt.signPlaybackId(video.mux_playback_id, { type: "video", expiration: "1h" });
        url += `?token=${encodeURIComponent(token)}`;
      } catch (error) {
        return next(error);
      }
    }
    res.setHeader("Cache-Control", video.mux_playback_policy === "public" ? "public, max-age=300" : "private, no-store");
    return res.json({ url, expiresIn: video.mux_playback_policy === "signed" ? 3600 : null });
  });

  app.post("/api/videos/:id/view", async (req, res) => {
    const video = await db.prepare("SELECT id FROM videos WHERE id = ? AND (visibility IN ('public', 'unlisted') OR owner_id = ?)")
      .get(req.params.id, req.user && req.user.id || "");
    if (!video) return res.status(404).json({ error: "Video not found." });
    await db.prepare("UPDATE videos SET views = views + 1 WHERE id = ?").run(video.id);
    if (req.user) {
      await db.prepare(`
        INSERT INTO watch_history (user_id, video_id, watched_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id, video_id) DO UPDATE SET watched_at = excluded.watched_at
      `).run(req.user.id, video.id, new Date().toISOString());
    }
    return res.json({ success: true });
  });

  app.post("/api/videos/:id/like", requireUser, async (req, res) => {
    const video = await db.prepare("SELECT id FROM videos WHERE id = ? AND visibility IN ('public', 'unlisted')").get(req.params.id);
    if (!video) return res.status(404).json({ error: "Video not found." });
    const existing = await db.prepare("SELECT 1 FROM likes WHERE user_id = ? AND video_id = ?").get(req.user.id, video.id);
    if (existing) {
      await db.prepare("DELETE FROM likes WHERE user_id = ? AND video_id = ?").run(req.user.id, video.id);
      await db.prepare("UPDATE videos SET likes = MAX(0, likes - 1) WHERE id = ?").run(video.id);
    } else {
      await db.prepare("INSERT INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)").run(req.user.id, video.id, new Date().toISOString());
      await db.prepare("UPDATE videos SET likes = likes + 1 WHERE id = ?").run(video.id);
    }
    return res.json({ liked: !existing, likes: (await db.prepare("SELECT likes FROM videos WHERE id = ?").get(video.id)).likes });
  });

  app.post("/api/videos/:id/save", requireUser, async (req, res) => {
    const video = await db.prepare("SELECT id FROM videos WHERE id = ? AND visibility IN ('public', 'unlisted')").get(req.params.id);
    if (!video) return res.status(404).json({ error: "Video not found." });
    const existing = await db.prepare("SELECT 1 FROM saved_videos WHERE user_id = ? AND video_id = ?").get(req.user.id, video.id);
    if (existing) await db.prepare("DELETE FROM saved_videos WHERE user_id = ? AND video_id = ?").run(req.user.id, video.id);
    else await db.prepare("INSERT INTO saved_videos (user_id, video_id, created_at) VALUES (?, ?, ?)").run(req.user.id, video.id, new Date().toISOString());
    return res.json({ saved: !existing });
  });

  app.post("/api/videos/:id/comments", requireUser, async (req, res) => {
    const video = await db.prepare("SELECT id FROM videos WHERE id = ? AND visibility IN ('public', 'unlisted')").get(req.params.id);
    if (!video) return res.status(404).json({ error: "Video not found." });
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 2000) return res.status(400).json({ error: "Comment must contain 1–2,000 characters." });
    await db.prepare("INSERT INTO comments (id, user_id, video_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), req.user.id, video.id, text, new Date().toISOString());
    const comments = (await db.prepare(`
      SELECT comments.id, comments.text, comments.created_at, users.channel_name
      FROM comments JOIN users ON users.id = comments.user_id
      WHERE comments.video_id = ? ORDER BY comments.created_at DESC LIMIT 100
    `).all(video.id)).map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at, channelName: row.channel_name }));
    return res.status(201).json({ comments });
  });

  app.post("/api/channels/:id/subscribe", requireUser, async (req, res) => {
    if (req.params.id.length > 128) return res.status(400).json({ error: "Invalid channel." });
    const existing = await db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?").get(req.user.id, req.params.id);
    if (existing) await db.prepare("DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?").run(req.user.id, req.params.id);
    else await db.prepare("INSERT INTO subscriptions (user_id, channel_id, created_at) VALUES (?, ?, ?)").run(req.user.id, req.params.id, new Date().toISOString());
    return res.json({ subscribed: !existing });
  });

  const storage = multer.diskStorage({
    destination: uploadDirectory,
    filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  });
  const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!MEDIA_TYPES.has(extension) || !MEDIA_TYPES.get(extension).has(file.mimetype)) {
        return callback(new Error("Choose an MP4, WebM, MOV, or OGV video file."));
      }
      return callback(null, true);
    },
  }).single("video");

  app.get("/api/studio/videos", requireUser, async (req, res) => {
    const rows = await db.prepare("SELECT * FROM videos WHERE owner_id = ? ORDER BY created_at DESC").all(req.user.id);
    return res.json({ videos: rows.map(normalizeVideo) });
  });

  app.post("/api/studio/mux/uploads", requireUser, async (req, res, next) => {
    if (!muxClient) return res.status(503).json({ error: "Mux video uploads are not configured." });
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
    const category = typeof req.body.category === "string" ? req.body.category : "Other";
    const visibility = typeof req.body.visibility === "string" ? req.body.visibility : "public";
    if (title.length < 2 || title.length > 160 || description.length > 10000) {
      return res.status(400).json({ error: "Title must be 2–160 characters and description at most 10,000 characters." });
    }
    if (!CATEGORIES.has(category) || !["public", "unlisted", "private"].includes(visibility)) {
      return res.status(400).json({ error: "Choose a valid category and visibility setting." });
    }
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO videos (id, owner_id, channel_id, channel_name, title, description, category, visibility, processing_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?)
    `).run(id, req.user.id, req.user.id, req.user.channel_name, title, description, category, visibility, new Date().toISOString());
    try {
      const response = await muxClient.video.uploads.create({
        cors_origin: `${req.protocol}://${req.get("host")}`,
        timeout: 3600,
        new_asset_settings: {
          playback_policies: [visibility === "public" ? "public" : "signed"],
          passthrough: id,
        },
      });
      const upload = response.data;
      await db.prepare("UPDATE videos SET mux_upload_id = ?, processing_status = 'uploading' WHERE id = ?").run(upload.id, id);
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json({ video: normalizeVideo(await db.prepare("SELECT * FROM videos WHERE id = ?").get(id)), upload: { id: upload.id, url: upload.url } });
    } catch (error) {
      await db.prepare("DELETE FROM videos WHERE id = ?").run(id);
      return next(error);
    }
  });

  app.post("/api/studio/live-streams", requireUser, async (req, res, next) => {
    if (!muxClient) return res.status(503).json({ error: "Mux live streaming is not configured." });
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
    const category = typeof req.body.category === "string" ? req.body.category : "Other";
    const visibility = typeof req.body.visibility === "string" ? req.body.visibility : "public";
    if (title.length < 2 || title.length > 160 || description.length > 10000) return res.status(400).json({ error: "Title must be 2–160 characters and description at most 10,000 characters." });
    if (!CATEGORIES.has(category) || !["public", "unlisted", "private"].includes(visibility)) return res.status(400).json({ error: "Choose a valid category and visibility setting." });
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO videos (id, owner_id, channel_id, channel_name, title, description, category, visibility, is_live, processing_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'idle', ?)
    `).run(id, req.user.id, req.user.id, req.user.channel_name, title, description, category, visibility, new Date().toISOString());
    try {
      const policy = visibility === "public" ? "public" : "signed";
      const response = await muxClient.video.liveStreams.create({
        playback_policies: [policy],
        passthrough: id,
        latency_mode: "reduced",
        new_asset_settings: { playback_policies: [policy], passthrough: id },
      });
      const liveStream = response.data;
      const playback = (liveStream.playback_ids || []).find((item) => item.policy === policy);
      await db.prepare(`
        UPDATE videos SET mux_live_stream_id = ?, mux_playback_id = ?, mux_playback_policy = ?,
          processing_status = 'idle', stream_url = NULL WHERE id = ?
      `).run(liveStream.id, playback && playback.id || null, policy, id);
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json({
        video: normalizeVideo(await db.prepare("SELECT * FROM videos WHERE id = ?").get(id)),
        ingest: { url: "rtmp://global-live.mux.com:5222/app", streamKey: liveStream.stream_key },
      });
    } catch (error) {
      await db.prepare("DELETE FROM videos WHERE id = ?").run(id);
      return next(error);
    }
  });

  app.post("/api/studio/live-streams/:videoId/rotate-key", requireUser, async (req, res, next) => {
    if (!muxClient) return res.status(503).json({ error: "Mux live streaming is not configured." });
    const video = await db.prepare("SELECT * FROM videos WHERE id = ? AND owner_id = ? AND mux_live_stream_id IS NOT NULL")
      .get(req.params.videoId, req.user.id);
    if (!video) return res.status(404).json({ error: "Live stream not found in your Studio." });
    try {
      const current = (await muxClient.video.liveStreams.retrieve(video.mux_live_stream_id)).data;
      if (current.status === "active") return res.status(409).json({ error: "Stop your broadcast before rotating its stream key." });
      const policy = video.mux_playback_policy || "public";
      const replacement = (await muxClient.video.liveStreams.create({
        playback_policies: [policy],
        passthrough: video.id,
        latency_mode: "reduced",
        new_asset_settings: { playback_policies: [policy], passthrough: video.id },
      })).data;
      try {
        await muxClient.video.liveStreams.delete(video.mux_live_stream_id);
        const playback = (replacement.playback_ids || []).find((item) => item.policy === policy);
        await db.prepare("UPDATE videos SET mux_live_stream_id = ?, mux_playback_id = ?, is_live = 0, processing_status = 'idle' WHERE id = ?")
          .run(replacement.id, playback && playback.id || null, video.id);
      } catch (error) {
        await muxClient.video.liveStreams.delete(replacement.id).catch((cleanupError) => {
          console.error("Could not remove an unassigned Mux live stream after key rotation failed.", cleanupError);
        });
        throw error;
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ingest: { url: "rtmp://global-live.mux.com:5222/app", streamKey: replacement.stream_key } });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/studio/videos", requireUser, (req, res, next) => {
    if (env.NODE_ENV === "production") return res.status(410).json({ error: "Use the Mux direct-upload and live-stream endpoints in production." });
    upload(req, res, async (error) => {
      if (error) {
        const status = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ error: error.message });
      }
      const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
      const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
      const category = typeof req.body.category === "string" ? req.body.category : "";
      const visibility = typeof req.body.visibility === "string" ? req.body.visibility : "public";
      const streamUrl = typeof req.body.streamUrl === "string" ? req.body.streamUrl.trim() : "";
      let parsedStream;
      if (streamUrl) {
        try {
          parsedStream = new URL(streamUrl);
        } catch {
          if (req.file) await fsp.unlink(req.file.path);
          return res.status(400).json({ error: "Enter a valid HTTPS HLS stream URL." });
        }
      }
      if (title.length < 2 || title.length > 160 || description.length > 10000) {
        if (req.file) await fsp.unlink(req.file.path);
        return res.status(400).json({ error: "Title must be 2–160 characters and description at most 10,000 characters." });
      }
      if (category && !CATEGORIES.has(category)) {
        if (req.file) await fsp.unlink(req.file.path);
        return res.status(400).json({ error: "Choose a supported category." });
      }
      if (!["public", "unlisted", "private"].includes(visibility)) {
        if (req.file) await fsp.unlink(req.file.path);
        return res.status(400).json({ error: "Choose a valid visibility setting." });
      }
      if (parsedStream && (parsedStream.protocol !== "https:" || !parsedStream.pathname.toLowerCase().endsWith(".m3u8") || parsedStream.username || parsedStream.password)) {
        if (req.file) await fsp.unlink(req.file.path);
        return res.status(400).json({ error: "Live streams must use an HTTPS .m3u8 manifest without embedded credentials." });
      }
      if (!req.file && !parsedStream) return res.status(400).json({ error: "Choose a video file or provide an HLS stream URL." });
      try {
        const channel = req.user.channel_name;
        const id = crypto.randomUUID();
        await db.prepare(`
          INSERT INTO videos (id, owner_id, channel_id, channel_name, title, description, category, visibility,
            filename, stream_url, is_live, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, req.user.id, req.user.id, channel, title, description, category || "Other", visibility,
          req.file ? req.file.filename : null, parsedStream ? parsedStream.href : null, parsedStream ? 1 : 0, new Date().toISOString());
        const video = await db.prepare("SELECT * FROM videos WHERE id = ?").get(id);
        return res.status(201).json({ video: normalizeVideo(video) });
      } catch (insertError) {
        if (req.file) await fsp.unlink(req.file.path).catch((unlinkError) => console.error("Could not remove untracked upload.", unlinkError));
        return next(insertError);
      }
    });
  });

  app.patch("/api/studio/videos/:id", requireUser, async (req, res, next) => {
    try {
    const video = await db.prepare("SELECT * FROM videos WHERE id = ? AND owner_id = ?").get(req.params.id, req.user.id);
    if (!video) return res.status(404).json({ error: "Video not found in your Studio." });
    const title = req.body.title === undefined ? video.title : String(req.body.title).trim();
    const description = req.body.description === undefined ? video.description : String(req.body.description).trim();
    const visibility = req.body.visibility === undefined ? video.visibility : req.body.visibility;
    if (title.length < 2 || title.length > 160 || description.length > 10000) return res.status(400).json({ error: "Title must be 2–160 characters and description at most 10,000 characters." });
    if (!["public", "unlisted", "private"].includes(visibility)) return res.status(400).json({ error: "Choose a valid visibility setting." });
    let playbackId = video.mux_playback_id;
    let playbackPolicy = video.mux_playback_policy;
    const desiredPolicy = visibility === "public" ? "public" : "signed";
    if (muxClient && playbackId && playbackPolicy !== desiredPolicy && (video.mux_asset_id || video.mux_live_stream_id)) {
      const replacement = video.mux_live_stream_id
        ? await muxClient.video.liveStreams.createPlaybackId(video.mux_live_stream_id, { policy: desiredPolicy })
        : await muxClient.video.assets.createPlaybackId(video.mux_asset_id, { policy: desiredPolicy });
      try {
        if (video.mux_live_stream_id) {
          await muxClient.video.liveStreams.deletePlaybackId(video.mux_live_stream_id, playbackId);
        } else {
          await muxClient.video.assets.deletePlaybackId(video.mux_asset_id, playbackId);
        }
      } catch (error) {
        const newPlayback = replacement.data;
        const cleanup = video.mux_live_stream_id
          ? muxClient.video.liveStreams.deletePlaybackId(video.mux_live_stream_id, newPlayback.id)
          : muxClient.video.assets.deletePlaybackId(video.mux_asset_id, newPlayback.id);
        await cleanup.catch((cleanupError) => console.error("Could not remove a replacement playback ID after visibility change failed.", cleanupError));
        throw error;
      }
      playbackId = replacement.data.id;
      playbackPolicy = desiredPolicy;
    }
    await db.prepare("UPDATE videos SET title = ?, description = ?, visibility = ?, mux_playback_id = ?, mux_playback_policy = ? WHERE id = ?")
      .run(title, description, visibility, playbackId, playbackPolicy, video.id);
    return res.json({ video: normalizeVideo(await db.prepare("SELECT * FROM videos WHERE id = ?").get(video.id)) });
    } catch (error) {
      return next(error);
    }
  });

  app.delete("/api/studio/videos/:id", requireUser, async (req, res, next) => {
    try {
      const video = await db.prepare("SELECT * FROM videos WHERE id = ? AND owner_id = ?").get(req.params.id, req.user.id);
      if (!video) return res.status(404).json({ error: "Video not found in your Studio." });
      if (video.filename) {
        try {
          await fsp.unlink(path.join(uploadDirectory, video.filename));
        } catch (error) {
          if (error.code !== "ENOENT") return next(error);
        }
      }
      if (muxClient && video.mux_upload_id && !video.mux_asset_id) {
        const upload = (await muxClient.video.uploads.retrieve(video.mux_upload_id)).data;
        if (upload.status === "waiting") await muxClient.video.uploads.cancel(video.mux_upload_id);
      }
      if (muxClient && video.mux_live_stream_id) await muxClient.video.liveStreams.delete(video.mux_live_stream_id);
      if (muxClient && video.mux_asset_id) await muxClient.video.assets.delete(video.mux_asset_id);
      await db.prepare("DELETE FROM videos WHERE id = ? AND owner_id = ?").run(video.id, req.user.id);
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/media/:filename", async (req, res) => {
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) return res.status(400).json({ error: "Invalid media filename." });
    const video = await db.prepare("SELECT owner_id, visibility FROM videos WHERE filename = ?").get(filename);
    if (!video) return res.status(404).json({ error: "Media not found." });
    if (video.visibility === "private" && (!req.user || req.user.id !== video.owner_id)) return res.status(404).json({ error: "Media not found." });
    res.setHeader("Cache-Control", video.visibility === "public" ? "public, max-age=3600" : "private, no-store");
    return res.sendFile(filename, { root: uploadDirectory });
  });

  app.get("/api/billing/status", (req, res) => res.json({
    configured: stripeReady,
    mode: stripeMode,
    isPremium: Boolean(req.user && (req.user.membership_status === "active" || req.user.membership_status === "trialing")),
    status: req.user ? req.user.membership_status : "signed_out",
  }));

  app.post("/api/billing/checkout", requireUser, async (req, res, next) => {
    if (!stripeReady) return res.status(503).json({ error: `Stripe ${stripeMode} billing is not configured with a matching secret key, price, and webhook.` });
    try {
      const origin = appUrl || `${req.protocol}://${req.get("host")}`;
      let customer = req.user.stripe_customer_id;
      if (!customer) {
        const created = await stripeClient.customers.create({ email: req.user.email, name: req.user.channel_name, metadata: { userId: req.user.id } });
        customer = created.id;
        await db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customer, req.user.id);
      }
      const session = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        customer,
        line_items: [{ price: stripePrice, quantity: 1 }],
        client_reference_id: req.user.id,
        metadata: { userId: req.user.id },
        subscription_data: { metadata: { userId: req.user.id } },
        success_url: `${origin}/premium?checkout=success`,
        cancel_url: `${origin}/premium?checkout=cancelled`,
      });
      return res.json({ url: session.url });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/billing/portal", requireUser, async (req, res, next) => {
    if (!stripeReady) return res.status(503).json({ error: `Stripe ${stripeMode} billing is not configured.` });
    if (!req.user.stripe_customer_id) return res.status(404).json({ error: "No billing account is linked to this user." });
    try {
      const session = await stripeClient.billingPortal.sessions.create({
        customer: req.user.stripe_customer_id,
        return_url: `${appUrl || `${req.protocol}://${req.get("host")}`}/premium`,
      });
      return res.json({ url: session.url });
    } catch (error) {
      return next(error);
    }
  });

  if (fs.existsSync(webRoot)) {
    app.use(express.static(webRoot, { index: false, maxAge: env.NODE_ENV === "production" ? "1h" : 0 }));
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) return next();
      return res.sendFile(path.join(webRoot, "index.html"));
    });
  }

  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("Request failed.", error);
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request payload is too large." });
    return res.status(500).json({ error: "The server could not complete the request." });
  });

  return app;
}

if (require.main === module) {
  if (process.env.NODE_ENV === "production") {
    const errors = getProductionConfigErrors(process.env);
    if (errors.length) throw new Error(`Production configuration is incomplete: ${errors.join(", ")}`);
  }
  (async () => {
    let db;
    let sessionStore;
    if (process.env.NODE_ENV === "production") {
      const databaseUrl = new URL(process.env.DATABASE_URL);
      const redisUrl = new URL(process.env.REDIS_URL);
      if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !databaseUrl.hostname
        || !["redis:", "rediss:"].includes(redisUrl.protocol) || !redisUrl.hostname) {
        throw new Error("DATABASE_URL must use postgres:// or postgresql:// and REDIS_URL must use redis:// or rediss://.");
      }
      db = createPostgresDatabase(databaseUrl.toString());
      try {
        await migratePostgres(db);
        sessionStore = await connectRedisSessionStore(redisUrl.toString());
      } catch (error) {
        if (sessionStore) await sessionStore.close();
        await db.close();
        throw error;
      }
    }
    const app = createApp({ db, sessionStore });
    const port = Number(process.env.PORT || 5000);
    const server = app.listen(port, () => {
      console.log(`VoxBox server listening on http://localhost:${port}`);
      if (!app.locals.stripeReady) console.warn("Stripe billing is disabled until matching mode configuration is supplied.");
      if (!app.locals.muxReady) console.warn("Mux media delivery and ingest are disabled until configured.");
      if (!app.locals.emailReady) console.warn("Email delivery is disabled until Resend, sender, and public app URL are configured.");
    });
    const shutdown = () => server.close(async () => {
      await app.locals.sessionStore?.close();
      await app.locals.db.close();
      process.exit(0);
    });
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })().catch((error) => {
    console.error("Could not start VoxBox.", error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, createDatabase, getProductionConfigErrors };
