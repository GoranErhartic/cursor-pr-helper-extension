# LazyDev PR Helper

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-F16061?logo=ko-fi&logoColor=white)](https://ko-fi.com/goranlegenda)

Cursor/VS Code extension that lists open GitHub pull requests, shows CI status and comments, and runs AI reviews with optional Jira context.

## Setup

1. `pnpm install`
2. `pnpm run compile`
3. Press F5 to launch Extension Development Host
4. Open the **PR Helper** sidebar (or run **Run PR**) — if no API key/model is configured you are offered **Configure**, which walks through: **provider** → **API key** → **model**.
   - The key is validated against the provider (cancellable) and only stored in Secret Storage if it is accepted.
   - For **Cursor**, use an API key from the Cursor dashboard. Validation and the model list use `@cursor/sdk` (`Cursor.models.list`); reviews run as a local SDK agent in an empty temp directory, so your workspace is never touched.
5. Optional Jira (Atlassian MCP):
   - Run **PR Helper: Connect Jira** and choose **Sign in with browser (SSO)**. This opens the Atlassian login (OAuth 2.1 + PKCE, dynamic client registration) and receives the callback on `http://127.0.0.1:<prHelper.jiraOAuthPort>/callback` (default 33418). Tokens are stored in Secret Storage and refreshed automatically.
   - **Run PR** also offers **Sign in to Jira** when a Jira key is detected and you are not connected.
   - Alternatively choose **Paste access token** for an admin-provided [Atlassian remote MCP](https://developer.atlassian.com/cloud/mcp/) token.
   - Default endpoint is `https://mcp.atlassian.com/v2/mcp` (`prHelper.jiraMcpUrl`). Legacy SSE URLs ending in `/v1/sse` are still supported.
   - If your token can access multiple sites, set `prHelper.jiraSiteUrl` to your site (for example `https://your-org.atlassian.net`) or cloud ID.
   - Set `prHelper.jiraProjectKeys` (optional) to narrow issue key detection from branch/title.
   - On success, **Run PR** shows a short status message and logs to the **PR Helper** output channel (View → Output).
6. Refresh PRs and use **Run PR** once setup shows “ready”

## Commands

- `PR Helper: Configure Provider` — pick provider, enter and validate API key, pick model
- `PR Helper: Select Model` — change the model for the current provider
- `PR Helper: Clear Stored API Key` — delete the key for the current provider and reset the model

## Scripts

- `pnpm run compile` — typecheck and bundle (also vendors `@cursor/sdk` into `dist/vendor`)
- `pnpm run lint`
- `pnpm run test:unit`
- `pnpm run package` — build a production `.vsix` (bundled, `--no-dependencies`)
