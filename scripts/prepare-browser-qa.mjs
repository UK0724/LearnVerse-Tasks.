// Creates only an isolated QA workspace; credentials stay in an ignored private file.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const origin = process.argv[2] || "http://127.0.0.1:3000";
const email = `ui-${randomUUID()}@example.test`, password = randomBytes(24).toString("hex");
const register = await fetch(origin + "/api/v1/auth/register", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, password }) });
if (!register.ok) throw new Error("QA registration failed");
const cookie = register.headers.get("set-cookie").split(";")[0];
const request = async (path, body, revision) => {
  const response = await fetch(origin + "/api/v1/" + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin, "If-Match": `"${revision}"`, "Idempotency-Key": randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error("QA fixture setup failed"); return response.json();
};
await request("commands/sample.seed", {}, 0);
const state = await request("workspace");
const project = state.projects.find(p => p.prefix === "CODE");
await request("commands/task.create", { projectId: project.id, title: "Searchable parent epic", type: "epic" }, state.revision);
const final = await request("workspace");
await writeFile(".browser-qa.private.json", JSON.stringify({ email, password, origin, projectId: project.id, taskId: final.tasks.find(t => t.projectId === project.id && t.type === "task").id }));
await request("auth/logout", {});
console.log("Isolated browser QA workspace prepared; secrets kept out of output.");
