'use strict';

// Huddle panel renderer. Session names and steps come from local files and
// prompt text comes from hook input: all of it is untrusted and only ever set
// with textContent, never innerHTML.

(function () {
  const STATUS = {
    busy: { label: 'Busy' },
    waiting: { label: 'Waiting for you' },
    idle: { label: 'Idle' },
  };
  // An idle session that just finished and was not looked at yet.
  const FINISHED = { label: 'Finished' };

  const panel = document.getElementById('panel');
  const list = document.getElementById('buddies');
  const count = document.getElementById('count');
  const collapseBtn = document.getElementById('collapse');
  const hideBtn = document.getElementById('hide');
  const quitBtn = document.getElementById('quit');
  const pill = document.getElementById('pill');
  const pillCount = document.getElementById('pill-count');
  const pillAlert = document.getElementById('pill-alert');
  const expanded = new Set(); // sessionIds whose step list is open
  const promptStates = new Map(); // prompt id -> HuddlePrompt state
  let sessions = [];
  let collapsed = false; // set by main through onUiState
  let armTimer = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function promptStateFor(prompt) {
    if (!prompt || typeof prompt.id !== 'string') return null;
    let st = promptStates.get(prompt.id);
    if (!st) {
      st = window.HuddlePrompt.createPromptState();
      if (!st.show(prompt)) return null;
      promptStates.set(prompt.id, st);
    }
    return st;
  }

  function promptButton(text, role, className) {
    const b = el('button', className ? `prompt-btn ${className}` : 'prompt-btn', text);
    b.type = 'button';
    b.dataset.role = role;
    return b;
  }

  function sendAnswers(id, result) {
    if (result.done) window.huddle.answer({ id, kind: 'ask', answers: result.answers });
    render();
  }

  // One question at a time; the answers go to main together after the last.
  function renderAsk(st, view) {
    const q = view.question;
    const multi = q.multiSelect === true;
    const card = el('div', 'prompt');
    const options = el('div', 'prompt-options');
    q.options.forEach((o, j) => {
      const label = str(o.label);
      const b = promptButton(label, `opt-${j}`);
      if (str(o.description)) b.title = str(o.description);
      if (multi) {
        const on = view.chosen.includes(label);
        b.classList.toggle('chosen', on);
        b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => {
          st.toggleOption(label);
          render();
        });
      } else {
        b.addEventListener('click', () => sendAnswers(view.id, st.answerQuestion(label)));
      }
      options.append(b);
    });
    if (multi) {
      const done = promptButton('Done', 'done', 'done');
      done.disabled = view.chosen.length === 0;
      done.addEventListener('click', () => sendAnswers(view.id, st.finishMulti()));
      options.append(done);
    }
    card.append(el('p', 'prompt-text', str(q.question)), options);
    return card;
  }

  // Re-render when a confirm click runs out, so "Confirm allow" turns back
  // into "Allow". Waits while a pointer is down so the press keeps its button.
  function scheduleArmExpiry() {
    clearTimeout(armTimer);
    const tick = () => {
      if (hold.isHeld()) armTimer = setTimeout(tick, 100);
      else render();
    };
    armTimer = setTimeout(tick, window.HuddlePrompt.ARM_MS + 50);
  }

  // Allow needs a second click MIN_CONFIRM_MS to ARM_MS after the first;
  // Deny is one click.
  function renderPermission(st, view) {
    const card = el('div', 'prompt permission');
    const summary = el('p', 'prompt-summary', str(view.summary));
    summary.title = str(view.summary);
    const allow = promptButton(view.armed ? 'Confirm allow' : 'Allow', 'allow', view.armed ? 'allow armed' : 'allow');
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
    const options = el('div', 'prompt-options');
    options.append(allow, deny);
    card.append(el('p', 'prompt-tool', str(view.toolName)), summary, options);
    return card;
  }

  // The card for a held prompt, or null (none, malformed, or already answered).
  function renderPrompt(prompt) {
    const st = promptStateFor(prompt);
    const view = st && st.current();
    // An answered card is hidden at once, but main may still ignore the
    // answer (it does not fit, or its timing is refused). The hold then runs
    // to its 15 s timeout and Desktop shows its own prompt.
    if (!view || view.answered) return null;
    return view.kind === 'ask' ? renderAsk(st, view) : renderPermission(st, view);
  }

  function renderBuddy(s) {
    const id = str(s.sessionId);
    const status = Object.prototype.hasOwnProperty.call(STATUS, s.status) ? s.status : 'idle';
    const name = str(s.name) || 'Untitled session';
    const isOpen = expanded.has(id);
    const isFinished = status === 'idle' && s.finished === true;
    const label = isFinished ? FINISHED.label : STATUS[status].label;

    const li = el('li', isFinished ? `buddy ${status} finished` : `buddy ${status}`);
    li.dataset.sessionId = id;

    const row = el('div', 'buddy-row');

    const body = el('button', 'buddy-body');
    body.type = 'button';
    body.dataset.role = 'body';
    body.setAttribute('aria-expanded', String(isOpen));
    body.title = name;
    const avatar = window.HuddleAvatar.createAvatar(document, id, status);
    const nameBox = el('span', 'name-box');
    nameBox.append(el('span', 'name', name));
    if (isFinished) {
      // Visible label; screen readers get it from the sr-only prefix.
      const tag = el('span', 'state-label', label);
      tag.setAttribute('aria-hidden', 'true');
      nameBox.append(tag);
    }
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

    row.append(body, open, dismiss);
    li.append(row);

    const card = s.prompt ? renderPrompt(s.prompt) : null;
    if (card) li.append(card);

    if (isOpen) {
      const steps = Array.isArray(s.steps) ? s.steps.filter((x) => typeof x === 'string') : [];
      const ol = el('ol', 'steps');
      ol.setAttribute('aria-label', 'Recent steps, newest first');
      if (steps.length === 0) ol.append(el('li', 'no-steps', 'No steps yet'));
      for (const step of steps.slice().reverse()) {
        const item = el('li', '', step);
        item.title = step;
        ol.append(item);
      }
      li.append(ol);
    }
    return li;
  }

  function render() {
    // Remember which control had focus so a re-render does not steal it.
    const active = document.activeElement;
    const focusId = active && active.closest('.buddy') ? active.closest('.buddy').dataset.sessionId : null;
    const focusRole = active && active.dataset ? active.dataset.role : null;

    const ids = new Set(sessions.map((s) => str(s.sessionId)));
    for (const id of expanded) if (!ids.has(id)) expanded.delete(id);
    // A prompt no longer in the snapshot was answered, timed out or ended.
    const promptIds = new Set(sessions.map((s) => (s && s.prompt ? s.prompt.id : null)));
    for (const id of promptStates.keys()) if (!promptIds.has(id)) promptStates.delete(id);

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

  window.huddle.onSnapshot((snapshot) => hold.push(snapshot));
})();
