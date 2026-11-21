# Huddle

Huddle is a small always-on-top panel in the top-right corner of the screen. It shows your Claude Desktop (Claude Code) sessions that need attention, their status and their latest steps. The arrow on a session takes you to that session in Claude Desktop. The panel hides itself when nothing needs showing.

Version 0.2.0 adds: header buttons to hide and quit, a hotkey, a collapsed pill you can drag, quiet mode, toasts, a pixel creature avatar per session, and answering Claude's option prompts and shell command approvals from the panel.

## Which sessions show

A session is shown only when it is:

- busy,
- waiting for you,
- finished and not yet looked at, or
- holding a prompt.

Plain idle sessions are never shown. "Finished" means the session went from busy or waiting to idle while Huddle ran. It clears when you open the session with the arrow (a successful open), when you dismiss it, or when the session is busy or waiting again. A session that is already idle when Huddle starts is never "finished".

## Panel controls

- **Quit** (power icon, leftmost in the header): closes Huddle at once, with no confirmation. Held prompts go back to Desktop. A mis-click ends answering from the panel until you start Huddle again.
- **Hide** (cross in the header): hides the panel, the same as the hotkey. Held prompts are released, so Desktop shows its own prompt. Hidden is not kept across restarts. The tray item "Panel hidden" shows the state and toggles it.
- **Hotkey:** `Ctrl+Alt+H` hides and shows the panel. It ignores a hide request when nothing is on screen. If the hotkey cannot be registered, the tray shows a note and the tray item still works.
- **Collapse:** the collapse button (or tray "Collapse panel") shrinks the panel to one pill with the session count and a "!" dot when a session waits. A collapse by hand hands every open prompt back to Desktop.
  - Click the pill to expand it. Press and drag to move it (it moves only after 4 px; at least 24 px stays on screen). The pill position is not saved across restarts.
  - The expanded panel moves by its header. On expand, the panel is fitted inside the screen's work area.
  - A prompt expands the pill by itself and collapses it again afterwards, without changing the saved setting.
- **Quiet mode** (tray): silences toasts and stops the panel from holding prompts; Desktop handles them.

## Toasts

A small window says "needs you" when a session starts waiting and "finished" when a busy session goes idle (not when a waiting session goes idle).

- It shows only while you cannot see the panel: hidden (hotkey, tray or Hide button) or collapsed to the pill. With the panel open, the card is the notification; opening the panel clears any toast showing or waiting.
- It shows for 4 seconds.
- Its close cross is the only clickable part. The rest lets clicks through and never takes focus.
- It sits below the panel or pill, or above it when there is no room below. While the panel is hidden, it sits in the top-right corner of the display.
- Quiet mode silences toasts. Dismissed sessions get none.
- The one "port in use" notice is not a card, so it shows with the panel open too.

## Look

Each session gets a small pixel creature: 6 colors and 3 small shape variants, picked from the session id, with eyes that show busy, waiting or idle. Animation follows the system's reduced-motion setting. The style is a warm Anthropic look set in Georgia and Segoe UI; Anthropic's own fonts are licensed and are not bundled. Light and dark follow the system.

The panel stays above borderless full-screen windows (such as a browser video in full screen).

## Answering from the panel

When a session raises a prompt that Huddle can handle, its card shows it:

- **`AskUserQuestion`:** the question and its option buttons, answered at the `PreToolUse` hook. One click answers a single-select question; a multi-select question has a "Done" button. Several questions are shown one after the other and sent together at the end. There is no "Other" answer; use the arrow for anything else. A prompt with more than 4 questions, a question with more than 4 options, or duplicate questions or option labels falls through to Desktop.
- **Bash and PowerShell commands:** the whole command, wrapped, in monospace, with Allow and Deny. There is no scroll box: what passes the rules below fits on the card, and the panel list scrolls if the card is tall. Allow takes two clicks: the first turns it into "Confirm allow", the second must come after a short pause. Deny is one click.
- Clicks in the first moment after a card appears are ignored, so a stray double-click cannot answer.

A command card appears only when all of this holds:

- The tool is Bash or PowerShell.
- The command has at most 600 characters and at most 8 lines, with no 3 or more blank lines in a row.
- `tool_input` has no keys beyond `command`, `description` and `timeout` (so `run_in_background`, `dangerouslyDisableSandbox` and the like are never approved unseen).
- The command has no control characters (other than tab and CRLF line breaks), no invisible characters (zero-width or bidi marks) and no blank-looking characters (no-break and other wide spaces, Hangul fillers, the blank Braille pattern, variation selectors).

Everything else, including Write, Edit and MCP tools, falls through to Desktop at once. Free typing, "Other" answers and editing a command are not handled; the arrow opens the session in Desktop for those.

How prompts reach the panel:

- The hooks fire for every Claude Code session on this machine (Desktop, CLI, IDE, SDK). Huddle matches the hook's `session_id` against every registry session that is not dismissed (idle ones included), then the hook's transcript path. A hook from a session that is not in the registry, or that is dismissed, gets no card: an immediate "no decision", so Desktop (or the CLI) shows its own prompt.
- One prompt per session at a time; a second one goes straight to Desktop.

Desktop stays the fallback for everything:

