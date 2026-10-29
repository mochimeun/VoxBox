const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const request = require("supertest");
const { createApp, getProductionConfigErrors } = require("../server");

async function createTestApp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videohub-test-"));
  const app = createApp({
    dataDirectory: directory,
    databasePath: path.join(directory, "test.sqlite"),
    uploadDirectory: path.join(directory, "uploads"),
    webRoot: path.join(directory, "missing-build"),
    env: { NODE_ENV: "test" },
  });
  t.after(async () => {
    app.locals.db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return app;
}

async function register(agent, email = "creator@example.test") {
  const response = await agent.post("/api/auth/register").send({
    email,
    password: "local-test-password",
    channelName: "Sample Creator",
  });
  assert.equal(response.status, 201, response.body.error);
  return response.body.user;
}

test("accounts use cookie sessions, reject duplicates, and can sign out", async (t) => {
  const app = await createTestApp(t);
  const agent = request.agent(app);
  const user = await register(agent);
  assert.equal(user.email, "creator@example.test");
  assert.equal((await agent.get("/api/auth/me")).body.user.id, user.id);

  const duplicate = await agent.post("/api/auth/register").send({
    email: "CREATOR@example.test",
    password: "local-test-password",
    channelName: "Second Channel",
  });
  assert.equal(duplicate.status, 409);

  const logout = await agent.post("/api/auth/logout");
  assert.equal(logout.status, 200);
  assert.equal((await agent.get("/api/auth/me")).body.user, null);
  assert.equal((await agent.get("/api/history")).status, 401);
});

test("users upload, publish, edit, and delete only their own videos", async (t) => {
  const app = await createTestApp(t);
  const owner = request.agent(app);
  await register(owner);
  const upload = await owner.post("/api/studio/videos")
    .field("title", "A local test upload")
    .field("description", "Uploaded in the integration test.")
    .field("category", "Learning")
    .field("visibility", "public")
    .attach("video", Buffer.from("not decoded by this metadata-only test"), {
      filename: "sample.mp4",
      contentType: "video/mp4",
    });
  assert.equal(upload.status, 201, upload.body.error);
  assert.match(upload.body.video.mediaUrl, /^\/media\/[0-9a-f-]+\.mp4$/);

  const catalog = await request(app).get("/api/videos?search=local%20test");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.videos[0].title, "A local test upload");

  const other = request.agent(app);
  await register(other, "other@example.test");
  const forbidden = await other.patch(`/api/studio/videos/${upload.body.video.id}`).send({ visibility: "private" });
  assert.equal(forbidden.status, 404);

  const updated = await owner.patch(`/api/studio/videos/${upload.body.video.id}`).send({ visibility: "private" });
  assert.equal(updated.status, 200);
  assert.equal((await request(app).get(`/api/videos/${upload.body.video.id}`)).status, 404);
  assert.equal((await request(app).get(upload.body.video.mediaUrl)).status, 404);
  assert.equal((await owner.get(upload.body.video.mediaUrl)).status, 200);

  const deleted = await owner.delete(`/api/studio/videos/${upload.body.video.id}`);
  assert.equal(deleted.status, 200);
  assert.equal((await owner.get("/api/studio/videos")).body.videos.length, 0);
});

test("live HLS streams appear only in the live catalog and reject insecure URLs", async (t) => {
  const app = await createTestApp(t);
  const owner = request.agent(app);
  await register(owner);

  const invalid = await owner.post("/api/studio/videos")
    .field("title", "Insecure live stream")
    .field("category", "Technology")
    .field("isLive", "true")
    .field("streamUrl", "http://localhost/private.m3u8");
  assert.equal(invalid.status, 400);

  const live = await owner.post("/api/studio/videos")
    .field("title", "Hosted live event")
    .field("description", "A test HLS stream listing.")
    .field("category", "Technology")
    .field("visibility", "public")
    .field("isLive", "true")
    .field("streamUrl", "https://streams.example.test/events/demo.m3u8");
  assert.equal(live.status, 201, live.body.error);
  assert.equal(live.body.video.isLive, true);

  const catalog = await request(app).get("/api/videos?sort=live");
  assert.equal(catalog.body.videos.length, 1);
  assert.equal(catalog.body.videos[0].streamUrl, live.body.video.streamUrl);
});

