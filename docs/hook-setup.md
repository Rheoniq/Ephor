# Hook setup for answering from the panel

Ephor answers prompts through two `http` hooks in Claude Code's user settings. Ephor never writes that file; you add the entries yourself.

## Where it goes

File: `~/.claude/settings.json` (on Windows `C:\Users\<user>\.claude\settings.json`), inside the existing top-level `"hooks"` object.

`hook-settings.json` in this folder (`docs`) shows the full shape. Only two things are new:

- In the `PreToolUse` array: one new object with `"matcher": "AskUserQuestion"`. The array keeps the existing `pretool-guard` entry exactly as it is; add the new object next to it, do not replace it.
- A new `PermissionRequest` key with one object and no `matcher`. It reaches Ephor for every tool; Ephor holds only Bash and PowerShell commands that pass the command rule below and answers every other request at once with no decision, so Desktop shows its own prompt.

The command rule: the tool is Bash or PowerShell; the command has at most 600 characters and at most 8 lines, with no 3 or more blank lines in a row; `tool_input` has no keys beyond `command`, `description` and `timeout`; the command has no control, invisible or blank-looking characters. The card then shows the whole command, with no scroll box. Everything else goes to Desktop at once.

Because the `PermissionRequest` hook has no matcher, Claude Code posts every permission request to Ephor, including Write and Edit with file contents up to 64 KiB, only to get a no-decision answer. The data stays on `127.0.0.1`. An optional `"matcher": "Bash|PowerShell"` on that object would keep other tools away from Ephor; it is not verified and is not in `hook-settings.json`.

Both new hooks use the same values:

- `"type": "http"`
- `"url": "http://127.0.0.1:47821/hook"`
- `"timeout": 70`
- `"headers": { "X-Ephor-Token": "$EPHOR_HOOK_TOKEN" }`
- `"allowedEnvVars": ["EPHOR_HOOK_TOKEN"]`

The `timeout` (in seconds) must be longer than Ephor's hold, the setting `holdSeconds` (default 60, see the README), in BOTH Ephor hook entries: the `PermissionRequest` entry and the `PreToolUse` entry with `"matcher": "AskUserQuestion"`. The default pairing is `"timeout": 70` with `holdSeconds` 60, as in `hook-settings.json`; an older setup with `"timeout": 20` needs `70` in both entries. A longer hold works the same way as long as both timeouts stay above it, for example `"timeout": 300` with `holdSeconds` 290. An entry whose timeout is shorter than the hold (for example the old `"timeout": 20`) is safe but wrong: Claude Code closes the connection early, the card vanishes after the shorter time, and the question stays open in the app. Ephor then shows the handover notice ("Answer waiting in <host>" in the list, and in the session view "This question is open in <host>. Ephor is not holding it." with an "Open <host>" button) and, once per run, a notice toast: "Claude Code closed a question after N s. Raise the hook timeout above the hold." The toast shows only when the session still waits for that answer at a refresh within 3 seconds; a hold Ephor ended itself (answer, release, hide, collapse, quiet, dismissal, the app answered first, terminal answering off, a crashed page, the hold running out, quit) never shows it, and quiet mode suppresses it without using up the once. The countdown ("Releases in N s") can also be wrong. Ephor never edits `~/.claude/settings.json`; you make this edit yourself.

`holdSeconds` lives in `%APPDATA%\Ephor\settings.json`: a whole number from 5 to 300, default 60. A change needs a restart of Ephor.

The card's "Answer in <app>" button ends the hold at once with no decision, so the app's own prompt appears, and brings that app to the front. The arrow of a session with a held prompt does the same ("Release the question and open <host>"); if the hold ended just before the click, the arrow only opens the app. Clicks in the first 500 ms after the card appears are ignored, for the arrow too. The release stands even if the app cannot be opened. A long hold keeps the app's own prompt hidden for that long unless you release it with the arrow or the button.

The placeholder strings in `hook-settings.json` (`EXISTING_...`) stand for your current entries; they are not text to paste. The existing `Stop` and `Notification` hooks stay unchanged.

The hooks apply to every Claude Code session on this machine (Desktop, terminals, IDEs, SDK), not only the ones Ephor shows. Ephor matches the hook's `session_id` against every registry session that is not dismissed (idle ones included), then the hook's transcript path. A session that is not in the registry, or is dismissed, gets no card: an immediate no-decision, so its own prompt appears without delay.

Terminal sessions (Zed, VS Code, Cursor, JetBrains or any terminal) are in the registry too, but their prompt cards are behind Ephor's setting `terminalAnswering` (tray checkbox "Answer terminal prompts"), off by default until the live check in a terminal passes. While it is off, a terminal session's hook gets an immediate no-decision, so the terminal's own prompt appears at once. Whether a hook answer is honored in a terminal, and suppresses the terminal's own dialog, is not yet verified live.

## Ephor's folder

Ephor keeps its files in `%APPDATA%\Ephor` (for example `C:\Users\<user>\AppData\Roaming\Ephor`): `settings.json` and the token file `hook-token`. Electron names the folder after the product name. A folder first created as `ephor` keeps that spelling; Windows ignores case, so it is the same folder.

## Token

The token is not in `settings.json`. Claude Code reads it from the Windows user environment variable `EPHOR_HOOK_TOKEN` and sends it in the header.

