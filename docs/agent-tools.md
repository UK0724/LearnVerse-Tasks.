# Agent architecture

The implemented REST integration routes and official-SDK MCP adapter are documented in [mcp.md](mcp.md), with versioned REST contracts in [openapi.json](openapi.json).

`server/domain.ts` owns hierarchy, status, ordering, sprint and task rules. `server/integrations.ts` owns credential authentication and permission checks and exports the atomic workspace command repository operation. The browser REST command route calls that same operation. Both REST integration routes and MCP callbacks use the same scoped credential verification, domain commands, workspace revision checks and retry receipts.

| Tool                                           | Purpose                                                      | Permission    |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------- |
| list_projects                                  | Read projects and workflow status IDs                        | projects:read |
| list_tasks / search_tasks                      | Paginated owned tasks and filters                            | tasks:read    |
| read_task                                      | Read a task by stable UUID                                   | tasks:read    |
| create_task / update_task                      | Create or edit task fields                                   | tasks:write   |
| move_task                                      | Move by status and stable neighboring IDs                    | tasks:write   |
| list_sprints                                   | Read sprints; task snapshots are redacted without tasks:read | sprints:read  |
| create_sprint / start_sprint / complete_sprint | Manage a sprint and carryover                                | sprints:write |

Write calls require the expected workspace revision and a unique retry key. Credentials are explicitly created by an authenticated owner, stored only as hashes, scoped to one workspace, expire, and can be revoked. Every call rechecks credential validity and permissions. Actor identity is preserved atomically in mutation activity, and sanitized access events are available in the owner's audit view.

MCP remains disabled by default; credential creation does not connect a client or enable external access. The server binds to loopback by default. Team roles, OAuth authorization, and externally hosted credential onboarding are future work. No tools expose arbitrary code or shell execution.
