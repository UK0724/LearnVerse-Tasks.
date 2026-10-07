import React, { useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  pointerWithin,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ReactMarkdown from "react-markdown";
import "./style.css";
import { Integrations } from "./integrations";
import { SearchPicker } from "./workspace-tools";
import { Authentication, AccountSettings } from "./account";
const BulkImport = lazy(() => import("./bulk-import"));
type Item = Record<string, any>;
function CardContent({
  task,
  handle,
  open,
}: {
  task: Item;
  handle?: React.ReactNode;
  open?: () => void;
}) {
  return (
    <>
      <div className="cardtop">
        <span>{task.key}</span>
        {handle ?? <span aria-hidden="true">⠿</span>}
      </div>
      {open ? (
        <button className="cardtitle" onClick={open}>
          {task.title}
        </button>
      ) : (
        <div className="cardtitle">{task.title}</div>
      )}
      <div className="cardbottom">
        <span className={"priority " + task.priority}>{task.priority}</span>
        <span>{task.type}</span>
      </div>
      {task.dueDate && <small>Due {task.dueDate}</small>}
    </>
  );
}
function calendarDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
async function api(path: string, options: RequestInit = {}) {
  const r = await fetch("/api/v1/" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await r.json().catch(() => {
    throw new Error("The service could not respond. Please try again.");
  });
  if (!r.ok) throw new Error(data.error?.message ?? "Request failed");
  return data;
}
function Card({
  task,
  open,
  disabled,
}: {
  task: Item;
  open: () => void;
  disabled: boolean;
}) {
  const d = useSortable({ id: task.id, disabled });
  return (
    <article
      ref={d.setNodeRef}
      style={{
        transform: CSS.Transform.toString(d.transform),
        transition: d.transition,
      }}
      className={
        "card" +
        (d.isDragging ? " dragging" : "") +
        (disabled ? "" : " draggable")
      }
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest(".handle")) return;
        // Touch users scroll from the card body and drag from its grip.
        if (event.pointerType === "touch") return;
        d.listeners?.onPointerDown?.(event);
      }}
    >
      <CardContent
        task={task}
        open={open}
        handle={
          <button
            ref={d.setActivatorNodeRef}
            className="handle"
            aria-label={"Reorder " + task.key}
            {...d.attributes}
            {...d.listeners}
            disabled={disabled}
          >
            ⠿
          </button>
        }
      />
    </article>
  );
}
function Column({
  status,
  children,
  count,
}: {
  status: Item;
  children: React.ReactNode;
  count: number;
}) {
  const d = useDroppable({ id: status.id });
  return (
    <section
      ref={d.setNodeRef}
      className={"column " + (d.isOver ? "over" : "")}
    >
      <h3>
        {status.name}
        <span>{count}</span>
      </h3>
      {children}
    </section>
  );
}
function App() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draggedTask, setDraggedTask] = useState<Item | null>(null);
  const [account, setAccount] = useState("");
  const [state, setState] = useState<Item | null>(null),
    [auth, setAuth] = useState(false),
    [booting, setBooting] = useState(true),
    [view, setView] = useState("overview"),
    [projectId, setProjectId] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [selected, setSelected] = useState<Item | null>(null),
    [modal, setModal] = useState(""),
    [q, setQ] = useState(""),
    [priority, setPriority] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [label, setLabel] = useState(""),
    [sprintFilter, setSprintFilter] = useState(""),
    [due, setDue] = useState(""),
    [sort, setSort] = useState("manual"),
    [projectFilter, setProjectFilter] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  async function load() {
    try {
      const s = await api("workspace");
      setState(s);
      setAuth(true);
      api("auth/me")
        .then((user) => setAccount(user.email))
        .catch(() => {});
      setProjectId((current) =>
        s.projects.some((p: Item) => p.id === current)
          ? current
          : (s.projects[0]?.id ?? ""),
      );
    } catch (e) {
      if ((e as Error).message === "Please sign in") {
        setAuth(false);
        setState(null);
      } else setError((e as Error).message);
    } finally {
      setBooting(false);
    }
  }
  useEffect(() => {
    load();
    const closeAccount = (event: Event) => {
      const menu = document.querySelector<HTMLDetailsElement>(".accountmenu");
      if (
        menu &&
        (event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !menu.contains(event.target as Node))
      )
        menu.open = false;
    };
    document.addEventListener("pointerdown", closeAccount);
    document.addEventListener("keydown", closeAccount);
    return () => {
      document.removeEventListener("pointerdown", closeAccount);
      document.removeEventListener("keydown", closeAccount);
    };
  }, []);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 650px)");
    const changed = () => {
      if (!mobile.matches) setNavigationOpen(false);
    };
    mobile.addEventListener("change", changed);
    return () => mobile.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!state || !auth) return;
    const openLink = () => {
      const match = /^\/tasks\/([0-9a-f-]{36})\/?$/i.exec(location.pathname);
      if (!match) {
        setSelected(null);
        return;
      }
      const task = state.tasks.find((t: Item) => t.id === match[1]);
      if (task) {
        setProjectId(task.projectId);
        setView(task.archived ? "archive" : "board");
        setSelected(task);
      } else setError("This task is unavailable in your workspace.");
    };
    openLink();
    window.addEventListener("popstate", openLink);
    return () => window.removeEventListener("popstate", openLink);
  }, [auth, state]);
  function openTask(task: Item) {
    history.pushState(null, "", `/tasks/${task.id}`);
    setSelected(task);
  }
  function closeTask() {
    if (location.pathname.startsWith("/tasks/"))
      history.replaceState(null, "", "/");
    setSelected(null);
  }
  const dialogOpen = !!modal || !!selected || navigationOpen;
  useEffect(() => {
    if (!dialogOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(
      navigationOpen ? "#workspace-navigation" : '[role="dialog"]',
    );
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
      ).filter((el) => el.offsetParent !== null);
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavigationOpen(false);
        setModal("");
        closeTask();
        event.preventDefault();
      }
      if (event.key === "Tab") {
        const elements = focusable(),
          first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          last?.focus();
          event.preventDefault();
        } else if (!event.shiftKey && document.activeElement === last) {
          first?.focus();
          event.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [dialogOpen, modal, navigationOpen]);

  async function mutate(action: string, data: Item, optimistic?: Item) {
    if (!state || saving) return;
    const previous = state;
    setSaving(true);
    setError("");
    if (optimistic) setState(optimistic);
    try {
      await api("commands/" + action, {
        method: "POST",
        headers: {
          "If-Match": `"${previous.revision}"`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(data),
      });
      await load();
      setMessage("Changes saved");
      return true;
    } catch (e) {
      setState(previous);
      setError((e as Error).message);
      await load();
      return false;
    } finally {
      setSaving(false);
    }
  }
  if (booting)
    return (
      <main className="login">
        <p role="status">Loading your workspace…</p>
      </main>
    );
  if (!auth || location.pathname === "/reset-password")
    return (
      <Authentication
        request={api}
        signedIn={load}
        resetDone={() => {
          setAuth(false);
          setState(null);
          setAccount("");
        }}
      />
    );
  if (!state) return <p>Loading workspace…</p>;
  const activeFilters = [
    priority,
    statusFilter,
    label,
    sprintFilter,
    due,
    sort !== "manual",
    view === "overview" && projectFilter,
  ].filter(Boolean).length;
  const resetFilters = () => {
    setPriority("");
    setStatusFilter("");
    setLabel("");
    setSprintFilter("");
    setDue("");
    setSort("manual");
    setProjectFilter("");
  };
  const project = state.projects.find((p: Item) => p.id === projectId),
    statuses = project?.statuses ?? [],
    tasks = state.tasks as Item[],
    sprints = state.sprints.filter((s: Item) => s.projectId === projectId),
    today = calendarDate(new Date()),
    week = calendarDate(new Date(Date.now() + 7 * 86400000));
  const filterProjects =
    view === "overview"
      ? state.projects.filter(
          (p: Item) => !projectFilter || p.id === projectFilter,
        )
      : project
        ? [project]
        : [];
  const filterStatuses = filterProjects.flatMap((p: Item) =>
    p.statuses.map((status: Item) => ({
      ...status,
      name:
        view === "overview" && !projectFilter
          ? `${p.prefix} · ${status.name}`
          : status.name,
    })),
  );
  const filterSprints = state.sprints.filter((s: Item) =>
    filterProjects.some((p: Item) => p.id === s.projectId),
  );
  let filtered = tasks.filter(
    (t) =>
      (view === "archive" ? t.archived : !t.archived) &&
      (view === "overview"
        ? !projectFilter || t.projectId === projectFilter
        : t.projectId === projectId) &&
      (!q ||
        [t.title, t.description, t.key]
          .join(" ")
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (!priority || t.priority === priority) &&
      (!statusFilter || t.statusId === statusFilter) &&
      (!label || t.labels.includes(label)) &&
      (!sprintFilter ||
        (sprintFilter === "none"
          ? !t.sprintId
          : t.sprintId === sprintFilter)) &&
      (!due || (t.dueDate && t.dueDate <= due)),
  );
  if (sort === "priority")
    filtered = filtered.toSorted(
      (a, b) =>
        ["urgent", "high", "medium", "low"].indexOf(a.priority) -
        ["urgent", "high", "medium", "low"].indexOf(b.priority),
    );
  if (sort === "due")
    filtered = filtered.toSorted((a, b) =>
      (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
    );
  const isDone = (t: Item) =>
    state.projects
      .find((p: Item) => p.id === t.projectId)
      ?.statuses.find((s: Item) => s.id === t.statusId)?.category === "done";
  const list = (items: Item[]) =>
    items.length ? (
      <div className="tasklist">
        {items.map((t) => (
          <button key={t.id} onClick={() => openTask(t)}>
            <span className="key">{t.key}</span>
            <strong>{t.title}</strong>
            <span className={"priority " + t.priority}>{t.priority}</span>
            <span>{t.dueDate ?? "No due date"}</span>
          </button>
        ))}
      </div>
    ) : (
      <p className="empty">Nothing here yet.</p>
    );
  async function move(
    task: Item,
    statusId: string,
    beforeId: string | null = null,
    afterId: string | null = null,
  ) {
    const copy = structuredClone(state!);
    const t = copy.tasks.find((x: Item) => x.id === task.id);
    t.statusId = statusId;
    copy.tasks = copy.tasks.filter((x: Item) => x.id !== t.id);
    const index = beforeId
      ? copy.tasks.findIndex((x: Item) => x.id === beforeId)
      : afterId
        ? copy.tasks.findIndex((x: Item) => x.id === afterId) + 1
        : copy.tasks.length;
    copy.tasks.splice(index, 0, t);
    await mutate(
      "task.move",
      { id: task.id, statusId, beforeId, afterId },
      copy,
    );
  }
  return (
    <div className="shell">
      {navigationOpen && (
        <button
          className="navigationbackdrop"
          aria-label="Dismiss navigation"
          tabIndex={-1}
          onClick={() => setNavigationOpen(false)}
        />
      )}
      <aside
        id="workspace-navigation"
        className={navigationOpen ? "navigation-open" : ""}
        aria-label="Workspace navigation"
      >
        <button
          className="navigationclose secondary"
          aria-label="Close navigation"
          onClick={() => setNavigationOpen(false)}
        >
          ×
        </button>
        <a className="brand" href="#">
          L{" "}
          <span>
            LearnVerse<small>TASKS</small>
          </span>
        </a>
        <nav aria-label="Workspace views">
          {[
            ["overview", "◈", "Overview"],
            ["board", "▦", "Board"],
            ["backlog", "☷", "Backlog"],
            ["sprints", "◷", "Sprints"],
            ["archive", "▣", "Archive"],
            ["activity", "↺", "Activity"],
            ["integrations", "⚙", "Integrations"],
          ].map(([key, icon, name]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => {
                setNavigationOpen(false);
                setView(key);
                setStatusFilter("");
                setSprintFilter("");
              }}
            >
              {icon} {name}
            </button>
          ))}
        </nav>
        <div className="projectnav">
          <small>PROJECT</small>
          <button
            className="chosen"
            onClick={() => {
              setNavigationOpen(false);
              setModal("projects");
            }}
          >
            <span>{project?.prefix.slice(0, 2) ?? "◈"}</span>
            {project?.name ?? "Choose a project"}
            <b aria-hidden="true">⌄</b>
          </button>
          <button
            onClick={() => {
              setNavigationOpen(false);
              setModal("project");
            }}
          >
            ＋ New project
          </button>
        </div>
      </aside>
      <main inert={navigationOpen || undefined}>
        <header>
          <div className="workspacecontext">
            <button
              className="navigationtoggle secondary"
              aria-label="Open navigation"
              aria-expanded={navigationOpen}
              aria-controls="workspace-navigation"
              onClick={() => setNavigationOpen(true)}
            >
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="mobilebrand">
              <b>L</b> Tasks
            </span>
            <span className="breadcrumb">
              Workspace /{" "}
              {view === "overview"
                ? "Your focus"
                : (project?.name ?? "Choose a project")}
            </span>
          </div>
          <div className="headeraccount">
            <span
              role="status"
              className={
                saving || message ? "savestatus hasactivity" : "savestatus"
              }
            >
              {saving ? "Saving…" : message || "Private workspace"}
            </span>
            <details className="accountmenu">
              <summary aria-label="Account menu" className="avatar">
                {account.slice(0, 1).toUpperCase() || "U"}
              </summary>
              <div className="accountdropdown">
                <strong>{account || "Your account"}</strong>
                <button
                  className="secondary"
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    setView("settings");
                  }}
                >
                  Settings
                </button>
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await api("auth/logout", { method: "POST" });
                      setAuth(false);
                      setState(null);
                      closeTask();
                      setAccount("");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Sign out
                </button>
              </div>
            </details>
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        <div className="pagetitle">
          <div>
            <small>LEARNVERSE TASKS</small>
            <h1>
              {view === "overview"
                ? "Overview"
                : view === "board"
                  ? (project?.name ?? "Project board")
                  : view.charAt(0).toUpperCase() + view.slice(1)}
            </h1>
            <p>
              {view === "overview"
                ? "Your projects and next steps."
                : "Plan thoughtfully. Keep moving."}
            </p>
          </div>
          <div className="actions">
            {project && ["board", "backlog"].includes(view) && (
              <button
                className="secondary"
                disabled={project.archived || saving}
                onClick={() => setModal("import")}
              >
                Import tasks
              </button>
            )}
            {project &&
              !["settings", "integrations"].includes(view) &&
              (view !== "overview" || !!state.tasks.length) && (
                <button
                  onClick={() => setModal("task")}
                  disabled={project.archived}
                >
                  ＋ Create task
                </button>
              )}
            {project && view === "board" && (
              <button
                className="secondary"
                disabled={saving}
                onClick={() =>
                  mutate("project.archive", {
                    id: projectId,
                    archived: !project.archived,
                  })
                }
              >
                {project.archived ? "Restore project" : "Archive project"}
              </button>
            )}
            {project && view === "board" && (
              <button
                className="secondary"
                onClick={() => setModal("statuses")}
              >
                Workflow
              </button>
            )}
          </div>
        </div>
        {!state.projects.length &&
          !["settings", "integrations"].includes(view) && (
            <section className="welcome">
              <div className="welcomeicon" aria-hidden="true">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <path d="M12 11v6M9 14h6" />
                </svg>
              </div>
              <h2>Create your first project</h2>
              <p>
                Bring your tasks, priorities and sprints together in one place.
              </p>
              <button onClick={() => setModal("project")}>
                Create project
              </button>
              <small>Private to your account.</small>
            </section>
          )}
        {!!state.tasks.length &&
          ["overview", "board", "backlog", "archive"].includes(view) && (
            <div className="filters">
              <div className="filtersearch">
                <input
                  aria-label="Search tasks"
                  placeholder="Search tasks…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <button
                  className="filtertoggle secondary"
                  aria-expanded={filtersOpen}
                  aria-controls="task-filter-controls"
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  Filters{activeFilters > 0 && <span>{activeFilters}</span>}
                  <span aria-hidden="true">{filtersOpen ? "⌃" : "⌄"}</span>
                </button>
                {activeFilters > 0 && (
                  <button className="filterreset" onClick={resetFilters}>
                    Reset filters
                  </button>
                )}
              </div>
              <div
                id="task-filter-controls"
                className={"filtercontrols" + (filtersOpen ? " expanded" : "")}
              >
                <select
                  aria-label="Project filter"
                  value={view === "overview" ? projectFilter : projectId}
                  onChange={(e) => {
                    if (view === "overview") setProjectFilter(e.target.value);
                    else setProjectId(e.target.value);
                    setStatusFilter("");
                    setSprintFilter("");
                  }}
                >
                  {view === "overview" && (
                    <option value="">All projects</option>
                  )}
                  {state.projects.map((p: Item) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Priority filter"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option value="">All priorities</option>
                  {["urgent", "high", "medium", "low"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <select
                  aria-label="Status filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {filterStatuses.map((s: Item) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Label filter"
                  placeholder="Label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <select
                  aria-label="Sprint filter"
                  value={sprintFilter}
                  onChange={(e) => setSprintFilter(e.target.value)}
                >
                  <option value="">All sprints</option>
                  <option value="none">Unscheduled</option>
                  {filterSprints.map((s: Item) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="manual">Manual order</option>
                  <option value="priority">Priority</option>
                  <option value="due">Due date</option>
                </select>
                <label className="datefilter">
                  Due before
                  <input
                    aria-label="Due before"
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                </label>
              </div>
            </div>
          )}
        {view === "overview" && project && !state.tasks.length && (
          <section className="welcome">
            <div className="welcomeicon" aria-hidden="true">
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M8 6h13M8 12h13M8 18h13M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" />
              </svg>
            </div>
            <h2>Add your first task</h2>
            <p>Turn your next step into a task in {project.name}.</p>
            <button onClick={() => setModal("task")}>Create task</button>
          </section>
        )}
        {view === "overview" && !!state.tasks.length && (
          <>
            <div className="stats">
              {[
                [
                  "Active projects",
                  state.projects.filter((p: Item) => !p.archived).length,
                ],
                [
                  "High priority",
                  filtered.filter(
                    (t) =>
                      ["high", "urgent"].includes(t.priority) && !isDone(t),
                  ).length,
                ],
                [
                  "Overdue",
                  filtered.filter(
                    (t) => t.dueDate && t.dueDate < today && !isDone(t),
                  ).length,
                ],
                ["Completed", filtered.filter(isDone).length],
              ].map(([name, n]) => (
                <section key={name}>
                  <small>{name}</small>
                  <strong>{n}</strong>
                </section>
              ))}
            </div>
            <div className="overviewgrid">
              <section className="panel">
                <h2>Needs your attention</h2>
                <p className="hint">
                  High/urgent priority or overdue; completed tasks excluded.
                </p>
                {list(
                  filtered.filter(
                    (t) =>
                      !isDone(t) &&
                      (["high", "urgent"].includes(t.priority) ||
                        (t.dueDate && t.dueDate < today)),
                  ),
                )}
              </section>
              <section className="panel">
                <h2>Active sprints</h2>
                {!state.sprints.some((s: Item) => s.state === "active") && (
                  <p className="empty">
                    No active sprints. Plan one from Sprints.
                  </p>
                )}
                {state.sprints
                  .filter((s: Item) => s.state === "active")
                  .map((s: Item) => {
                    const all = tasks.filter(
                        (t) => t.sprintId === s.id && !t.archived,
                      ),
                      done = all.filter(isDone).length;
                    return (
                      <div className="sprintsummary" key={s.id}>
                        <strong>{s.name}</strong>
                        <p>
                          {done} / {all.length} complete
                        </p>
                        <progress value={done} max={all.length || 1} />
                      </div>
                    );
                  })}
              </section>
              <section className="panel">
                <h2>Coming up this week</h2>
                {list(
                  filtered.filter(
                    (t) =>
                      t.dueDate &&
                      t.dueDate >= today &&
                      t.dueDate <= week &&
                      !isDone(t),
                  ),
                )}
              </section>
              <section className="panel">
                <h2>Unscheduled backlog</h2>
                {list(filtered.filter((t) => !t.sprintId && !isDone(t)))}
              </section>
              <section className="panel">
                <h2>Recently completed</h2>
                {list(
                  filtered
                    .filter(isDone)
                    .toSorted((a, b) =>
                      (b.completedAt ?? b.updatedAt).localeCompare(
                        a.completedAt ?? a.updatedAt,
                      ),
                    )
                    .slice(0, 10),
                )}
              </section>
            </div>
          </>
        )}
        {view === "board" && project && (
          <>
            <p className="hint boardhint">
              <span className="desktopdraghint">
                Drag a card or focus its grip and press Space, arrow keys, then
                Space. Task details also offer “Move to status”.
              </span>
              <span className="mobiledraghint">
                Swipe to browse columns. Use a card’s grip to drag, or tap it to
                change status.
              </span>{" "}
              {sort !== "manual" && "Reordering disabled for this sort."}
            </p>
            <DndContext
              sensors={sensors}
              collisionDetection={(args) => {
                // Prefer the card under the pointer over its enclosing column.
                if (args.pointerCoordinates) {
                  const hits = pointerWithin(args);
                  const cards = hits.filter((hit) =>
                    tasks.some((task) => task.id === hit.id),
                  );
                  return cards.length ? cards : hits;
                }
                return closestCorners(args);
              }}
              onDragStart={({ active }) =>
                setDraggedTask(tasks.find((t) => t.id === active.id) ?? null)
              }
              onDragCancel={() => setDraggedTask(null)}
              accessibility={{
                announcements: {
                  onDragStart: ({ active }) =>
                    `Picked up ${tasks.find((t) => t.id === active.id)?.key ?? "task"}. Use arrow keys to move, Space to drop, Escape to cancel.`,
                  onDragOver: ({ over }) =>
                    over
                      ? `Move to ${tasks.find((t) => t.id === over.id)?.title ?? statuses.find((status: Item) => status.id === over.id)?.name ?? "position"}.`
                      : undefined,
                  onDragEnd: ({ active, over }) =>
                    over
                      ? `Dropped ${tasks.find((t) => t.id === active.id)?.key ?? "task"}. Saving changes.`
                      : "Move cancelled.",
                  onDragCancel: () => "Move cancelled.",
                },
              }}
              onDragEnd={(e) => {
                setDraggedTask(null);
                if (!e.over || sort !== "manual") return;
                const t = tasks.find((x) => x.id === e.active.id),
                  target = tasks.find((x) => x.id === e.over!.id),
                  statusId = target?.statusId ?? String(e.over.id);
                if (!t || t.id === target?.id) return;
                const peers = filtered.filter(
                  (x) => x.statusId === statusId && x.id !== t.id,
                );
                if (target) {
                  const index = peers.findIndex((x) => x.id === target.id);
                  const down =
                    t.statusId === statusId &&
                    filtered.indexOf(t) < filtered.indexOf(target);
                  if (down)
                    move(t, statusId, peers[index + 1]?.id ?? null, target.id);
                  else
                    move(
                      t,
                      statusId,
                      target.id,
                      index > 0 ? peers[index - 1].id : null,
                    );
                } else move(t, statusId, null, peers.at(-1)?.id ?? null);
              }}
            >
              <div className="board">
                {statuses.map((s: Item) => {
                  const items = filtered.filter((t) => t.statusId === s.id);
                  return (
                    <Column key={s.id} status={s} count={items.length}>
                      <SortableContext
                        items={items.map((t) => t.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {items.map((t) => (
                          <Card
                            key={t.id}
                            task={t}
                            open={() => openTask(t)}
                            disabled={saving || sort !== "manual"}
                          />
                        ))}
                      </SortableContext>
                      {!items.length && <p className="empty">Drop work here</p>}
                    </Column>
                  );
                })}
              </div>
              {createPortal(
                <DragOverlay dropAnimation={null} zIndex={1000}>
                  {draggedTask && (
                    <article className="card drag-preview" aria-hidden="true">
                      <CardContent task={draggedTask} />
                    </article>
                  )}
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
          </>
        )}
        {["backlog", "archive"].includes(view) && list(filtered)}
        {view === "sprints" && project && (
          <>
            <button onClick={() => setModal("sprint")}>＋ Plan sprint</button>
            {!sprints.length && (
              <p className="empty">No sprints yet. Plan your first sprint.</p>
            )}
            {sprints.map((s: Item) => {
              const items = tasks.filter(
                (t) => t.sprintId === s.id && !t.archived,
              );
              return (
                <section className="panel sprint" key={s.id}>
                  <div className="pagetitle">
                    <div>
                      <h2>
                        {s.name} <span className="badge">{s.state}</span>
                      </h2>
                      <p>{s.goal}</p>
                      <small>
                        {s.startDate} → {s.endDate}
                      </small>
                    </div>
                    {s.state === "planned" && (
                      <button
                        disabled={saving}
                        onClick={() => mutate("sprint.start", { id: s.id })}
                      >
                        Start sprint
                      </button>
                    )}
                    {s.state === "active" && (
                      <button
                        onClick={() => {
                          setSelected(s);
                          setModal("complete");
                        }}
                      >
                        Complete sprint
                      </button>
                    )}
                  </div>
                  {s.state === "completed" ? (
                    <>
                      <h3>Finished · {s.snapshot.finished.length}</h3>
                      {list(s.snapshot.finished)}
                      <h3>Unfinished · {s.snapshot.unfinished.length}</h3>
                      {list(s.snapshot.unfinished)}
                      <p className="hint">
                        Immutable completion snapshot · {s.snapshot.completedAt}
                      </p>
                    </>
                  ) : (
                    list(items)
                  )}
                </section>
              );
            })}
          </>
        )}
        {view === "integrations" && <Integrations />}
        {view === "settings" && (
          <AccountSettings
            email={account}
            request={api}
            changed={() => {
              setAuth(false);
              setState(null);
              setAccount("");
              setView("overview");
              setMessage("Password updated. Sign in again.");
              closeTask();
            }}
          />
        )}
        {view === "activity" && (
          <section className="panel">
            <h2>Workspace history</h2>
            {!state.activity.length && (
              <p className="empty">
                Your project and task changes will appear here.
              </p>
            )}
            {state.activity.toReversed().map((a: Item) => (
              <div className="activity" key={a.id}>
                <span>{a.message}</span>
                <time>{new Date(a.at).toLocaleString()}</time>
              </div>
            ))}
          </section>
        )}
        {selected && !modal && (
          <div className="overlay" onClick={closeTask}>
            <section
              className="drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Task details"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="close"
                onClick={closeTask}
                aria-label="Close details"
              >
                ×
              </button>
              <small>{selected.key}</small>
              <h2>{selected.title}</h2>
              <button
                className="secondary"
                onClick={async () => {
                  const url = new URL(`/tasks/${selected.id}`, location.origin)
                    .href;
                  try {
                    await navigator.clipboard.writeText(url);
                    setMessage("Task link copied");
                  } catch {
                    setMessage("Copy the task link from your address bar");
                  }
                }}
              >
                Copy task link
              </button>
              <ReactMarkdown>
                {selected.description || "No description yet."}
              </ReactMarkdown>
              <TaskForm
                key={selected.id}
                task={tasks.find((t) => t.id === selected.id) ?? selected}
                project={state.projects.find(
                  (p: Item) => p.id === selected.projectId,
                )}
                tasks={tasks}
                sprints={state.sprints}
                saving={saving}
                submit={async (data) => {
                  if (await mutate("task.update", { ...data, id: selected.id }))
                    closeTask();
                }}
              />
              <label>
                Move to status
                <select
                  value={
                    (tasks.find((t) => t.id === selected.id) ?? selected)
                      .statusId
                  }
                  disabled={saving}
                  onChange={(e) => move(selected, e.target.value)}
                >
                  {state.projects
                    .find((p: Item) => p.id === selected.projectId)
                    .statuses.map((s: Item) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="secondary"
                disabled={saving}
                onClick={async () => {
                  if (
                    await mutate("task.update", {
                      id: selected.id,
                      archived: !selected.archived,
                    })
                  )
                    closeTask();
                }}
              >
                {selected.archived ? "Restore task" : "Archive task"}
              </button>
              <p className="hint">Archiving preserves all child tasks.</p>
            </section>
          </div>
        )}
        {modal && (
          <div className="overlay">
            <section
              className="dialog"
              role="dialog"
              aria-modal="true"
              aria-label={modal}
            >
              <button
                className="close"
                onClick={() => {
                  setModal("");
                  setSelected(null);
                }}
                aria-label="Close dialog"
              >
                ×
              </button>
              <h2>
                {
                  (
                    {
                      project: "Create project",
                      task: "Create task",
                      sprint: "Plan sprint",
                      complete: "Complete sprint",
                      statuses: "Edit workflow",
                      projects: "Switch project",
                      import: "Import tasks",
                    } as Item
                  )[modal]
                }
              </h2>
              {modal === "projects" && (
                <SearchPicker
                  label="Project"
                  allowNone={false}
                  items={state.projects.map((p: Item) => ({
                    id: p.id,
                    name: `${p.name}${p.archived ? " (archived)" : ""}`,
                  }))}
                  value={projectId}
                  onChange={(id) => {
                    closeTask();
                    setProjectId(id);
                    setView("board");
                    setStatusFilter("");
                    setSprintFilter("");
                    setModal("");
                  }}
                />
              )}
              {modal === "import" && project && (
                <Suspense fallback={<p role="status">Loading import…</p>}>
                  <BulkImport
                    project={project}
                    tasks={tasks}
                    saving={saving}
                    submit={async (rows) => {
                      const ok = await mutate("task.import", {
                        projectId,
                        rows,
                      });
                      if (ok) setModal("");
                      return ok;
                    }}
                  />
                </Suspense>
              )}
              {modal === "task" && (
                <TaskForm
                  project={project}
                  tasks={tasks}
                  sprints={sprints}
                  saving={saving}
                  submit={async (data) => {
                    if (await mutate("task.create", { ...data, projectId }))
                      setModal("");
                  }}
                />
              )}
              {modal === "project" && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    if (await mutate("project.create", Object.fromEntries(f)))
                      setModal("");
                  }}
                >
                  <label>
                    Project name
                    <input name="name" required maxLength={200} />
                  </label>
                  <label>
                    Key prefix
                    <input
                      name="prefix"
                      required
                      pattern="[A-Z][A-Z0-9]{1,9}"
                      placeholder="LV"
                    />
                  </label>
                  <button disabled={saving}>Create project</button>
                </form>
              )}
              {modal === "sprint" && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = Object.fromEntries(new FormData(e.currentTarget));
                    if (await mutate("sprint.create", { ...f, projectId }))
                      setModal("");
                  }}
                >
                  <label>
                    Name
                    <input name="name" required />
                  </label>
                  <label>
                    Goal
                    <textarea name="goal" />
                  </label>
                  <label>
                    Start date
                    <input type="date" name="startDate" required />
                  </label>
                  <label>
                    End date
                    <input type="date" name="endDate" required />
                  </label>
                  <button disabled={saving}>Plan sprint</button>
                </form>
              )}
              {modal === "complete" && selected && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const target = new FormData(e.currentTarget).get("target");
                    if (
                      await mutate("sprint.complete", {
                        id: selected.id,
                        targetSprintId: target || null,
                      })
                    ) {
                      setModal("");
                      setSelected(null);
                    }
                  }}
                >
                  <h3>Finished</h3>
                  {list(
                    tasks.filter(
                      (t) => t.sprintId === selected.id && isDone(t),
                    ),
                  )}
                  <h3>Unfinished</h3>
                  {list(
                    tasks.filter(
                      (t) => t.sprintId === selected.id && !isDone(t),
                    ),
                  )}
                  <label>
                    Move unfinished work to
                    <select name="target">
                      <option value="">Backlog (no sprint)</option>
                      {sprints
                        .filter((s: Item) => s.state === "planned")
                        .map((s: Item) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="hint">
                    Subtasks move with their parent. Finished parents require
                    all subtasks to be finished.
                  </p>
                  <button disabled={saving}>Complete and save snapshot</button>
                </form>
              )}
              {modal === "statuses" && (
                <Workflow
                  project={project}
                  saving={saving}
                  submit={async (data) => {
                    if (await mutate("status.save", data)) setModal("");
                  }}
                />
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
function TaskForm({
  task,
  project,
  tasks,
  sprints,
  saving,
  submit,
}: {
  task?: Item;
  project: Item;
  tasks: Item[];
  sprints: Item[];
  saving: boolean;
  submit: (d: Item) => void;
}) {
  const [type, setType] = useState(task?.type ?? "task");
  const [parentId, setParentId] = useState(task?.parentId ?? "");
  return (
    <form
      key={task?.id ?? "new"}
      onSubmit={(e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.currentTarget));
        submit({
          ...f,
          labels: String(f.labels)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          parentId: f.parentId || null,
          sprintId: f.sprintId || null,
          dueDate: f.dueDate || null,
          estimate: f.estimate === "" ? null : Number(f.estimate),
        });
      }}
    >
      <label>
        Title
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={task?.title}
        />
      </label>
      <label>
        Description (Markdown)
        <textarea
          name="description"
          rows={4}
          defaultValue={task?.description}
        />
      </label>
      <div className="formgrid">
        <label>
          Type
          <select
            name="type"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setParentId("");
            }}
          >
            {["epic", "task", "bug", "subtask"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select name="priority" defaultValue={task?.priority ?? "medium"}>
            {["low", "medium", "high", "urgent"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select name="statusId" defaultValue={task?.statusId}>
            {project.statuses.map((s: Item) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <SearchPicker
            label="Parent task"
            value={parentId}
            onChange={setParentId}
            items={tasks
              .filter(
                (t) =>
                  t.projectId === project.id &&
                  t.id !== task?.id &&
                  (!t.archived || t.id === task?.parentId) &&
                  (type === "subtask"
                    ? ["task", "bug"].includes(t.type)
                    : ["task", "bug"].includes(type)
                      ? t.type === "epic"
                      : false),
              )
              .map((t) => ({
                id: t.id,
                name: `${t.key} · ${t.title}${t.archived ? " (archived)" : ""}`,
              }))}
          />
          <input type="hidden" name="parentId" value={parentId} />
        </div>
        <label>
          Sprint
          <select name="sprintId" defaultValue={task?.sprintId ?? ""}>
            <option value="">Unscheduled</option>
            {sprints
              .filter(
                (s) => s.projectId === project.id && s.state !== "completed",
              )
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Due date
          <input
            name="dueDate"
            type="date"
            defaultValue={task?.dueDate ?? ""}
          />
        </label>
        <label>
          Estimate
          <input
            name="estimate"
            type="number"
            min="0"
            max="10000"
            step="0.5"
            defaultValue={task?.estimate ?? ""}
          />
        </label>
        <label>
          Labels (comma separated)
          <input name="labels" defaultValue={task?.labels.join(", ")} />
        </label>
      </div>
      <p className="hint">Subtasks inherit their parent’s sprint.</p>
      <button disabled={saving}>Save task</button>
    </form>
  );
}
function Workflow({
  project,
  saving,
  submit,
}: {
  project: Item;
  saving: boolean;
  submit: (d: Item) => void;
}) {
  const [rows, setRows] = useState<Item[]>(structuredClone(project.statuses)),
    [replacements, setReplacements] = useState<Item>({});
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit({ projectId: project.id, statuses: rows, replacements });
      }}
    >
      {rows.map((s, i) => (
        <div className="workflowrow" key={s.id}>
          <input
            aria-label="Status name"
            required
            value={s.name}
            onChange={(e) =>
              setRows(
                rows.map((x) =>
                  x.id === s.id ? { ...x, name: e.target.value } : x,
                ),
              )
            }
          />
          <select
            aria-label="Category"
            value={s.category}
            onChange={(e) =>
              setRows(
                rows.map((x) =>
                  x.id === s.id ? { ...x, category: e.target.value } : x,
                ),
              )
            }
          >
            {["todo", "progress", "done"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={!i}
            onClick={() => {
              const next = [...rows];
              [next[i - 1], next[i]] = [next[i], next[i - 1]];
              setRows(next);
            }}
            aria-label="Move status up"
          >
            ↑
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setRows(rows.filter((x) => x.id !== s.id))}
          >
            Remove
          </button>
        </div>
      ))}
      {project.statuses
        .filter((s: Item) => !rows.some((x) => x.id === s.id))
        .map((s: Item) => (
          <label key={s.id}>
            Replacement for {s.name}
            <select
              required
              value={replacements[s.id] ?? ""}
              onChange={(e) =>
                setReplacements({ ...replacements, [s.id]: e.target.value })
              }
            >
              <option value="">Choose replacement</option>
              {rows.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          setRows([
            ...rows,
            { id: crypto.randomUUID(), name: "New status", category: "todo" },
          ])
        }
      >
        Add status
      </button>
      <button disabled={saving || !rows.length}>Save workflow</button>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
