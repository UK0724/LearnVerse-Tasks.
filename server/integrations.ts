import type { Express, Request, Response, NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Db, Collection } from "mongodb";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { command, Problem, query } from "./domain.js";
import { expectedOrigin } from "./origin.js";
import { MongoRateLimitStore } from "./rate-limit-store.js";

const permissions = [
  "projects:read",
  "tasks:read",
  "tasks:write",
  "sprints:read",
  "sprints:write",
] as const;
type Permission = (typeof permissions)[number];
type Credential = {
  authVersion?: number;
  _id: string;
  owner: string;
  name: string;
  tokenHash: string;
  permissions: Permission[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};
type Actor = { owner: string; id: string; permissions: Permission[] };
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const safeCredential = ({
  _id,
  name,
  permissions,
  createdAt,
  expiresAt,
  revokedAt,
  lastUsedAt,
}: Credential) => ({
  id: _id,
  name,
  permissions,
  createdAt,
  expiresAt,
  revokedAt,
  lastUsedAt,
});
const actionPermission: Record<string, Permission> = {
  "task.create": "tasks:write",
  "task.update": "tasks:write",
  "task.move": "tasks:write",
  "sprint.create": "sprints:write",
  "sprint.start": "sprints:write",
  "sprint.complete": "sprints:write",
};
export const queryFiltersSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    statusId: z.string().uuid().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    sprintId: z.string().uuid().optional(),
    label: z.string().max(200).optional(),
    q: z.string().max(200).optional(),
    dueBefore: z.iso.date().optional(),
    dueAfter: z.iso.date().optional(),
    archived: z.enum(["true", "false"]).optional(),
    page: z.coerce.number().int().min(1).max(100000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const mutationMeta = z.object({
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(100),
});
const uuid = z.string().uuid();
const taskFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).optional(),
  type: z.enum(["epic", "task", "bug", "subtask"]),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  labels: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  dueDate: z.iso.date().nullable().optional(),
  estimate: z.number().min(0).max(10000).nullable().optional(),
  parentId: uuid.nullable().optional(),
  sprintId: uuid.nullable().optional(),
  statusId: uuid.optional(),
});
const toolInputs = {
  "task.create": taskFields.extend({ projectId: uuid }),
  "task.update": taskFields
    .partial()
    .extend({ id: uuid, archived: z.boolean().optional() }),
  "task.move": z
    .object({
      id: uuid,
      statusId: uuid,
      beforeId: uuid.nullable().optional(),
      afterId: uuid.nullable().optional(),
    })
    .describe(
      "beforeId and afterId are task ordering anchors in the target status",
    ),
  "sprint.create": z.object({
    projectId: uuid,
    name: z.string().trim().min(1).max(200),
    goal: z.string().max(2000).optional(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  }),
  "sprint.start": z.object({ id: uuid }),
  "sprint.complete": z
    .object({ id: uuid, targetSprintId: uuid.nullable() })
    .describe("Use null to return unfinished tasks to backlog"),
};
function redactMutationResult(
  actor: Actor,
  action: string,
  response: { result: any; revision: number },
) {
  const result = response.result;
  if (action.startsWith("task.") && !actor.permissions.includes("tasks:read"))
    return {
      revision: response.revision,
      result: { id: result.id, key: result.key },
    };
  if (action.startsWith("sprint.")) {
    if (!actor.permissions.includes("sprints:read"))
      return {
        revision: response.revision,
        result: { id: result.id, state: result.state },
      };
    if (result.snapshot && !actor.permissions.includes("tasks:read"))
      return {
        revision: response.revision,
        result: {
          ...result,
          snapshot: {
            completedAt: result.snapshot.completedAt,
            finishedCount: result.snapshot.finished.length,
            unfinishedCount: result.snapshot.unfinished.length,
          },
        },
      };
  }
  return response;
}

// Both the browser command route and integration writes use the same atomic repository operation.
export async function executeWorkspaceCommand(
  workspaces: Collection<any>,
  owner: string,
  action: string,
  input: unknown,
  expectedRevision: number,
  idempotencyKey: string,
  namespace = "",
) {
  const s = await workspaces.findOne({ owner });
  if (!s) throw new Problem(404, "NOT_FOUND", "Workspace not found");
  const key = namespace ? `${namespace}:${idempotencyKey}` : idempotencyKey;
  const signature = sha256(JSON.stringify({ action, body: input }));
  const receipt = s.receipts.find((r: any) => r.key === key);
  if (receipt) {
    if (receipt.signature !== signature)
      throw new Problem(
        409,
        "KEY_REUSED",
        "Idempotency key was used for a different request",
      );
    return receipt.response;
  }
  if (expectedRevision !== s.revision)
    throw new Problem(
      409,
      "VERSION_CONFLICT",
      "Workspace changed; reload and try again",
    );
  const { state, result } = command(s, action, input);
  for (const entry of state.activity.slice(s.activity.length))
    Object.assign(entry, {
      actor: namespace || "owner",
      credentialId: namespace || null,
      idempotencyKey,
    });
  state.revision = s.revision + 1;
  const response = { result, revision: state.revision };
  state.receipts.push({ key, signature, response });
  const updated = await workspaces.updateOne(
    { owner, revision: s.revision },
    { $set: state },
  );
  if (!updated.modifiedCount)
    throw new Problem(
      409,
      "VERSION_CONFLICT",
      "Workspace changed; reload and try again",
    );
  return response;
}

export async function installIntegrations(
  app: Express,
  db: Db,
  workspaces: Collection<any>,
) {
  const credentials = db.collection<Credential>("integration_credentials");
  const audit = db.collection<any>("integration_audit");
  await credentials.createIndex({ owner: 1, createdAt: -1 });
  await audit.createIndex({ owner: 1, at: -1 });
  const mcpEnabled = process.env.MCP_ENABLED === "true";
  const requestLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    store: new MongoRateLimitStore(db, "integration", 60_000),
  });
  const setupLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    store: new MongoRateLimitStore(db, "setup", 15 * 60_000),
  });
  const auditEvent = async (
    owner: string,
    actor: string,
    action: string,
    outcome: "success" | "denied" | "error",
    code?: string,
    requestId?: string,
  ) =>
    audit.insertOne({
      owner,
      actor,
      credentialId: actor === "owner" ? null : actor,
      action,
      outcome,
      code: code ?? null,
      requestId: requestId ?? randomUUID(),
      at: new Date(),
    });
  const ownerSession = (res: Response) => {
    const owner = res.locals.owner as string | undefined;
    if (!owner) throw new Problem(401, "AUTH_REQUIRED", "Please sign in");
    return owner;
  };
  const sameOrigin = (req: Request) => {
    const origin = req.get("Origin");
    if (!origin || origin !== expectedOrigin(req))
      throw new Problem(403, "ORIGIN_REJECTED", "Same-origin request required");
  };
  const authenticate = async (req: Request): Promise<Actor> => {
    const header = req.get("Authorization") ?? "";
    const match = /^Bearer (lvt_([a-f0-9]{32})_([a-f0-9]{64}))$/.exec(header);
    if (!match)
      throw new Problem(
        401,
        "INTEGRATION_AUTH_REQUIRED",
        "Valid integration bearer token required",
      );
    const credential = await credentials.findOne({ _id: match[2] });
    if (
      !credential ||
      !timingSafeEqual(
        Buffer.from(credential.tokenHash, "hex"),
        Buffer.from(sha256(match[1]), "hex"),
      )
    )
      throw new Problem(
        401,
        "INTEGRATION_AUTH_REQUIRED",
        "Valid integration bearer token required",
      );
    const ownerUser = await db.collection("users").findOne({ owner: credential.owner }, { projection: { authVersion: 1 } });
    if (!ownerUser || (credential.authVersion ?? 0) !== (ownerUser.authVersion ?? 0) || credential.revokedAt || credential.expiresAt <= new Date()) {
      await auditEvent(
        credential.owner,
        credential._id,
        "credential.authenticate",
        "denied",
        credential.revokedAt ? "CREDENTIAL_REVOKED" : "CREDENTIAL_EXPIRED",
      ).catch(() => {});
      throw new Problem(
        401,
        "INTEGRATION_AUTH_REQUIRED",
        "Valid integration bearer token required",
      );
    }
    // Authentication rechecks revocation on every call. This is informational, not an auth cache.
    const current = await credentials.updateOne(
      { _id: credential._id, revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { lastUsedAt: new Date() } },
    );
    if (!current.matchedCount)
      throw new Problem(
        401,
        "INTEGRATION_AUTH_REQUIRED",
        "Valid integration bearer token required",
      );
    return {
      owner: credential.owner,
      id: credential._id,
      permissions: credential.permissions,
    };
  };
  const requirePermission = (actor: Actor, permission: Permission) => {
    if (!actor.permissions.includes(permission))
      throw new Problem(
        403,
        "INSUFFICIENT_SCOPE",
        "Credential lacks required permission",
      );
  };
  const workspace = async (owner: string) => {
    const state = await workspaces.findOne({ owner });
    if (!state) throw new Problem(404, "NOT_FOUND", "Workspace not found");
    return state;
  };
  const withBearer =
    (
      action: string,
      permission: Permission,
      fn: (req: Request, res: Response, actor: Actor) => Promise<unknown>,
    ) =>
    async (req: Request, res: Response, next: NextFunction) => {
      let actor: Actor | undefined;
      const requestId = randomUUID();
      try {
        actor = await authenticate(req);
        requirePermission(actor, permission);
        const result = await fn(req, res, actor);
        await auditEvent(
          actor.owner,
          actor.id,
          action,
          "success",
          undefined,
          requestId,
        );
        res.json(result);
      } catch (error) {
        if (actor)
          await auditEvent(
            actor.owner,
            actor.id,
            action,
            error instanceof Problem && error.status === 403
              ? "denied"
              : "error",
            error instanceof Problem ? error.code : "INTERNAL_ERROR",
            requestId,
          ).catch(() => {});
        next(error);
      }
    };

  app.get("/api/v1/integrations/credentials", async (_req, res, next) => {
    try {
      const owner = ownerSession(res);
      const records = await credentials
        .find({ owner })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();
      res.json({ credentials: records.map(safeCredential), mcpEnabled });
    } catch (e) {
      next(e);
    }
  });
  app.post(
    "/api/v1/integrations/credentials",
    setupLimit,
    async (req, res, next) => {
      try {
        const owner = ownerSession(res);
        sameOrigin(req);
        const d = z
          .object({
            name: z.string().trim().min(1).max(100),
            permissions: z
              .array(z.enum(permissions))
              .min(1)
              .max(permissions.length)
              .refine((x) => new Set(x).size === x.length),
            expiresInDays: z.number().int().min(1).max(90),
          })
          .strict()
          .parse(req.body);
        await workspace(owner);
        const id = randomBytes(16).toString("hex"),
          token = `lvt_${id}_${randomBytes(32).toString("hex")}`;
        const record: Credential = {
          _id: id,
          owner,
          authVersion: res.locals.authVersion ?? 0,
          name: d.name,
          permissions: d.permissions,
          tokenHash: sha256(token),
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + d.expiresInDays * 86400000),
          revokedAt: null,
          lastUsedAt: null,
        };
        await credentials.insertOne(record);
        await auditEvent(owner, "owner", "credential.create", "success");
        res.status(201).json({ credential: safeCredential(record), token });
      } catch (e) {
        next(e);
      }
    },
  );
  app.delete(
    "/api/v1/integrations/credentials/:id",
    setupLimit,
    async (req, res, next) => {
      try {
        const owner = ownerSession(res);
        sameOrigin(req);
        const id = z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .parse(req.params.id);
        const record = await credentials.findOneAndUpdate(
          { _id: id, owner, revokedAt: null },
          { $set: { revokedAt: new Date() } },
          { returnDocument: "after" },
        );
        if (!record)
          throw new Problem(404, "NOT_FOUND", "Credential not found");
        await auditEvent(owner, "owner", "credential.revoke", "success");
        res.json({ credential: safeCredential(record) });
      } catch (e) {
        next(e);
      }
    },
  );
  app.get("/api/v1/integrations/audit", async (req, res, next) => {
    try {
      const owner = ownerSession(res);
      const { page = 1, limit = 50 } = z
        .object({
          page: z.coerce.number().int().min(1).max(100000).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query);
      const [items, total] = await Promise.all([
        audit
          .find({ owner }, { projection: { _id: 0, owner: 0 } })
          .sort({ at: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        audit.countDocuments({ owner }),
      ]);
      res.json({ items, total, page, limit });
    } catch (e) {
      next(e);
    }
  });

  app.get(
    "/api/v1/integrations/workspace",
    requestLimit,
    withBearer("workspace.read", "projects:read", async (_req, res, actor) => {
      const s = await workspace(actor.owner);
      res.set("ETag", `"${s.revision}"`);
      return { revision: s.revision, projects: s.projects };
    }),
  );
  app.get(
    "/api/v1/integrations/projects",
    requestLimit,
    withBearer(
      "projects.list",
      "projects:read",
      async (_req, _res, actor) => (await workspace(actor.owner)).projects,
    ),
  );
  app.get(
    "/api/v1/integrations/tasks",
    requestLimit,
    withBearer("tasks.search", "tasks:read", async (req, res, actor) => {
      const s = await workspace(actor.owner);
      res.set("ETag", `"${s.revision}"`);
      const filters = queryFiltersSchema.parse(req.query);
      return {
        ...query(s, filters as Record<string, string>),
        revision: s.revision,
      };
    }),
  );
  app.get(
    "/api/v1/integrations/tasks/:id",
    requestLimit,
    withBearer("tasks.read", "tasks:read", async (req, res, actor) => {
      const id = z.string().uuid().parse(req.params.id),
        s = await workspace(actor.owner);
      const task = s.tasks.find((x: any) => x.id === id);
      if (!task) throw new Problem(404, "NOT_FOUND", "Task not found");
      res.set("ETag", `"${s.revision}"`);
      return { task, revision: s.revision };
    }),
  );
  app.get(
    "/api/v1/integrations/sprints",
    requestLimit,
    withBearer("sprints.list", "sprints:read", async (req, res, actor) => {
      const s = await workspace(actor.owner);
      res.set("ETag", `"${s.revision}"`);
      const projectId = req.query.projectId
        ? z.string().uuid().parse(req.query.projectId)
        : null;
      const items = projectId
        ? s.sprints.filter((x: any) => x.projectId === projectId)
        : s.sprints;
      return {
        items: items.map((item: any) =>
          actor.permissions.includes("tasks:read")
            ? item
            : {
                ...item,
                snapshot: item.snapshot
                  ? {
                      completedAt: item.snapshot.completedAt,
                      finishedCount: item.snapshot.finished.length,
                      unfinishedCount: item.snapshot.unfinished.length,
                    }
                  : null,
              },
        ),
        revision: s.revision,
      };
    }),
  );
  app.post(
    "/api/v1/integrations/commands/:action",
    requestLimit,
    async (req, res, next) => {
      let actor: Actor | undefined;
      const action = String(req.params.action),
        requestId = randomUUID();
      try {
        actor = await authenticate(req);
        const permission = actionPermission[action];
        if (!permission)
          throw new Problem(404, "NOT_FOUND", "Unknown integration operation");
        requirePermission(actor, permission);
        const key = z
          .string()
          .min(8)
          .max(100)
          .parse(req.get("Idempotency-Key"));
        const match = /^"(0|[1-9]\d*)"$/.exec(req.get("If-Match") ?? "");
        if (!match)
          throw new Problem(
            428,
            "REVISION_REQUIRED",
            "Quoted workspace revision required in If-Match",
          );
        const result = await executeWorkspaceCommand(
          workspaces,
          actor.owner,
          action,
          req.body,
          Number(match[1]),
          key,
          actor.id,
        );
        await auditEvent(
          actor.owner,
          actor.id,
          action,
          "success",
          undefined,
          requestId,
        );
        res.json(redactMutationResult(actor, action, result));
      } catch (e) {
        if (actor)
          await auditEvent(
            actor.owner,
            actor.id,
            action,
            e instanceof Problem && e.status === 403 ? "denied" : "error",
            e instanceof Problem ? e.code : "INTERNAL_ERROR",
            requestId,
          ).catch(() => {});
        next(e);
      }
    },
  );

  app.use("/api/v1/mcp", (req, _res, next) => {
    const origin = req.get("Origin");
    if (origin && origin !== expectedOrigin(req))
      return next(new Problem(403, "ORIGIN_REJECTED", "Request origin rejected"));
    next();
  });
  // Stateless JSON Streamable HTTP works with buffered, on-demand Lambda invocations.
  app.post("/api/v1/mcp", requestLimit, async (req, res, next) => {
    let actor: Actor | undefined;
    const requestId = randomUUID();
    try {
      if (!mcpEnabled)
        throw new Problem(404, "NOT_FOUND", "MCP adapter is disabled");
      actor = await authenticate(req);
      const server = new McpServer({
        name: "learnverse-tasks",
        version: "1.0.0",
      });
      const read =
        (
          permission: Permission,
          action: string,
          work: () => Promise<unknown>,
        ) =>
        async () => {
          try {
            requirePermission(actor!, permission);
            const result = await work();
            await auditEvent(
              actor!.owner,
              actor!.id,
              action,
              "success",
              undefined,
              requestId,
            );
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(result) },
              ],
            };
          } catch (e) {
            await auditEvent(
              actor!.owner,
              actor!.id,
              action,
              e instanceof Problem && e.status === 403 ? "denied" : "error",
              e instanceof Problem ? e.code : "INTERNAL_ERROR",
              requestId,
            ).catch(() => {});
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    e instanceof Problem
                      ? e.message
                      : "Request could not be completed",
                },
              ],
            };
          }
        };
      const write =
        (action: string) =>
        async ({
          input,
          revision,
          idempotencyKey,
        }: {
          input: unknown;
          revision: number;
          idempotencyKey: string;
        }) =>
          read(actionPermission[action], action, async () =>
            redactMutationResult(
              actor!,
              action,
              await executeWorkspaceCommand(
                workspaces,
                actor!.owner,
                action,
                input,
                revision,
                idempotencyKey,
                actor!.id,
              ),
            ),
          )();
      server.registerTool(
        "list_projects",
        { description: "List projects and workflow statuses", inputSchema: {} },
        read("projects:read", "projects.list", async () => {
          const s = await workspace(actor!.owner);
          return { items: s.projects, revision: s.revision };
        }),
      );
      server.registerTool(
        "list_tasks",
        {
          description: "List workspace tasks with pagination",
          inputSchema: {
            page: z.number().int().min(1).optional(),
            limit: z.number().int().min(1).max(100).optional(),
          },
        },
        async ({ page, limit }) =>
          read("tasks:read", "tasks.list", async () => {
            const s = await workspace(actor!.owner);
            return {
              ...query(s, {
                page: String(page ?? 1),
                limit: String(limit ?? 50),
              }),
              revision: s.revision,
            };
          })(),
      );
      server.registerTool(
        "search_tasks",
        {
          description: "Search tasks with filters and pagination",
          inputSchema: { filters: queryFiltersSchema.optional() },
        },
        async ({ filters }) =>
          read("tasks:read", "tasks.search", async () => {
            const s = await workspace(actor!.owner);
            return {
              ...query(s, (filters ?? {}) as Record<string, string>),
              revision: s.revision,
            };
          })(),
      );
      server.registerTool(
        "read_task",
        {
          description: "Read one task by UUID",
          inputSchema: { id: z.string().uuid() },
        },
        async ({ id }) =>
          read("tasks:read", "tasks.read", async () => {
            const s = await workspace(actor!.owner),
              task = s.tasks.find((x: any) => x.id === id);
            if (!task) throw new Problem(404, "NOT_FOUND", "Task not found");
            return { task, revision: s.revision };
          })(),
      );
      server.registerTool(
        "list_sprints",
        {
          description: "List sprints",
          inputSchema: { projectId: z.string().uuid().optional() },
        },
        async ({ projectId }) =>
          read("sprints:read", "sprints.list", async () => {
            const s = await workspace(actor!.owner);
            const items = projectId
              ? s.sprints.filter((x: any) => x.projectId === projectId)
              : s.sprints;
            return {
              items: items.map((item: any) =>
                actor!.permissions.includes("tasks:read")
                  ? item
                  : {
                      ...item,
                      snapshot: item.snapshot
                        ? {
                            completedAt: item.snapshot.completedAt,
                            finishedCount: item.snapshot.finished.length,
                            unfinishedCount: item.snapshot.unfinished.length,
                          }
                        : null,
                    },
              ),
              revision: s.revision,
            };
          })(),
      );
      for (const [tool, action] of Object.entries({
        create_task: "task.create",
        update_task: "task.update",
        move_task: "task.move",
        create_sprint: "sprint.create",
        start_sprint: "sprint.start",
        complete_sprint: "sprint.complete",
      }))
        server.registerTool(
          tool,
          {
            description: `Run ${action} using the workspace revision and unique retry key`,
            inputSchema: {
              input: toolInputs[action as keyof typeof toolInputs],
              revision: mutationMeta.shape.revision,
              idempotencyKey: mutationMeta.shape.idempotencyKey,
            },
          },
          write(action),
        );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (actor)
        await auditEvent(
          actor.owner,
          actor.id,
          "mcp.request",
          "error",
          e instanceof Problem ? e.code : "INTERNAL_ERROR",
          requestId,
        ).catch(() => {});
      next(e);
    }
  });
  app.get("/api/v1/mcp", (_req, _res, next) =>
    next(new Problem(405, "METHOD_NOT_ALLOWED", "Use MCP HTTP POST")),
  );
  app.delete("/api/v1/mcp", (_req, _res, next) =>
    next(
      new Problem(
        405,
        "METHOD_NOT_ALLOWED",
        "Stateless MCP sessions cannot be deleted",
      ),
    ),
  );
}
