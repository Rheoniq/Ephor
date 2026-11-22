# Huddle

Huddle is a small always-on-top panel in the top-right corner of the screen. It shows your Claude Code sessions that need attention, in Claude Desktop and in terminals (Zed, VS Code, Cursor, JetBrains or any terminal), their status and how far each one is through its plan. The arrow on a Desktop session takes you to that session in Claude Desktop; on a terminal session it brings the window that hosts the session to the front. The panel hides itself when nothing needs showing.

This branch adds terminal sessions: they are listed with a small badge naming their host program, and their arrow reads "Open in <host>" (see [Terminal sessions](#terminal-sessions)).

Version 0.3.0 adds: a progress bar and a plan checklist per session, a distinct color for each visible session, and clearer question and permission cards.

Version 0.2.0 added: header buttons to hide and quit, a hotkey, a collapsed pill you can drag, quiet mode, toasts, a pixel creature avatar per session, and answering Claude's option prompts and shell command approvals from the panel.

## Which sessions show

A session is shown only when it is:

- busy,
- waiting for you,
- finished and not yet looked at, or
- holding a prompt.

Plain idle sessions are never shown. "Finished" means the session went from busy or waiting to idle while Huddle ran. It clears when you open the session with the arrow (a successful open), when you dismiss it, or when the session is busy or waiting again. A session that is already idle when Huddle starts is never "finished".

## Progress view

Under each session's name is a thin bar with a label `current/total phase`, for example `3/5 Write tests`. `current` is the number of the step being worked on, so a plan with two steps done and the third active reads 3/5. A finished plan reads `7/7 Done`. The bar fills to current/total, so an active last step already shows a full bar; only the label tells `7/7 Review` from `7/7 Done`. A chip next to the label says "Needs you" (waiting) or "Finished".

A busy session whose plan is complete (it works on a follow-up that made no new plan) shows its Working tag instead of the bar; its expanded checklist still shows every step checked. A waiting or finished session with a complete plan keeps the bar, reading `7/7 Done`.

What feeds it:

- The agent's own plan, recorded in the session transcript each time the agent calls its `update_plan` tool.
- The agent's end-of-turn `wrap_up` call, which checks the whole plan off: a turn that ends reads `7/7 Done`. A later `update_plan` call starts a new plan or edits the checked-off one.
- A session that never makes a plan shows its status label instead (Working, Needs you or Finished).
- The plan comes from Desktop's undocumented transcript format. If that format changes, the bar disappears and the status label shows; nothing else breaks.

Click a session to expand it:

- The whole plan as a checklist: a checked box for done steps, a spinner for the active step, an empty box for steps still to do. At most 30 steps are shown. Without a plan it reads "No plan yet".
- Control and invisible characters in plan steps (bidi marks, zero-width characters, escape codes, variation selectors, blank-looking characters) show as `?`, so they cannot change what the line seems to say.

Each row has the arrow (open in Claude Desktop, or "Open in <host>" for a terminal session) and the x (dismiss) stacked on its right edge.

## Terminal sessions

Claude Code sessions running in Zed, VS Code, Cursor, JetBrains or any terminal are listed like Desktop sessions, under the same rules for which sessions show. Only interactive sessions count; headless and SDK sessions never show.

- **Host badge:** a small badge after the name names the program that hosts the session (Zed, VS Code, Cursor, JetBrains, Terminal, or the program's own name). Huddle finds it by walking up the process tree from the session's process to the first program with a visible window. The lookup runs in the background; a host that cannot be found is asked again after 60 seconds, then after 5 minutes, and then not again for that session.
- **Arrow:** "Open in <host>" brings that program's window to the front, restoring it when minimized. It picks the window whose title shows the session's folder name (see [Limits](#limits)). When the host is not known yet, the arrow looks it up on the click.
- **No progress bar:** the plan comes from Claude Desktop's plan tool, which terminal sessions do not have. A terminal session shows its status label.
- **Prompt cards** are off for terminal sessions by default (see [Answering from the panel](#answering-from-the-panel)).
- A registry file left behind by a crashed session is dropped as soon as the host lookup proves it stale: its process id is missing from the process table, or a Claude process on that id started at another time (seen on two table reads in a row). Each drop is logged with the first 8 characters of the session id, the process id and the reason. A process id held by another program is not proof: that session stays, without a badge. When two registry files name the same session, the one updated last counts among those not proven stale.

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

Each session gets a small pixel creature with eyes that show busy, waiting or idle, and one of 3 small shape variants picked from the session id.

Colors come from a palette of 12, assigned per visible session so no two visible sessions share one. A session keeps its color while it stays visible; one that disappears and comes back may return in another color. With more than 12 sessions on screen, colors repeat. The progress bar and the spinner use the session's color. Animation follows the system's reduced-motion setting. The style is a warm Anthropic look set in Georgia and Segoe UI; Anthropic's own fonts are licensed and are not bundled. Light and dark follow the system.

The panel stays above borderless full-screen windows (such as a browser video in full screen).

## Answering from the panel

When a session raises a prompt that Huddle can handle, a card appears right under the session's name. It has a small line naming the source ("Question from ..." or "Bash command from ..."), the question in large text, the choices, the hint "Or answer in Claude Desktop (closes in 60 s)" ("Or answer in the terminal (closes in 60 s)" for a terminal session; the number is the hold, see `holdSeconds` below), and a line along its bottom edge that drains over the hold (it stands still when the system asks for reduced motion). The redesign changed the look only; the behaviour is as before:

- **`AskUserQuestion`:** the question and its options as full-width buttons, each with its description, answered at the `PreToolUse` hook. One click answers a single-select question; a multi-select question has a "Done" button. Several questions are shown one after the other and sent together at the end. There is no "Other" answer; use the arrow for anything else. A prompt with more than 4 questions, a question with more than 4 options, or duplicate questions or option labels falls through to Desktop.
- **Bash and PowerShell commands:** "Run this command?", then the whole command, wrapped, in monospace, with Deny on the left and Allow on the right. There is no scroll box: what passes the rules below fits on the card, and the panel list scrolls if the card is tall. Allow takes two clicks: the first turns it into "Confirm allow", the second must come after a short pause. Deny is one click.
- Clicks in the first moment after a card appears are ignored, so a stray double-click cannot answer.

A command card appears only when all of this holds:

- The tool is Bash or PowerShell.
- The command has at most 600 characters and at most 8 lines, with no 3 or more blank lines in a row.
- `tool_input` has no keys beyond `command`, `description` and `timeout` (so `run_in_background`, `dangerouslyDisableSandbox` and the like are never approved unseen).
- The command has no control characters (other than tab and CRLF line breaks), no invisible characters (zero-width or bidi marks) and no blank-looking characters (no-break and other wide spaces, Hangul fillers, the blank Braille pattern, variation selectors).

Everything else, including Write, Edit and MCP tools, falls through to Desktop at once. Free typing, "Other" answers and editing a command are not handled; the arrow opens the session in Desktop for those.

How prompts reach the panel:

- The hooks apply to every Claude Code session on this machine (Desktop, terminals, IDEs, SDK). Huddle matches the hook's `session_id` against every registry session that is not dismissed (idle ones included), then the hook's transcript path. A hook from a session that is not in the registry, or that is dismissed, gets no card: an immediate "no decision", so Desktop (or the terminal) shows its own prompt.
- One prompt per session at a time; a second one goes straight to Desktop.

Terminal sessions:

- Prompt cards for terminal sessions are behind the setting `terminalAnswering`, the tray checkbox "Answer terminal prompts". It is off by default until the live check in a terminal passes.
- While it is off, a hook from a terminal session gets an immediate "no decision", so the terminal's own prompt appears at once, with no delay. Turning it off while a terminal card is open hands that prompt back to the terminal at once.
- With it on, a terminal session's card works exactly like a Desktop one, under the same rules, and the terminal takes the place of Desktop as the fallback.
- Not yet verified live: that a hook answer is honored in a terminal and that it suppresses the terminal's own dialog. The hook gate below proved this for Claude Desktop only.

Desktop stays the fallback for everything:

- A prompt is held at most `holdSeconds` (60 seconds by default; the hook timeout must be longer, 70 seconds in the hook setup). Then the card goes away and Desktop shows its normal prompt. A hook entry that still has the old timeout of 20 seconds ends the hold after 20 seconds, with the same safe fall-through.
- Desktop handles the prompt when the panel is hidden, quiet mode is on, the panel page has crashed or not loaded yet, the session was dismissed, or Huddle is closed. A hung panel page cannot be detected within the hold; it just means the prompt waits the full hold.
- Hiding the panel, collapsing it by hand, turning quiet on or dismissing the session while a card is open hands the prompt back to Desktop at once.
- A crashed panel page is reloaded after a second. A crash loop (more than 3 crashes in 60 seconds) leaves the panel blank and answering off until Huddle is restarted.
- If port 47821 is in use, answering is off: a toast says so once per run, the tray shows "Answering off: port 47821 in use" (also in the tray tooltip), and Huddle retries every 30 seconds. Any other start failure shows "Answering off: hook server failed" and retries the same way.
- Hook bodies over 64 KiB get no decision, so Desktop shows its own prompt.

### Hook setup and token

Answering needs two `http` hooks in `~/.claude/settings.json` and the token in the user environment variable `HUDDLE_HOOK_TOKEN`. Huddle never edits that file or sets the variable. The exact entries, the token steps and the verified facts are in [docs/superpowers/notes/hook-setup.md](docs/superpowers/notes/hook-setup.md); the JSON shape is in `docs/superpowers/notes/hook-settings.json`.

The token is 64 hex characters. The hook gate test used a shorter test token, so after the first start of 0.2.0 or later run the tray "Copy token setup command" again, paste and run the `setx` line, then restart Claude Desktop fully, and every terminal and editor that runs Claude Code: a program sees `HUDDLE_HOOK_TOKEN` only after a restart. The copied token can stay in Windows clipboard history (Win+V) if that is on; clear the entry.

Without the hooks or the token, Huddle works as a viewer and Desktop shows every prompt.

### Rollback

1. Delete the two Huddle entries from `~/.claude/settings.json` (keep the guard entry).
2. Run `reg delete HKCU\Environment /v HUDDLE_HOOK_TOKEN /f`. (`setx` with an empty value leaves an empty variable behind.)
3. Restart Claude Desktop, and every terminal and editor that runs Claude Code.

## Settings file

Huddle keeps its files in `%APPDATA%\Huddle`: `settings.json` and the token file `hook-token`. Electron names the folder after the product name. A folder first created as `%APPDATA%\huddle` keeps that spelling; Windows ignores case, so both are the same folder.

```
{ "hotkey": "Ctrl+Alt+H", "quiet": false, "collapsed": false, "terminalAnswering": false, "holdSeconds": 60 }
```

`hotkey` takes an Electron accelerator string. `terminalAnswering` turns prompt cards for terminal sessions on (`true`) or off (`false`, the default); the tray checkbox "Answer terminal prompts" sets it too. `holdSeconds` is how long a prompt card holds the hook before Desktop or the terminal takes over: a whole number from 5 to 300, 60 by default; it has no tray item, and a change takes effect only after a restart. Keep the hook `timeout` in `~/.claude/settings.json` above it (see the hook setup). Restart Huddle after editing the file by hand. A missing or broken value falls back to its default.

## Running next to the first version

Both versions use the app name Huddle, so they share the settings folder and the single-instance lock. Close the first version (tray, Quit) before starting 0.3.0; otherwise 0.3.0 exits silently.

## How it finds sessions

Huddle only reads local files; it never writes to them.

- Session list: `~/.claude/sessions/*.json`, kept current with a file watcher plus a 2 second poll. Sessions whose process is gone are dropped, and so are entries whose `pidDomain` is text that does not start with `win32` (WSL, another machine). An entry whose `pidDomain` is missing, `null` or not text is kept. When two files name the same session, the one with the newest `updatedAt` among those not proven stale counts.
- Host of a terminal session: one process table (pid, parent pid, name and start time of each process, through PowerShell's `Get-CimInstance Win32_Process`, cached for 5 seconds) and the visible windows of the programs above the session's process. Both run off the refresh path.
- Plan: each session's transcript under `~/.claude/projects/`, read backwards from the end until the latest plan is found, at most 8 MiB per read. Results are cached per file; a grown file is read on from where the last read stopped. A file that was rewritten rather than appended to, or that grew by more than 8 MiB, is read again from the end.

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

- For a Desktop session the arrow opens a `claude://` deep link. That link format is undocumented and may break with a Claude Desktop update. When the link cannot be opened, the arrow falls back to bringing the Claude Desktop window forward.
- Windows only.
- Full screen: the panel and toasts stay above borderless full-screen windows, not above exclusive full-screen apps (some games).
- Port 47821 is fixed.
- Write, Edit, MCP and other non-shell approvals always stay in Desktop.
- The progress view reads Desktop's undocumented transcript format; a format change turns the bar off until Huddle is updated.
- A plan whose latest full list lies more than 8 MiB from the end of the transcript when Huddle reads it from scratch is not found; the session then shows its status label.

Terminal sessions:

- The arrow picks the window by the session's folder name (the last part of its working directory) in the window title, as a whole name and ignoring case: "Huddle" matches "Huddle - README.md" or "~/code/Huddle/src", not "Huddle-terminal" or "Old-Huddle". Among several matching windows a normal one wins, then the topmost. With no match, the host's window is used only when it has exactly one normal window; otherwise the result is "not-found" and the arrow does nothing.
- The arrow brings the window forward but cannot select a tab or a split inside it.
- A click takes about one to two seconds, an estimate: a process-list read when the cache is older than 5 s, then a window list and the focus call; each PowerShell call compiles a small helper.
- The badge and the arrow need Windows PowerShell 5.1 with `Add-Type` allowed. Under Constrained Language Mode or app control (AppLocker, WDAC) there is no badge and the arrow does nothing.
- A session whose registry entry names a pid domain other than Windows (WSL, another machine) is not listed. A session whose host cannot be resolved (for example one running in WSL) gets no badge.
- Terminal sessions get no progress bar: the plan comes from Desktop's plan tool. They show the status label.
- A shell that Windows 11 starts in the default terminal from Start may have no resolvable host (not verified).

### Verified live (hook gate, 2026-11-20)

- Both hooks fire in the Desktop Code tab, before Desktop shows its own dialog.
- The token header is expanded from the user environment variable.
- The hook `session_id` matches the session registry.
- A hook answer to a question, and a hook allow and deny, are honored and suppress Desktop's dialog.

The hook gate ran before the `Origin` and `Host` checks were added: the server now answers 403 to any request with an `Origin` header or a `Host` other than `127.0.0.1:47821`. That check has not met the real Claude Code client yet.

### Not yet verified

- The `Origin`/`Host` rejection against the real Claude Code client. If the client sends an `Origin` header or another `Host`, every hook gets 403 and answering is dead without any sign; Desktop then handles every prompt.
- The round trip with the 64-character token (the gate used a shorter test token).
- Fall-through when Huddle is closed, and at the end of the hold.
- Whether Desktop shows a hook error on the instant 204 (no decision).
- The refusal round trip: an answer main refuses brings the card back and the prompt stays held.
- Crash recovery of the panel page, and the port retry.
- The separator used to join multi-select answers, and the exact label Claude receives.
- The interaction with the existing `pretool-guard` hook.
- What Claude Code does on a refused (over 64 KiB) payload that gets no decision.
- Clicking the toast cross with a real pointer.
- Two monitors and mixed DPI.
- The plan reader's real-world behaviour on very large transcripts (speed, and whether the plan is still found).
- Terminal sessions: that a hook answer is honored in a terminal and suppresses the terminal's own dialog (the reason `terminalAnswering` is off by default).
- A real arrow click from the panel on a terminal session (the window lookup and focus were checked from a script only).
- The Windows 11 default-terminal case (a shell started from Start).
- The badge and the arrow on managed machines with endpoint protection (EDR), which may block or slow the PowerShell calls.

## Privacy

Huddle reads `~/.claude` on your own machine. It makes no network requests beyond `127.0.0.1` and sends nothing anywhere. The hook server listens on `127.0.0.1` only and needs the token.

For terminal sessions Huddle reads the process table (pid, parent pid, name and start time of each process) and the window titles of the programs that may host a session. Both stay in memory only; they are never stored, logged or sent anywhere.

A command card shows the command only while the prompt is open; it is never stored or logged. The plan steps are read from the local transcript and kept in Huddle's memory while the session is shown; they are never written to disk, logged or sent anywhere.
