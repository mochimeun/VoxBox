const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDatabase } = require("../server");
const { postgresSql } = require("./postgres");
const { RedisSessionStore } = require("./redis-sessions");

test("PostgreSQL SQL conversion preserves quoted placeholders and converts SQLite expressions", () => {
  assert.equal(
    postgresSql("SELECT * FROM videos WHERE title LIKE ? AND note = '?' AND id = ? AND likes = MAX(0, likes - 1)"),
    "SELECT * FROM videos WHERE title ILIKE $1 AND note = '?' AND id = $2 AND likes = GREATEST(0, likes - 1)",
  );
  assert.equal(
    postgresSql("SELECT id FROM videos WHERE title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'"),
    "SELECT id FROM videos WHERE title ILIKE $1 ESCAPE '\\' OR description ILIKE $2 ESCAPE '\\'",
  );
});

test("SQLite startup upgrades an existing schema additively and idempotently", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videohub-migration-test-"));
  const filename = path.join(directory, "legacy.sqlite");
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, channel_name TEXT NOT NULL,
      membership_status TEXT NOT NULL DEFAULT 'free', stripe_customer_id TEXT UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE videos (
      id TEXT PRIMARY KEY, owner_id TEXT, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public', filename TEXT, source_url TEXT, stream_url TEXT,
      thumbnail_url TEXT, is_live INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0
    );
  `);
  legacy.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = createDatabase(filename);
  const userColumns = first.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
  const videoColumns = first.prepare("PRAGMA table_info(videos)").all().map((column) => column.name);
  assert.ok(userColumns.includes("email_verified"));
  for (const column of ["mux_upload_id", "mux_asset_id", "mux_playback_id", "mux_live_stream_id", "processing_status"]) {
    assert.ok(videoColumns.includes(column));
  }
  first.close();

  const second = createDatabase(filename);
  assert.equal(second.prepare("SELECT COUNT(*) AS count FROM videos").get().count, 4);
  second.close();
});

test("Redis session storage shares records and invalidates every session for a reset account", async () => {
  const records = new Map();
  const indexes = new Map();
  const counters = new Map();
  const client = {
    isOpen: true,
    get: async (key) => records.get(key) || null,
    del: async (key) => { records.delete(key); counters.delete(key); },
    zRange: async (key) => [...(indexes.get(key) || new Map()).keys()],
    multi() {
      const commands = [];
      const chain = {
        set(key, value) { commands.push(() => records.set(key, value)); return chain; },
        incr(key) {
          commands.push(() => {
            const value = Number(counters.get(key) || 0) + 1;
            counters.set(key, value);
            return value;
          });
          return chain;
        },
        pExpire() { commands.push(() => true); return chain; },
        zAdd(key, entries) {
          commands.push(() => {
            const values = indexes.get(key) || new Map();
            for (const entry of entries) values.set(entry.value, entry.score);
            indexes.set(key, values);
          });
          return chain;
        },
        zRemRangeByScore(key, minimum, maximum) {
          commands.push(() => {
            const values = indexes.get(key) || new Map();
            for (const [token, score] of values) {
              if ((minimum === "-inf" || score >= Number(minimum)) && score <= Number(maximum)) values.delete(token);
            }
          });
          return chain;
        },
        expire() { return chain; },
        del(key) { commands.push(() => records.delete(key)); return chain; },
        zRem(key, token) { commands.push(() => indexes.get(key)?.delete(token)); return chain; },
        async exec() { return commands.map((command) => command()); },
      };
      return chain;
    },
  };
  const store = new RedisSessionStore(client);
  await store.create("session-one", "user-1", Date.now() + 60_000);
  await store.create("session-two", "user-1", Date.now() + 60_000);
  await store.create("other-user-session", "user-2", Date.now() + 60_000);

  assert.equal((await store.load("session-one")).userId, "user-1");
  await store.revokeUser("user-1");
  assert.equal(await store.load("session-one"), null);
  assert.equal(await store.load("session-two"), null);
  assert.equal((await store.load("other-user-session")).userId, "user-2");
  const secondStore = new RedisSessionStore(client);
  assert.equal(await store.rateLimit("login", "192.0.2.5", 2, 60_000), false);
  assert.equal(await secondStore.rateLimit("login", "192.0.2.5", 2, 60_000), false);
  assert.equal(await store.rateLimit("login", "192.0.2.5", 2, 60_000), true);
  await secondStore.clearRateLimit("login", "192.0.2.5");
  assert.equal(await store.rateLimit("login", "192.0.2.5", 2, 60_000), false);
});