- A prompt is held at most 15 seconds (the hook timeout is 20 seconds). Then the card goes away and Desktop shows its normal prompt.
- Desktop handles the prompt when the panel is hidden, quiet mode is on, the panel page has crashed or not loaded yet, the session was dismissed, or Huddle is closed. A hung panel page cannot be detected within the hold; it just means the prompt waits the full 15 seconds.
- Hiding the panel, collapsing it by hand, turning quiet on or dismissing the session while a card is open hands the prompt back to Desktop at once.
- A crashed panel page is reloaded after a second. A crash loop (more than 3 crashes in 60 seconds) leaves the panel blank and answering off until Huddle is restarted.
- If port 47821 is in use, answering is off: a toast says so once per run, the tray shows "Answering off: port 47821 in use" (also in the tray tooltip), and Huddle retries every 30 seconds. Any other start failure shows "Answering off: hook server failed" and retries the same way.
- Hook bodies over 64 KiB get no decision, so Desktop shows its own prompt.

### Hook setup and token

Answering needs two `http` hooks in `~/.claude/settings.json` and the token in the user environment variable `HUDDLE_HOOK_TOKEN`. Huddle never edits that file or sets the variable. The exact entries, the token steps and the verified facts are in [docs/superpowers/notes/hook-setup.md](docs/superpowers/notes/hook-setup.md); the JSON shape is in `docs/superpowers/notes/hook-settings.json`.

The token is 64 hex characters. The hook gate test used a shorter test token, so after the first start of 0.2.0 run the tray "Copy token setup command" again, paste and run the `setx` line, then restart Claude Desktop fully. The copied token can stay in Windows clipboard history (Win+V) if that is on; clear the entry.

Without the hooks or the token, Huddle works as a viewer and Desktop shows every prompt.

### Rollback

1. Delete the two Huddle entries from `~/.claude/settings.json` (keep the guard entry).
2. Run `reg delete HKCU\Environment /v HUDDLE_HOOK_TOKEN /f`. (`setx` with an empty value leaves an empty variable behind.)
3. Restart Claude Desktop.

## Settings file

Huddle keeps its files in `%APPDATA%\Huddle`: `settings.json` and the token file `hook-token`. Electron names the folder after the product name. A folder first created as `%APPDATA%\huddle` keeps that spelling; Windows ignores case, so both are the same folder.

```
{ "hotkey": "Ctrl+Alt+H", "quiet": false, "collapsed": false }
```

`hotkey` takes an Electron accelerator string. Restart Huddle after editing the file by hand. A missing or broken value falls back to its default.

## Running next to the first version

Both versions use the app name Huddle, so they share the settings folder and the single-instance lock. Close the first version (tray, Quit) before starting 0.2.0; otherwise 0.2.0 exits silently.

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

`npm audit` reports 8 vulnerabilities: 2 high (in `electron` and `extract-zip`) and 6 moderate (through `electron-builder`). They are not fixed. The installed Electron is 41.7.1. `npm view electron versions` (checked 2026-11-20) shows 41.10.7 as the newest 41.x; it covers the advisories that end at 41.10.6, but several advisories, one of them high, are listed as fixed only from 42.11.x (42.11.16 for the high one). The newest releases are 42.11.18, 43.8.12 and 45.4.1. No upgrade has been made.

## Start at login

Right-click the Huddle tray icon and tick "Start at login". It is off by default. The setting is stored by Windows through Electron's login item settings; untick it to remove it. For the portable build the login item points at the portable exe, so moving that file breaks it until you tick the option again. "Quit" in the same menu closes Huddle.

## Limits

- The arrow opens a `claude://` deep link. That link format is undocumented and may break with a Claude Desktop update. When the link cannot be opened, the arrow falls back to bringing the Claude Desktop window forward.
- Windows only.
- Full screen: the panel and toasts stay above borderless full-screen windows, not above exclusive full-screen apps (some games).
- Port 47821 is fixed.
- Write, Edit, MCP and other non-shell approvals always stay in Desktop.

### Verified live (hook gate, 2026-11-20)

- Both hooks fire in the Desktop Code tab, before Desktop shows its own dialog.
- The token header is expanded from the user environment variable.
- The hook `session_id` matches the session registry.
- A hook answer to a question, and a hook allow and deny, are honored and suppress Desktop's dialog.

The hook gate ran before the `Origin` and `Host` checks were added: the server now answers 403 to any request with an `Origin` header or a `Host` other than `127.0.0.1:47821`. That check has not met the real Claude Code client yet.

### Not yet verified

- The `Origin`/`Host` rejection against the real Claude Code client. If the client sends an `Origin` header or another `Host`, every hook gets 403 and answering is dead without any sign; Desktop then handles every prompt.
- The round trip with the 64-character token (the gate used a shorter test token).
- Fall-through when Huddle is closed, and after the 15 second hold.
- Whether Desktop shows a hook error on the instant 204 (no decision).
- The refusal round trip: an answer main refuses brings the card back and the prompt stays held.
- Crash recovery of the panel page, and the port retry.
- The separator used to join multi-select answers, and the exact label Claude receives.
- The interaction with the existing `pretool-guard` hook.
- What Claude Code does on a refused (over 64 KiB) payload that gets no decision.
- Clicking the toast cross with a real pointer.
- Two monitors and mixed DPI.

## Privacy

Huddle reads `~/.claude` on your own machine. It makes no network requests beyond `127.0.0.1` and sends nothing anywhere. The hook server listens on `127.0.0.1` only and needs the token.

A command card shows the command only while the prompt is open; it is never stored or logged.
