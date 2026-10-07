// Creates only an isolated QA workspace; credentials stay in an ignored private file.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const origin = process.argv[2] || "http://127.0.0.1:3000";
const email = `ui-${randomUUID()}@example.test`,
  password = randomBytes(24).toString("hex");
const register = await fetch(origin + "/api/v1/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ email, password }),
});
if (!register.ok) throw new Error("QA registration failed");
const cookie = register.headers.get("set-cookie").split(";")[0];
const request = async (path, body, revision) => {
  const response = await fetch(origin + "/api/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: origin,
      "If-Match": `"${revision}"`,
      "Idempotency-Key": randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error("QA fixture setup failed");
  return response.json();
};
if (!process.argv.includes("--empty")) {
  await request(
    "commands/project.create",
    { name: "Product launch", prefix: "PLAN" },
    0,
  );
  let state = await request("workspace");
  const project = state.projects[0];
  await request(
    "commands/task.create",
    {
      projectId: project.id,
      title: "Prepare project brief",
      type: "task",
      priority: "high",
    },
    state.revision,
  );
  state = await request("workspace");
  await request(
    "commands/task.create",
    { projectId: project.id, title: "Release milestone", type: "epic" },
    state.revision,
  );
}
const final = await request("workspace");
await writeFile(
  ".browser-qa.private.json",
  JSON.stringify({
    email,
    password,
    origin,
    projectId: final.projects[0]?.id ?? null,
    taskId: final.tasks.find((t) => t.type === "task")?.id ?? null,
  }),
);
await request("auth/logout", {});
console.log(
  "Isolated browser QA workspace prepared; secrets kept out of output.",
);
