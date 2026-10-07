import { useEffect, useState } from "react";
type Request = (path: string, options?: RequestInit) => Promise<any>;
export function Authentication({ request, signedIn, resetDone }: { request: Request; signedIn: () => Promise<void>; resetDone: () => void }) {
  const [mode, setMode] = useState(location.pathname === "/reset-password" ? "reset" : "login");
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  useEffect(() => { if (location.pathname === "/reset-password") history.replaceState(null, "", "/reset-password"); }, []);
  function change(next: string) { setMode(next); setError(""); setMessage(""); }
  return <main className="login">
    <div className="loginbrand">L<span>LearnVerse Tasks</span></div>
    <h1>{mode === "forgot" ? "Find your way back." : mode === "reset" ? "Choose a new password." : "Make room for meaningful work."}</h1>
    <p>{mode === "forgot" ? "We’ll email you a link to reset your password." : "Private projects, focused sprints, and a clear next step."}</p>
    <form key={mode} onSubmit={async e => {
      e.preventDefault(); if (busy) return;
      const fields = new FormData(e.currentTarget), password = fields.get("password");
      if ((mode === "reset" || mode === "register") && password !== fields.get("confirm")) { setError("Passwords do not match."); return; }
      setBusy(true); setError(""); setMessage("");
      try {
        const action = mode === "forgot" ? "forgot-password" : mode === "reset" ? "reset-password" : mode;
        const data = await request("auth/" + action, { method: "POST", body: JSON.stringify({ email: fields.get("email"), password, token }) });
        if (mode === "forgot") setMessage(data.message);
        else if (mode === "reset") { resetDone(); history.replaceState(null, "", "/"); setMode("login"); setMessage(data.message); }
        else await signedIn();
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>
      {mode !== "reset" && <label>Email<input name="email" type="email" required maxLength={254} autoComplete="username" /></label>}
      {mode !== "forgot" && <><label>{mode === "reset" ? "New password" : "Password"}<input name="password" type="password" required minLength={12} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {mode !== "login" && <label>Confirm password<input name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>}
        <p className="hint">Use at least 12 characters, up to 72 UTF-8 bytes.</p></>}
      {mode === "reset" && !token && <p className="error" role="alert">This link is missing its reset token. Request a new reset email.</p>}
      <button disabled={busy || (mode === "reset" && !token)}>{busy ? "Please wait…" : ({ login: "Sign in", register: "Create account", forgot: "Send reset link", reset: "Reset password" } as Record<string, string>)[mode]}</button>
      {mode === "login" && <><button type="button" className="secondary" disabled={busy} onClick={() => change("register")}>Create account</button><button type="button" className="textbutton" disabled={busy} onClick={() => change("forgot")}>Forgot password?</button></>}
      {mode !== "login" && <button type="button" className="secondary" disabled={busy} onClick={() => { history.replaceState(null, "", "/"); change("login"); }}>Back to sign in</button>}
      {mode === "reset" && <p className="hint">The link expires after 15 minutes and works once. Changing your password signs out all sessions and revokes integration credentials.</p>}
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
  </main>;
}
export function AccountSettings({ email, request, changed }: { email: string; request: Request; changed: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <section className="panel accountsettings"><h2>Your account</h2><p>Signed in as <strong>{email}</strong></p><h3>Change password</h3>
    <form onSubmit={async e => {
      e.preventDefault(); const f = new FormData(e.currentTarget);
      if (f.get("password") !== f.get("confirm")) { setError("Passwords do not match."); return; }
      setBusy(true); setError("");
      try { await request("auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: f.get("current"), password: f.get("password") }) }); changed(); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>
      <label>Current password<input name="current" type="password" required autoComplete="current-password" /></label>
      <label>New password<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
      <label>Confirm new password<input name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
      <p className="hint">Use at least 12 characters, up to 72 UTF-8 bytes. All sessions will be signed out and integration credentials revoked.</p>
      {error && <p className="error" role="alert">{error}</p>}<button disabled={busy}>{busy ? "Updating…" : "Update password"}</button>
    </form>
  </section>;
}
