# Validation results — 2026-10-07

Validation uses Windows, Node 24.21.0 and MongoDB 8.2.6 bound to loopback. Browser checks for the current follow-up use the Codex in-app browser.

| Local check | Result |
| --- | --- |
| TypeScript and Vite production build | Passed |
| Domain, API, MCP, rate limits, recovery, imports and email MIME | 18 tests passed |
| Packaged Lambda HTTP handler | Passed authentication, origin gate, owner isolation, retries, OpenAPI and MCP read/write/scopes/revocation |
| CloudFormation templates | Passed cfn-lint; only the documented optional-certificate W1030 is suppressed |
| Production dependency audit | Zero vulnerabilities |
| Credential scan and release ZIP | Passed; no environment secrets, private QA credentials or local database; embedded email PNG assets included |
| HTML recovery email preview | Desktop and 390 px mobile checked; both images loaded, no horizontal overflow |

Recovery tests cover non-enumerating responses, hashed reset tokens, cooldown, expiry, simultaneous one-time consumption, password validation, delivery-failure cleanup and immediate session/scoped-token invalidation. Import tests cover CSV quoting/multiline parsing, validation/size limits, duplicates including archived tasks, project isolation and atomic batch rejection. MIME tests verify the sender display name, plain-text alternative, HTML, safe links and embedded Content-ID images.

Local UI checks passed for the avatar Settings/Sign out menu, searchable project switcher, duplicate import preview and persistence, searchable compatible parents, direct task links after reload and the MCP setup guide. Mobile layout and menu placement were checked at 390 px without page overflow. The earlier card-drag checks covered dragging from the body, cursor preview outside the board, keyboard movement, Escape cancellation and saved order after reload.

The initial release ran six browser tests against each of its development and production builds. Those tests were updated for the new navigation and password-confirmation controls but were not rerun through a terminal browser for this follow-up, honoring the owner's Codex-browser-only requirement. Current visual results come from the manual Codex-browser checks above.

Live release records are saved under `output/` after each environment passes. Full protocol checks exercise health/database access, HTTPS/deep links, asset hashes/MIME, missing assets, secure sessions, anonymous rejection, owner isolation, mutation retries, hostile origins, sprint lifecycle/carryover, OpenAPI, MCP initialization and all 11 tools, scope enforcement, revocation, logout and direct Lambda rejection. Feature checks exercise bulk import duplicates/retries, atomic rejection, task links, Gmail SMTP acceptance, private recovery responses, invalid tokens, password change, session/token invalidation, rejected old passwords and fresh-login persistence.

The owner confirmed receipt of the earlier recovery email. SMTP acceptance is verified for new releases; the actual Gmail client rendering and inbox placement of the redesigned message are not inspected by the agent. Its HTML and multipart images are verified locally.

Live tests use isolated QA accounts and projects with random passwords held only in memory. These workspaces remain because account deletion is not implemented. Test sessions are logged out and tokens revoked; browser QA fixtures remain separately for UI verification. Existing user workspaces are never seeded or reset. Local integration databases are removed after tests.

Each account's workspace occupies one MongoDB document, bounded by MongoDB's 16 MB document limit and intended for small personal workspaces. See [release results](aws-release.md), [password recovery](password-reset.md) and the [AWS runbook](../infra/aws/README.md).

## Mobile layout follow-up

The frontend-only update passed TypeScript/Vite build and Codex-browser checks at 320 and 390 px. Empty onboarding has no sample option or irrelevant filters/zero summaries. Populated views have a collapsed filter panel, active-filter count/reset and full-width date input; very narrow screens use one filter column. Navigation uses a drawer with focus containment, Escape dismissal and focus restoration. Task forms use one column. Card bodies allow touch scrolling; the grip retains touch dragging, and desktop body dragging remains available.

Live dev and production verified exact new assets, MIME, HTTPS/deep links, missing assets, DB health, API/MCP anonymous rejection, no-store responses and no WAF. Production UI checks passed project/task creation, native date-filter changes, reset, status changes persisting after reload, task details, board scrolling and desktop layout. Both phone widths showed no page overflow; no console errors were captured. Screenshots and fixture details are recorded in `output/mobile-live-check.json` and [mobile notes](mobile-layout.md).

The backend, dependencies and CloudFormation resources are unchanged; the earlier 18 backend/domain/security/email tests remain the validation for that immutable API artifact. Updated browser tests are maintained but were not executed through a terminal browser. Native iPhone Safari was not controlled; these are responsive viewport checks in the Codex browser. Test account/project/task fixtures remain isolated, and their sessions are logged out after checks.
