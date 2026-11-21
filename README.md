# Huddle

Huddle is a small always-on-top panel in the top-right corner of the screen. It shows your Claude Desktop (Claude Code) orchestrator sessions, their status and their latest steps. The arrow on a session takes you to that session in Claude Desktop. The panel hides itself when there are no sessions.

Version 0.2.0 adds: a hotkey to hide and show the panel, a collapsed pill, quiet mode, in-app toasts, an avatar per session, and answering Claude's option and permission prompts from the panel.

## What v2 adds

- **Hotkey:** `Ctrl+Alt+H` hides and shows the panel. The tray item "Hide / Show panel" does the same. If the hotkey cannot be registered, the tray shows a note and the tray item still works.
- **Collapse:** the collapse button (or tray "Collapse panel") shrinks the panel to one pill with the session count and a "!" dot when a session waits.
- **Toasts:** a small window under the panel says "needs you" when a session starts waiting and "finished" when a busy session goes idle. It never takes focus and lets clicks through. Toasts also show while the panel is hidden; not for dismissed sessions.
- **Quiet mode:** tray "Quiet mode" turns toasts off and stops the panel from holding prompts (Desktop handles them).
- **Avatars:** each session gets a small blob character. Its color comes from the session id; its face shows busy, waiting or idle. Animation follows the system's reduced-motion setting.
- The panel stays above borderless full-screen windows (such as a browser video in full screen).

## Answering from the panel

When a session raises a prompt, its card shows it:

- `AskUserQuestion`: the question and up to 4 option buttons. One click answers a single-select question; a multi-select question has a "Done" button. Several questions are shown one after the other and sent together at the end.
- Permission prompts (any tool): the tool name, a one-line summary (command, path or URL), Allow and Deny. Allow takes two clicks: the first turns it into "Confirm allow", the second must come at least half a second later and within 5 seconds. Deny is one click.
- Clicks in the first half second after a card appears are ignored, so a stray double-click cannot answer.

What is not handled: free typing, "Other" answers, editing a command, more than 4 questions or options. For those the arrow opens the session in Claude Desktop, and Desktop shows its own prompt.

Desktop stays the fallback for everything:

- If nobody answers within 15 seconds, the card goes away and Desktop shows its normal prompt.
- When the panel is hidden or quiet mode is on, Huddle does not hold the prompt; Desktop handles it at once. A collapsed pill expands itself and holds.
- Hiding the panel, turning quiet on or dismissing the session while a card is open hands the prompt back to Desktop at once.
- One prompt per session at a time; a second one goes straight to Desktop.

### Hook setup and token

Answering needs two `http` hooks in `~/.claude/settings.json` and the token in the user environment variable `HUDDLE_HOOK_TOKEN`. Huddle never edits that file or sets the variable. The exact entries, the token steps (tray "Copy token setup command", run the `setx` line, restart Claude Desktop) and the verified facts are in [docs/superpowers/notes/hook-setup.md](docs/superpowers/notes/hook-setup.md); the JSON shape is in `docs/superpowers/notes/hook-settings.json`.

Without the hooks or the token, Huddle works as a viewer and Desktop shows every prompt.

### Rollback

1. Delete the two Huddle entries from `~/.claude/settings.json` (keep the guard entry).
2. Run `setx HUDDLE_HOOK_TOKEN ""`.
3. Restart Claude Desktop.

## Settings file

Huddle keeps its settings in `settings.json` in its user-data folder (`%APPDATA%\Huddle\settings.json`), next to the token file `hook-token`:

```
{ "hotkey": "Ctrl+Alt+H", "quiet": false, "collapsed": false }
```

`hotkey` takes an Electron accelerator string. Restart Huddle after editing the file by hand. A missing or broken value falls back to its default.

## v1 and v2

v1 and v2 share the app name, the user-data folder and the single-instance lock. Close v1 (tray, Quit) before starting v2; otherwise v2 exits silently.

## How it finds sessions

Huddle only reads local files; it never writes to them.

- Session list: `~/.claude/sessions/*.json`, kept current with a file watcher plus a 2 second poll. Sessions whose process is gone are dropped.
- Steps: each session's transcript under `~/.claude/projects/`.

## Run

```
npm install
npm start
```

Demo mode shows fixed fake sessions, including fake prompts, and reads nothing from `~/.claude`. It starts no hook server and makes no token:

```
$env:HUDDLE_DEMO = "1"; npm start
```

(PowerShell; in Git Bash use `HUDDLE_DEMO=1 npm start`.)

Demo mode shares the single-instance lock with the real panel, so while the real Huddle runs, a demo start exits silently. The tray "Start at login" toggle is live in demo mode too and registers the real login item, so leave it alone there.

## Tests

```
npm test
```

## Build

```
npm run dist
```

This writes two Windows builds to `dist/`:

- `Huddle-<version>-portable.exe`: runs without installing.
- `Huddle-<version>-setup.exe`: installer.

The icon is generated by `npm run icon` (`build/make-icon.js`); the output is checked in.

Build notes:

- `npm run dist` downloads Electron, NSIS and code signing tool pieces at build time. Only the build uses the network; the running app does not, and the privacy statement below is about the running app.
- The exes are unsigned, so Windows SmartScreen warns the first time you run one.
- The portable build's login entry points at the exe where it was when you ticked "Start at login"; moving the exe breaks it.

## Known vulnerabilities

`npm audit` reports 8 vulnerabilities: 2 high (in `electron` and `extract-zip`) and 6 moderate (through `electron-builder`). They are not fixed in v1. The installed Electron is 41.7.1. `npm view electron versions` (checked 2026-11-20) shows 41.10.7 as the newest 41.x; it covers the advisories that end at 41.10.6, but several advisories, one of them high, are listed as fixed only from 42.11.x (42.11.16 for the high one). The newest releases are 42.11.18, 43.8.12 and 45.4.1. No upgrade has been made.

## Start at login

Right-click the Huddle tray icon and tick "Start at login". It is off by default. The setting is stored by Windows through Electron's login item settings; untick it to remove it. For the portable build the login item points at the portable exe, so moving that file breaks it until you tick the option again. "Quit" in the same menu closes Huddle.

## Limits

- The arrow opens a `claude://` deep link. That link format is undocumented and may break with a Claude Desktop update. When the link cannot be opened, the arrow falls back to bringing the Claude Desktop window forward.
- Windows only.
- Full screen: the panel and toasts stay above borderless full-screen windows, not above exclusive full-screen apps (some games).
- If Huddle is closed, the hook cannot connect and Desktop shows its own prompt.
- Port 47821 is fixed. If another program holds it, the tray shows "Answering off: port 47821 in use" and Desktop handles every prompt.
- Hook payloads over 64 KiB (for example a large `Write` or `Edit`) are refused, so Desktop shows its own prompt.
- "Copy token setup command" goes through the Windows clipboard, so clipboard history may keep the token.

### Not yet verified on the real machine

- That Desktop's prompt appears with no delay when Huddle is closed, and after the 15 second hold.
- The interaction with the existing `pretool-guard` hook.
- The `", "` separator Huddle uses to join multi-select answers, and the exact label Claude receives.
- Whether Claude Code shows an error for a refused (over 64 KiB) payload.

## Privacy

Huddle reads `~/.claude` on your own machine. It makes no network requests beyond `127.0.0.1` and sends nothing anywhere. The hook server listens on `127.0.0.1` only and needs the token.

A permission card shows a one-line summary of the tool input (a command, a path or a URL). It is shown only while the prompt is open and is never stored or logged.
