import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { MongoClient } from "mongodb";

const database = "learnverse_lambda_test_" + randomUUID().replaceAll("-", "");
const token = randomBytes(32).toString("hex");
Object.assign(process.env, {
  NODE_ENV: "production", COOKIE_SECURE: "true", MCP_ENABLED: "true",
  AWS_LAMBDA_FUNCTION_NAME: "learnverse-local-smoke", MONGODB_DATABASE: database,
  PUBLIC_ORIGIN: "https://example.cloudfront.net", ORIGIN_TOKEN: token,
});
delete process.env.MONGODB_PARAMETER;
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
const { handler } = createRequire(import.meta.url)("../output/lambda/index.js");
const cleanup = await MongoClient.connect(process.env.MONGODB_URI);
async function request(path, body, cookie = "", overrides = {}, method = body === undefined ? "GET" : "POST") {
  const result = await handler({
    version: "2.0", routeKey: "$default", rawPath: "/api/v1/" + path, rawQueryString: "",
    headers: { host: "example.lambda-url.ap-south-1.on.aws", "x-forwarded-proto": "https", "content-type": "application/json", origin: process.env.PUBLIC_ORIGIN, "x-learnverse-origin": token, ...overrides },
    cookies: cookie ? [cookie] : [],
    requestContext: { accountId: "anonymous", domainName: "example.lambda-url.ap-south-1.on.aws", requestId: randomUUID(), routeKey: "$default", stage: "$default", http: { method, path: "/api/v1/" + path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "local-smoke" } },
    body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
  }, { callbackWaitsForEmptyEventLoop: true });
  const data = result.body ? JSON.parse(result.isBase64Encoded ? Buffer.from(result.body, "base64").toString() : result.body) : null;
  return { ...result, data };
}
let code = 0;
try {
  assert.equal((await request("health", undefined, "", { "x-learnverse-origin": "wrong" })).statusCode, 403);
  const health = await request("health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal((await request("workspace")).statusCode, 401);
  const a = await request("auth/register", { email: "lambda-a@example.test", password: "lambda smoke password" });
  assert.equal(a.statusCode, 200);
  const session = a.cookies[0];
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Strict/);
  const cookie = session.split(";")[0];
  assert.equal((await request("workspace", undefined, cookie)).statusCode, 200);
  const headers = { "if-match": '"0"', "idempotency-key": randomUUID() };
  const body = { name: "Lambda project", prefix: "LM" };
  const project = await request("commands/project.create", body, cookie, headers);
  assert.equal(project.statusCode, 200);
  assert.equal((await request("commands/project.create", body, cookie, headers)).data.result.id, project.data.result.id);
  assert.equal((await request("commands/project.create", body, cookie, { ...headers, origin: "https://evil.test" })).statusCode, 403);
  const b = await request("auth/register", { email: "lambda-b@example.test", password: "another lambda password" });
  assert.equal(b.statusCode, 200);
  assert.equal((await request("workspace", undefined, b.cookies[0].split(";")[0])).data.projects.length, 0);
  assert.equal((await request("openapi.json")).statusCode, 200);
  assert.equal((await request("not-a-route", undefined, cookie)).statusCode, 404);
  const credential = await request("integrations/credentials", { name: "Lambda MCP smoke", permissions: ["projects:read", "tasks:read", "tasks:write"], expiresInDays: 1 }, cookie);
  assert.equal(credential.statusCode, 201);
  const mcpHeaders = { accept: "application/json, text/event-stream", authorization: `Bearer ${credential.data.token}` };
  let rpcId = 0;
  const rpc = (method, params = {}, headers = mcpHeaders) => request("mcp", { jsonrpc: "2.0", id: ++rpcId, method, params }, "", headers);
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lambda-smoke", version: "1.0.0" } });
  assert.equal(initialized.statusCode, 200);
  assert.match(initialized.headers["content-type"], /application\/json/);
  assert.equal(initialized.data.result.serverInfo.name, "learnverse-tasks");
  assert.equal((await request("mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, "", mcpHeaders)).statusCode, 202);
  const tools = await rpc("tools/list");
  assert.equal(tools.data.result.tools.length, 11);
  const list = await rpc("tools/call", { name: "list_projects", arguments: {} });
  assert.equal(JSON.parse(list.data.result.content[0].text).items[0].id, project.data.result.id);
  const task = await rpc("tools/call", { name: "create_task", arguments: { input: { projectId: project.data.result.id, title: "MCP Lambda task", type: "task" }, revision: 1, idempotencyKey: randomUUID() } });
  assert.equal(task.data.result.isError, undefined);
  assert.equal(JSON.parse(task.data.result.content[0].text).revision, 2);
  const denied = await rpc("tools/call", { name: "list_sprints", arguments: {} });
  assert.equal(denied.data.result.isError, true);
  assert.equal((await rpc("tools/list", {}, { ...mcpHeaders, authorization: "Bearer invalid" })).statusCode, 401);
  assert.equal((await request("mcp", undefined, "", { origin: "https://evil.test" })).statusCode, 403);
  assert.equal((await request("integrations/credentials/" + credential.data.credential.id, undefined, cookie, {}, "DELETE")).statusCode, 200);
  assert.equal((await rpc("tools/list")).statusCode, 401);
  await request("auth/logout", {}, cookie);
  assert.equal((await request("workspace", undefined, cookie)).statusCode, 401);
  console.log("Packaged Lambda passed: DB health, private-origin gate, secure sessions, retries, isolation, OpenAPI, logout, and MCP initialize/tools/read/write/scope denial/revocation through JSON HTTP.");
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  assert.match(database, /^learnverse_lambda_test_[a-f0-9]+$/);
  await cleanup.db(database).dropDatabase();
  await cleanup.close();
  // The bundled Lambda deliberately retains its connection pool for warm invocations.
  process.exit(code);
}