test("likes, comments, subscriptions, watch history, and recommendations are account-backed", async (t) => {
  const app = await createTestApp(t);
  const agent = request.agent(app);
  await register(agent);
  const videoId = "welcome-garden";

  assert.equal((await agent.post(`/api/videos/${videoId}/like`)).body.liked, true);
  assert.equal((await agent.post(`/api/videos/${videoId}/like`)).body.liked, false);
  const comment = await agent.post(`/api/videos/${videoId}/comments`).send({ text: "A real saved comment." });
  assert.equal(comment.status, 201);
  assert.equal(comment.body.comments[0].text, "A real saved comment.");

  const details = await agent.get(`/api/videos/${videoId}`);
  const subscription = await agent.post(`/api/channels/${details.body.video.channelId}/subscribe`);
  assert.equal(subscription.body.subscribed, true);
  await agent.post(`/api/videos/${videoId}/view`);

  assert.ok((await agent.get("/api/history")).body.videos.some((video) => video.id === videoId));
  assert.ok((await agent.get("/api/subscriptions")).body.videos.some((video) => video.id === videoId));
  const recommendations = await agent.get("/api/recommendations");
  assert.equal(recommendations.status, 200);
  assert.ok(recommendations.body.videos.length > 0);
});

test("premium endpoints clearly require test billing configuration", async (t) => {
  const app = await createTestApp(t);
  const agent = request.agent(app);
  await register(agent);
  const status = await agent.get("/api/billing/status");
  assert.equal(status.body.configured, false);
  const checkout = await agent.post("/api/billing/checkout");
  assert.equal(checkout.status, 503);
});

