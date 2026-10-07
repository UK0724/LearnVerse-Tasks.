import express from "express";
import { resolve } from "node:path";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import { z, ZodError } from "zod";
import { expectedOrigin } from "./origin.js";
import { MongoRateLimitStore } from "./rate-limit-store.js";
import { empty, Problem, query } from "./domain.js";
import { configuredResetMailer, type ResetMailer } from "./reset-email.js";
import {
  executeWorkspaceCommand,
  installIntegrations,
  queryFiltersSchema,
} from "./integrations.js";
export async function createApp(uri: string, database = "learnverse_tasks", options: { sendResetEmail?: ResetMailer; now?: () => number } = {}) {
  const sendResetEmail = options.sendResetEmail ?? configuredResetMailer();
  const now = options.now ?? Date.now;
  const passwordSchema = z.string().min(12).max(128).refine(v => Buffer.byteLength(v, "utf8") <= 72);
  const client = await MongoClient.connect(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    }),
    db = client.db(database),
    users = db.collection("users"),
    sessions = db.collection("sessions"),
    workspaces = db.collection<any>("workspaces");
  try {
    await users.createIndex({ email: 1 }, { unique: true });
    await sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    await db.collection("rate_limits").createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
  } catch (error) {
    await client.close();
    throw error;
  }
  const app = express();
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy:
        process.env.NODE_ENV === "production" ? undefined : false,
    }),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  app.use("/api", async (req, res, next) => {
    try {
      const cookie = req.headers.cookie
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("lv_session="))
        ?.slice(11);
      if (cookie) {
        const session = await sessions.findOne({
          token: hash(cookie),
          expires: { $gt: new Date() },
        });
        if (session) {
          const user = await users.findOne({ owner: session.owner }, { projection: { authVersion: 1 } });
          if (user && (session.authVersion ?? 0) === (user.authVersion ?? 0)) {
            res.locals.owner = session.owner;
            res.locals.authVersion = session.authVersion ?? 0;
          }
        }
      }
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.headers.origin &&
        req.headers.origin !== expectedOrigin(req)
      )
        throw new Problem(403, "ORIGIN_REJECTED", "Request origin rejected");
      next();
    } catch (e) {
      next(e);
    }
  });
  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    store: new MongoRateLimitStore(db, "auth", 15 * 60 * 1000),
    message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
  });
  app.post("/api/v1/auth/:action", authLimit, async (req, res, next) => {
    try {
      const { action } = req.params;
      if (action === "forgot-password") {
        const { email } = z.object({ email: z.email().max(254) }).parse(req.body);
        if (!sendResetEmail) throw new Problem(503, "EMAIL_UNAVAILABLE", "Password reset email is not configured yet. Please contact the workspace owner.");
        const token = randomBytes(32).toString("hex"), tokenHash = hash(token), time = new Date(now());
        // Per-account cooldown does not change the public response, even for unknown emails.
        const user = await users.findOneAndUpdate({ email: email.toLowerCase(), $or: [{ resetRequestedAt: { $exists: false } }, { resetRequestedAt: { $lte: new Date(now() - 60_000) } }] },
          { $set: { resetTokenHash: tokenHash, resetExpires: new Date(now() + 15 * 60_000), resetRequestedAt: time } }, { returnDocument: "after" });
        if (user) {
          try { await sendResetEmail(user.email, `${expectedOrigin(req)}/reset-password#token=${token}`); console.info("Password reset email accepted"); }
          catch (e) {
            await users.updateOne({ _id: user._id, resetTokenHash: tokenHash }, { $unset: { resetTokenHash: "", resetExpires: "", resetRequestedAt: "" } });
            // Never log recipients, message contents, tokens or provider error text.
            console.error("Password reset delivery failed");
          }
        }
        res.json({ message: "If an account exists for this email, a reset link will be sent. Check your inbox and spam folder." });
        return;
      }
      if (action === "reset-password" || action === "change-password") {
        const { password } = z.object({ password: passwordSchema }).parse(req.body);
        let selector: any;
        if (action === "reset-password") {
          const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
          selector = { resetTokenHash: hash(token), resetExpires: { $gt: new Date(now()) } };
        } else {
          if (!res.locals.owner) throw new Problem(401, "AUTH_REQUIRED", "Please sign in");
          const { currentPassword } = z.object({ currentPassword: passwordSchema }).parse(req.body);
          const user = await users.findOne({ owner: res.locals.owner });
          if (!user || !await bcrypt.compare(currentPassword, user.password)) throw new Problem(401, "INVALID_LOGIN", "Current password is incorrect");
          selector = { _id: user._id, password: user.password };
        }
        // Consume and change the password in one atomic document update. Auth-version
        // invalidation also covers sessions created concurrently with this reset.
        const user = await users.findOneAndUpdate(selector, { $set: { password: await bcrypt.hash(password, 12) }, $inc: { authVersion: 1 }, $unset: { resetTokenHash: "", resetExpires: "", resetRequestedAt: "" } }, { returnDocument: "after" });
        if (!user) throw new Problem(422, "RESET_INVALID", "This reset link has expired or was already used. Request a new link.");
        await sessions.deleteMany({ owner: user.owner, authVersion: { $ne: user.authVersion } });
        await db.collection("integration_credentials").updateMany({ owner: user.owner, revokedAt: null }, { $set: { revokedAt: new Date(now()) } });
        res.clearCookie("lv_session", { path: "/" });
        res.json({ message: "Password updated. Sign in with your new password. All sessions and integration credentials were revoked." });
        return;
      }
      if (action === "logout") {
        const cookie = req.headers.cookie
          ?.split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith("lv_session="))
          ?.slice(11);
        if (cookie) await sessions.deleteOne({ token: hash(cookie) });
        res.clearCookie("lv_session", { path: "/" });
        res.json({ ok: true });
        return;
      }
      const d = z
        .object({
          email: z.email().max(254),
          password: passwordSchema,
        })
        .parse(req.body);
      const email = d.email.toLowerCase();
      let user = await users.findOne({ email });
      if (action === "register") {
        if (user)
          throw new Problem(409, "ACCOUNT_EXISTS", "Account already exists");
        const owner = randomBytes(16).toString("hex");
        await users.insertOne({
          email,
          password: await bcrypt.hash(d.password, 12),
          owner,
        });
        await workspaces.insertOne({ _id: owner, owner, ...empty() });
        user = await users.findOne({ email });
      } else if (action !== "login")
        throw new Problem(404, "NOT_FOUND", "Unknown operation");
      if (!user || !(await bcrypt.compare(d.password, user.password)))
        throw new Problem(401, "INVALID_LOGIN", "Invalid email or password");
      const token = randomBytes(32).toString("hex");
      await sessions.insertOne({
        token: hash(token),
        owner: user.owner,
        authVersion: user.authVersion ?? 0,
        expires: new Date(Date.now() + 7 * 86400000),
      });
      res.cookie("lv_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.COOKIE_SECURE === "true",
        maxAge: 7 * 86400000,
        path: "/",
      });
      res.json({ email: user.email });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/v1/health", async (_req, res, next) => {
    try {
      await db.command({ ping: 1 });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/v1/openapi.json", (_req, res) =>
    res.sendFile(
      resolve("docs/openapi.json"),
    ),
  );
  await installIntegrations(app, db, workspaces).catch(async (error) => {
    await client.close();
    throw error;
  });
  app.use("/api/v1", (_req, res, next) => {
    if (!res.locals.owner)
      return next(new Problem(401, "AUTH_REQUIRED", "Please sign in"));
    next();
  });
  app.get("/api/v1/workspace", async (_req, res, next) => {
    try {
      const s = await workspaces.findOne({ owner: res.locals.owner });
      if (!s) throw new Problem(404, "NOT_FOUND", "Workspace not found");
      const { _id, owner, receipts, ...data } = s;
      res.set("ETag", `"${s.revision}"`).json(data);
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/v1/auth/me", async (_req, res, next) => {
    try { const user = await users.findOne({ owner: res.locals.owner }); res.json({ email: user!.email }); } catch (e) { next(e); }
  });
  app.get("/api/v1/tasks", async (req, res, next) => {
    try {
      const s = await workspaces.findOne({ owner: res.locals.owner });
      res.json(
        query(
          s!,
          queryFiltersSchema.parse(req.query) as Record<string, string>,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/v1/commands/:action", async (req, res, next) => {
    try {
      const key = z.string().min(8).max(100).parse(req.get("Idempotency-Key"));
      const match = /^"(0|[1-9][0-9]*)"$/.exec(req.get("If-Match") ?? "");
      const response = await executeWorkspaceCommand(
        workspaces,
        res.locals.owner,
        req.params.action,
        req.body,
        match ? Number(match[1]) : -1,
        key,
      );
      res.json(response);
    } catch (e) {
      next(e);
    }
  });
  app.use("/api", (_req, _res, next) =>
    next(new Problem(404, "NOT_FOUND", "API route not found")),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err instanceof ZodError
          ? 422
          : (err.status ?? (err.code === 11000 ? 409 : 500));
      if (status >= 500) console.error("API failure", { name: err.name, code: err.code });
      res.status(status).json({
        error: {
          code:
            err instanceof ZodError
              ? "VALIDATION_ERROR"
              : err instanceof Problem
                ? err.code
                : status === 409
                  ? "CONFLICT"
                  : "INTERNAL_ERROR",
          message:
            err instanceof ZodError
              ? "Invalid request fields"
              : err instanceof Problem
                ? err.message
                : "Request could not be completed",
        },
      });
    },
  );
  return { app, client, db };
}
