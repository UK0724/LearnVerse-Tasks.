import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
test("Mongo-backed authorization, retry safety, CAS conflict, restart persistence, and safe validation", async () => {
  const name = "learnverse_test_" + Date.now();
  let runtime = await createApp(
    process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
    name,
  );
  let server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = () =>
    `http://127.0.0.1:${(server.address() as any).port}/api/v1/`;
  async function request(
    path: string,
    body?: any,
    cookie = "",
    headers: Record<string, string> = {},
  ) {
    const r = await fetch(url() + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  }
  try {
    const a = await request("auth/register", {
        email: "a@example.test",
        password: "correct horse battery staple",
      }),
      b = await request("auth/register", {
        email: "b@example.test",
        password: "another secure passphrase",
      });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await request("workspace")).status, 401);
    assert.equal(
      (await request("tasks?q[]=invalid", undefined, a.cookie)).status,
      422,
    );
    const key = crypto.randomUUID(),
      headers = { "If-Match": '"0"', "Idempotency-Key": key },
      payload = { name: "Persistent", prefix: "LV" },
      created = await request(
        "commands/project.create",
        payload,
        a.cookie,
        headers,
      );
    assert.equal(created.status, 200);
    assert.equal(
      (await request("commands/project.create", payload, a.cookie, headers))
        .data.result.id,
      created.data.result.id,
    );
    assert.equal(
      (
        await request(
          "commands/project.create",
          { ...payload, name: "Different" },
          a.cookie,
          headers,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          "commands/project.create",
          { name: "Conflict", prefix: "CF" },
          a.cookie,
          { "If-Match": '"0"', "Idempotency-Key": crypto.randomUUID() },
        )
      ).status,
      409,
    );
    const denied = await request(
      "commands/task.create",
      { projectId: created.data.result.id, title: "Cross owner", type: "task" },
      b.cookie,
      { "If-Match": '"0"', "Idempotency-Key": crypto.randomUUID() },
    );
    assert.equal(denied.status, 404);
    assert.equal(
      (await request("tasks?q=Persistent", undefined, b.cookie)).data.total,
      0,
    );
    assert.equal(
      (
        await request(
          "commands/task.create",
          {
            projectId: created.data.result.id,
            title: "Saved task",
            type: "task",
          },
          a.cookie,
          { "If-Match": '"1"', "Idempotency-Key": crypto.randomUUID() },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "commands/task.update",
          { id: "bad", title: "" },
          a.cookie,
          { "If-Match": '"2"', "Idempotency-Key": crypto.randomUUID() },
        )
      ).status,
      422,
    );
    const origin = await request("commands/project.create", payload, a.cookie, {
      Origin: "https://evil.test",
      ...headers,
    });
    assert.equal(origin.status, 403);
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.client.close();
    runtime = await createApp(
      process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
      name,
    );
    server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const persisted = await request("workspace", undefined, a.cookie);
    assert.equal(persisted.data.tasks[0].title, "Saved task");
    assert.equal(persisted.data.projects.length, 1);
    assert.equal(
      (await request("workspace", undefined, b.cookie)).data.projects.length,
      0,
    );
    await request("auth/logout", {}, a.cookie);
    assert.equal((await request("workspace", undefined, a.cookie)).status, 401);
  } finally {
    await runtime.db.dropDatabase();
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.client.close();
  }
});
