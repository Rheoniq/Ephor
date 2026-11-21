'use strict';

// Fixed fake sessions for HUDDLE_DEMO=1, so the UI can be checked without
// reading ~/.claude. Steps are oldest first, like readSteps returns them.
function demoSessions() {
  const now = Date.now();
  const base = { cwd: 'C:\\demo', pid: 0, updatedAt: now };
  return [
    {
      ...base,
      sessionId: 'demo-busy',
      hostSessionId: 'local_demo-busy',
      name: 'Write plan 5: the vault sync and backup rotation',
      status: 'busy',
      steps: ['Read docs/plan.md', 'Edit src/vault.js', 'Ran: npm test'],
    },
    {
      ...base,
      sessionId: 'demo-waiting',
      hostSessionId: 'local_demo-waiting',
      name: 'Run plan 4, Tasks 7 to 9 and report back',
      status: 'waiting',
      steps: ['Edit src/a.js', 'Ran: npm test -- --watch=false', 'Asked you a question'],
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
      steps: ['Read src/export.js', 'Edit src/export.js', 'Ran: npm test'],
    },
    {
      ...base,
      // Plain idle: never shown in the panel.
      sessionId: 'demo-idle',
      hostSessionId: 'local_demo-idle',
      name: 'Notification sounds configuration',
      status: 'idle',
      steps: [],
    },
    {
      ...base,
      sessionId: 'demo-long',
      hostSessionId: 'local_demo-long',
      name: 'A very long session name with <b>x</b> markup that must be shown literally and truncated',
      status: 'busy',
      steps: ['Write <script>alert(1)</script>.md'],
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
              question: 'Which storage should the sync use?',
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
