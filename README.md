# Personal Notebook

A static, responsive notebook made with plain HTML, CSS, and JavaScript. It has
editable notes, search, formatting and code blocks. The browser saves edits
immediately. Optional GitHub sync stores a queued snapshot in Cloudflare and
queues edits after 30 seconds without typing and publishes them to GitHub Pages
on Cloudflare's one-minute schedule.

> **Privacy:** when GitHub sync is enabled, note titles and contents are
> committed to this repository and served publicly by GitHub Pages. Do not put
> passwords, private keys, personal data, or anything else confidential in
> synced notes.

## Run locally

Open `site/index.html` in a browser. Without sync configured, notes are saved
only in that browser's local storage. To read the latest published notes on a
new device, configure sync and connect the GitHub account that owns the
repository.

## Publish the static site

1. Push the repository to GitHub on the `main` branch.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. The workflow deploys the `site/` directory. Open the URL shown in Pages
   settings.

## Enable cross-device GitHub sync

Sync uses a Cloudflare Worker as a small OAuth/API backend. GitHub credentials
stay in Worker secrets, not in the website. After 30 seconds without typing,
the browser queues edits; the Worker commits the latest snapshot and requests a
Pages deployment on its one-minute schedule. Cloudflare cron cannot run every
30 seconds. The static site remains usable locally
without this setup.

### 1. Create the Cloudflare KV namespace

Install Node.js/npm if needed, then run in the repository:

```powershell
cd worker
npx wrangler kv namespace create NOTEBOOK_DATA
```

Copy the returned namespace ID into `worker/wrangler.toml`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

### 2. Set Worker configuration

Edit the `[vars]` values in `worker/wrangler.toml`:

- `GITHUB_OWNER`: `AmitKMGit` (the repository owner)
- `GITHUB_REPO`: `InterviewPrepBlog`
- `SITE_ORIGIN`: `https://amitkmgit.github.io` (origin only; no repository path)
- `SITE_URL`: `https://amitkmgit.github.io/InterviewPrepBlog/`

These values must match the actual GitHub account and Pages URL if the
repository is transferred or Pages uses a custom domain.

### 3. Deploy the Worker once to get its URL

From the `worker` directory, deploy the Worker:

```powershell
npx wrangler deploy
```

The deployed Worker URL for this notebook is
`https://personal-notebook-sync.amitkmgit-notebook.workers.dev`. The Worker can
be deployed before adding OAuth secrets; sign-in will work after the next
steps.

### 4. Create a GitHub OAuth App

In GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**.
Set the homepage URL to the Pages URL above. Set its authorization callback URL
to:

```text
https://personal-notebook-sync.amitkmgit-notebook.workers.dev/api/auth/callback
```

Copy the OAuth App's Client ID and Client Secret; do not add either value to
site files or commit them.

### 5. Add credentials and redeploy the Worker

From the `worker` directory, add the OAuth credentials as Worker secrets and
deploy again:

```powershell
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler deploy
```

The Worker enables the configured `*/1 * * * *` cron trigger (once per minute).

### 6. Point the site at the Worker

Set `window.NOTEBOOK_SYNC_API` in `site/sync-config.js` to the deployed Worker
URL:

```js
window.NOTEBOOK_SYNC_API = "https://personal-notebook-sync.amitkmgit-notebook.workers.dev";
```

Push this change to `main` and wait for the Pages workflow to finish. Open the
site, select **Connect GitHub**, and authorize the OAuth App using the account
that owns this repository. Once connected, published notes can be read from
other devices; editing requires connecting that account.

## Save and publish behavior

- Each edit is saved to browser storage immediately.
- When connected, the latest full notebook snapshot is sent to Cloudflare after
  30 seconds without typing.
- Cloudflare retains the queued snapshot and, every minute, commits it to
  `site/notes.json` and dispatches the Pages deployment workflow.
- A browser closed before the short queue request completes leaves that last
  edit only in that browser's local storage until it is reopened and connected.
- GitHub Actions deploys ordinary site changes immediately. Notes-only commits
  wait for the Worker-triggered deployment, avoiding a deployment for every
  edit.
