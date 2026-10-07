import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import assert from "node:assert/strict";
import { command, empty } from "../server/domain.js";
const path = "test-results/db-restart-fixture.json";
const client = await MongoClient.connect(
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
);
try {
  if (process.argv[2] === "prepare") {
    let state = empty();
    const run = (action: string, data: unknown) => {
      const result = command(state, action, data);
      state = result.state;
      state.revision++;
      return result.result;
    };
    const project = run("project.create", {
      name: "Database restart fixture",
      prefix: "DR",
    });
    const sprint = run("sprint.create", {
      projectId: project.id,
      name: "Persistence sprint",
      goal: "Verify restart",
      startDate: "2026-10-06",
      endDate: "2026-10-20",
    });
    const one = run("task.create", {
      projectId: project.id,
      title: "Finished fixture",
      type: "task",
      sprintId: sprint.id,
      statusId: project.statuses[4].id,
    });
    const two = run("task.create", {
      projectId: project.id,
      title: "Carryover fixture",
      type: "task",
      sprintId: sprint.id,
    });
    run("task.move", {
      id: two.id,
      statusId: project.statuses[0].id,
      beforeId: null,
    });
    run("sprint.start", { id: sprint.id });
    run("sprint.complete", { id: sprint.id, targetSprintId: null });
    const database =
      "learnverse_restart_test_" + randomUUID().replaceAll("-", "");
    await mkdir("test-results", { recursive: true });
    await writeFile(path, JSON.stringify({ database, state }), { flag: "wx" });
    await client
      .db(database)
      .collection<any>("workspaces")
      .insertOne({ _id: "fixture", ...state });
    console.log(
      "Prepared fictional workspace, ordered tasks, and sprint snapshot for database restart.",
    );
  } else if (process.argv[2] === "verify") {
    const { database, state } = JSON.parse(await readFile(path, "utf8"));
    assert.match(database, /^learnverse_restart_test_[a-f0-9]{32}$/);
    const actual = await client
      .db(database)
      .collection<any>("workspaces")
      .findOne({ _id: "fixture" });
    assert.ok(actual);
    delete actual._id;
    assert.deepEqual(actual, state);
    await client.db(database).dropDatabase();
    await unlink(path);
    console.log(
      "PASS: entire workspace, task ordering, carryover and immutable sprint snapshot survived MongoDB restart.",
    );
  } else throw new Error("Use prepare or verify");
} finally {
  await client.close();
}
