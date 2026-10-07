import { z } from "zod";

export const taskFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).default(""),
  type: z.enum(["epic", "task", "bug", "subtask"]),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  labels: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  dueDate: z.iso.date().nullable().default(null),
  estimate: z.number().min(0).max(10000).nullable().default(null),
  parentId: z.string().uuid().nullable().default(null),
  sprintId: z.string().uuid().nullable().default(null),
  statusId: z.string().uuid().optional(),
});
export const importRows = z.array(taskFields).min(1).max(100);
export const titleIdentity = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

// CSV handles quoted commas, doubled quotes and multiline descriptions.
function csv(text: string) {
  const rows: string[][] = [], row: string[] = [];
  let cell = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === "," || c === "\n") {
      row.push(cell.replace(/\r$/, "")); cell = ""; closed = false;
      if (c === "\n") { if (row.some(v => v.trim())) rows.push([...row]); row.length = 0; }
    } else if (closed && c !== "\r") throw new Error("Unexpected text after a quoted CSV value.");
    else cell += c;
  }
  if (quoted) throw new Error("A quoted CSV value is missing its closing quote.");
  row.push(cell.replace(/\r$/, ""));
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
export function parseTaskImport(text: string) {
  if (new TextEncoder().encode(text).length > 200_000) throw new Error("Import files must be smaller than 200 KB.");
  const source = text.trim().replace(/^\uFEFF/, "");
  let input: unknown;
  if (source.startsWith("[")) input = JSON.parse(source);
  else {
    const [header, ...rows] = csv(source);
    const allowed = ["title", "description", "type", "priority", "labels", "dueDate", "estimate", "parentId", "sprintId", "statusId"];
    const names = header?.map(v => v.trim()) ?? [];
    if (!names.includes("title") || new Set(names).size !== names.length || names.some(n => !allowed.includes(n)))
      throw new Error("CSV needs a title column and supported, unique column names.");
    input = rows.map((values, index) => {
      if (values.length !== names.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
      const item: Record<string, unknown> = { type: "task" };
      names.forEach((name, i) => {
        const value = values[i];
        if (!value && name !== "title") return;
        item[name] = name === "labels" ? value.split(";").map(v => v.trim()).filter(Boolean) : name === "estimate" ? Number(value) : value;
      });
      return item;
    });
  }
  const parsed = importRows.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Check ${typeof issue.path[0] === "number" ? `row ${issue.path[0] + 1}, ` : ""}${issue.path.slice(1).join(".") || "rows"}: ${issue.message}`);
  }
  return parsed.data;
}
