# LearnVerse Tasks

A private project workspace built with React, TypeScript, Express, and MongoDB. No paid services or API keys are needed. Each account has a separate workspace; team invitations are deferred, and the optional MCP adapter uses explicit scoped credentials.

## Local startup

Requirements: Node.js 24, npm, and Docker with Compose (or an existing MongoDB 7+ server).

```sh
cd /workspace/LearnVerse-Tasks.
npm ci
npm run db
cp .env.example .env
npm run dev
```

Open port 3000 in your local browser. Register an owner account with a password of at least 12 characters and at most 72 UTF-8 bytes. Create a project, or load optional fictional samples in an empty workspace. Development serves React through Vite middleware on the same origin as the API. If running elsewhere, use the actual checkout directory.

MongoDB binds only to loopback and stores its data in the named Docker volume `learnverse_mongodb_data`. `npm run db:stop` stops it without deleting data. `npm run db` starts it again. Never remove the volume unless you intend to delete your database. For an existing MongoDB server, skip Docker and set `MONGODB_URI` in `.env`; keep credentials server-side. The `.env.example` contains no credentials.

```sh
npm run build
NODE_ENV=production npm start
```

Production serves the built `dist` directory, including SPA navigation without turning missing assets into HTML. The server binds to `127.0.0.1` by default. Frontend, API, and MCP are deployed and verified in [production](https://tasks.abuk.in) and [dev](https://d38hszs898xc3y.cloudfront.net). Each uses its own Atlas Free database and pay-as-you-go CloudFront distribution without WAF. See [release results](docs/aws-release.md) and [the AWS runbook](infra/aws/README.md).

## Account and navigation

Use the top avatar for **Settings** and **Sign out**. Projects use a searchable switcher, keeping navigation compact. **Forgot password?** emails a single-use, 15-minute reset link. Resetting or changing a password signs out existing sessions and revokes integration credentials; see [password recovery setup](docs/password-reset.md).

Task details have **Copy task link** and a stable `/tasks/{id}` address. Links reopen the task after sign-in only in the owning account. Parent selection searches by title or key and offers only compatible hierarchy types. **Import tasks** accepts CSV or JSON with a preview, 100-row/200 KB limits, and duplicate-title skipping within the selected project, including archived tasks. Imports use the same atomic revision and retry protection as other commands; a rule violation rejects the whole batch.

## Workflow

- Projects have readable, incrementing keys, configurable ordered statuses and categories, a board, and a prioritized backlog. “Backlog” is a list of all project work; filter Sprint → Unscheduled for unplanned work.
- Task descriptions accept Markdown and render without raw HTML. Tasks support epics, tasks, bugs, subtasks, priorities, labels, estimates, due dates, archive and restore.
- Epic → Task/Bug → Subtask is enforced within one project. Subtasks require a parent and inherit its sprint. Parent sprint changes cascade to subtasks. Archiving a parent preserves children; a child with an already archived parent can still be edited.
- Drag a card body or grip between columns or to a neighboring card. Focus a grip and use Space, arrows, Space for keyboard dragging. The task detail drawer also has a Move to status selector. A stable before/after anchor identifies order; hidden cards retain their relative order. Priority/due-date sorts disable manual drag ordering.
- Workflow editing adds, renames, reorders, and removes statuses. Removed populated statuses require replacement, including for archived tasks.
- Only one sprint can be active per project. Completion previews finished and unfinished work. Carryover goes to the backlog or a planned sprint. Subtasks follow an unfinished parent, including finished subtasks; a finished parent cannot complete with unfinished subtasks. Completion snapshots preserve task data even after later edits.
- The overview uses explicit rules: urgent/high priority and overdue unfinished work, upcoming seven-day due dates, unscheduled work, active sprint progress, and recently completed work. No AI prioritization.
- Project/task archiving is reversible. Activity is chronological and records mutation type, resource, and time; detailed field-level diffs are not yet recorded.

## API and architecture

The versioned API is described in [docs/openapi.json](docs/openapi.json). The authenticated `GET /api/v1/workspace` returns the complete workspace and revision; `GET /api/v1/tasks` offers pagination and filters. Mutation endpoints use `POST /api/v1/commands/{action}` with `If-Match: "revision"` and a unique `Idempotency-Key`. Reusing an identical key returns its saved response; changing its payload returns 409. A stale revision returns 409 without writing. Reload before applying an intentional new edit.

`server/domain.ts` contains business logic independent of HTTP and database access. `server/app.ts` owns sessions, request validation, ownership, and atomic MongoDB compare-and-swap. MongoDB stores each owner's workspace as one document, making task order, sprint changes, snapshots, activity and retry receipts atomic without requiring a replica set. This deliberately favors a small single-owner workspace: MongoDB's 16 MB document limit bounds workspace size. Large workspaces need normalized documents, transactions, and activity/receipt retention policies. Do not use this implementation for large enterprise datasets.

Passwords are hashed with bcrypt; sessions are random tokens stored as SHA-256 hashes, persisted server-side with seven-day expiry, and sent in HttpOnly, SameSite=Strict cookies. Origin checks protect browser mutations. Auth requests are rate-limited. Every workspace, search, nested reference, and command derives ownership from the session. Validation and safe errors never return database credentials. Team invitations and shell execution APIs are not included. Integration credentials require explicit creation in the setup interface.

The optional MCP adapter and scoped REST integration API share permission checks, revocation, version checks, and an access audit. See [docs/mcp.md](docs/mcp.md). The MCP transport is disabled by default. In Integrations, explicitly create a credential with selected permissions and expiry; copy its secret once and revoke it at any time. No credentials or external connections are created automatically.

## Tests

```sh
npm run db
npm test
npm run build
# Playwright starts the app automatically if it is not already running:
npm run test:e2e
npm run test:lambda
```

Browser tests use Playwright Chromium by default. Install it with `npx playwright install chromium`, or set `CHROMIUM_PATH` to an existing Chromium executable. Browser download hosts may require network permission. API and Lambda tests use unique temporary databases and delete only those databases. Browser tests create fictional accounts in the configured local app database. Run live browser tests only with explicit disposable-account planning. `TEST_BASE_URL` targets an already-running deployment and disables local server startup.

`npm run test:unit` needs no MongoDB. Node 24's `--test-isolation=none` is intentional: it ensures TypeScript test registrations execute under this environment's loader rather than reporting only a file-level test. See [docs/validation.md](docs/validation.md) for actual results.

## Deferred features and limits

Chat, attachments, notifications, real-time collaboration, team roles, password recovery, bulk task operations, and analytics are deferred. The API provides paginated task reads, while the browser fetches the complete small workspace for boards. The drawer preserves board context, traps keyboard focus, and closes with Escape. Dates use ISO calendar dates; estimates are numeric units chosen by the owner. Sessions expire rather than using background refresh. No Git or GitHub operations were used to build this application.
