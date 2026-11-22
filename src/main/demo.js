'use strict';

// A demo plan: the items before `current` (1-based) are completed, item
// `current` is in progress and the rest are pending. `current` past the end
// gives a complete plan.
function demoPlan(contents, current) {
  return contents.map((content, i) => ({
    content,
    status: i + 1 < current ? 'completed' : i + 1 === current ? 'in_progress' : 'pending',
  }));
}

// Fixed fake sessions for HUDDLE_DEMO=1, so the UI can be checked without
// reading ~/.claude. `planItems` are update_plan items as the plan reader
// returns them (no key means no plan); `lastCommand` is the last shell
// command. Seven sessions, six of them shown: two run in a terminal
// (`source: 'terminal'`, no hostSessionId), the rest in Claude Desktop.
function demoSessions() {
  const now = Date.now();
  const base = { cwd: 'C:\\demo', pid: 0, updatedAt: now, source: 'desktop' };
  const terminal = { cwd: 'C:\\demo', pid: 0, updatedAt: now, source: 'terminal', entrypoint: 'cli' };
  return [
    {
      ...base,
      sessionId: 'demo-busy',
      hostSessionId: 'local_demo-busy',
      name: 'Write plan 5: the vault sync and backup rotation',
      status: 'busy',
      planItems: demoPlan(
        ['Read the spec', 'Plan model', 'Transcript reader', 'Snapshot wiring', 'Animations', 'Docs', 'Review'],
        5,
      ),
      lastCommand: 'npm test -- test/panel.test.js',
    },
    {
      ...base,
      sessionId: 'demo-waiting',
      hostSessionId: 'local_demo-waiting',
      name: 'Run plan 4, Tasks 7 to 9 and report back',
      status: 'waiting',
      planItems: demoPlan(['Read the plan', 'Watching', 'Task 7', 'Task 8', 'Task 9'], 2),
      lastCommand: 'npm test -- --watch=false',
    },
    {
      ...base,
      // `before` is demo only: main primes the first read with it, so this
      // session counts as gone busy to idle and shows as finished.
      sessionId: 'demo-finished',
      hostSessionId: 'local_demo-finished',
      name: 'Review the invoice export and fix the totals',
      status: 'idle',
      before: 'busy',
      planItems: demoPlan(['Read the export', 'Fix the totals', 'Add a test', 'Run the tests'], 5),
      lastCommand: 'npm test',
    },
    {
      ...base,
      // Plain idle: never shown in the panel.
      sessionId: 'demo-idle',
      hostSessionId: 'local_demo-idle',
      name: 'Notification sounds configuration',
      status: 'idle',
      lastCommand: 'git status',
    },
    {
      ...base,
      // No plan: the panel shows it without a bar.
      sessionId: 'demo-long',
      hostSessionId: 'local_demo-long',
      name: 'A very long session name with <b>x</b> markup that must be shown literally and truncated',
      status: 'busy',
      lastCommand: 'echo "<b>not bold</b>" > notes/<script>.md',
    },
    {
      ...terminal,
      // Terminal, busy past its complete plan (a follow-up that made no new
      // plan): the panel shows Working with no bar; the checklist is all
      // checked.
      sessionId: 'demo-drafting',
      // `host` is demo only: real terminal sessions get theirs from the
      // host lookup in main.
      host: 'Zed',
      name: 'Draft the newsletter for December',
      status: 'busy',
      planItems: demoPlan(['Collect the topics', 'Outline', 'Pick the hook', 'Drafting', 'Edit', 'Send to review'], 7),
      lastCommand: 'git diff --stat drafts/december.md',
    },
    {
      ...terminal,
      // Terminal, finished like demo-finished (busy before, idle now).
      sessionId: 'demo-term-finished',
      host: 'VS Code',
      name: 'Rename the client folders to the new scheme',
      status: 'idle',
      before: 'busy',
      planItems: demoPlan(['List the folders', 'Rename', 'Check the links'], 4),
      lastCommand: 'git status --short',
    },
  ];
}

// Fake hook bodies for HUDDLE_DEMO=1: one question prompt (a single-select
// then a multi-select question) and one permission prompt. Main parses them
// with the real parseHook, so the demo cards follow the same rules as real
// ones. Nothing is sent anywhere; an answer is only logged.
function demoPrompts() {
  return [
    {
      id: 'demo-ask',
      body: {
        session_id: 'demo-waiting',
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question:
                'Where should the vault sync keep the nightly backups, so that they survive a disk failure on this PC?',
              header: 'Storage',
              multiSelect: false,
              options: [
                { label: 'Local folder', description: 'Keep the backups on this PC' },
                { label: 'Google Drive', description: 'Sync to the company Drive' },
                { label: 'Both', description: 'Local first, then Drive' },
              ],
            },
            {
              question: 'Which checks run before a push?',
              header: 'Checks',
              multiSelect: true,
              options: [
                { label: 'Unit tests', description: 'npm test' },
                { label: 'Lint', description: 'eslint over src' },
                { label: 'Build', description: 'npm run dist' },
              ],
            },
          ],
        },
      },
    },
    {
      id: 'demo-permission',
      body: {
        session_id: 'demo-busy',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'npm run dist && echo "<b>built</b>" > dist/notes.txt' },
      },
    },
  ];
}

module.exports = { demoSessions, demoPrompts };
