'use strict';

// Huddle panel renderer. Session names and steps come from local files and
// are untrusted: they are only ever set with textContent, never innerHTML.

(function () {
  const STATUS = {
    busy: { glyph: '', label: 'Busy' },
    waiting: { glyph: '!', label: 'Waiting for you' },
    idle: { glyph: '', label: 'Idle' },
  };

  const panel = document.getElementById('panel');
  const list = document.getElementById('buddies');
  const count = document.getElementById('count');
  const collapseBtn = document.getElementById('collapse');
  const pill = document.getElementById('pill');
  const pillCount = document.getElementById('pill-count');
  const pillAlert = document.getElementById('pill-alert');
  const expanded = new Set(); // sessionIds whose step list is open
  let sessions = [];
  let collapsed = false; // set by main through onUiState

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function renderBuddy(s) {
    const id = str(s.sessionId);
    const status = Object.prototype.hasOwnProperty.call(STATUS, s.status) ? s.status : 'idle';
    const name = str(s.name) || 'Untitled session';
    const isOpen = expanded.has(id);

    const li = el('li', `buddy ${status}`);
    li.dataset.sessionId = id;

    const row = el('div', 'buddy-row');

    const body = el('button', 'buddy-body');
    body.type = 'button';
    body.dataset.role = 'body';
    body.setAttribute('aria-expanded', String(isOpen));
    body.title = name;
    const dot = el('span', `dot ${status}`, STATUS[status].glyph);
    dot.setAttribute('aria-hidden', 'true');
    body.append(dot, el('span', 'sr-only', `${STATUS[status].label}: `), el('span', 'name', name));
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

  function setCollapsed(b) {
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
  pill.addEventListener('click', () => {
    setCollapsed(false);
    window.huddle.setCollapsed(false);
  });

  window.huddle.onUiState((state) => {
    const next = !!(state && state.collapsed === true);
    if (next !== collapsed) setCollapsed(next);
  });

  window.huddle.onSnapshot((snapshot) => hold.push(snapshot));
})();