1. Start Ephor. It makes its token on first run in `%APPDATA%\Ephor\hook-token` (64 hex characters).
2. Right-click the tray icon and choose "Copy token setup command". The clipboard now holds `setx EPHOR_HOOK_TOKEN <token>`.
3. Paste it into a terminal and run it.
4. Restart Claude Desktop (quit it fully, including the tray icon), and every terminal and editor that runs Claude Code (Zed, VS Code, Windows Terminal and so on). A program only sees a new variable after a restart, and a Claude Code session gets its environment from the program that started it.

The hook gate used a 32-character test token. After the first start of 0.2.0, do steps 2 to 4 again, or every hook gets a 401 and Desktop shows its own prompts.

Until both are done, Ephor answers the hooks with 401 and Desktop shows its own prompts. To rotate the token, close Ephor, delete `%APPDATA%\Ephor\hook-token`, start Ephor, and repeat steps 2 to 4.

Note: the copy goes through the Windows clipboard, so Windows clipboard history (Win+V) may keep the token. Clear that entry if clipboard history is on.

## When Desktop handles the prompt

- The panel is hidden, quiet mode is on, or the session was dismissed.
- The session runs in a terminal and the setting `terminalAnswering` (tray "Answer terminal prompts") is off, the default: the terminal shows its own prompt at once. Turning the setting off while a terminal card is open hands that prompt back at once.
- The panel is collapsed by hand while a card is open: every open prompt goes back to Desktop.
- The panel page has crashed or not loaded yet, or Ephor is closed (the hook cannot connect). A crash loop (more than 3 crashes in 60 seconds) leaves the panel blank and answering off until Ephor is restarted. A crashed or unresponsive panel page ends all holds at once (detection of a hung page is not verified live).
- Nobody answers within the hold (the setting `holdSeconds`, 60 seconds by default; the hook timeout is 70 seconds). With an old `"timeout": 20` the hook ends after 20 seconds instead.
- You click "Answer in <app>" on the card: the prompt is released at once.
- The tool is not `AskUserQuestion`, Bash or PowerShell, or the command breaks the command rule above.
- An `AskUserQuestion` has more than 4 questions, a question has more than 4 options, or questions or option labels repeat.
- Port 47821 is in use: answering is off, a toast says so once per run (even with the panel open; session toasts show only while the panel is hidden or collapsed), the tray menu and tooltip show "Answering off: port 47821 in use", and Ephor retries every 30 seconds. Any other start failure shows "Answering off: hook server failed" and retries the same way.
- The hook body is over 64 KiB: it gets no decision (204).
- The Quit button (no confirmation) closes Ephor; answering stays off until Ephor is started again.

## Rollback

1. Delete the two new entries from `~/.claude/settings.json` (the `AskUserQuestion` object in `PreToolUse` and the `PermissionRequest` key). Leave the guard entry.
2. Run `reg delete HKCU\Environment /v EPHOR_HOOK_TOKEN /f`. Do not use `setx EPHOR_HOOK_TOKEN ""`: it leaves an empty variable behind.
3. Restart Claude Desktop, and every terminal and editor that runs Claude Code.

## Verified live (hook gate, 2026-11-20)

- Both hooks fire in the Claude Desktop Code tab, before Desktop shows its own dialog.
- The `$EPHOR_HOOK_TOKEN` header is expanded from the user environment variable (after a Desktop restart).
- The hook `session_id` equals the session registry `sessionId`.
- A `PreToolUse` answer for `AskUserQuestion` (`permissionDecision: allow` plus `updatedInput` with `questions` and `answers`) is honored: no Desktop dialog, and `PermissionRequest` does not fire afterwards.
- A `PermissionRequest` allow runs the tool; a deny stops it. Either way Desktop shows no dialog.
- `PermissionRequest` only fires when the session is in a mode that asks for permission.

The `Origin` and `Host` checks were added after this gate: the server answers 403 to any request with an `Origin` header or a `Host` other than `127.0.0.1:47821`.

## Not yet verified

- The `Origin`/`Host` rejection against the real Claude Code client. If the client sends an `Origin` header or another `Host`, every hook gets 403 and answering is dead without any sign; Desktop then handles every prompt.
- The round trip with the 64-character token.
- Fall-through when Ephor is closed, and at the end of the hold (expected: Desktop's prompt appears; Claude Code documents connection failure, non-2xx and timeout as non-blocking).
- "Answer in <app>" against a live hook: that the app's own prompt appears at once after the release.
- Whether Desktop shows a hook error on the instant 204 (no decision).
- The refusal round trip: an answer main refuses brings the card back and the prompt stays held.
- Crash recovery of the panel page, and the port retry.
- The `", "` separator Ephor uses to join multi-select answers, and the exact echoed label.
- Interaction with the `pretool-guard` hook (to be tested with a `Bash` call).
- What Claude Code does on the no-decision (204) for a payload over 64 KiB.
- Clicking the toast close cross with a real pointer.
- Two monitors and mixed DPI.
- Terminal sessions: that the hook `session_id` equals the registry `sessionId`, that a hook answer is honored and that it suppresses the terminal's own dialog. Until this passes, `terminalAnswering` stays off by default.
- The arrow's release against a live hook, and its plain open when the hold ended just before the click.
- The hook timeout notice against a real early close (a hook timeout shorter than the hold).
- The handover notice after a real hook timeout: that the session waits in the registry while the question is open in the app.
