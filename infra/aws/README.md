# LearnVerse Tasks AWS deployment

Status on 2026-10-07: frontend, API, and MCP are deployed and verified in dev and prod. Both stacks are `UPDATE_COMPLETE`, with separate Atlas Free clusters and encrypted Standard SSM connections. Both CloudFront distributions are verified as pay-as-you-go with WAF disabled. See [release results](../../docs/aws-release.md). The owner deferred database password rotation. Source templates here are the infrastructure source of truth.

## Architecture and cost choices

Each environment has a private encrypted/versioned S3 web bucket, a Node.js 24 ARM64 Lambda (256 MB, no provisioned or reserved concurrency), a Function URL, and a standard CloudFront distribution. CloudFront uses pay-as-you-go rather than a flat-rate subscription, PriceClass_100, compression, and no WAF. Live console billing-plan verification is required after creation. API requests forward cookies, authorization, query strings, and bodies with caching disabled. Browser mutations require the configured HTTPS website origin. A random origin header restricts direct Function URL requests before database initialization; the URL remains publicly addressable and requires application authentication for workspace access.

There is no EC2, DocumentDB, NAT Gateway, load balancer, purchased domain, or Secrets Manager secret. MongoDB connection strings are Standard SecureString SSM parameters under `/learnverse-tasks/dev/mongodb-uri` and `/learnverse-tasks/prod/mongodb-uri`, using the default AWS-managed SSM key. Lambda may read only its own MongoDB and encrypted SMTP parameters. Its logs expire after seven days. The application shares auth/integration rate-limit counters through MongoDB, so Lambda scaling does not reset them.

Use separate Atlas Free projects and clusters, named `learnverse-tasks-dev` and `learnverse-tasks-prod`, preferably on AWS Mumbai if available. Free-tier eligibility and availability must be checked live. Do not select a paid fallback without resolving the user's low-cost constraint. Configure database users restricted to their own environment database. A free Atlas cluster cannot use a private endpoint; Lambda outbound addresses are dynamic. Any broad network allowlist needs explicit security review at the point of configuration. Do not modify existing projects, clusters, users, or WAFs associated with other applications.

AWS charges depend on usage and account allowances. No zero-cost or hard spending-cap claim is made. PriceClass_100 limits edge locations to reduce cost and can increase latency for Indian users. Versioned S3 release objects accumulate storage until intentionally reviewed and retired.

## Local preparation

The imported app lives directly in `E:\projects\tasks`. For this machine, `.env` points to a loopback MongoDB instance on port 27018, with persistent data in `output/local-db`; no production MongoDB credentials are in that file; local SMTP credentials, when configured, remain excluded from Git and artifacts. Docker remains an alternative on port 27017.

```powershell
npm test
npm run build
npm run test:e2e
npm run test:lambda
pwsh -NoProfile -File scripts/package-release.ps1
```

The release ZIP is `output/aws-release.zip`. It contains immutable backend ZIP bytes, the generated frontend, CloudFormation templates, deployment tooling, and a source/artifact hash manifest. It excludes `.env`, MongoDB data, dependencies, and user credentials. Never substitute the development server entrypoint for `index.handler`.

## Account setup and release

Use the user's authenticated AWS CLI or AWS CloudShell. Confirm the account with STS and inspect existing stack/resource ownership before creating anything. Default region is `ap-south-1`; dev and prod use separate stacks, buckets, functions, parameters, and databases. New resources use the `learnverse-tasks` prefix. Create the two Standard SecureString SSM parameters through a secure AWS UI or interactive secret-entry flow; the values must be full TLS MongoDB connection strings with URL-encoded credentials. Do not paste them into chat or command arguments.

Upload the release ZIP to CloudShell and extract into an isolated directory. First inspect the change sets without executing, then execute the reviewed proposals:

```sh
unzip aws-release.zip -d learnverse-tasks-release
cd learnverse-tasks-release
python3 scripts/aws-deploy.py dev
python3 scripts/aws-deploy.py dev --execute
# Complete live dev API and browser checks before production:
python3 scripts/aws-deploy.py prod
python3 scripts/aws-deploy.py prod --execute
```

The script inspects resource changes before execution, rejects replacements/removals and IAM changes on existing stacks, and records proposals without secrets. A first dry run prepares only the artifact stack; subsequent dry runs can review environment stacks once artifacts exist. The first environment creation is followed by a reviewed Lambda configuration update to set its assigned CloudFront HTTPS origin. Storage and deployed resources are retained; stacks receive termination protection after successful creation.

