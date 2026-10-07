import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";

test("password recovery is private, expires, consumes once, invalidates concurrent sessions and scoped credentials", async () => {
  let time = Date.now();
  const mail: { email: string; link: string }[] = [];
  const runtime = await createApp(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017", "learnverse_reset_test_" + time, {
    now: () => time, sendResetEmail: async (email, link) => { mail.push({ email, link }); },
  });
  const server = runtime.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const req = async (path: string, body?: unknown, cookie = "", token = "") => {
    const response = await fetch(origin + "/api/v1/" + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const email = "reset@example.test", password = "before reset secure phrase", replacement = "after reset another phrase";
  try {
    const registered = await req("auth/register", { email, password }); assert.equal(registered.status, 200);
    const credential = await req("integrations/credentials", { name: "Reset test", permissions: ["tasks:read"], expiresInDays: 1 }, registered.cookie);
    assert.equal(credential.status, 201);
    const unknown = await req("auth/forgot-password", { email: "unknown@example.test" });
    const known = await req("auth/forgot-password", { email: email.toUpperCase() });
    assert.deepEqual(known.data, unknown.data); assert.equal(mail.length, 1);
    const token = new URL(mail[0].link).hash.slice(7);
    assert.equal(new URL(mail[0].link).pathname, "/reset-password");
    const user = await runtime.db.collection("users").findOne({ email });
    assert.ok(user!.resetTokenHash); assert.ok(!JSON.stringify(user).includes(token));
    await req("auth/forgot-password", { email }); assert.equal(mail.length, 1);
    assert.equal((await req("auth/reset-password", { token: "a".repeat(64), password: replacement })).status, 422);
    assert.equal((await req("auth/reset-password", { token, password: "short" })).status, 422);
    const simultaneous = await Promise.all([req("auth/reset-password", { token, password: replacement }), req("auth/reset-password", { token, password: replacement })]);
    assert.deepEqual(simultaneous.map(x => x.status).sort(), [200, 422]);
    assert.equal((await req("workspace", undefined, registered.cookie)).status, 401);
    assert.equal((await req("integrations/tasks", undefined, "", credential.data.token)).status, 401);
    assert.equal((await req("auth/login", { email, password })).status, 401);
    const login = await req("auth/login", { email, password: replacement }); assert.equal(login.status, 200);
    assert.equal((await req("auth/me", undefined, login.cookie)).data.email, email);
    const newCredential = await req("integrations/credentials", { name: "New", permissions: ["tasks:read"], expiresInDays: 1 }, login.cookie);
    assert.equal((await req("integrations/tasks", undefined, "", newCredential.data.token)).status, 200);
    time += 61_000; await req("auth/forgot-password", { email }); const expired = new URL(mail.at(-1)!.link).hash.slice(7);
    time += 16 * 60_000;
    assert.equal((await req("auth/reset-password", { token: expired, password })).status, 422);
    assert.equal((await req("auth/change-password", { currentPassword: password, password }, login.cookie)).status, 401);
    assert.equal((await req("auth/change-password", { currentPassword: replacement, password }, login.cookie)).status, 200);
    assert.equal((await req("workspace", undefined, login.cookie)).status, 401);
    assert.equal((await req("integrations/tasks", undefined, "", newCredential.data.token)).status, 401);
    assert.equal((await req("auth/reset-password", { token: expired, password: replacement })).status, 422);
    assert.equal((await req("auth/login", { email, password })).status, 200);
  } finally { await runtime.db.dropDatabase(); await new Promise<void>(r => server.close(() => r())); await runtime.client.close(); }
});

test("delivery failure never exposes account existence, credentials or a usable reset token", async () => {
  const runtime = await createApp(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017", "learnverse_reset_failure_" + Date.now(), { sendResetEmail: async () => { throw new Error("private provider detail"); } });
  const server = runtime.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1/auth/`;
  const req = async (path: string, body: any) => { const response = await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return response.json(); };
  try {
    await req("register", { email: "failure@example.test", password: "safe long reset test phrase" });
    assert.deepEqual(await req("forgot-password", { email: "failure@example.test" }), await req("forgot-password", { email: "unknown@example.test" }));
    const user = await runtime.db.collection("users").findOne({ email: "failure@example.test" });
    assert.equal(user!.resetTokenHash, undefined);
  } finally { await runtime.db.dropDatabase(); await new Promise<void>(r => server.close(() => r())); await runtime.client.close(); }
});
