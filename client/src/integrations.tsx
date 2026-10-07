import { useEffect, useState } from "react";
type Credential = {
  id: string;
  name: string;
  permissions: string[];
  expiresAt: string;
  revokedAt?: string | null;
};
const permissions = [
  "projects:read",
  "tasks:read",
  "tasks:write",
  "sprints:read",
  "sprints:write",
];
async function request(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api/v1/integrations/" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => {
    throw new Error("The service could not respond. Please try again.");
  });
  if (!r.ok) throw new Error(data.error?.message ?? "Request failed");
  return data;
}
export function Integrations() {
  const endpoint = `${location.origin}/api/v1/mcp`;
  const [credentials, setCredentials] = useState<Credential[]>([]),
    [audit, setAudit] = useState<any[]>([]),
    [enabled, setEnabled] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [token, setToken] = useState(""),
    [selected, setSelected] = useState(["tasks:read", "projects:read"]),
    [message, setMessage] = useState("");
  async function load() {
    try {
      const [c, a] = await Promise.all([
        request("credentials"),
        request("audit?limit=50"),
      ]);
      setCredentials(c.credentials);
      setEnabled(c.mcpEnabled);
      setAudit(a.items);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <section className="panel">
        <h2>Connect on your terms</h2>
        <p>
          Give an agent access to this workspace with only the permissions it
          needs. Credentials expire and can be revoked immediately. Creating a
          credential does not connect an integration.
        </p>
        <p className="hint">{enabled ? "MCP is enabled." : "MCP is disabled on this server."} REST access uses the same permissions and audit log.</p>
        <label>MCP endpoint<input readOnly value={endpoint} /></label>
        <button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(endpoint); setMessage("MCP endpoint copied"); } catch { setMessage("Select and copy the endpoint manually"); } }}>Copy endpoint</button>
        <details className="setupguide"><summary>Set up an MCP client</summary><ol>
          <li>Create a scoped credential below. Start with read permissions; enable writes only when needed.</li>
          <li>Add a remote server in a client that supports Streamable HTTP and custom headers.</li>
          <li>Use the endpoint above and the header <code>Authorization: Bearer YOUR_SECRET</code>. Keep the secret in your client's secure credential storage.</li>
          <li>Connect and list tools. Clients without custom bearer-header support cannot connect with this credential.</li>
        </ol><pre>{JSON.stringify({ mcpServers: { learnverse: { url: endpoint, headers: { Authorization: "Bearer YOUR_SECRET" } } } }, null, 2)}</pre>
        <p className="hint">Configuration format varies by client. This example uses a placeholder; your real secret is shown only when created. Revoking it or changing your password disconnects the client.</p></details>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {loading ? (
          <p role="status">Loading integration settings…</p>
        ) : (
          <>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setSaving(true);
                setError("");
                try {
                  const data = await request("credentials", "POST", {
                    name: f.get("name"),
                    permissions: selected,
                    expiresInDays: Number(f.get("days")),
                  });
                  setToken(data.token);
                  await load();
                  setMessage(
                    "Credential created. Copy it now; it will not be shown again.",
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              <div className="formgrid">
                <label>
                  Credential name
                  <input
                    name="name"
                    required
                    maxLength={100}
                    placeholder="My task assistant"
                  />
                </label>
                <label>
                  Expires in days
                  <input
                    name="days"
                    type="number"
                    min={1}
                    max={90}
                    defaultValue={7}
                    required
                  />
                </label>
              </div>
              <fieldset>
                <legend>Allowed permissions</legend>
                {permissions.map((p) => (
                  <label className="checklabel" key={p}>
                    <input
                      type="checkbox"
                      checked={selected.includes(p)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, p]
                            : selected.filter((x) => x !== p),
                        )
                      }
                    />
                    {p}
                  </label>
                ))}
              </fieldset>
              <p className="hint">
                This creates a secret for the current workspace. Give it only to
                the intended client through a secure setup flow.
              </p>
              <button disabled={saving || !selected.length}>
                Create scoped credential
              </button>
            </form>
            {token && (
              <div className="tokenpanel">
                <h3>Shown once</h3>
                <p role="status">{message}</p>
                <label>
                  New credential secret
                  <textarea readOnly value={token} rows={3} />
                </label>
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(token);
                      setMessage("Copied to clipboard");
                    } catch {
                      setMessage("Select and copy the secret manually");
                    }
                  }}
                >
                  Copy secret
                </button>
                <button className="secondary" onClick={() => setToken("")}>
                  Hide secret
                </button>
                <p className="hint">
                  This value stays only in page memory. Reloading or leaving
                  this page clears it.
                </p>
              </div>
            )}
            <h3>Workspace credentials</h3>
            {!credentials.length ? (
              <p className="empty">No credentials have been created.</p>
            ) : (
              credentials.map((c) => (
                <div className="credential" key={c.id}>
                  <div>
                    <strong>{c.name}</strong>
                    <p className="hint">
                      {c.permissions.join(" · ")}
                      <br />
                      Expires {new Date(c.expiresAt).toLocaleString()} ·{" "}
                      {c.revokedAt
                        ? "Revoked"
                        : new Date(c.expiresAt).getTime() <= Date.now()
                          ? "Expired"
                          : "Active"}
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={saving || !!c.revokedAt}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        await request("credentials/" + c.id, "DELETE");
                        setToken("");
                        await load();
                        setMessage("Credential revoked");
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))
            )}
          </>
        )}
      </section>
      <section className="panel integrationaudit">
        {message && !token && <p role="status">{message}</p>}
        <h2>Access audit</h2>
        <button className="secondary" onClick={load}>
          Refresh audit
        </button>
        <p className="hint">
          Latest 50 credential and integration access events for this workspace.
          No secret values or task descriptions are logged.
        </p>
        {audit.length ? (
          audit.map((a, i) => (
            <div className="activity" key={a.id ?? i}>
              <span>
                {a.action} · {a.outcome}
                {a.code ? " · " + a.code : ""}
                <small className="auditactor">
                  {a.actor} {a.credentialId ?? ""}
                </small>
              </span>
              <time>{new Date(a.at ?? a.timestamp).toLocaleString()}</time>
            </div>
          ))
        ) : (
          <p className="empty">No integration access yet.</p>
        )}
      </section>
    </>
  );
}
