const crypto = require("node:crypto");

class RedisSessionStore {
  constructor(client, { prefix = "videohub:session:" } = {}) {
    this.client = client;
    this.prefix = prefix;
  }

  sessionKey(tokenHash) {
    return `${this.prefix}token:${tokenHash}`;
  }

  userKey(userId) {
    return `${this.prefix}user:${userId}`;
  }

  async load(tokenHash) {
    const value = await this.client.get(this.sessionKey(tokenHash));
    return value ? JSON.parse(value) : null;
  }

  async create(tokenHash, userId, expiresAt) {
    const ttl = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    const indexKey = this.userKey(userId);
    await this.client.multi()
      .set(this.sessionKey(tokenHash), JSON.stringify({ userId, expiresAt }), { EX: ttl })
      .zRemRangeByScore(indexKey, "-inf", Date.now())
      .zAdd(indexKey, [{ score: expiresAt, value: tokenHash }])
      .expire(indexKey, ttl + 86400)
      .exec();
  }

  async revoke(tokenHash, userId) {
    const multi = this.client.multi().del(this.sessionKey(tokenHash));
    if (userId) multi.zRem(this.userKey(userId), tokenHash);
    await multi.exec();
  }

  async revokeUser(userId) {
    const indexKey = this.userKey(userId);
    const tokenHashes = await this.client.zRange(indexKey, 0, -1);
    const multi = this.client.multi();
    for (const tokenHash of tokenHashes) multi.del(this.sessionKey(tokenHash));
    multi.del(indexKey);
    await multi.exec();
  }

  async rateLimit(scope, identifier, limit, windowMs) {
    const identity = crypto.createHash("sha256").update(String(identifier)).digest("hex");
    const key = `${this.prefix}rate:${scope}:${identity}`;
    const results = await this.client.multi().incr(key).pExpire(key, windowMs).exec();
    return Number(results[0]) > limit;
  }

  async clearRateLimit(scope, identifier) {
    const identity = crypto.createHash("sha256").update(String(identifier)).digest("hex");
    await this.client.del(`${this.prefix}rate:${scope}:${identity}`);
  }

  async ping() {
    return this.client.ping();
  }

  async close() {
    if (this.client.isOpen) await this.client.quit();
  }
}

async function connectRedisSessionStore(redisUrl) {
  const { createClient } = require("redis");
  const client = createClient({ url: redisUrl });
  client.on("error", (error) => console.error("Redis session store error.", error.message));
  await client.connect();
  await client.ping();
  return new RedisSessionStore(client);
}

module.exports = { RedisSessionStore, connectRedisSessionStore };
