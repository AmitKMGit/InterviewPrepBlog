# Personal Notebook

A static, responsive notebook built with plain HTML, CSS, and JavaScript.
Create, edit, search, format, and delete notes. Notes are saved automatically
in the current browser's local storage.

## Privacy and storage

This version has no sync backend or account connection. Notes stay in the
browser profile where they were created and are not uploaded by the notebook.
Clearing that browser's site data can erase its notes, so export or back up
important notes before clearing browser storage.

Notes that were published before sync was removed may still appear in earlier
Git commits. Git history was intentionally left unchanged. The current
`site/notes.json` is empty.

## Run locally

Open `site/index.html` in a browser. No build step or package installation is
required.

## Publish on GitHub Pages

1. Push the repository to GitHub on the `main` branch.
2. In **Settings → Pages**, choose **GitHub Actions** as the deployment source.
3. The workflow deploys the `site/` directory on pushes to `main`.

GitHub Pages hosts the notebook interface only. Because each browser has its
own local storage, notes do not transfer to another device.
