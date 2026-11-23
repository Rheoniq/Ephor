# Contributing

Ephor is a small Windows-only Electron app. Changes go through pull requests; `main` is protected.

## Set up

```powershell
npm install
npm start
```

Try it with fake sessions and no hooks: `$env:EPHOR_DEMO = "1"; npm start`.

## Before you open a pull request

1. Branch from `main` (`feat/...`, `fix/...`, `docs/...`, `chore/...`).
2. Run `npm test`. CI runs the same on Windows and must pass before merge.
3. Update `README.md` or `docs/reference.md` when behavior changes.
4. Use short, imperative commit messages with a type prefix, for example `fix: keep the toast above full-screen video`.
5. Open a pull request. Merges are squash merges.

## Releases

Push a tag `vX.Y.Z` that matches `version` in `package.json`. The release workflow builds the installer and portable exe and attaches them to a GitHub Release.

## Reporting a problem

Open an issue with your Windows version, how you start Claude Code (Desktop, terminal, editor) and what the panel showed.
