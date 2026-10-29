const { AsyncLocalStorage } = require("node:async_hooks");

const connectionContext = new AsyncLocalStorage();

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    channel_name TEXT NOT NULL, membership_status TEXT NOT NULL DEFAULT 'free', stripe_customer_id TEXT UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))",
  `CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE SET NULL, channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'unlisted', 'private')),
    filename TEXT, source_url TEXT, stream_url TEXT, thumbnail_url TEXT, mux_upload_id TEXT UNIQUE,
    mux_asset_id TEXT UNIQUE, mux_playback_id TEXT UNIQUE, mux_live_stream_id TEXT UNIQUE, mux_playback_policy TEXT,
    processing_status TEXT NOT NULL DEFAULT 'ready', is_live INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS videos_catalog_idx ON videos(visibility, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS videos_channel_idx ON videos(channel_id)",
  `CREATE TABLE IF NOT EXISTS account_tokens (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('verify_email', 'password_reset')),
    expires_at BIGINT NOT NULL, created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS account_tokens_expiry_idx ON account_tokens(expires_at)",
  `CREATE TABLE IF NOT EXISTS provider_events (
    provider TEXT NOT NULL, event_id TEXT NOT NULL, processed_at TEXT NOT NULL, PRIMARY KEY(provider, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS likes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, video_id)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS comments_video_idx ON comments(video_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel_id TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(user_id, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS watch_history (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, watched_at TEXT NOT NULL,
    PRIMARY KEY(user_id, video_id)
  )`,
  `CREATE TABLE IF NOT EXISTS saved_videos (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, video_id)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_upload_idx ON videos(mux_upload_id) WHERE mux_upload_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_asset_idx ON videos(mux_asset_id) WHERE mux_asset_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_playback_idx ON videos(mux_playback_id) WHERE mux_playback_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS videos_mux_live_idx ON videos(mux_live_stream_id) WHERE mux_live_stream_id IS NOT NULL",
];

function postgresSql(sql) {
  let index = 0;
  let result = "";
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      result += char;
      if (char === quote) {
        if (sql[i + 1] === quote) {
          result += sql[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      result += char;
    } else if (char === "?") {
      index += 1;
      result += `$${index}`;
    } else {
      result += char;
    }
  }
  return result
    .replace(/\bLIKE\b/gi, "ILIKE")
    .replace(/MAX\s*\(\s*0\s*,\s*likes\s*-\s*1\s*\)/gi, "GREATEST(0, likes - 1)");
}

function normalizeRow(row) {
  if (!row) return row;
  if (typeof row.count === "string") row.count = Number(row.count);
  return row;
}

function createPostgresDatabase(databaseUrl) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX || 10) });
  const db = {
    pool,
    isPostgres: true,
    prepare(sql) {
      const text = postgresSql(sql);
      return {
        async get(...params) {
          const client = connectionContext.getStore() || pool;
          const result = await client.query(text, params);
          return normalizeRow(result.rows[0]);
        },
        async all(...params) {
          const client = connectionContext.getStore() || pool;
          const result = await client.query(text, params);
          return result.rows.map(normalizeRow);
        },
        async run(...params) {
          const client = connectionContext.getStore() || pool;
          const result = await client.query(text, params);
          return { changes: result.rowCount };
        },
      };
    },
    transaction(callback) {
      return async (...args) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await connectionContext.run(client, () => callback(...args));
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}

async function migratePostgres(db) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(739184206)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const migration = await client.query("SELECT version FROM schema_migrations WHERE version = 1");
    if (migration.rowCount === 0) {
      for (const statement of schema) await client.query(statement);
      await client.query("INSERT INTO schema_migrations (version) VALUES (1)");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(739184206)").get();
    const count = Number((await db.prepare("SELECT COUNT(*) AS count FROM videos").get()).count);
    if (count) return;
    const now = new Date().toISOString();
    const seed = db.prepare(`
      INSERT INTO videos (id, channel_id, channel_name, title, description, category, visibility, source_url, thumbnail_url, created_at, views, likes)
      VALUES (?, ?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?)
    `);
    const samples = [
      ["welcome-garden", "channel-field-notes", "Field Notes", "A quiet morning in the greenhouse", "A sample video to get started. Create an account to publish your own work.", "Learning", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", null, "2025-08-04T12:00:00.000Z", 12400, 760],
      ["welcome-music", "channel-soft-signal", "Soft Signal", "Focus music for a rainy afternoon", "A sample music listing. The same sample clip is used as placeholder media.", "Music", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", null, "2025-08-02T12:00:00.000Z", 32100, 1890],
      ["welcome-cooking", "channel-good-table", "Good Table", "One-pan dinner with crispy potatoes", "A sample cooking listing. Upload a video to replace the demo catalog with your own.", "Cooking", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", null, "2025-07-28T12:00:00.000Z", 8700, 390],
      ["welcome-tech", "channel-plain-tech", "Plain English Tech", "What actually happens when you hit save?", "A sample technology listing for the local demo catalog.", "Technology", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", null, "2025-07-21T12:00:00.000Z", 19400, 1020],
    ];
    for (const sample of samples) await seed.run(...sample.slice(0, 8), sample[8] || now, sample[9], sample[10]);
  })();
}

module.exports = { createPostgresDatabase, migratePostgres, postgresSql };
