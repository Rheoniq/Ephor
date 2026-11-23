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

// Fixed fake sessions for EPHOR_DEMO=1, so the UI can be checked without
// reading ~/.claude. `planItems` are update_plan items as the plan reader
// returns them (no key means no plan). `pendingAgents` is the number of
// background agents still running (no key means none); main turns an idle
// session with pending agents into busy, as it does for real sessions. Seven
// sessions, six of them shown: two run in a terminal (`source: 'terminal'`,
// no hostSessionId), the rest in Claude Desktop.
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
    },
    {
      ...base,
      sessionId: 'demo-waiting',
      hostSessionId: 'local_demo-waiting',
      name: 'Run plan 4, Tasks 7 to 9 and report back',
      status: 'waiting',
      planItems: demoPlan(['Read the plan', 'Watching', 'Task 7', 'Task 8', 'Task 9'], 2),
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
      // Its agents are done, so it shows as finished.
      pendingAgents: 0,
      planItems: demoPlan(['Read the export', 'Fix the totals', 'Add a test', 'Run the tests'], 5),
    },
    {
      ...base,
      // Plain idle: never shown in the panel.
      sessionId: 'demo-idle',
      hostSessionId: 'local_demo-idle',
      name: 'Notification sounds configuration',
      status: 'idle',
    },
    {
      ...base,
      // No plan: the panel shows it without a bar. Idle in the registry, but
      // two background agents still run, so it shows as working and never
      // as finished.
      sessionId: 'demo-long',
      hostSessionId: 'local_demo-long',
      name: 'A very long session name with <b>x</b> markup that must be shown literally and truncated',
      status: 'idle',
      pendingAgents: 2,
    },
    {
      ...terminal,
      // Terminal, busy past its complete plan (a follow-up that made no new
      // plan): no bar in the list, an all-checked checklist in its session
      // view. The demo-multi prompt makes it need you (Working without it).
      sessionId: 'demo-drafting',
      // `host` is demo only: real terminal sessions get theirs from the
      // host lookup in main.
      host: 'Zed',
      name: 'Draft the newsletter for December',
      status: 'busy',
      planItems: demoPlan(['Collect the topics', 'Outline', 'Pick the hook', 'Drafting', 'Edit', 'Send to review'], 7),
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
    },
  ];
}

// Fake hook bodies for EPHOR_DEMO=1: a question prompt (a single-select
// question with three options, then a multi-select one), a permission
// prompt, and a multi-select question for the terminal session hosted by
// Zed (its card offers "Answer in Zed"). Main parses them with the real
// parseHook, so the demo cards follow the same rules as real ones. Nothing
// is sent anywhere; an answer or a release is only logged.
// EPHOR_DEMO_PROMPTS=<id>,<id> keeps only those prompts (for example
// "demo-ask" for a list with a single session that needs you); empty or
// unset keeps all of them.
function demoPrompts(env = process.env) {
  const only = String(env.EPHOR_DEMO_PROMPTS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const all = allDemoPrompts();
  return only.length ? all.filter((p) => only.includes(p.id)) : all;
}

function allDemoPrompts() {
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
    {
      id: 'demo-multi',
      body: {
        session_id: 'demo-drafting',
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Which sections go into the December newsletter?',
              header: 'Sections',
              multiSelect: true,
              options: [
                { label: 'Product news', description: 'The two releases of this month' },
                { label: 'Client story', description: 'The case from the November workshop' },
                { label: 'Three short tips', description: 'How-tos for the new panel' },
              ],
            },
          ],
        },
      },
    },
  ];
}

module.exports = { demoSessions, demoPrompts };
