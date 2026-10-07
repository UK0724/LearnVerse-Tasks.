import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoRateLimitStore } from "../server/rate-limit-store.js";

test("auth throttling shares atomic counters across server instances without storing raw IP addresses", async () => {
  const client = await MongoClient.connect(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017");
  const db = client.db("learnverse_rate_test_" + randomUUID().replaceAll("-", ""));
  try {
    const a = new MongoRateLimitStore(db, "auth", 900_000);
    const b = new MongoRateLimitStore(db, "auth", 900_000);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).increment("192.0.2.7")));
    assert.equal(Math.max(...results.map((x) => x.totalHits)), 20);
    const row = await db.collection<any>("rate_limits").findOne({});
    assert.equal(row!.hits, 20);
    assert.ok(!row!._id.includes("192.0.2.7"));
    await a.decrement("192.0.2.7");
    assert.equal((await b.increment("192.0.2.7")).totalHits, 20);
    await a.resetKey("192.0.2.7");
    assert.equal((await b.increment("192.0.2.7")).totalHits, 1);
    assert.equal((await new MongoRateLimitStore(db, "integration", 60_000).increment("192.0.2.7")).totalHits, 1);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
