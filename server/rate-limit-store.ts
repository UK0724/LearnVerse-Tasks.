import type { Store } from "express-rate-limit";
import type { Db } from "mongodb";
import { createHash } from "node:crypto";

// Fixed windows share their counters across Lambda instances and expire automatically.
export class MongoRateLimitStore implements Store {
  localKeys = false;
  prefix: string;
  constructor(private db: Db, prefix: string, private windowMs: number) {
    this.prefix = prefix;
  }
  private id(key: string) {
    const window = Math.floor(Date.now() / this.windowMs);
    return `${this.prefix}:${createHash("sha256").update(key).digest("hex")}:${window}`;
  }
  async increment(key: string) {
    const resetTime = new Date((Math.floor(Date.now() / this.windowMs) + 1) * this.windowMs);
    const row = await this.db.collection<any>("rate_limits").findOneAndUpdate(
      { _id: this.id(key) },
      { $inc: { hits: 1 }, $setOnInsert: { expires: resetTime } },
      { upsert: true, returnDocument: "after" },
    );
    return { totalHits: row!.hits, resetTime: row!.expires as Date };
  }
  async decrement(key: string) {
    await this.db.collection<any>("rate_limits").updateOne({ _id: this.id(key), hits: { $gt: 0 } }, { $inc: { hits: -1 } });
  }
  async resetKey(key: string) {
    await this.db.collection<any>("rate_limits").deleteOne({ _id: this.id(key) });
  }
}
