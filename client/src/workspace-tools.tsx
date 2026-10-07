import { useState } from "react";
type Item = Record<string, any>;

export function SearchPicker({ items, value, onChange, label, allowNone = true }: {
  items: { id: string; name: string }[]; value: string; onChange: (id: string) => void; label: string; allowNone?: boolean;
}) {
  const [query, setQuery] = useState("");
  const matches = items.filter(x => x.name.toLowerCase().includes(query.toLowerCase()) || x.id === value);
  return <div className="searchpicker">
    <label>{`Search ${label.toLowerCase()}`}<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Type a name or key…" /></label>
    <label>{label}<select value={value} onChange={e => onChange(e.target.value)} size={Math.min(5, Math.max(2, matches.length + 1))}>
      {allowNone && <option value="">None</option>}
      {matches.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
    </select></label>
    {!matches.length && <p className="hint">No matches.</p>}
  </div>;
}
