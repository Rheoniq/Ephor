'use strict';

// Pure helpers for a session's plan in the panel: the bar label
// ("5/7 Animations", "7/7 Done"), whether the bar shows, how full it is, and
// the checklist rows.
// The plan comes from the snapshot (panel.js snapshotPlan); its text is
// model output, so the renderer sets it with textContent only. Plain script:
// in the page it sets window.HuddleProgress, under Node it is a CommonJS
// module.

(function (root) {
  // The phase in the bar is cut to this many characters (the ellipsis
  // included); the title and the accessible name keep the whole text.
  const PHASE_MAX = 28;
  const ELLIPSIS = '\u2026';

  // Row marks and the words a screen reader hears for them.
  const MARKS = { completed: 'checked', in_progress: 'spinner', pending: 'empty' };
  const SPOKEN = { completed: 'Done', in_progress: 'Now', pending: 'To do' };

  function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // A plan the bar can show: whole numbers with 1 <= current <= total.
  function isPlan(plan) {
    return (
      isObject(plan) &&
      Array.isArray(plan.items) &&
      Number.isInteger(plan.total) &&
      plan.total >= 1 &&
      Number.isInteger(plan.current) &&
      plan.current >= 1 &&
      plan.current <= plan.total
    );
  }

  // Trimmed text cut to at most `max` UTF-16 units, the last one an
  // ellipsis when cut. Never leaves half a surrogate pair.
  function cutText(value, max) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length <= max) return text;
    let cut = text.slice(0, max - 1);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return cut.trimEnd() + ELLIPSIS;
  }

  function isComplete(plan) {
    return plan.state === 'complete';
  }

  // The bar label, or null when there is no plan to show. `text` is what the
  // bar reads; `title` (tooltip) and `spoken` (accessible name) have the
  // whole phase.
  function barLabel(plan) {
    if (!isPlan(plan)) return null;
    const total = plan.total;
    if (isComplete(plan)) {
      const title = total === 1 ? 'The 1 step is done' : `All ${total} steps done`;
      return {
        count: `${total}/${total}`,
        phase: 'Done',
        full: 'Done',
        text: `${total}/${total} Done`,
        title,
        spoken: title.charAt(0).toLowerCase() + title.slice(1),
        complete: true,
      };
    }
    const count = `${plan.current}/${total}`;
    const full = typeof plan.phase === 'string' ? plan.phase.trim() : '';
    const phase = cutText(full, PHASE_MAX);
    const where = `${plan.current} of ${total}`;
    return {
      count,
      phase,
      full,
      text: phase ? `${count} ${phase}` : count,
      title: full ? `Step ${where}: ${full}` : `Step ${where}`,
      spoken: full ? `step ${where}: ${full}` : `step ${where}`,
      complete: false,
    };
  }

  // Whether the status line shows the plan bar for a session with this
  // status ('busy', 'waiting', 'idle' or 'finished'). A busy session whose
  // plan is complete is working past its plan (a follow-up that made no new
  // plan), so it shows its Working tag instead of a full bar reading Done;
  // the session view's checklist still shows the plan. No plan, no bar.
  function showsBar(plan, status) {
    if (!isPlan(plan)) return false;
    return !(status === 'busy' && isComplete(plan));
  }

  // How full the bar is, 0 to 100: the current step over the total, or all
  // of it for a complete plan. Anything malformed is empty.
  function fillPercent(plan) {
    if (!isPlan(plan)) return 0;
    if (isComplete(plan)) return 100;
    return Math.min(100, Math.max(0, (plan.current / plan.total) * 100));
  }

  // One row per plan item, in order: its text, its status (unknown statuses
  // read as pending), the mark to draw, whether it is the active step, and
  // the word a screen reader hears before it. Items that are not objects or
  // have no text are skipped.
  function planRows(plan) {
    if (!isObject(plan) || !Array.isArray(plan.items)) return [];
    const rows = [];
    for (const item of plan.items) {
      if (!isObject(item)) continue;
      const raw = item.content;
      const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
      if (text === '') continue;
      const status = Object.prototype.hasOwnProperty.call(MARKS, item.status) ? item.status : 'pending';
      rows.push({
        text,
        status,
        mark: MARKS[status],
        active: status === 'in_progress',
        spoken: SPOKEN[status],
      });
    }
    return rows;
  }

  const api = { barLabel, showsBar, fillPercent, planRows, cutText, isPlan, PHASE_MAX };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleProgress = api;
})(typeof window !== 'undefined' ? window : globalThis);
