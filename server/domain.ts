import { randomUUID } from "node:crypto";
import { z } from "zod";
import { taskFields, importRows, titleIdentity } from "../shared/task-import.js";
export class Problem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export type State = {
  revision: number;
  projects: any[];
  tasks: any[];
  sprints: any[];
  activity: any[];
  receipts: any[];
};
export const empty = (): State => ({
  revision: 0,
  projects: [],
  tasks: [],
  sprints: [],
  activity: [],
  receipts: [],
});
const text = z.string().trim().min(1).max(200),
  id = z.string().uuid();
function fail(message: string): never {
  throw new Problem(422, "RULE_VIOLATION", message);
}
function find(items: any[], key: string) {
  const item = items.find((x) => x.id === key);
  if (!item) throw new Problem(404, "NOT_FOUND", "Resource not found");
  return item;
}
export function command(state: State, action: string, input: unknown) {
  const s = structuredClone(state),
    now = new Date().toISOString();
  let result: any;
  const record = (entity: string, entityId: string, message: string) =>
    s.activity.push({ id: randomUUID(), entity, entityId, message, at: now });
  const project = (key: string) => find(s.projects, key),
    task = (key: string) => find(s.tasks, key),
    sprint = (key: string) => find(s.sprints, key);
  const validateTask = (t: any) => {
    const p = project(t.projectId);
    if (!p.statuses.some((x: any) => x.id === t.statusId))
      fail("Invalid project status");
    if (t.parentId) {
      const parent = task(t.parentId);
      if (parent.projectId !== t.projectId)
        fail("Parents must belong to the same project");
      if (
        parent.archived &&
        state.tasks.find((x) => x.id === t.id)?.parentId !== t.parentId
      )
        fail("Parent is archived");
      if (
        t.type === "epic" ||
        (t.type === "subtask" && !["task", "bug"].includes(parent.type)) ||
        (["task", "bug"].includes(t.type) && parent.type !== "epic")
      )
        fail("Use Epic → Task/Bug → Subtask hierarchy");
      let cursor: any = parent;
      const seen = new Set([t.id]);
      while (cursor) {
        if (seen.has(cursor.id)) fail("Circular parent relationship");
        seen.add(cursor.id);
        cursor = cursor.parentId ? task(cursor.parentId) : null;
      }
      if (t.type === "subtask" && t.sprintId !== parent.sprintId)
        fail("Subtasks inherit their parent sprint");
    } else if (t.type === "subtask") fail("Subtasks require a parent");
    if (t.sprintId) {
      const sp = sprint(t.sprintId);
      if (
        sp.projectId !== t.projectId ||
        (sp.state === "completed" &&
          state.tasks.find((x) => x.id === t.id)?.sprintId !== t.sprintId)
      )
        fail("Choose a planned or active sprint in this project");
    }
  };
  if (action === "project.create") {
    const d = z
      .object({ name: text, prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/) })
      .parse(input);
    if (s.projects.some((p) => p.prefix === d.prefix))
      fail("Project prefix already exists");
    result = {
      ...d,
      id: randomUUID(),
      nextKey: 1,
      archived: false,
      statuses: ["Backlog", "To Do", "In Progress", "In Review", "Done"].map(
        (name, i) => ({
          id: randomUUID(),
          name,
          category: i === 4 ? "done" : i >= 2 ? "progress" : "todo",
        }),
      ),
    };
    s.projects.push(result);
  } else if (action === "project.archive") {
    const d = z.object({ id, archived: z.boolean() }).parse(input);
    result = project(d.id);
    result.archived = d.archived;
  } else if (action === "task.import") {
    const d = z.object({ projectId: id, rows: importRows }).parse(input);
    if (project(d.projectId).archived) fail("Restore project first");
    const seen = new Set(s.tasks.filter(t => t.projectId === d.projectId).map(t => titleIdentity(t.title)));
    const imported = [], skipped = [];
    for (const [index, row] of d.rows.entries()) {
      const identity = titleIdentity(row.title);
      if (seen.has(identity)) { skipped.push({ row: index + 1, title: row.title }); continue; }
      const created = command(s, "task.create", { ...row, projectId: d.projectId });
      Object.assign(s, created.state);
      imported.push({ id: created.result.id, key: created.result.key });
      seen.add(identity);
    }
    result = { created: imported.length, imported, skipped };
  } else if (action === "task.create") {
    const d = taskFields.extend({ projectId: id }).parse(input),
      p = project(d.projectId);
    if (p.archived) fail("Restore project first");
    result = {
      ...d,
      id: randomUUID(),
      key: `${p.prefix}-${p.nextKey++}`,
      statusId: d.statusId ?? p.statuses[0].id,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    if (result.type === "subtask" && result.parentId)
      result.sprintId = task(result.parentId).sprintId;
    validateTask(result);
    s.tasks.push(result);
  } else if (action === "task.update") {
    const parsed = taskFields
      .partial()
      .extend({ id, archived: z.boolean().optional() })
      .parse(input);
    const d: Partial<typeof parsed> & { id: string } = Object.fromEntries(
      Object.entries(parsed).filter(([key]) =>
        Object.prototype.hasOwnProperty.call(input, key),
      ),
    ) as Partial<typeof parsed> & { id: string };
    result = task(d.id);
    Object.assign(result, d, { updatedAt: now });
    if (result.type === "subtask" && result.parentId)
      result.sprintId = task(result.parentId).sprintId;
    validateTask(result);
    const children = s.tasks.filter((t) => t.parentId === result.id);
    for (const c of children) {
      if (result.archived) continue;
      if (
        (result.type === "epic" && !["task", "bug"].includes(c.type)) ||
        (["task", "bug"].includes(result.type) && c.type !== "subtask") ||
        result.type === "subtask"
      )
        fail("Type conflicts with existing children");
      if (c.type === "subtask") {
        c.sprintId = result.sprintId;
        c.updatedAt = now;
        validateTask(c);
      }
    }
  } else if (action === "task.move") {
    const d = z
      .object({
        id,
        statusId: id,
        beforeId: id.nullable().default(null),
        afterId: id.nullable().default(null),
      })
      .parse(input);
    result = task(d.id);
    if (result.archived) fail("Restore task before moving");
    result.statusId = d.statusId;
    validateTask(result);
    const validAnchor = (key: string | null) =>
      key
        ? s.tasks.find(
            (t) =>
              t.id === key &&
              t.id !== result.id &&
              t.projectId === result.projectId &&
              t.statusId === d.statusId &&
              !t.archived,
          )
        : null;
    const before = validAnchor(d.beforeId),
      after = validAnchor(d.afterId);
    if ((d.beforeId && !before) || (d.afterId && !after))
      fail("Ordering anchor is no longer valid");
    s.tasks = s.tasks.filter((t) => t.id !== result.id);
    if (before && after && s.tasks.indexOf(after) >= s.tasks.indexOf(before))
      fail("Conflicting ordering anchors");
    const at = before
      ? s.tasks.indexOf(before)
      : after
        ? s.tasks.indexOf(after) + 1
        : s.tasks.length;
    s.tasks.splice(at, 0, result);
    result.updatedAt = now;
  } else if (action === "status.save") {
    const d = z
      .object({
        projectId: id,
        statuses: z
          .array(
            z.object({
              id,
              name: text,
              category: z.enum(["todo", "progress", "done"]),
            }),
          )
          .min(1)
          .max(30),
        replacements: z.record(z.string(), id).default({}),
      })
      .parse(input);
    result = project(d.projectId);
    if (new Set(d.statuses.map((x) => x.id)).size !== d.statuses.length)
      fail("Duplicate statuses");
    for (const t of s.tasks.filter((t) => t.projectId === d.projectId)) {
      if (!d.statuses.some((x) => x.id === t.statusId)) {
        const replacement = d.replacements[t.statusId];
        if (!d.statuses.some((x) => x.id === replacement))
          fail("Populated statuses require a replacement");
        t.statusId = replacement;
        t.updatedAt = now;
      }
    }
    result.statuses = d.statuses;
  } else if (action === "sprint.create") {
    const d = z
      .object({
        projectId: id,
        name: text,
        goal: z.string().max(2000).default(""),
        startDate: z.iso.date(),
        endDate: z.iso.date(),
      })
      .parse(input);
    project(d.projectId);
    if (d.startDate > d.endDate) fail("End date precedes start");
    result = { ...d, id: randomUUID(), state: "planned", snapshot: null };
    s.sprints.push(result);
  } else if (action === "sprint.start") {
    const d = z.object({ id }).parse(input);
    result = sprint(d.id);
    if (
      result.state !== "planned" ||
      s.sprints.some(
        (x) => x.projectId === result.projectId && x.state === "active",
      )
    )
      fail("Only one active sprint per project");
    result.state = "active";
    result.startedAt = now;
  } else if (action === "sprint.complete") {
    const d = z.object({ id, targetSprintId: id.nullable() }).parse(input);
    result = sprint(d.id);
    if (result.state !== "active") fail("Sprint must be active");
    if (d.targetSprintId) {
      const target = sprint(d.targetSprintId);
      if (target.projectId !== result.projectId || target.state !== "planned")
        fail("Carryover requires a planned sprint in this project");
    }
    const p = project(result.projectId),
      items = s.tasks.filter((t) => t.sprintId === result.id),
      done = (t: any) =>
        p.statuses.find((x: any) => x.id === t.statusId)?.category === "done";
    result.snapshot = {
      completedAt: now,
      finished: structuredClone(items.filter(done)),
      unfinished: structuredClone(items.filter((t) => !done(t))),
    };
    for (const t of items.filter((t) => t.type !== "subtask")) {
      const children = items.filter(
        (c) => c.parentId === t.id && c.type === "subtask",
      );
      if (!done(t)) {
        t.sprintId = d.targetSprintId;
        children.forEach((c) => (c.sprintId = d.targetSprintId));
      } else {
        for (const c of children)
          if (!done(c))
            fail("Finish all subtasks before completing a finished parent");
      }
    }
    result.state = "completed";
  } else if (action === "sample.seed") {
    if (s.projects.length)
      fail("Samples are only available in an empty workspace");
    for (const [i, name] of [
      "Mahabharatham",
      "Motivational Videos",
      "Coding Lessons",
      "Job Search",
    ].entries()) {
      const a = command(s, "project.create", {
        name,
        prefix: ["MAH", "VID", "CODE", "JOB"][i],
      });
      Object.assign(s, a.state);
      const b = command(s, "task.create", {
        projectId: a.result.id,
        title: "Plan the next milestone",
        type: "task",
        priority: "high",
        description: "Fictional sample task. Replace this with your own work.",
      });
      Object.assign(s, b.state);
    }
    result = { created: 4 };
  } else throw new Problem(404, "NOT_FOUND", "Unknown operation");
  for (const current of s.tasks) {
    const ownerProject = s.projects.find((p) => p.id === current.projectId);
    const nowDone =
      ownerProject?.statuses.find(
        (status: any) => status.id === current.statusId,
      )?.category === "done";
    const previous = state.tasks.find((t) => t.id === current.id);
    const previousProject = state.projects.find(
      (p) => p.id === current.projectId,
    );
    const wasDone =
      previousProject?.statuses.find(
        (status: any) => status.id === previous?.statusId,
      )?.category === "done";
    current.completedAt = nowDone
      ? wasDone
        ? (previous?.completedAt ?? current.updatedAt)
        : now
      : null;
    if (previous && previous.sprintId !== current.sprintId)
      current.updatedAt = now;
  }
  record(
    action.split(".")[0],
    result.id ?? "workspace",
    `${action}: ${result.title ?? result.name ?? result.created ?? ""}`,
  );
  return { state: s, result };
}
export function query(s: State, filters: Record<string, string>) {
  let items = s.tasks.filter((t) =>
    filters.archived === "true" ? t.archived : !t.archived,
  );
  for (const k of ["projectId", "statusId", "priority", "sprintId"])
    if (filters[k])
      items = items.filter((t) => String(t[k] ?? "") === filters[k]);
  if (filters.label)
    items = items.filter((t) => t.labels.includes(filters.label));
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter((t) =>
      [t.title, t.description, t.key].some((v) => v.toLowerCase().includes(q)),
    );
  }
  if (filters.dueBefore)
    items = items.filter((t) => t.dueDate && t.dueDate <= filters.dueBefore);
  if (filters.dueAfter)
    items = items.filter((t) => t.dueDate && t.dueDate >= filters.dueAfter);
  const page = Math.max(1, Number(filters.page) || 1),
    limit = Math.min(100, Math.max(1, Number(filters.limit) || 50));
  return {
    items: items.slice((page - 1) * limit, page * limit),
    total: items.length,
    page,
    limit,
  };
}
