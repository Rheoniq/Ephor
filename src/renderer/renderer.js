'use strict';

// Huddle panel renderer. Session names, plan items and commands come from
// local files and prompt text comes from hook input: all of it is untrusted
// and only ever set with textContent, never innerHTML.

(function () {
  const STATUS = {
    busy: { label: 'Busy' },
    waiting: { label: 'Waiting for you' },
    idle: { label: 'Idle' },
  };
  // An idle session that just finished and was not looked at yet.
  const FINISHED = { label: 'Finished' };
  // Short visible tags under the name of a session without a plan; screen
  // readers get the label instead.
  const TAGS = { busy: 'Working', waiting: 'Needs you', finished: 'Finished' };
  // The chip on the plan label line. Busy has none: the bar says enough.
  const CHIPS = { waiting: 'Needs you', finished: 'Finished' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const panel = document.getElementById('panel');
  const list = document.getElementById('buddies');
  const count = document.getElementById('count');
  const collapseBtn = document.getElementById('collapse');
  const hideBtn = document.getElementById('hide');
  const quitBtn = document.getElementById('quit');
  const pill = document.getElementById('pill');
  const pillCount = document.getElementById('pill-count');
  const pillAlert = document.getElementById('pill-alert');
  const expanded = new Set(); // sessionIds whose plan checklist is open
  const promptStates = new Map(); // prompt id -> HuddlePrompt state
  // Prompt id -> performance.now() when this page first showed it. The line
  // that drains over the hold runs from there, across re-renders.
  const promptSeen = new Map();
  let sessions = [];
  // Avatar colors (task 3): sessionId -> palette index, so no two visible
  // sessions share a color. Updated on each render by HuddleColors.
  let colorOf = new Map();
  let collapsed = false; // set by main through onUiState
  let armTimer = null;
  let idSeq = 0; // for aria-labelledby ids, unique per page

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    return node;
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  // The session's avatar color, as createAvatar picks it.
  function colorFor(id) {
    const { PALETTE, colorIndex } = window.HuddleAvatar;
    const idx = colorOf.get(id);
    return PALETTE[Number.isInteger(idx) && idx >= 0 && idx < PALETTE.length ? idx : colorIndex(id)];
  }

  // --- Marks: drawn in SVG, colored by class or by the avatar color --------

  function markSvg(kind) {
    return svg('svg', {
      class: `mark mark-${kind}`,
      viewBox: '0 0 16 16',
      width: '16',
      height: '16',
      'aria-hidden': 'true',
      focusable: 'false',
    });
  }

  // A checked box: a filled rounded square with a check cut out of it.
  function checkedBox(className) {
    const node = markSvg('checked');
    if (className) node.classList.add(className);
    node.append(
      svg('rect', { class: 'box-fill', x: '1.5', y: '1.5', width: '13', height: '13', rx: '3.5' }),
      svg('path', { class: 'box-check', d: 'M4.6 8.3 7 10.6 11.5 5.6' }),
    );
    return node;
  }

  function emptyBox(className) {
    const node = markSvg('empty');
    if (className) node.classList.add(className);
    node.append(svg('rect', { class: 'box-line', x: '2', y: '2', width: '12', height: '12', rx: '3' }));
    return node;
  }

  // The active step: a ring with an arc in the session color. It spins only
  // when motion is welcome (style.css); otherwise it is a still ring.
  function spinner(color) {
    const node = markSvg('spinner');
    node.append(
      svg('circle', { class: 'spin-track', cx: '8', cy: '8', r: '5.5' }),
      svg('circle', { class: 'spin-arc', cx: '8', cy: '8', r: '5.5', stroke: color }),
    );
    return node;
  }

  // --- Prompt cards ---------------------------------------------------------

  function promptStateFor(prompt) {
    if (!prompt || typeof prompt.id !== 'string') return null;
    let st = promptStates.get(prompt.id);
    if (!st) {
      st = window.HuddlePrompt.createPromptState();
      if (!st.show(prompt)) return null;
      promptStates.set(prompt.id, st);
      if (!promptSeen.has(prompt.id)) promptSeen.set(prompt.id, performance.now());
    }
    return st;
  }

  function promptButton(text, role, className) {
    const b = el('button', className ? `prompt-btn ${className}` : 'prompt-btn', text);
    b.type = 'button';
    b.dataset.role = role;
    return b;
  }

  // The frame every prompt card shares: a small kicker naming where it comes
  // from, then the card's own content, then the hint and the line that
  // drains over the hold (decorative: hidden from screen readers, and still
  // when motion is reduced).
  function promptCard(kind, kicker, id, content) {
    const card = el('div', `prompt ${kind}`);
    const kick = el('p', 'prompt-kicker', kicker);
    kick.id = `prompt-kicker-${++idSeq}`;
    kick.title = kicker;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', kick.id);
    const drain = el('span', 'prompt-drain');
    drain.setAttribute('aria-hidden', 'true');
    drain.dataset.promptId = id;
    card.append(kick, ...content, el('p', 'prompt-hint', 'Or answer in Claude Desktop'), drain);
    return card;
  }

  function sendAnswers(id, result) {
    if (result.done) window.huddle.answer({ id, kind: 'ask', answers: result.answers });
    render();
  }

  // One question at a time; the answers go to main together after the last.
  // Each option is a full-width button with its label and, below it, its
  // description. Multi-select options carry a check box and end with Done.
  function renderAsk(st, view, sessionName) {
    const q = view.question;
    const multi = q.multiSelect === true;
    const options = el('div', 'prompt-options');
    q.options.forEach((o, j) => {
      const label = str(o.label);
      const description = str(o.description);
      const b = promptButton(undefined, `opt-${j}`, 'option');
      const text = el('span', 'opt-text');
      text.append(el('span', 'opt-label', label));
      if (description) text.append(el('span', 'opt-desc', description));
      if (multi) {
        const on = view.chosen.includes(label);
        b.classList.toggle('chosen', on);
        b.setAttribute('aria-pressed', String(on));
        b.append(on ? checkedBox('opt-mark') : emptyBox('opt-mark'));
        b.addEventListener('click', () => {
          st.toggleOption(label);
          render();
        });
      } else {
        b.addEventListener('click', () => sendAnswers(view.id, st.answerQuestion(label)));
      }
      b.append(text);
      options.append(b);
    });
    if (multi) {
      const done = promptButton('Done', 'done', 'done primary');
      done.disabled = view.chosen.length === 0;
      done.addEventListener('click', () => sendAnswers(view.id, st.finishMulti()));
      options.append(done);
    }
    return promptCard('ask', `Question from ${sessionName}`, view.id, [
      el('p', 'prompt-text', str(q.question)),
      options,
    ]);
  }

  // Renders now, or once no pointer is down, so a press keeps its button.
  function renderWhenFree() {
    if (hold.isHeld()) setTimeout(renderWhenFree, 100);
    else render();
  }

  // Re-render when a confirm click runs out, so "Confirm allow" turns back
  // into "Allow".
  function scheduleArmExpiry() {
    clearTimeout(armTimer);
    armTimer = setTimeout(renderWhenFree, window.HuddlePrompt.ARM_MS + 50);
  }

  // Allow needs a second click MIN_CONFIRM_MS to ARM_MS after the first;
  // Deny is one click. The whole command is shown, wrapped, with no scroll
  // box of its own.
  function renderPermission(st, view, sessionName) {
    const command = el('pre', 'prompt-command', str(view.command));
    const allow = promptButton(
      view.armed ? 'Confirm allow' : 'Allow',
      'allow',
      view.armed ? 'allow primary armed' : 'allow primary',
    );
    allow.addEventListener('click', () => {
      const wasArmed = st.confirmPending();
      if (st.armAllow() === 'send') {
        window.huddle.answer({ id: view.id, kind: 'permission', allow: true });
      } else if (!wasArmed && st.confirmPending()) {
        // A fresh arm: main records it too and takes the allow only after it.
        window.huddle.arm(view.id);
        scheduleArmExpiry();
      }
      render();
    });
    const deny = promptButton('Deny', 'deny', 'deny');
    deny.addEventListener('click', () => {
      if (st.deny()) window.huddle.answer({ id: view.id, kind: 'permission', allow: false });
      render();
    });
    const actions = el('div', 'prompt-actions');
    actions.append(deny, allow);
    const tool = str(view.toolName) || 'Shell';
    return promptCard('permission', `${tool} command from ${sessionName}`, view.id, [
      el('p', 'prompt-text', 'Run this command?'),
      command,
      actions,
    ]);
  }

  // The card for a held prompt, or null (none, malformed, or already answered).
  function renderPrompt(prompt, sessionName) {
    const st = promptStateFor(prompt);
    const view = st && st.current();
    // An answered card is hidden at once. If main refuses the answer (it
    // does not fit, or its timing is off), it says so and the card comes
    // back (onAnswerRefused below).
    if (!view || view.answered) return null;
    return view.kind === 'ask' ? renderAsk(st, view, sessionName) : renderPermission(st, view, sessionName);
  }

  // --- Plan: the bar under the name and the checklist ------------------------

  // A thin track filled to the current step, in the session's color.
  function progressBar(plan, color) {
    const bar = svg('svg', {
      class: 'bar',
      width: '100%',
      height: '4',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    bar.append(svg('rect', { class: 'bar-track', x: '0', y: '0', width: '100%', height: '4', rx: '2' }));
    const pct = window.HuddleProgress.fillPercent(plan);
    if (pct > 0) {
      bar.append(
        svg('rect', { class: 'bar-fill', x: '0', y: '0', width: `${pct.toFixed(2)}%`, height: '4', rx: '2', fill: color }),
      );
    }
    return bar;
  }

  // The status under the name: the plan bar with "5/7 Animations" and a chip
  // for waiting or finished, or the plain status tag when there is no plan.
  // Hidden from screen readers: the body button's name says the same, with
  // the whole phase. Returns null when there is nothing to show.
  function statusLine(plan, label, kind, color) {
    if (!label) {
      const tagText = TAGS[kind];
      if (!tagText) return null;
      const tag = el('span', 'state-label', tagText);
      tag.setAttribute('aria-hidden', 'true');
      return tag;
    }
    const box = el('span', label.complete ? 'progress complete' : 'progress');
    box.setAttribute('aria-hidden', 'true');
    box.title = label.title;
    const line = el('span', 'progress-line');
    line.append(el('span', 'progress-count', label.count));
    if (label.phase) line.append(el('span', 'progress-phase', label.phase));
    if (CHIPS[kind]) line.append(el('span', `chip chip-${kind}`, CHIPS[kind]));
    box.append(progressBar(plan, color), line);
    return box;
  }

  // The expanded view: every plan step (a checked box when done, a spinner
  // for the active one, an empty box when still to do), then the last
  // command. Without a plan only the command shows, or "No plan yet".
  function renderDetails(s, label, color) {
    const box = el('div', 'details');
    const rows = window.HuddleProgress.planRows(s.plan);
    if (rows.length > 0) {
      const ol = el('ol', 'plan');
      ol.setAttribute('aria-label', label ? `Plan, ${label.spoken}` : 'Plan');
      for (const r of rows) {
        const item = el('li', r.active ? `plan-item ${r.status} active` : `plan-item ${r.status}`);
        const mark = r.mark === 'checked' ? checkedBox() : r.mark === 'spinner' ? spinner(color) : emptyBox();
        const text = el('span', 'plan-text');
        text.append(el('span', 'sr-only', `${r.spoken}: `), document.createTextNode(r.text));
        item.append(mark, text);
        ol.append(item);
      }
      box.append(ol);
    }
    const cmd = str(s.lastCommand);
    if (cmd) {
      const line = el('p', 'last-command');
      line.append(el('span', 'last-label', 'Last command:'), ' ', el('span', 'last-cmd', cmd));
      box.append(line);
    } else if (rows.length === 0) {
      box.append(el('p', 'no-plan', 'No plan yet'));
    }
    return box;
  }

  function renderBuddy(s) {
    const id = str(s.sessionId);
    const status = Object.prototype.hasOwnProperty.call(STATUS, s.status) ? s.status : 'idle';
    const name = str(s.name) || 'Untitled session';
    const isOpen = expanded.has(id);
    const isFinished = status === 'idle' && s.finished === true;
    const label = isFinished ? FINISHED.label : STATUS[status].label;
    const kind = isFinished ? 'finished' : status;
    const color = colorFor(id);
    const bar = window.HuddleProgress.barLabel(s.plan);

    const li = el('li', isFinished ? `buddy ${status} finished` : `buddy ${status}`);
    li.dataset.sessionId = id;

    const row = el('div', 'buddy-row');

    // A held prompt sits right under the name, above the status line, so it
    // is the first thing seen; the status line then moves below the card.
    const card = s.prompt ? renderPrompt(s.prompt, name) : null;
    const line = statusLine(s.plan, bar, kind, color);

    const body = el('button', 'buddy-body');
    body.type = 'button';
    body.dataset.role = 'body';
    body.setAttribute('aria-expanded', String(isOpen));
    body.title = name;
    const avatar = window.HuddleAvatar.createAvatar(document, id, status, colorOf.get(id));
    const nameBox = el('span', 'name-box');
    nameBox.append(el('span', 'name', name));
    // Screen readers hear the status first and the whole plan step last.
    if (bar) nameBox.append(el('span', 'sr-only', `, ${bar.spoken}`));
    if (line && !card) nameBox.append(line);
    body.append(avatar, el('span', 'sr-only', `${label}: `), nameBox);
    body.addEventListener('click', () => {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
    });

    const open = el('button', 'icon-btn open', '→');
    open.type = 'button';
    open.dataset.role = 'open';
    open.setAttribute('aria-label', `Open ${name} in Claude Desktop`);
    open.title = 'Open in Claude Desktop';
    open.addEventListener('click', () => {
      window.huddle.open(str(s.hostSessionId)).catch(() => {});
    });

    const dismiss = el('button', 'icon-btn dismiss', '×');
    dismiss.type = 'button';
    dismiss.dataset.role = 'dismiss';
    dismiss.setAttribute('aria-label', `Hide ${name} from the panel`);
    dismiss.title = 'Hide until new activity';
    dismiss.addEventListener('click', () => window.huddle.dismiss(id));

    // Open and hide stacked at the right of the row, open on top; the DOM
    // order keeps the tab order (open, then hide).
    const actions = el('div', 'row-actions');
    actions.append(open, dismiss);
    row.append(body, actions);
    li.append(row);

    if (card) {
      li.append(card);
      if (line) {
        const after = el('div', 'after-prompt');
        after.append(line);
        li.append(after);
      }
    }

    if (isOpen) li.append(renderDetails(s, bar, color));
    return li;
  }

  // The drain line of each prompt card and the spinners are CSS animations,
  // and a re-render builds new elements. Each new animation is moved to where
  // it would be: the drain to the time since the prompt was first shown, the
  // spinners to one shared clock, so neither jumps back. Under reduced motion
  // there are no animations and nothing to move.
  function syncAnimations() {
    const now = performance.now();
    for (const drain of list.querySelectorAll('.prompt-drain')) {
      const seen = promptSeen.get(drain.dataset.promptId);
      if (seen === undefined) continue;
      for (const a of drain.getAnimations()) a.currentTime = Math.max(0, now - seen);
    }
    for (const spin of list.querySelectorAll('.mark-spinner')) {
      for (const a of spin.getAnimations()) {
        const d = a.effect ? a.effect.getComputedTiming().duration : 0;
        if (typeof d === 'number' && d > 0) a.currentTime = now % d;
      }
    }
  }

  function render() {
    // Remember which control had focus so a re-render does not steal it.
    const active = document.activeElement;
    const focusId = active && active.closest('.buddy') ? active.closest('.buddy').dataset.sessionId : null;
    const focusRole = active && active.dataset ? active.dataset.role : null;

    const ids = new Set(sessions.map((s) => str(s.sessionId)));
    for (const id of expanded) if (!ids.has(id)) expanded.delete(id);
    // Avatar colors (task 3): keep, free and hand out palette indexes.
    colorOf = window.HuddleColors.assignColors([...ids], colorOf, window.HuddleAvatar.PALETTE.length);
    // A prompt no longer in the snapshot was answered, timed out or ended.
    const promptIds = new Set(sessions.map((s) => (s && s.prompt ? s.prompt.id : null)));
    for (const id of promptStates.keys()) if (!promptIds.has(id)) promptStates.delete(id);
    for (const id of promptSeen.keys()) if (!promptIds.has(id)) promptSeen.delete(id);

    count.textContent = sessions.length ? String(sessions.length) : '';
    panel.classList.toggle('collapsed', collapsed);

    if (collapsed) {
      // Pill only: the session count and a "!" when any session waits.
      const waiting = sessions.filter((s) => s.status === 'waiting').length;
      pillCount.textContent = String(sessions.length);
      pillAlert.hidden = waiting === 0;
      const label = `Expand panel, ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`;
      pill.setAttribute('aria-label', waiting ? `${label}, ${waiting} waiting for you` : label);
      list.replaceChildren();
      reportHeight();
      return;
    }

    list.replaceChildren(...sessions.map(renderBuddy));
    if (sessions.length === 0) list.append(el('li', 'empty', 'No sessions'));

    if (focusId !== null && focusRole) {
      for (const li of list.children) {
        if (li.dataset.sessionId === focusId) {
          const target = li.querySelector(`[data-role="${focusRole}"]`);
          if (target) target.focus();
          break;
        }
      }
    }
    syncAnimations();
    reportHeight();
  }

  function reportHeight() {
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const h = rect.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    window.huddle.reportHeight(Math.ceil(h));
  }

  new ResizeObserver(reportHeight).observe(panel);

  const hold = window.HuddleHold.createSnapshotHold((snapshot) => {
    sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    render();
  });

  // While a pointer is down on the list, snapshots wait so the pressed button
  // stays the same element until the click lands.
  function release() {
    hold.up();
    // Deferred so the click that follows pointerup fires on the old button first.
    setTimeout(hold.flush, 0);
  }
  list.addEventListener('pointerdown', () => hold.down());
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
  document.documentElement.addEventListener('pointerleave', release);

  // Dragging the collapsed pill. The pill is a button, so an app-region drag
  // area would swallow its click; instead the pointer's offset in screen
  // coordinates goes to main (at most once per animation frame), and main
  // moves the window. A press that moved less than the threshold is a click.
  const dragTracker = window.HuddleDrag.createDragTracker({ threshold: window.HuddleDrag.DEFAULT_THRESHOLD });
  let dragPointer = null; // pointerId of the press on the pill, or null
  let dragSent = false; // drag-start went to main for this press
  let dragFrame = 0;
  let dragPending = null; // latest { dx, dy } not sent yet
  let skipClick = false; // the press that just ended was a drag

  function sendDragFrame() {
    dragFrame = 0;
    if (!dragPending) return;
    window.huddle.dragTo(dragPending.dx, dragPending.dy);
    dragPending = null;
  }

  // Ends the current press on the pill; true when it was a drag.
  function endPillDrag() {
    if (dragPointer === null) return false;
    const id = dragPointer;
    dragPointer = null;
    try {
      if (pill.hasPointerCapture(id)) pill.releasePointerCapture(id);
    } catch {
      // The pointer is already gone.
    }
    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      sendDragFrame(); // the last position still goes out
    }
    dragPending = null;
    const { wasDrag } = dragTracker.end();
    if (dragSent) window.huddle.dragEnd();
    dragSent = false;
    return wasDrag;
  }

  pill.addEventListener('pointerdown', (e) => {
    skipClick = false;
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    endPillDrag();
    dragPointer = e.pointerId;
    dragTracker.start(e.screenX, e.screenY);
    try {
      // A fast drag keeps the pointer even when it leaves the pill.
      pill.setPointerCapture(e.pointerId);
    } catch {
      // Capture failed; the drag still works while over the pill.
    }
  });
  pill.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragPointer) return;
    // A mouse with no button down: the release was missed, so the press ends.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      endPillDrag();
      return;
    }
    const m = dragTracker.move(e.screenX, e.screenY);
    if (!m.dragging) return;
    if (!dragSent) {
      dragSent = true;
      window.huddle.dragStart();
    }
    dragPending = { dx: m.dx, dy: m.dy };
    if (!dragFrame) dragFrame = requestAnimationFrame(sendDragFrame);
  });
  pill.addEventListener('pointerup', (e) => {
    if (e.pointerId !== dragPointer) return;
    if (endPillDrag()) skipClick = true;
  });
  pill.addEventListener('pointercancel', (e) => {
    if (e.pointerId === dragPointer) endPillDrag();
  });
  pill.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId === dragPointer) endPillDrag();
  });

  function setCollapsed(b) {
    if (!b) endPillDrag();
    const wasFocused = document.activeElement === collapseBtn || document.activeElement === pill;
    collapsed = b;
    render();
    // Keep keyboard focus on the control that now stands in for the old one.
    if (wasFocused) (collapsed ? pill : collapseBtn).focus();
  }

  collapseBtn.addEventListener('click', () => {
    setCollapsed(true);
    window.huddle.setCollapsed(true);
  });
  pill.addEventListener('click', (e) => {
    // A press that dragged the pill does not also expand it. Enter and Space
    // give a click with detail 0 and always expand.
    const afterDrag = skipClick && e.detail !== 0;
    skipClick = false;
    if (afterDrag) return;
    setCollapsed(false);
    window.huddle.setCollapsed(false);
  });

  // Hide works like the hotkey; Quit ends the app (held prompts go back to
  // Desktop). Main checks that both come from this window.
  hideBtn.addEventListener('click', () => window.huddle.hide());
  quitBtn.addEventListener('click', () => window.huddle.quit());

  window.huddle.onUiState((state) => {
    if (state && typeof state.hideTitle === 'string') hideBtn.title = state.hideTitle;
    const next = !!(state && state.collapsed === true);
    if (next !== collapsed) setCollapsed(next);
  });

  // Main refused an answer or an arm: the card is shown again, unarmed.
  window.huddle.onAnswerRefused((payload) => {
    const id = window.HuddlePrompt.refusedId(payload);
    const st = id === null ? null : promptStates.get(id);
    if (st && st.refused()) renderWhenFree();
  });

  window.huddle.onSnapshot((snapshot) => hold.push(snapshot));
})();
