import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server/app.js";

test("scoped credentials enforce owner isolation, retries, MCP access, and revocation", async () => {
  const name = "learnverse_integration_test_" + Date.now();
  const previous = process.env.MCP_ENABLED;
  process.env.MCP_ENABLED = "true";
  const runtime = await createApp(
    process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
    name,
  );
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  async function request(
    path: string,
    {
      method = "GET",
      body,
      cookie,
      token,
      headers = {},
    }: {
      method?: string;
      body?: unknown;
      cookie?: string;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const payload = raw.startsWith("event:")
      ? (raw
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6) ?? "{}")
      : raw;
    return {
      status: response.status,
      data: JSON.parse(payload),
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  }
  const origin = { Origin: new URL(base).origin };
  const meta = (revision: number) => ({
    "If-Match": `"${revision}"`,
    "Idempotency-Key": crypto.randomUUID(),
  });
  try {
    const a = await request("/auth/register", {
      method: "POST",
      body: {
        email: "integration-a@example.test",
        password: "correct horse battery staple",
      },
    });
    const b = await request("/auth/register", {
      method: "POST",
      body: {
        email: "integration-b@example.test",
        password: "another correct horse battery",
      },
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const project = await request("/commands/project.create", {
      method: "POST",
      cookie: a.cookie,
      headers: meta(0),
      body: { name: "Owner A", prefix: "OWN" },
    });
    assert.equal(project.status, 200);
    const otherProject = await request("/commands/project.create", {
      method: "POST",
      cookie: b.cookie,
      headers: meta(0),
      body: { name: "Owner B", prefix: "OTH" },
    });
    assert.equal(otherProject.status, 200);
    assert.equal(
      (
        await request("/integrations/credentials", {
          method: "POST",
          cookie: a.cookie,
          body: {
            name: "unsafe",
            permissions: ["tasks:read"],
            expiresInDays: 1,
          },
        })
      ).status,
      403,
    );
    const created = await request("/integrations/credentials", {
      method: "POST",
      cookie: a.cookie,
      headers: origin,
      body: {
        name: "Task agent",
        permissions: ["projects:read", "tasks:read", "tasks:write"],
        expiresInDays: 1,
      },
    });
    assert.equal(created.status, 201);
    const token = created.data.token as string;
    const id = created.data.credential.id as string;
    assert.match(token, /^lvt_[a-f0-9]{32}_[a-f0-9]{64}$/);
    assert.equal(
      (await request("/integrations/credentials", { cookie: a.cookie })).data
        .credentials[0].token,
      undefined,
    );
    const dbCredential = await runtime.db
      .collection<any>("integration_credentials")
      .findOne({ _id: id });
    assert.ok(dbCredential?.tokenHash);
    assert.equal(JSON.stringify(dbCredential).includes(token), false);
    const list = await request("/integrations/projects", { token });
    assert.equal(list.status, 200);
    assert.equal(list.data[0].id, project.data.result.id);
    assert.equal(
      (await request("/integrations/sprints", { token })).status,
      403,
    );
    assert.equal(
      (
        await request("/integrations/commands/sprint.create", {
          method: "POST",
          token,
          headers: meta(1),
          body: {
            projectId: project.data.result.id,
            name: "Denied",
            startDate: "2026-10-01",
            endDate: "2026-10-05",
          },
        })
      ).status,
      403,
    );
    const taskInput = {
      projectId: project.data.result.id,
      title: "Integration task",
      type: "task",
    };
    const retryHeaders = meta(1);
    const task = await request("/integrations/commands/task.create", {
      method: "POST",
      token,
      headers: retryHeaders,
      body: taskInput,
    });
    assert.equal(task.status, 200);
    const retried = await request("/integrations/commands/task.create", {
      method: "POST",
      token,
      headers: retryHeaders,
      body: taskInput,
    });
    assert.equal(retried.data.result.id, task.data.result.id);
    assert.equal(
      (
        await request("/integrations/commands/task.create", {
          method: "POST",
          token,
          headers: { ...retryHeaders, "Idempotency-Key": crypto.randomUUID() },
          body: taskInput,
        })
      ).status,
      409,
    );
    const crossOwner = await request("/integrations/commands/task.create", {
      method: "POST",
      token,
      headers: meta(2),
      body: {
        projectId: otherProject.data.result.id,
        title: "Cross workspace",
        type: "task",
      },
    });
    assert.equal(crossOwner.status, 404);
    const search = await request("/integrations/tasks?q=Integration", {
      token,
    });
    assert.equal(search.status, 200);
    assert.equal(search.data.total, 1);
    const mcpCall = await request("/mcp", {
      method: "POST",
      token,
      headers: { Accept: "application/json, text/event-stream" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_tasks",
          arguments: { filters: { q: "Integration" } },
        },
      },
    });
    assert.equal(mcpCall.status, 200);
    assert.equal(
      mcpCall.data.result.content[0].text.includes("Integration task"),
      true,
    );
    const mcpDenied = await request("/mcp", {
      method: "POST",
      token,
      headers: { Accept: "application/json, text/event-stream" },
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_sprints", arguments: {} },
      },
    });
    assert.equal(mcpDenied.data.result.isError, true);
    const full = await request("/integrations/credentials", {
      method: "POST",
      cookie: a.cookie,
      headers: origin,
      body: {
        name: "Sprint agent",
        permissions: [
          "projects:read",
          "tasks:read",
          "tasks:write",
          "sprints:read",
          "sprints:write",
        ],
        expiresInDays: 1,
      },
    });
    assert.equal(full.status, 201);
    const fullToken = full.data.token as string;
    const sdkClient = new Client({ name: "learnverse-test", version: "1.0.0" });
    const sdkTransport = new StreamableHTTPClientTransport(
      new URL(base + "/mcp"),
      {
        requestInit: { headers: { Authorization: `Bearer ${fullToken}` } },
      },
    );
    await sdkClient.connect(sdkTransport);
    assert.ok(
      (await sdkClient.listTools()).tools.some(
        (tool) => tool.name === "create_task",
      ),
    );
    const sdkList = await sdkClient.callTool({
      name: "list_tasks",
      arguments: {},
    });
    assert.equal(sdkList.isError, undefined);
    await sdkClient.close();
    let rpcId = 3;
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const response = await request("/mcp", {
        method: "POST",
        token: fullToken,
        headers: { Accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: rpcId++,
          method: "tools/call",
          params: { name, arguments: args },
        },
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.data.result.isError,
        undefined,
        JSON.stringify(response.data),
      );
      return JSON.parse(response.data.result.content[0].text);
    };
    const initialized = await request("/mcp", {
      method: "POST",
      token: fullToken,
      headers: { Accept: "application/json, text/event-stream" },
      body: {
        jsonrpc: "2.0",
        id: rpcId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0" },
        },
      },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.data.result.serverInfo.name, "learnverse-tasks");
    const listed = await request("/mcp", {
      method: "POST",
      token: fullToken,
      headers: { Accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} },
    });
    assert.equal(
      listed.data.result.tools.some((x: any) => x.name === "create_task"),
      true,
    );
    assert.equal((await mcp("list_projects", {})).revision, 2);
    const createArgs = {
      input: {
        projectId: project.data.result.id,
        title: "MCP task",
        type: "task",
      },
      revision: 2,
      idempotencyKey: crypto.randomUUID(),
    };
    const mcpTask = await mcp("create_task", createArgs);
    assert.equal(mcpTask.revision, 3);
    assert.equal(
      (await mcp("create_task", createArgs)).result.id,
      mcpTask.result.id,
    );
    const statusId = project.data.result.statuses[1].id;
    assert.equal(
      (
        await mcp("move_task", {
          input: {
            id: mcpTask.result.id,
            statusId,
            beforeId: null,
            afterId: null,
          },
          revision: 3,
          idempotencyKey: crypto.randomUUID(),
        })
      ).revision,
      4,
    );
    assert.equal(
      (
        await mcp("update_task", {
          input: { id: mcpTask.result.id, title: "MCP updated" },
          revision: 4,
          idempotencyKey: crypto.randomUUID(),
        })
      ).revision,
      5,
    );
    const sprint = await mcp("create_sprint", {
      input: {
        projectId: project.data.result.id,
        name: "October",
        startDate: "2026-10-01",
        endDate: "2026-10-14",
      },
      revision: 5,
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(sprint.revision, 6);
    assert.equal(
      (
        await mcp("update_task", {
          input: { id: mcpTask.result.id, sprintId: sprint.result.id },
          revision: 6,
          idempotencyKey: crypto.randomUUID(),
        })
      ).revision,
      7,
    );
    assert.equal(
      (
        await mcp("start_sprint", {
          input: { id: sprint.result.id },
          revision: 7,
          idempotencyKey: crypto.randomUUID(),
        })
      ).revision,
      8,
    );
    const completed = await mcp("complete_sprint", {
      input: { id: sprint.result.id, targetSprintId: null },
      revision: 8,
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(completed.revision, 9);
    assert.equal(completed.result.snapshot.unfinished.length, 1);
    assert.equal(
      (await mcp("read_task", { id: mcpTask.result.id })).task.sprintId,
      null,
    );
    await runtime.db
      .collection<any>("integration_credentials")
      .updateOne(
        { _id: full.data.credential.id },
        { $set: { expiresAt: new Date(0) } },
      );
    assert.equal(
      (await request("/integrations/tasks", { token: fullToken })).status,
      401,
    );
    const secretUpdate = await request("/commands/task.update", {
      method: "POST",
      cookie: a.cookie,
      headers: meta(9),
      body: { id: mcpTask.result.id, description: "Owner private description" },
    });
    assert.equal(secretUpdate.status, 200);
    const writeOnly = await request("/integrations/credentials", {
      method: "POST",
      cookie: a.cookie,
      headers: origin,
      body: {
        name: "Write-only agent",
        permissions: ["tasks:write", "sprints:write"],
        expiresInDays: 1,
      },
    });
    assert.equal(writeOnly.status, 201);
    const writeToken = writeOnly.data.token as string;
    const writeEdit = await request("/integrations/commands/task.update", {
      method: "POST",
      token: writeToken,
      headers: meta(10),
      body: { id: mcpTask.result.id, title: "Write-only edit" },
    });
    assert.equal(writeEdit.status, 200);
    assert.deepEqual(Object.keys(writeEdit.data.result).sort(), ["id", "key"]);
    assert.equal(
      JSON.stringify(writeEdit.data).includes("Owner private description"),
      false,
    );
    const privateSprint = await request(
      "/integrations/commands/sprint.create",
      {
        method: "POST",
        token: writeToken,
        headers: meta(11),
        body: {
          projectId: project.data.result.id,
          name: "Private sprint",
          startDate: "2026-10-15",
          endDate: "2026-10-28",
        },
      },
    );
    assert.equal(privateSprint.status, 200);
    assert.deepEqual(Object.keys(privateSprint.data.result).sort(), [
      "id",
      "state",
    ]);
    const privateSprintId = privateSprint.data.result.id;
    assert.equal(
      (
        await request("/integrations/commands/task.update", {
          method: "POST",
          token: writeToken,
          headers: meta(12),
          body: { id: mcpTask.result.id, sprintId: privateSprintId },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/integrations/commands/sprint.start", {
          method: "POST",
          token: writeToken,
          headers: meta(13),
          body: { id: privateSprintId },
        })
      ).status,
      200,
    );
    const privateComplete = await request(
      "/integrations/commands/sprint.complete",
      {
        method: "POST",
        token: writeToken,
        headers: meta(14),
        body: { id: privateSprintId, targetSprintId: null },
      },
    );
    assert.equal(privateComplete.status, 200);
    assert.deepEqual(Object.keys(privateComplete.data.result).sort(), [
      "id",
      "state",
    ]);
    assert.equal(
      JSON.stringify(privateComplete.data).includes(
        "Owner private description",
      ),
      false,
    );
    const revoked = await request("/integrations/credentials/" + id, {
      method: "DELETE",
      cookie: a.cookie,
      headers: origin,
    });
    assert.equal(revoked.status, 200);
    assert.equal((await request("/integrations/tasks", { token })).status, 401);
    assert.equal(
      (
        await request("/mcp", {
          method: "POST",
          token,
          headers: { Accept: "application/json, text/event-stream" },
          body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        })
      ).status,
      401,
    );
    assert.equal(
      (await request("/integrations/tasks", { token, cookie: a.cookie }))
        .status,
      401,
    );
    const audit = await request("/integrations/audit", { cookie: a.cookie });
    assert.equal(audit.status, 200);
    assert.ok(
      audit.data.items.some((x: any) => x.action === "credential.revoke"),
    );
    assert.ok(audit.data.items.some((x: any) => x.action === "task.create"));
    assert.equal(JSON.stringify(audit.data).includes(token), false);
    assert.equal(
      (await request("/integrations/audit", { cookie: b.cookie })).data.total,
      0,
    );
  } finally {
    await runtime.db.dropDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.client.close();
    if (previous === undefined) delete process.env.MCP_ENABLED;
    else process.env.MCP_ENABLED = previous;
  }
});
