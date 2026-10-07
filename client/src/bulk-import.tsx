import { useState } from "react";
import { parseTaskImport, titleIdentity } from "../../shared/task-import";
type Item = Record<string, any>;
export default function BulkImport({ project, tasks, saving, submit }: { project: Item; tasks: Item[]; saving: boolean; submit: (rows: Item[]) => Promise<boolean | undefined> }) {
  const [text, setText] = useState(""), [error, setError] = useState("");
  let rows: Item[] = [], previewError = "";
  if (text.trim()) try { rows = parseTaskImport(text); } catch (e) { previewError = (e as Error).message; }
  const seen = new Set(tasks.filter(t => t.projectId === project.id).map(t => titleIdentity(t.title)));
  const preview: Item[] = rows.map((row, i) => {
    const duplicate = seen.has(titleIdentity(row.title)); seen.add(titleIdentity(row.title));
    return { ...row, index: i + 1, duplicate };
  });
  const count = preview.filter(r => !r.duplicate).length;
  return <form onSubmit={async e => { e.preventDefault(); if (!count || previewError) return; setError(""); try { await submit(rows); } catch (e) { setError((e as Error).message); } }}>
    <p>Import up to 100 tasks into <strong>{project.name}</strong>. Matching titles in this project (including archived tasks) and repeated rows are skipped, ignoring case and extra spaces. Other projects are unaffected.</p>
    <label>CSV or JSON file<input type="file" accept=".csv,.json,text/csv,application/json" onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 200_000) { setError("Import files must be smaller than 200 KB."); return; }
      setText(await file.text()); setError("");
    }} /></label>
    <label>Import data<textarea rows={7} value={text} onChange={e => { setText(e.target.value); setError(""); }} placeholder={'title,type,priority\nPlan next milestone,task,high\nReview release,task,medium'} /></label>
    <p className="hint">CSV columns: title (required), type (defaults to task), priority, description, labels (separated by semicolons), dueDate (YYYY-MM-DD), estimate, parentId, sprintId, statusId. JSON accepts an array with these fields; type is required. Parent, sprint and status references use IDs from this project.</p>
    {(error || previewError) && <p role="alert" className="error">{error || previewError}</p>}
    {preview.length > 0 && <><p role="status">{count} to import · {preview.length - count} duplicates to skip</p><div className="importpreview">
      {preview.map(r => <div key={r.index}><span>{r.index}. {r.title}</span><small>{r.duplicate ? "Skip duplicate" : `${r.type} · ${r.priority}`}</small></div>)}
    </div></>}
    <p className="hint">Nothing is saved until you confirm. If any task violates the project rules, the entire import is rejected.</p>
    <button disabled={saving || !count || !!previewError}>{saving ? "Importing…" : `Import ${count || ""} task${count === 1 ? "" : "s"}`}</button>
  </form>;
}
