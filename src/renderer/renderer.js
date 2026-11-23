'use strict';

// Huddle panel renderer. Session names, plan items and commands come from
// local files and prompt text comes from hook input: all of it is untrusted
// and only ever set with textContent, never innerHTML.
//
// Two views (view.js): the list of sessions, and one session with a back
// arrow, its prompt card and its plan. A prompt card is shown only in the
// session view; the list marks the session "Needs you".

(function () {
  // Words a screen reader hears before a session's name, per card kind
  // (HuddleView.cardKind).
  const SPOKEN = { 'needs-you': 'Needs you', finished: 'Finished', busy: 'Busy', idle: 'Idle' };
  // The chip on a card's status line. Busy has none: the bar says enough.
  const CHIPS = { 'needs-you': 'Needs you', finished: 'Finished' };
  // After the open session's last prompt is answered or released, the view
  // goes back to the list after this long, unless a new prompt comes first.
  const RETURN_MS = 700;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Outline icons on a 24 px grid, drawn with the stroke in style.css.
  const ICONS = {
    'arrow-right': ['M5 12h14', 'M13 18l6-6', 'M13 6l6 6'],
    'arrow-left': ['M5 12h14', 'M5 12l6 6', 'M5 12l6-6'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    external: ['M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6', 'M11 13l9-9', 'M15 4h5v5'],
  };

  const panel = document.getElementById('panel');
  const list = document.getElementById('buddies');
  const sessionView = document.getElementById('session-view');
  const count = document.getElementById('count');
  const collapseBtn = document.getElementById('collapse');
  const hideBtn = document.getElementById('hide');
  const quitBtn = document.getElementById('quit');
  const pill = document.getElementById('pill');
  const pillCount = document.getElementById('pill-count');
  const pillAlert = document.getElementById('pill-alert');
  const view = window.HuddleView.createViewState();
  const promptStates = new Map(); // prompt id -> HuddlePrompt state
  // Prompt id -> performance.now() when a snapshot first brought it. The
  // countdown and the line that drains over the hold run from there, also
  // when the card itself is first seen later (its session opened later).
  const promptSeen = new Map();
  // Prompt id -> the hold in ms from the snapshot's holdMs (HuddlePrompt
  // holdMsOf), for the countdown and the drain line.
  const promptHold = new Map();
  let sessions = [];
  // Avatar colors: sessionId -> palette index, so no two visible sessions
  // share a color. Updated on each render by HuddleColors.
  let colorOf = new Map();
  let collapsed = false; // set by main through onUiState
  let armTimer = null;
  let returnTimer = null;
  let returnFor = null; // the session the pending return is for
  let countdownTimer = null;
  // The prompt id whose card the last render showed, or null. A card that
  // was not on screen in the last render comes back with a new minimum age.
  let lastCardId = null;
  // The session whose handover notice the last render showed, or null, and
  // when that notice appeared: its Open button ignores a click younger than
  // the minimum age, like the release button.
  let lastNoticeId = null;
  let noticeShownAt = 0;
  // What the last render showed ('pill', 'list' or 'session'): a list that
  // comes back gives the held prompts a new minimum age, as their arrows may
  // sit under the cursor.
  let lastViewKind = null;

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

  function icon(name, size) {
    const px = String(size || 16);
    const node = svg('svg', {
      class: `icon icon-${name}`,
      viewBox: '0 0 24 24',
      width: px,
      height: px,
      'aria-hidden': 'true',
      focusable: 'false',
    });
    for (const d of ICONS[name]) node.append(svg('path', { d }));
    return node;
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function sessionById(id) {
    return sessions.find((s) => s && str(s.sessionId) === id) || null;
  }

  // The session's avatar color, as createAvatar picks it.
  function colorFor(id) {
    const { PALETTE, colorIndex } = window.HuddleAvatar;
    const idx = colorOf.get(id);
    return PALETTE[Number.isInteger(idx) && idx >= 0 && idx < PALETTE.length ? idx : colorIndex(id)];
  }

  // What every view needs to know about one session.
  function facts(s, needs) {
    const id = str(s.sessionId);
    const status = ['busy', 'waiting', 'idle'].includes(s.status) ? s.status : 'idle';
    const isTerminal = s.source === 'terminal';
    return {
      id,
      status,
      name: str(s.name) || 'Untitled session',
      kind: window.HuddleView.cardKind(s, needs.has(id)),
      color: colorFor(id),
      bar: window.HuddleProgress.barLabel(s.plan),
      isTerminal,
      host: isTerminal ? str(s.host) : '',
    };
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

  // --- Shared pieces ---------------------------------------------------------

  // The arrow that opens the session's app: Claude Desktop, or for a
  // terminal session the window that hosts it. With the host not known yet
  // it stays enabled and main looks it up on click.
  //
  // While the session has a held prompt the arrow releases it first (the same
  // call as the "Answer in <app>" button, with the same early-click guard);
  // main then opens the app. Without one it only opens the app.
  function openButton(s, f) {
    const open = el('button', 'icon-btn open');
    open.type = 'button';
    open.dataset.role = 'open';
    let openTip = 'Open in Claude Desktop';
    let openLabel = `Open ${f.name} in Claude Desktop`;
    if (f.isTerminal && f.host) {
      openTip = `Open in ${f.host}`;
      openLabel = `Open ${f.name} in ${f.host}`;
    } else if (f.isTerminal) {
      openTip = 'Open the terminal window';
      openLabel = `Open the terminal window of ${f.name}`;
    }
    const releaseText = window.HuddlePrompt.arrowText({
      hasHeldPrompt: heldPromptId(s) !== null,
      source: s.source,
      host: f.host,
    });
    if (releaseText) {
      openTip = releaseText;
      openLabel = releaseText;
    }
    open.setAttribute('aria-label', openLabel);
    open.title = openTip;
    open.append(icon('arrow-right'));
    open.addEventListener('click', () => {
      const held = heldPromptId(s);
      if (window.HuddlePrompt.arrowAction({ hasHeldPrompt: held !== null }) === 'release') {
        // Younger than the minimum age: ignored, nothing is released.
        if (promptStates.get(held).release()) {
          window.huddle.release(held).catch(() => 'failed');
          render();
        }
        return;
      }
      window.huddle.open(openTargetOf(s, f)).catch(() => {});
    });
    return open;
  }

  // The target main opens: Claude Desktop, or the terminal's host window.
  function openTargetOf(s, f) {
    return f.isTerminal
      ? { kind: 'terminal', sessionId: f.id }
      : { kind: 'desktop', hostSessionId: str(s.hostSessionId) };
  }

  // The id of the session's held prompt while it can still be released (its
  // card is not answered or released yet), else null.
  function heldPromptId(s) {
    if (!s.prompt || typeof s.prompt.id !== 'string') return null;
    const st = promptStates.get(s.prompt.id);
    const pv = st ? st.current() : null;
    return pv && !pv.answered && !pv.released ? s.prompt.id : null;
  }

  // The handover notice for a session, or null (see HuddlePrompt).
  function noticeFor(s, f) {
    return window.HuddlePrompt.handoverNotice({
      status: f.status,
      hasPrompt: !!s.prompt,
      source: s.source,
      host: f.host,
    });
  }

  // The program that hosts a terminal session (Zed, VS Code), or null.
  function hostBadge(f) {
    return f.host ? el('span', 'host-badge', f.host) : null;
  }

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

  // The bar with "5/7 Animations" below it, and the chip when `chip` is set.
  // Hidden from screen readers: the names around it say the same, with the
  // whole phase.
  function progressBlock(plan, label, color, chip, kind) {
    const box = el('span', label.complete ? 'progress complete' : 'progress');
    box.setAttribute('aria-hidden', 'true');
    box.title = label.title;
    const line = el('span', 'progress-line');
    line.append(el('span', 'progress-count', label.count));
    if (label.phase) line.append(el('span', 'progress-phase', label.phase));
    if (chip) line.append(el('span', `chip chip-${kind}`, chip));
    box.append(progressBar(plan, color), line);
    return box;
  }

  // The line under a name with no bar to show (no plan, or a busy session
  // past its complete plan): the chip, or "Working" for a busy session.
  // Hidden from screen readers like the bar. null when there is nothing.
  function tagLine(kind, noChip) {
    if (CHIPS[kind]) {
      if (noChip) return null;
      const line = el('span', 'tag-line');
      line.setAttribute('aria-hidden', 'true');
      line.append(el('span', `chip chip-${kind}`, CHIPS[kind]));
      return line;
    }
    if (kind !== 'busy') return null;
    const tag = el('span', 'state-label', 'Working');
    tag.setAttribute('aria-hidden', 'true');
    return tag;
  }

  // --- List view -------------------------------------------------------------

  // One card per session: avatar, name (and host badge), the bar or a tag,
  // "Question waiting" while a prompt is held, and the open and hide buttons
  // stacked at the right. The card body opens the session view.
  function renderBuddy(s, needs) {
    const f = facts(s, needs);
    const li = el('li', `buddy ${f.status} kind-${f.kind}`);
    li.dataset.sessionId = f.id;

    const body = el('button', 'buddy-body');
    body.type = 'button';
    body.dataset.role = 'body';
    body.title = f.name;
    const avatar = window.HuddleAvatar.createAvatar(document, f.id, f.status, colorOf.get(f.id));

    const nameBox = el('span', 'name-box');
    const nameLine = el('span', 'name-line');
    nameLine.append(el('span', 'name', f.name));
    const badge = hostBadge(f);
    if (badge) nameLine.append(badge);
    nameBox.append(nameLine);
    // Screen readers hear the state first and the whole plan step last.
    if (f.bar) nameBox.append(el('span', 'sr-only', `, ${f.bar.spoken}`));
    if (window.HuddleProgress.showsBar(s.plan, f.status) && f.bar) {
      nameBox.append(progressBlock(s.plan, f.bar, f.color, CHIPS[f.kind], f.kind));
    } else {
      const tag = tagLine(f.kind);
      if (tag) nameBox.append(tag);
    }
    if (s.prompt) {
      nameBox.append(el('span', 'sr-only', ', question waiting'));
      const waiting = el('span', 'waiting-line', 'Question waiting');
      waiting.setAttribute('aria-hidden', 'true');
      nameBox.append(waiting);
    } else {
      // Waiting, but Huddle holds no card: the question is open in the app.
      const notice = noticeFor(s, f);
      if (notice) {
        nameBox.append(el('span', 'sr-only', `, ${notice.listLine}`));
        const line = el('span', 'waiting-line handover-line', notice.listLine);
        line.setAttribute('aria-hidden', 'true');
        nameBox.append(line);
      }
    }
    body.append(avatar, el('span', 'sr-only', `${SPOKEN[f.kind]}: `), nameBox);
    body.addEventListener('click', () => openSession(f.id));

    const dismiss = el('button', 'icon-btn dismiss');
    dismiss.type = 'button';
    dismiss.dataset.role = 'dismiss';
    dismiss.setAttribute('aria-label', `Hide ${f.name} from the panel`);
    dismiss.title = 'Hide until new activity';
    dismiss.append(icon('x'));
    dismiss.addEventListener('click', () => window.huddle.dismiss(f.id));

    // Open and hide stacked at the right of the row, open on top; the DOM
    // order keeps the tab order (body, open, hide).
    const actions = el('div', 'row-actions');
    actions.append(openButton(s, f), dismiss);
    const row = el('div', 'buddy-row');
    row.append(body, actions);
    li.append(row);
    return li;
  }

  // --- Prompt cards (session view only) -------------------------------------

  function promptStateFor(prompt) {
    if (!prompt || typeof prompt.id !== 'string') return null;
    let st = promptStates.get(prompt.id);
    if (!st) {
      st = window.HuddlePrompt.createPromptState();
      if (!st.show(prompt)) return null;
      promptStates.set(prompt.id, st);
    } else if (lastCardId !== prompt.id) {
      // Back on screen after the list or the pill: maybe under the cursor.
      st.shownAgain();
    }
    return st;
  }

  function promptButton(text, role, className) {
    const b = el('button', className ? `prompt-btn ${className}` : 'prompt-btn', text);
    b.type = 'button';
    b.dataset.role = role;
    return b;
  }

  // Whole seconds left of the hold, as text. The hold starts when a snapshot
  // first brought the prompt and lasts its holdMs.
  function countdownFor(id) {
    const seen = promptSeen.get(id);
    const elapsed = seen === undefined ? 0 : performance.now() - seen;
    return window.HuddlePrompt.countdownText(promptHold.get(id), elapsed);
  }

  // Under the options: "Answer in <app>" (frees the prompt here and opens
  // the app where it can be answered instead) and the time left of the
  // hold, then a line that drains over the hold (decorative: hidden from
  // screen readers and still when motion is reduced; the text is the time
  // cue, updated at most once a second and never announced).
  function promptFoot(st, id, s, released) {
    const label = window.HuddlePrompt.releaseLabel(s.source, s.host);
    const releaseBtn = el('button', 'release-btn');
    releaseBtn.type = 'button';
    releaseBtn.dataset.role = 'release';
    releaseBtn.title = window.HuddlePrompt.releaseTitle(s.source, s.host);
    releaseBtn.append(icon('external', 14), el('span', 'release-text', label));
    releaseBtn.disabled = released;
    releaseBtn.addEventListener('click', () => {
      // A click on a card younger than MIN_AGE_MS is ignored, like the
      // options. The release stands even if the app does not open. The card
      // turns inert at once (no stale "Confirm allow", no live options); the
      // next snapshot drops it. The disabled button cannot keep focus, so it
      // moves to the back button (Escape still goes back from there).
      if (st.release()) {
        window.huddle.release(id).catch(() => 'failed');
        render({ focus: { sessionId: str(s.sessionId), role: 'back' } });
      }
    });
    const left = el('span', 'prompt-countdown', countdownFor(id));
    left.dataset.promptId = id;
    left.setAttribute('aria-live', 'off');
    const foot = el('div', 'prompt-foot');
    foot.append(releaseBtn, left);

    const holdMs = promptHold.has(id) ? promptHold.get(id) : window.HuddlePrompt.holdMsOf(null);
    const track = el('div', 'prompt-drain-track');
    track.setAttribute('aria-hidden', 'true');
    const drain = el('span', 'prompt-drain');
    drain.dataset.promptId = id;
    drain.dataset.holdMs = String(holdMs);
    // The drain runs over the hold from the payload (style.css reads
    // --hold-ms). Set through the CSSOM, which the CSP allows.
    drain.style.setProperty('--hold-ms', `${holdMs}ms`);
    track.append(drain);
    return [foot, track];
  }

  // The frame every prompt card shares: the kicker, the card's own content,
  // then the release row and the drain line. The group is named by the
  // kicker and described by the elements whose ids are in describedBy (the
  // question or the command); all ids come from the prompt id, so they hold
  // across renders.
  function promptCard(kind, kicker, st, pv, content, describedBy, s) {
    const id = pv.id;
    const card = el('div', `prompt ${kind}`);
    const kick = el('p', 'prompt-kicker', kicker);
    kick.id = window.HuddlePrompt.promptDomIds(id).kicker;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', kick.id);
    card.setAttribute('aria-describedby', describedBy.join(' '));
    card.append(kick, ...content, ...promptFoot(st, id, s, pv.released));
    return card;
  }

  function sendAnswers(id, result) {
    if (result.done) window.huddle.answer({ id, kind: 'ask', answers: result.answers });
    render();
  }

  // One question at a time; the answers go to main together after the last.
  // Each option is a full-width button with its label and, below it, its
  // description. Multi-select options carry a check box and end with Done.
  function renderAsk(st, pv, s) {
    const q = pv.question;
    const multi = q.multiSelect === true;
    const options = el('div', 'prompt-options');
    q.options.forEach((o, j) => {
      const label = str(o.label);
      const description = str(o.description);
      const b = promptButton(undefined, `opt-${j}`, 'option');
      b.disabled = pv.released;
      const text = el('span', 'opt-text');
      text.append(el('span', 'opt-label', label));
      if (description) text.append(el('span', 'opt-desc', description));
      if (multi) {
        const on = pv.chosen.includes(label);
        b.classList.toggle('chosen', on);
        b.setAttribute('aria-pressed', String(on));
        b.append(on ? checkedBox('opt-mark') : emptyBox('opt-mark'));
        b.addEventListener('click', () => {
          st.toggleOption(label);
          render();
        });
      } else {
        b.addEventListener('click', () => sendAnswers(pv.id, st.answerQuestion(label)));
      }
      b.append(text);
      options.append(b);
    });
    if (multi) {
      const done = promptButton('Done', 'done', 'done');
      done.disabled = pv.released || pv.chosen.length === 0;
      done.addEventListener('click', () => sendAnswers(pv.id, st.finishMulti()));
      options.append(done);
    }
    const ids = window.HuddlePrompt.promptDomIds(pv.id);
    const text = el('p', 'prompt-text', str(q.question));
    text.id = ids.text;
    return promptCard('ask', 'Question', st, pv, [text, options], [ids.text], s);
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
  function renderPermission(st, pv, s) {
    const command = el('pre', 'prompt-command', str(pv.command));
    command.title = `${str(pv.toolName) || 'Shell'} command`;
    const allow = promptButton(
      pv.armed ? 'Confirm allow' : 'Allow',
      'allow',
      pv.armed ? 'allow primary armed' : 'allow primary',
    );
    allow.disabled = pv.released;
    allow.addEventListener('click', () => {
      const wasArmed = st.confirmPending();
      if (st.armAllow() === 'send') {
        window.huddle.answer({ id: pv.id, kind: 'permission', allow: true });
      } else if (!wasArmed && st.confirmPending()) {
        // A fresh arm: main records it too and takes the allow only after it.
        window.huddle.arm(pv.id);
        scheduleArmExpiry();
      }
      render();
    });
    const deny = promptButton('Deny', 'deny', 'deny');
    deny.disabled = pv.released;
    deny.addEventListener('click', () => {
      if (st.deny()) window.huddle.answer({ id: pv.id, kind: 'permission', allow: false });
      render();
    });
    const actions = el('div', 'prompt-actions');
    actions.append(deny, allow);
    const ids = window.HuddlePrompt.promptDomIds(pv.id);
    command.id = ids.command;
    return promptCard('permission', 'Run this command?', st, pv, [command, actions], [ids.command], s);
  }

  // The card for a held prompt, or null (none, malformed, or answered).
  function renderPrompt(s) {
    const st = promptStateFor(s.prompt);
    const pv = st && st.current();
    // An answered card is hidden at once. If main refuses the answer (it
    // does not fit, or its timing is off), it says so and the card comes
    // back (onAnswerRefused below).
    if (!pv || pv.answered) return null;
    return pv.kind === 'ask' ? renderAsk(st, pv, s) : renderPermission(st, pv, s);
  }

  // --- Session view ----------------------------------------------------------

  // The bar with "5/7 Animations" and the chip, as on the list card (or the
  // chip or "Working" alone), then every plan step (a checked box when
  // done, a spinner for the active one, an empty box when still to do), or
  // "No plan yet". With a prompt card above it (`cardShown`) the chip is
  // left out: the card already says the session needs you.
  function planSection(s, f, cardShown) {
    const box = el('div', 'sv-plan');
    if (window.HuddleProgress.showsBar(s.plan, f.status) && f.bar) {
      box.append(progressBlock(s.plan, f.bar, f.color, cardShown ? null : CHIPS[f.kind], f.kind));
    } else {
      const tag = tagLine(f.kind, cardShown);
      if (tag) box.append(tag);
    }
    const rows = window.HuddleProgress.planRows(s.plan);
    if (rows.length === 0) {
      box.append(el('p', 'no-plan', 'No plan yet'));
      return box;
    }
    const ol = el('ol', 'plan');
    ol.setAttribute('aria-label', f.bar ? `Plan, ${f.bar.spoken}` : 'Plan');
    for (const r of rows) {
      const item = el('li', r.active ? `plan-item ${r.status} active` : `plan-item ${r.status}`);
      const mark = r.mark === 'checked' ? checkedBox() : r.mark === 'spinner' ? spinner(f.color) : emptyBox();
      const text = el('span', 'plan-text');
      text.append(el('span', 'sr-only', `${r.spoken}: `), document.createTextNode(r.text));
      item.append(mark, text);
      ol.append(item);
    }
    box.append(ol);
    return box;
  }

  // One session: the back arrow ("All sessions", with a needs-you badge when
  // another session needs you), the host badge and the open arrow; the avatar and name; the held prompt, if any; the plan.
  // Returns the prompt id of the card shown, or null.
  function renderSession(s, needs) {
    const f = facts(s, needs);
    sessionView.dataset.sessionId = f.id;
    sessionView.className = `session-view ${f.status} kind-${f.kind}`;
    sessionView.setAttribute('aria-label', f.name);

    // A prompt or a wait on another session never switches the view; the
    // back button carries it instead: a clay badge with a dot and the count
    // (visible), and the count in the spoken label.
    const cue = window.HuddleView.backCue([...needs], f.id);
    const back = el('button', cue.count ? 'back-btn has-cue' : 'back-btn');
    back.type = 'button';
    back.dataset.role = 'back';
    back.setAttribute('aria-label', cue.label);
    back.title = cue.count ? cue.label.replace('All sessions', 'Back to all sessions') : 'Back to all sessions';
    back.append(icon('arrow-left'), el('span', 'back-text', 'All sessions'));
    if (cue.count) {
      const badge = el('span', 'back-cue');
      badge.setAttribute('aria-hidden', 'true');
      badge.append(el('span', 'back-cue-dot'), el('span', 'back-cue-count', cue.badge));
      back.append(badge);
    }
    back.addEventListener('click', () => goBack(true));
    const right = el('div', 'sv-top-right');
    const badge = hostBadge(f);
    if (badge) right.append(badge);
    right.append(openButton(s, f));
    const top = el('div', 'sv-top');
    top.append(back, right);

    const head = el('div', 'sv-head');
    const name = el('h2', 'sv-name');
    name.title = f.name;
    name.append(el('span', 'sr-only', `${SPOKEN[f.kind]}: `), document.createTextNode(f.name));
    head.append(window.HuddleAvatar.createAvatar(document, f.id, f.status, colorOf.get(f.id)), name);

    const card = s.prompt ? renderPrompt(s) : null;
    // No card for a waiting session: the notice stands where the card would.
    const notice = card ? null : noticeFor(s, f);
    if (notice) {
      if (lastNoticeId !== f.id) noticeShownAt = performance.now();
      lastNoticeId = f.id;
    } else {
      lastNoticeId = null;
    }
    sessionView.replaceChildren(top, head);
    if (card) sessionView.append(card);
    else if (notice) sessionView.append(handoverBlock(s, f, notice));
    sessionView.append(planSection(s, f, !!card || !!notice));
    return card ? s.prompt.id : null;
  }

  // The notice block: what is going on, and a button that opens the app.
  // The kicker names the group; the text describes it. All text is fixed
  // wording around the host name, set with textContent.
  function handoverBlock(s, f, notice) {
    const box = el('div', 'handover');
    const kick = el('p', 'prompt-kicker', notice.kicker);
    kick.id = 'handover-kicker';
    const text = el('p', 'handover-text', notice.text);
    text.id = 'handover-text';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-labelledby', kick.id);
    box.setAttribute('aria-describedby', text.id);
    const btn = el('button', 'release-btn handover-btn');
    btn.type = 'button';
    btn.dataset.role = 'handover-open';
    btn.title = notice.button;
    btn.append(icon('external', 14), el('span', 'release-text', notice.button));
    btn.addEventListener('click', () => {
      // A notice that has just appeared may sit under the cursor: a click
      // before the minimum age opens nothing.
      if (!window.HuddlePrompt.clickAllowed(noticeShownAt, performance.now())) return;
      window.huddle.open(openTargetOf(s, f)).catch(() => {});
    });
    const foot = el('div', 'handover-foot');
    foot.append(btn);
    box.append(kick, text, foot);
    return box;
  }

  // --- Moving between the views ---------------------------------------------

  function cancelReturn() {
    clearTimeout(returnTimer);
    returnTimer = null;
    returnFor = null;
  }

  // Whether keyboard focus sits in the session view, or nowhere because the
  // control that had it just went away (an answered card).
  function focusInSessionView() {
    const a = document.activeElement;
    return !a || a === document.body || sessionView.contains(a);
  }

  function openSession(id) {
    cancelReturn();
    view.open(id);
    if (view.current().kind === 'session') render({ focus: { sessionId: id, role: 'back' } });
  }

  // Back to the list, with focus on the card of the session just left when
  // `withFocus` (the back button, or focus that was in the session view).
  function goBack(withFocus) {
    const cur = view.current();
    cancelReturn();
    view.back();
    render({ focus: withFocus && cur.kind === 'session' ? { sessionId: cur.sessionId, role: 'body' } : null });
  }

  function scheduleReturn(id) {
    clearTimeout(returnTimer);
    returnFor = id;
    returnTimer = setTimeout(returnNow, RETURN_MS);
  }

  // The delayed return: only while that session is still open and still has
  // no prompt, and never under a pressed pointer.
  function returnNow() {
    returnTimer = null;
    if (hold.isHeld()) {
      returnTimer = setTimeout(returnNow, 100);
      return;
    }
    const id = returnFor;
    returnFor = null;
    const cur = view.current();
    if (cur.kind !== 'session' || cur.sessionId !== id) return;
    const s = sessionById(id);
    if (s && s.prompt) return;
    goBack(focusInSessionView());
  }

  // --- Rendering -------------------------------------------------------------

  // The control that has focus, as its session and data-role, so a re-render
  // can give focus back to the control that stands in for it.
  function captureFocus() {
    const a = document.activeElement;
    if (!a || a === document.body || !a.dataset || !a.dataset.role) return null;
    const host = a.closest('[data-session-id]');
    return host ? { sessionId: host.dataset.sessionId, role: a.dataset.role } : null;
  }

  function restoreFocus(focus) {
    if (!focus || !focus.sessionId || !focus.role) return;
    let box = null;
    if (!sessionView.hidden) {
      if (sessionView.dataset.sessionId === focus.sessionId) box = sessionView;
    } else {
      for (const li of list.children) {
        if (li.dataset.sessionId === focus.sessionId) {
          box = li;
          break;
        }
      }
    }
    if (!box) return;
    for (const node of box.querySelectorAll('[data-role]')) {
      if (node.dataset.role === focus.role) {
        node.focus();
        return;
      }
    }
  }

  // The drain line of each prompt card and the spinners are CSS animations,
  // and a re-render builds new elements. Each new animation is moved to where
  // it would be: the drain to the time since the prompt first came, the
  // spinners to one shared clock, so neither jumps back. Under reduced motion
  // there are no animations and nothing to move.
  function syncAnimations() {
    const now = performance.now();
    for (const drain of sessionView.querySelectorAll('.prompt-drain')) {
      const seen = promptSeen.get(drain.dataset.promptId);
      if (seen === undefined) continue;
      for (const a of drain.getAnimations()) a.currentTime = Math.max(0, now - seen);
    }
    for (const spin of panel.querySelectorAll('.mark-spinner')) {
      for (const a of spin.getAnimations()) {
        const d = a.effect ? a.effect.getComputedTiming().duration : 0;
        if (typeof d === 'number' && d > 0) a.currentTime = now % d;
      }
    }
  }

  // The countdown text changes only when its whole second does, so it
  // updates at most once a second; the check runs a few times a second to
  // stay on the second.
  function updateCountdowns() {
    for (const node of sessionView.querySelectorAll('.prompt-countdown')) {
      const text = countdownFor(node.dataset.promptId);
      if (node.textContent !== text) node.textContent = text;
    }
  }

  function syncCountdownTimer() {
    const any = !collapsed && !sessionView.hidden && !!sessionView.querySelector('.prompt-countdown');
    if (any && !countdownTimer) countdownTimer = setInterval(updateCountdowns, 250);
    else if (!any && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // opts.focus: where focus goes after this render ({ sessionId, role }), or
  // null for nowhere in particular; without it the focused control keeps
  // focus across the re-render.
  function render(opts) {
    const focus = opts && opts.focus !== undefined ? opts.focus : captureFocus();

    const ids = new Set(sessions.map((s) => str(s && s.sessionId)));
    colorOf = window.HuddleColors.assignColors([...ids], colorOf, window.HuddleAvatar.PALETTE.length);
    const needs = new Set(view.needsYou());

    count.textContent = sessions.length ? String(sessions.length) : '';
    panel.classList.toggle('collapsed', collapsed);

    if (collapsed) {
      // Pill only: the session count and a "!" when any session needs you.
      pillCount.textContent = String(sessions.length);
      pillAlert.hidden = needs.size === 0;
      const label = `Expand panel, ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`;
      pill.setAttribute('aria-label', needs.size ? `${label}, ${needs.size} waiting for you` : label);
      list.replaceChildren();
      sessionView.replaceChildren();
      lastCardId = null;
      lastNoticeId = null;
      lastViewKind = 'pill';
      syncCountdownTimer();
      reportHeight();
      return;
    }

    const cur = view.current();
    const open = cur.kind === 'session' ? sessionById(cur.sessionId) : null;
    if (open) {
      list.hidden = true;
      list.replaceChildren();
      sessionView.hidden = false;
      lastCardId = renderSession(open, needs);
      lastViewKind = 'session';
    } else {
      sessionView.hidden = true;
      sessionView.replaceChildren();
      delete sessionView.dataset.sessionId;
      sessionView.removeAttribute('aria-label');
      list.hidden = false;
      // A list that comes back (from a session or the pill) may put an arrow
      // that releases a held prompt under the cursor: new minimum age.
      if (lastViewKind !== 'list') {
        for (const s of sessions) {
          const st = s.prompt && typeof s.prompt.id === 'string' ? promptStates.get(s.prompt.id) : null;
          if (st) st.shownAgain();
        }
      }
      list.replaceChildren(...sessions.map((s) => renderBuddy(s, needs)));
      if (sessions.length === 0) list.append(el('li', 'empty', 'No sessions'));
      lastCardId = null;
      lastNoticeId = null;
      lastViewKind = 'list';
    }

    restoreFocus(focus);
    syncAnimations();
    syncCountdownTimer();
    reportHeight();
  }

  function reportHeight() {
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const h = rect.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    window.huddle.reportHeight(Math.ceil(h));
  }

  new ResizeObserver(reportHeight).observe(panel);

  // A snapshot: the view state follows it (an open session that left goes
  // back to the list; a prompt on another session changes nothing), and the
  // open session's prompts are checked for the delayed return.
  function applySnapshot(snapshot) {
    sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions.filter((s) => s && typeof s === 'object') : [];
    const now = performance.now();
    const promptIds = new Set();
    for (const s of sessions) {
      if (!s.prompt || typeof s.prompt.id !== 'string') continue;
      promptIds.add(s.prompt.id);
      if (!promptSeen.has(s.prompt.id)) promptSeen.set(s.prompt.id, now);
      promptHold.set(s.prompt.id, window.HuddlePrompt.holdMsOf(s.prompt));
      // The arrow in the list releases a held prompt too, so its state (and
      // its minimum age) starts when the snapshot first brings the prompt.
      if (!promptStates.has(s.prompt.id)) {
        const st = window.HuddlePrompt.createPromptState();
        if (st.show(s.prompt)) promptStates.set(s.prompt.id, st);
      }
    }
    // A prompt no longer in the snapshot was answered, released, timed out
    // or ended: its state goes, so nothing of it reaches a later prompt.
    for (const id of promptStates.keys()) if (!promptIds.has(id)) promptStates.delete(id);
    for (const id of promptSeen.keys()) if (!promptIds.has(id)) promptSeen.delete(id);
    for (const id of promptHold.keys()) if (!promptIds.has(id)) promptHold.delete(id);

    view.sync(sessions);
    const cur = view.current();
    if (cur.kind === 'session') {
      const s = sessionById(cur.sessionId);
      const pending = s && s.prompt ? 1 : 0;
      if (pending > 0) cancelReturn();
      if (view.onPromptsSettled(cur.sessionId, pending)) scheduleReturn(cur.sessionId);
    } else {
      cancelReturn();
    }
    render();
  }

  const hold = window.HuddleHold.createSnapshotHold(applySnapshot);

  // While a pointer is down on the list or the session view, snapshots wait
  // so the pressed button stays the same element until the click lands.
  // `pressed` is any press anywhere in the window, for the Escape key.
  let pressed = false;
  function release() {
    pressed = false;
    hold.up();
    // Deferred so the click that follows pointerup fires on the old button first.
    setTimeout(hold.flush, 0);
  }
  window.addEventListener(
    'pointerdown',
    () => {
      pressed = true;
    },
    true,
  );
  list.addEventListener('pointerdown', () => hold.down());
  sessionView.addEventListener('pointerdown', () => hold.down());
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
  document.documentElement.addEventListener('pointerleave', release);

  // Escape in the session view goes back to the list, like the back button
  // (keyboard only: not in a text-like control, never during a press).
  document.addEventListener('keydown', (ev) => {
    const go = window.HuddleView.escapeGoesBack({
      key: ev.key,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      shiftKey: ev.shiftKey,
      isComposing: ev.isComposing,
      target: document.activeElement,
      view: collapsed ? 'list' : view.current().kind,
      pointerDown: pressed || hold.isHeld(),
    });
    if (!go) return;
    ev.preventDefault();
    goBack(true);
  });

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
