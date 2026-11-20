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

module.exports = { demoSessions };
