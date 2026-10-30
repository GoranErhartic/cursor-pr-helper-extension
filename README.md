# PR Helper

Cursor/VS Code extension that lists open GitHub pull requests, shows CI status and comments, and runs AI reviews with optional Jira context.

## Setup

1. `pnpm install`
2. `pnpm run compile`
3. Press F5 to launch Extension Development Host
4. Open the **PR Helper** sidebar (or run **Run PR**) — if no API key/model is configured you are offered **Configure**, which walks through: **provider** → **API key** → **model**.
   - The key is validated against the provider (cancellable) and only stored in Secret Storage if it is accepted.
   - For **Cursor**, use an API key from the Cursor dashboard. Validation and the model list use `@cursor/sdk` (`Cursor.models.list`); reviews run as a local SDK agent in an empty temp directory, so your workspace is never touched.
5. Optional: **PR Helper: Connect Jira** — Atlassian MCP access token
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
