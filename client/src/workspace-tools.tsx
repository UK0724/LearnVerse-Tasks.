import { useState } from "react";
type Item = Record<string, any>;

export function SearchPicker({
  items,
  value,
  onChange,
  label,
  allowNone = true,
}: {
  items: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  allowNone?: boolean;
}) {
  const [query, setQuery] = useState("");
  const matches = items.filter((x) =>
    x.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="searchpicker">
      <label>
        {`Search ${label.toLowerCase()}`}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${label.toLowerCase()}s…`}
        />
      </label>
      <div className="pickeroptions" role="group" aria-label={label}>
        {allowNone && (
          <button
            type="button"
            className={value === "" ? "pickeroption selected" : "pickeroption"}
            onClick={() => onChange("")}
          >
            None
          </button>
        )}
        {matches.map((x) => (
          <button
            type="button"
            className={
              value === x.id ? "pickeroption selected" : "pickeroption"
            }
            key={x.id}
            onClick={() => onChange(x.id)}
          >
            {x.name}
            {value === x.id && <span aria-hidden="true">✓</span>}
          </button>
        ))}
        {!matches.length && <p className="hint">No matches.</p>}
      </div>
    </div>
  );
}
