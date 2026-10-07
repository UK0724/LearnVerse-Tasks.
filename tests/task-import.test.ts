import { test } from "node:test";
import assert from "node:assert/strict";
import { command, empty } from "../server/domain.js";
import { parseTaskImport } from "../shared/task-import.js";

test("CSV preserves quoted multiline values and rejects malformed, oversize and invalid input", () => {
  const rows = parseTaskImport('title,description,labels\r\n"Plan, review","Line one\nHe said ""ready""",work;release\r\n');
  assert.equal(rows[0].title, "Plan, review"); assert.equal(rows[0].description, 'Line one\nHe said "ready"');
  assert.deepEqual(rows[0].labels, ["work", "release"]);
  for (const source of ['title,title\na,b', 'title\n"not closed', 'title,priority\nBad,impossible', '[{"title":"Missing type"}]', 'title\n' + 'x'.repeat(200_001)]) assert.throws(() => parseTaskImport(source));
});
test("imports skip normalized duplicates across archived and incoming rows, isolate projects, and reject atomically", () => {
  let state = command(empty(), "project.create", { name: "Import", prefix: "IM" }).state;
  const p = state.projects[0];
  state = command(state, "task.create", { projectId: p.id, title: "Already here", type: "task" }).state;
  state = command(state, "task.update", { id: state.tasks[0].id, archived: true }).state;
  const before = structuredClone(state);
  const r = command(state, "task.import", { projectId: p.id, rows: parseTaskImport('title\n  ALREADY   HERE \nNew work\nnew  work\nAnother') });
  assert.equal(r.result.created, 2); assert.equal(r.result.skipped.length, 2);
  assert.deepEqual(r.state.tasks.map(t => t.key), ["IM-1", "IM-2", "IM-3"]);
  assert.deepEqual(state, before);
  assert.throws(() => command(state, "task.import", { projectId: p.id, rows: [{ title: "Valid first", type: "task" }, { title: "Invalid second", type: "subtask" }] }), /require a parent/);
  assert.deepEqual(state, before);
  const other = command(r.state, "project.create", { name: "Other", prefix: "OT" });
  const second = command(other.state, "task.import", { projectId: other.result.id, rows: [{ title: "Already here", type: "task" }] });
  assert.equal(second.result.created, 1);
});