test("Stripe Checkout is test-key-only and verified webhooks activate membership", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videohub-stripe-test-"));
  const checkoutCalls = [];
  let webhookEvent = {
    id: "evt_initial",
    type: "checkout.session.completed",
    data: { object: { metadata: { userId: "pending" }, customer: "cus_demo", subscription: "sub_demo" } },
  };
  const stripeClient = {
    customers: { create: async () => ({ id: "cus_demo" }) },
    checkout: { sessions: { create: async (params) => {
      checkoutCalls.push(params);
      return { url: "https://checkout.stripe.com/test-session" };
    } } },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.com/test-portal" }) } },
    subscriptions: { retrieve: async () => ({ status: "active" }) },
    webhooks: { constructEvent: (body, signature, secret) => {
      assert.ok(Buffer.isBuffer(body));
      assert.equal(signature, "test-signature");
      assert.equal(secret, "whsec_local_test");
      return webhookEvent;
    } },
  };
  const app = createApp({
    dataDirectory: directory,
    databasePath: path.join(directory, "test.sqlite"),
    uploadDirectory: path.join(directory, "uploads"),
    webRoot: path.join(directory, "missing-build"),
    env: {
      NODE_ENV: "test",
      STRIPE_SECRET_KEY: "sk_test_local",
      STRIPE_PRICE_ID: "price_test_monthly",
      STRIPE_WEBHOOK_SECRET: "whsec_local_test",
    },
    stripeClient,
  });
  t.after(async () => {
    app.locals.db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const agent = request.agent(app);
  const user = await register(agent);
  webhookEvent = {
    id: "evt_checkout_complete",
    type: "checkout.session.completed",
    data: { object: { metadata: { userId: user.id }, customer: "cus_demo", subscription: "sub_demo" } },
  };
  const checkout = await agent.post("/api/billing/checkout");
  assert.equal(checkout.status, 200, checkout.body.error);
  assert.equal(checkout.body.url, "https://checkout.stripe.com/test-session");
  assert.equal(checkoutCalls[0].mode, "subscription");
  assert.equal(checkoutCalls[0].line_items[0].price, "price_test_monthly");
  assert.equal(checkoutCalls[0].metadata.userId, user.id);

  const webhook = await request(app).post("/api/billing/webhook")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", "test-signature")
    .send({ id: "evt_checkout_complete" });
  assert.equal(webhook.status, 200, webhook.body.error);
  assert.equal((await agent.get("/api/billing/status")).body.isPremium, true);
});

test("email verification and password recovery use expiring one-time links", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videohub-email-test-"));
  const sent = [];
  const sessions = new Map();
  const rateLimits = new Map();
  const sessionStore = {
    async load(tokenHash) { return sessions.get(tokenHash) || null; },
    async create(tokenHash, userId, expiresAt) { sessions.set(tokenHash, { userId, expiresAt }); },
    async revoke(tokenHash) { sessions.delete(tokenHash); },
    async revokeUser(userId) {
      for (const [tokenHash, session] of sessions) if (session.userId === userId) sessions.delete(tokenHash);
    },
    async rateLimit(scope, identifier, limit) {
      const key = `${scope}:${identifier}`;
      const count = (rateLimits.get(key) || 0) + 1;
      rateLimits.set(key, count);
      return count > limit;
    },
    async clearRateLimit(scope, identifier) { rateLimits.delete(`${scope}:${identifier}`); },
    async ping() { return "PONG"; },
  };
  const resendClient = { emails: { send: async (message) => { sent.push(message); return { data: { id: "email_demo" }, error: null }; } } };
  const app = createApp({
    dataDirectory: directory,
    databasePath: path.join(directory, "test.sqlite"),
    uploadDirectory: path.join(directory, "uploads"),
    webRoot: path.join(directory, "missing-build"),
    env: {
      NODE_ENV: "test",
      REQUIRE_EMAIL_VERIFICATION: "true",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "VoxBox <noreply@example.test>",
      PUBLIC_APP_URL: "https://videos.example.test",
    },
    resendClient,
    sessionStore,
  });
  t.after(async () => {
    app.locals.db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const agent = request.agent(app);
  const registration = await agent.post("/api/auth/register").send({
    email: "verified@example.test", password: "local-test-password", channelName: "Verified Creator",
  });
  assert.equal(registration.status, 201, registration.body.error);
  assert.equal(registration.body.verificationRequired, true);
  assert.equal((await agent.get("/api/auth/me")).body.user, null);
  const unverifiedLogin = await agent.post("/api/auth/login").send({ email: "verified@example.test", password: "local-test-password" });
  assert.equal(unverifiedLogin.status, 403);
  let token = new URL(sent.at(-1).text.match(/https:\/\/\S+/)[0]).searchParams.get("token");

  const verified = await agent.post("/api/auth/verify-email").send({ token });
  assert.equal(verified.status, 200, verified.body.error);
  assert.equal((await agent.post("/api/auth/verify-email").send({ token })).status, 400);
  const login = await agent.post("/api/auth/login").send({ email: "verified@example.test", password: "local-test-password" });
  assert.equal(login.status, 200, login.body.error);

  const forgot = await request(app).post("/api/auth/forgot-password").send({ email: "verified@example.test" });
  assert.equal(forgot.status, 202);
  token = new URL(sent.at(-1).text.match(/https:\/\/\S+/)[0]).searchParams.get("token");
  const reset = await request(app).post("/api/auth/reset-password").send({ token, password: "new-local-password" });
  assert.equal(reset.status, 200, reset.body.error);
  assert.equal(sessions.size, 0);
  assert.equal((await agent.get("/api/auth/me")).body.user, null);
  assert.equal((await request(app).post("/api/auth/login").send({ email: "verified@example.test", password: "local-test-password" })).status, 401);
  assert.equal((await request(app).post("/api/auth/login").send({ email: "verified@example.test", password: "new-local-password" })).status, 200);
  const unknown = await request(app).post("/api/auth/forgot-password").send({ email: "missing@example.test" });
  assert.equal(unknown.status, 202);
  assert.match(unknown.body.message, /If an account matches/);
});

test("Mux direct uploads, RTMP stream keys, playback signing, and webhooks are owner-scoped", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videohub-mux-test-"));
  let webhookEvent = null;
  let nextLiveId = 0;
  const muxClient = {
    video: {
      uploads: { create: async (params) => {
        assert.match(params.cors_origin, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.equal(params.new_asset_settings.playback_policies[0], "signed");
        return { data: { id: "upload_demo", url: "https://uploads.example.test/signed" } };
      } },
      assets: {
        retrieve: async () => ({ data: { playback_ids: [] } }),
        createPlaybackId: async (_, params) => ({ data: { id: `playback_${params.policy}`, policy: params.policy } }),
        deletePlaybackId: async () => {},
        delete: async () => {},
      },
      liveStreams: {
        create: async () => ({ data: {
          id: `live_${++nextLiveId}`, stream_key: `secret-stream-key-${nextLiveId}`,
          playback_ids: [{ id: `live_playback_${nextLiveId}`, policy: "public" }], status: "idle",
        } }),
        retrieve: async (id) => ({ data: { id, status: "idle" } }),
        delete: async () => {},
        createPlaybackId: async (_, params) => ({ data: { id: `live_playback_${params.policy}`, policy: params.policy } }),
        deletePlaybackId: async () => {},
      },
    },
    jwt: { signPlaybackId: async (id, options) => {
      assert.equal(id, "playback_signed");
      assert.equal(options.type, "video");
      return "signed-token";
    } },
    webhooks: { unwrap: async (body, headers, secret) => {
      assert.ok(Buffer.isBuffer(body));
      assert.equal(headers["mux-signature"], "mux-test-signature");
      assert.equal(secret, "mux_webhook_test");
      return webhookEvent;
    } },
  };
  const app = createApp({
    dataDirectory: directory,
    databasePath: path.join(directory, "test.sqlite"),
    uploadDirectory: path.join(directory, "uploads"),
    webRoot: path.join(directory, "missing-build"),
    env: {
      NODE_ENV: "test",
      MUX_TOKEN_ID: "mux_id",
      MUX_TOKEN_SECRET: "mux_secret",
      MUX_WEBHOOK_SECRET: "mux_webhook_test",
      MUX_SIGNING_KEY: "mux_signing_key",
      MUX_PRIVATE_KEY: "mux_private_key",
    },
    muxClient,
  });
  t.after(async () => {
    app.locals.db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const owner = request.agent(app);
  await register(owner);
  const upload = await owner.post("/api/studio/mux/uploads").send({
    title: "Mux private upload", description: "Provider direct upload.", category: "Learning", visibility: "private",
  });
  assert.equal(upload.status, 201, upload.body.error);
  assert.equal(upload.body.upload.id, "upload_demo");
  assert.equal(upload.body.video.processingStatus, "uploading");

  webhookEvent = {
    id: "evt_mux_asset_ready", type: "video.asset.ready",
    data: { id: "asset_demo", passthrough: upload.body.video.id, playback_ids: [] },
  };
  const webhook = await request(app).post("/api/media/mux/webhook")
    .set("Content-Type", "application/json").set("Mux-Signature", "mux-test-signature").send(Buffer.from("{}"));
  assert.equal(webhook.status, 200, webhook.body.error);
  const details = await owner.get(`/api/videos/${upload.body.video.id}`);
  assert.equal(details.status, 200);
  assert.match(details.body.video.playbackUrl, /token=signed-token$/);
  assert.equal((await request(app).get(`/api/videos/${upload.body.video.id}`)).status, 404);
  const published = await owner.patch(`/api/studio/videos/${upload.body.video.id}`).send({ visibility: "public" });
  assert.equal(published.status, 200, published.body.error);
  assert.equal(published.body.video.visibility, "public");
  const privatized = await owner.patch(`/api/studio/videos/${upload.body.video.id}`).send({ visibility: "private" });
  assert.equal(privatized.status, 200, privatized.body.error);
  assert.equal(privatized.body.video.visibility, "private");
  assert.equal((await request(app).get(`/api/videos/${upload.body.video.id}`)).status, 404);

  const live = await owner.post("/api/studio/live-streams").send({
    title: "Mux live event", category: "Technology", visibility: "public",
  });
  assert.equal(live.status, 201, live.body.error);
  assert.match(live.body.ingest.url, /^rtmp:\/\//);
  assert.match(live.body.ingest.streamKey, /^secret-stream-key/);
  const storedVideo = app.locals.db.prepare("SELECT * FROM videos WHERE id = ?").get(live.body.video.id);
  assert.equal(Object.prototype.hasOwnProperty.call(storedVideo, "stream_key"), false);
  const rotated = await owner.post(`/api/studio/live-streams/${live.body.video.id}/rotate-key`);
  assert.equal(rotated.status, 200, rotated.body.error);
  assert.notEqual(rotated.body.ingest.streamKey, live.body.ingest.streamKey);

  webhookEvent = {
    id: "evt_mux_live_active", type: "video.live_stream.active",
    data: { id: "live_2", passthrough: live.body.video.id, active_asset_id: "asset_live" },
  };
  const liveWebhook = await request(app).post("/api/media/mux/webhook")
    .set("Content-Type", "application/json").set("Mux-Signature", "mux-test-signature").send(Buffer.from("{}"));
  assert.equal(liveWebhook.status, 200, liveWebhook.body.error);
  assert.equal((await request(app).get("/api/videos?sort=live")).body.videos.length, 1);
});

test("Stripe mode rejects a key from the opposite environment", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videohub-stripe-mismatch-"));
  const mismatch = createApp({
    dataDirectory: directory,
    databasePath: path.join(directory, "mismatch.sqlite"),
    uploadDirectory: path.join(directory, "uploads"),
    webRoot: path.join(directory, "missing-build"),
    env: { NODE_ENV: "test", STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_test_wrong", STRIPE_PRICE_ID: "price_live" },
    stripeClient: { webhooks: {}, customers: {}, checkout: {}, billingPortal: {} },
  });
  t.after(async () => {
    mismatch.locals.db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.equal((await request(mismatch).get("/api/billing/status")).body.configured, false);
  assert.equal((await request(mismatch).get("/api/billing/status")).body.mode, "live");
});

test("production configuration accepts matching Stripe test credentials for staging", () => {
  const config = {
    DATABASE_URL: "postgresql://staging:secret@db.example.test/videohub",
    REDIS_URL: "rediss://default:secret@cache.example.test",
    PUBLIC_APP_URL: "https://videohub-staging.example.test",
    MUX_TOKEN_ID: "staging-token",
    MUX_TOKEN_SECRET: "staging-secret",
    MUX_WEBHOOK_SECRET: "staging-webhook-secret",
    MUX_SIGNING_KEY: "staging-signing-key",
    MUX_PRIVATE_KEY: "staging-private-key",
    RESEND_API_KEY: "staging-resend-key",
    EMAIL_FROM: "VoxBox Staging <staging@example.test>",
    STRIPE_MODE: "test",
    STRIPE_SECRET_KEY: "sk_test_staging",
    STRIPE_PRICE_ID: "price_staging",
    STRIPE_WEBHOOK_SECRET: "whsec_staging",
  };

  assert.deepEqual(getProductionConfigErrors(config), []);
  assert.ok(getProductionConfigErrors({ ...config, STRIPE_SECRET_KEY: "sk_live_wrong" })
    .includes("STRIPE_SECRET_KEY (must match STRIPE_MODE)"));
});

test("mutating API requests reject cross-origin requests", async (t) => {
  const app = await createTestApp(t);
  const response = await request(app)
    .post("/api/auth/register")
    .set("Origin", "https://attacker.example")
    .send({ email: "creator@example.test", password: "local-test-password", channelName: "Creator" });
  assert.equal(response.status, 403);
});
