import { test } from "node:test";
import assert from "node:assert/strict";
import { command, empty, query, State } from "../server/domain.js";
function setup() {
  let state = empty();
  const run = (a: string, d: any) => {
    const r = command(state, a, d);
    state = r.state;
    return r.result;
  };
  const p = run("project.create", { name: "Test", prefix: "LV" });
  return {
    run,
    p,
    get state() {
      return state;
    },
  };
}
test("hierarchy rejects cross-project parents and cycles; archive preserves children", () => {
  const x = setup(),
    epic = x.run("task.create", {
      projectId: x.p.id,
      title: "Epic",
      type: "epic",
    }),
    parent = x.run("task.create", {
      projectId: x.p.id,
      title: "Parent",
      type: "task",
      parentId: epic.id,
    }),
    child = x.run("task.create", {
      projectId: x.p.id,
      title: "Child",
      type: "subtask",
      parentId: parent.id,
    });
  const other = x.run("project.create", { name: "Other", prefix: "OT" });
  assert.throws(
    () =>
      x.run("task.create", {
        projectId: other.id,
        title: "Bad",
        type: "task",
        parentId: epic.id,
      }),
    /same project/,
  );
  assert.throws(
    () => x.run("task.update", { id: parent.id, parentId: child.id }),
    /hierarchy/,
  );
  assert.throws(
    () => x.run("task.update", { id: epic.id, parentId: epic.id }),
    /hierarchy/,
  );
  x.run("task.update", { id: parent.id, archived: true });
  assert.equal(x.state.tasks.find((t) => t.id === child.id).archived, false);
  x.run("task.update", { id: parent.id, archived: false });
  assert.equal(x.state.tasks.length, 3);
});
test("stable anchor ordering retains hidden card order", () => {
  const x = setup();
  const items = ["A", "hidden B", "C", "hidden D", "E"].map((title) =>
    x.run("task.create", { projectId: x.p.id, title, type: "task" }),
  );
  x.run("task.move", {
    id: items[4].id,
    statusId: x.p.statuses[0].id,
    beforeId: items[2].id,
    afterId: items[0].id,
  });
  assert.deepEqual(
    x.state.tasks.map((t) => t.title),
    ["A", "hidden B", "E", "C", "hidden D"],
  );
  assert.deepEqual(
    x.state.tasks
      .filter((t) => t.title.startsWith("hidden"))
      .map((t) => t.title),
    ["hidden B", "hidden D"],
  );
  assert.throws(
    () =>
      x.run("task.move", {
        id: items[4].id,
        statusId: x.p.statuses[1].id,
        beforeId: items[2].id,
      }),
    /anchor/,
  );
});
test("status deletion requires valid replacement including archived cards", () => {
  const x = setup(),
    t = x.run("task.create", {
      projectId: x.p.id,
      title: "Test",
      type: "task",
    });
  assert.throws(
    () =>
      x.run("status.save", {
        projectId: x.p.id,
        statuses: x.p.statuses.slice(1),
      }),
    /replacement/,
  );
  x.run("status.save", {
    projectId: x.p.id,
    statuses: x.p.statuses.slice(1),
    replacements: { [x.p.statuses[0].id]: x.p.statuses[1].id },
  });
  assert.equal(x.state.tasks[0].statusId, x.p.statuses[1].id);
});
test("sprints enforce one active sprint, subtask inheritance and immutable completion snapshot", () => {
  const x = setup(),
    create = (name: string) =>
      x.run("sprint.create", {
        projectId: x.p.id,
        name,
        startDate: "2026-10-01",
        endDate: "2026-10-14",
      }),
    a = create("First"),
    b = create("Next"),
    parent = x.run("task.create", {
      projectId: x.p.id,
      title: "Unfinished",
      type: "task",
      sprintId: a.id,
    }),
    sub = x.run("task.create", {
      projectId: x.p.id,
      title: "Subtask",
      type: "subtask",
      parentId: parent.id,
    }),
    done = x.run("task.create", {
      projectId: x.p.id,
      title: "Finished",
      type: "task",
      sprintId: a.id,
      statusId: x.p.statuses[4].id,
    });
  assert.equal(sub.sprintId, a.id);
  x.run("sprint.start", { id: a.id });
  assert.throws(() => x.run("sprint.start", { id: b.id }), /one active/);
  x.run("sprint.complete", { id: a.id, targetSprintId: b.id });
  assert.equal(x.state.tasks.find((t) => t.id === sub.id).sprintId, b.id);
  assert.equal(x.state.sprints[0].snapshot.finished.length, 1);
  assert.equal(x.state.sprints[0].snapshot.unfinished.length, 2);
  x.run("task.update", { id: done.id, title: "Edited later" });
  assert.equal(x.state.sprints[0].snapshot.finished[0].title, "Finished");
  x.run("task.update", { id: parent.id, sprintId: null });
  assert.equal(x.state.tasks.find((t) => t.id === sub.id).sprintId, null);
});
test("failed mutations leave input state untouched", () => {
  const x = setup(),
    t = x.run("task.create", {
      projectId: x.p.id,
      title: "Original",
      type: "task",
    }),
    before = structuredClone(x.state);
  assert.throws(() =>
    x.run("task.update", {
      id: t.id,
      title: "Changed",
      parentId: crypto.randomUUID(),
    }),
  );
  assert.deepEqual(x.state, before);
});
test("search supports key, description, filters and pagination", () => {
  const x = setup();
  for (let i = 0; i < 4; i++)
    x.run("task.create", {
      projectId: x.p.id,
      title: "Task " + i,
      type: "task",
      description: "Markdown knowledge",
      labels: ["lesson"],
      priority: "high",
    });
  assert.equal(query(x.state, { q: "LV-1" }).total, 1);
  assert.equal(
    query(x.state, {
      q: "knowledge",
      label: "lesson",
      priority: "high",
      page: "2",
      limit: "2",
    }).items.length,
    2,
  );
});
test("partial edits preserve omitted fields and archived parents remain editable", () => {
  const x = setup(),
    e = x.run("task.create", {
      projectId: x.p.id,
      title: "Epic",
      type: "epic",
    }),
    t = x.run("task.create", {
      projectId: x.p.id,
      title: "Original",
      type: "task",
      parentId: e.id,
      description: "Keep markdown",
      labels: ["keep"],
      priority: "urgent",
      dueDate: "2026-10-10",
    });
  x.run("task.update", { id: e.id, archived: true });
  x.run("task.update", { id: t.id, title: "Changed" });
  const actual = x.state.tasks.find((v) => v.id === t.id);
  assert.equal(actual.description, "Keep markdown");
  assert.equal(actual.priority, "urgent");
  assert.equal(actual.parentId, e.id);
  assert.deepEqual(actual.labels, ["keep"]);
  assert.equal(actual.dueDate, "2026-10-10");
  assert.throws(() =>
    x.run("task.update", { id: t.id, dueDate: "2026-02-31" }),
  );
});