API ZIP keys use SHA-256. Frontend hashed assets upload before index.html; previous assets and S3 versions are preserved. CloudFront invalidation completes before verification. Verification checks HTTPS, SHA-256 and MIME for every built asset, SPA deep links, missing-asset errors, DB-aware health, no-store API headers, unauthenticated rejection, disabled API caching, and no WAF association. The CloudFront subscription/pricing plan must also be checked in the console.

Before production, verify live signup/login/logout, representative project/task/sprint writes and reads, retries, cross-user isolation, integration setup, desktop/mobile rendering, and browser console errors using isolated fictional accounts. Verify MCP initialization, tool listing, reads/writes, permissions and revocation with an issued disposable scoped credential. Record test accounts if they cannot be cleaned up. `MCP_ENABLED=true` enables stateless Streamable HTTP with JSON responses in the same Lambda, avoiding a separate server or MCP subscription. The `McpUrl` stack output identifies the endpoint. Domain options default to disabled; subsequent releases preserve the existing domain parameters. See the staged custom-domain runbook before enabling DNS publication.

## Records and rollback

`output/dev-deployment.json` and `output/prod-deployment.json` are written only after deployment verification. Each records account/region, stack outputs, API key, and previous index.html version. Update the repository deployment status with these actual results and live URLs; preparation alone is not a deployment.

For an existing release, `output/learnverse-tasks-ENV-rollback.json` records the previous API key. Restore it through a reviewed CloudFormation update, preserving every other parameter. Restore the recorded S3 index.html version by copying it to the current index key; retain previous hashed assets. Invalidate CloudFront and rerun the full live checks. Do not delete a retained bucket, function, database, or cluster to force a failed stack to recreate resources. The production domain is `tasks.abuk.in`; see [custom-domain stages and rollback](../../docs/custom-domain.md).

Account verification on 2026-10-07 found a Lambda regional concurrency quota of 10. Reserved concurrency is omitted because AWS requires at least 100 unreserved units before reservations. Functions share the existing account quota; no increase is requested. Under load, this small shared quota can throttle requests.

For credential entry in CloudShell, upload `scripts/configure-database.py` and run `python3 configure-database.py both`. The user enters completed Atlas driver URIs through hidden prompts. Alternatively, pass the verified nonsecret hostnames with `--dev-host HOST --prod-host HOST`; the user then enters only passwords and the helper URL-encodes them. The helper creates Standard SecureString SSM parameters, preserves existing parameters, and does not print secrets.

After deployment, run `python3 scripts/check-live.py https://DISTRIBUTION.cloudfront.net` against dev before releasing prod, then against prod. This exercises real sessions, owner isolation, mutation retries, MCP initialization and all 11 tool discovery, read/write, permission denial, revocation, and logout. It creates two isolated QA accounts with random passwords held only in memory. The QA workspaces remain; tokens are revoked and sessions logged out. Existing workspaces are untouched.

The owner explicitly deferred database password rotation and requested deployment using the existing passwords on 2026-10-07. The helper permits that temporary choice only with `--allow-username-password`; default password prompts reject passwords equal to usernames. Passwords shared in chat must be replaced later. Rotate each Atlas user through the Atlas UI, then run the helper with `--replace` and the verified hostnames to update its encrypted connection. Do not use the temporary override with the new strong passwords. Recycle each Lambda's cached connection by calling `aws lambda update-function-code` with that environment's function name, the artifact bucket, and the current immutable API key recorded in its deployment JSON. This publishes the same tested code and loads the updated SSM value on the next invocation. Wait for each function update and rerun health/API checks, dev before prod.


Lambda updates can cause CloudFormation to mark ApiUrl as Conditional because of its dynamic reference to ApiFunction.Arn. The deployment helper permits only that exact dependency when URL properties and the named Lambda identity are unchanged, the function is not replaced, and the environment identity is unchanged. Other replacements, removals, and unreviewed IAM changes remain blocked.


## Password-reset release

Configure the owner-supplied Gmail app credential in the two Standard SecureString parameters using `scripts/configure-smtp.py` and an explicitly authorized private input file. This script erases that input after storage. Never put the credential into the release ZIP. The reviewed IAM update adds only `ssm:GetParameter` for `/learnverse-tasks/${Environment}/smtp`. After reviewing the change set, use `--review-smtp-access --execute` for the first dev/prod release with this permission. The helper rejects any other IAM change or resource replacement. Complete dev verification before prod. See [password reset](../../docs/password-reset.md).
