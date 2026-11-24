'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisibility } = require('../src/main/visibility');

const fresh = () => createVisibility({ collapsed: false, quiet: false });

test('toggleHidden twice returns to visible', () => {
  const v = fresh();
  assert.equal(v.isHidden(), false);
  assert.equal(v.toggleHidden(true), true);
  assert.equal(v.isHidden(), true);
  assert.equal(v.toggleHidden(false), true, 'a hidden panel is never on screen; showing it always works');
  assert.equal(v.isHidden(), false);
});

test('toggleHidden ignores a hide when the window is not on screen (nothing to hide)', () => {
  const v = fresh();
  assert.equal(v.toggleHidden(false), false);
  assert.equal(v.isHidden(), false);
  // So the panel still appears when a session shows up.
  assert.equal(v.shouldShowWindow(1), true);
});

test('setHidden: hiding needs the window on screen, showing does not', () => {
  const v = fresh();
  assert.equal(v.setHidden(true, false), false);
  assert.equal(v.isHidden(), false);
  assert.equal(v.setHidden(false, false), false, 'already shown');
  assert.equal(v.setHidden(true, true), true);
  assert.equal(v.isHidden(), true);
  assert.equal(v.setHidden(true, true), false, 'already hidden');
  assert.equal(v.setHidden(false, false), true);
  assert.equal(v.isHidden(), false);
});

test('expandForPrompt opens a collapsed pill without counting as the user choice', () => {
  const v = createVisibility({ collapsed: true, quiet: false });
  assert.equal(v.expandForPrompt(), true);
  assert.equal(v.isCollapsed(), false);
  assert.equal(v.isAutoExpanded(), true);
  assert.equal(v.expandForPrompt(), false, 'already open');
  // The holds end: back to the pill.
  assert.equal(v.holdsEnded(), true);
  assert.equal(v.isCollapsed(), true);
  assert.equal(v.isAutoExpanded(), false);
  assert.equal(v.holdsEnded(), false);
});

test('expandForPrompt leaves an expanded panel alone, and holdsEnded then does nothing', () => {
  const v = fresh();
  assert.equal(v.expandForPrompt(), false);
  assert.equal(v.isAutoExpanded(), false);
  assert.equal(v.holdsEnded(), false);
  assert.equal(v.isCollapsed(), false);
});

test('a user collapse or expand while auto-expanded wins over the re-collapse', () => {
  const v = createVisibility({ collapsed: true, quiet: false });
  v.expandForPrompt();
  v.setCollapsed(false); // the user keeps it open
  assert.equal(v.isAutoExpanded(), false);
  assert.equal(v.holdsEnded(), false);
  assert.equal(v.isCollapsed(), false);

  const w = createVisibility({ collapsed: true, quiet: false });
  w.expandForPrompt();
  w.setCollapsed(true); // the user collapses it by hand
  assert.equal(w.isAutoExpanded(), false);
  assert.equal(w.isCollapsed(), true);
});

test('shouldShowWindow needs sessions and not hidden', () => {
  const v = fresh();
  assert.equal(v.shouldShowWindow(0), false);
  assert.equal(v.shouldShowWindow(2), true);
  v.toggleHidden(true);
  assert.equal(v.shouldShowWindow(2), false);
});

test('canHold is false when hidden', () => {
  const v = fresh();
  v.toggleHidden(true);
  assert.equal(v.canHold(), false);
});

test('canHold is false when quiet', () => {
  const v = fresh();
  v.setQuiet(true);
  assert.equal(v.isQuiet(), true);
  assert.equal(v.canHold(), false);
});

test('answering is on by default and canHold is false when it is off', () => {
  const v = fresh();
  assert.equal(v.isAnswering(), true);
  assert.equal(v.canHold(), true);
  v.setAnswering(false);
  assert.equal(v.isAnswering(), false);
  assert.equal(v.canHold(), false);
  v.setAnswering(true);
  assert.equal(v.canHold(), true);
  assert.equal(createVisibility({ answering: false }).isAnswering(), false);
  assert.equal(createVisibility({ answering: false }).canHold(), false);
});

test('answering off does not change quiet or the toast gate', () => {
  const v = fresh();
  v.setAnswering(false);
  assert.equal(v.isQuiet(), false);
  const { shouldToast } = require('../src/main/visibility');
  assert.equal(shouldToast({ quiet: v.isQuiet(), hidden: true, collapsed: false, windowVisible: true }), true);
});

test('canHold is true when only collapsed', () => {
  const v = fresh();
  v.setCollapsed(true);
  assert.equal(v.isCollapsed(), true);
  assert.equal(v.canHold(), true);
});

test('initial state is taken from the argument', () => {
  const v = createVisibility({ collapsed: true, quiet: true });
  assert.equal(v.isCollapsed(), true);
  assert.equal(v.isQuiet(), true);
  assert.equal(v.isHidden(), false);
});

const { shouldToast, toastAllowed, keepsWhilePanelSeen } = require('../src/main/visibility');

const seen = { quiet: false, hidden: false, collapsed: false, windowVisible: true };

test('shouldToast: hidden panel shows a toast', () => {
  assert.equal(shouldToast({ ...seen, hidden: true, windowVisible: false }), true);
});

test('shouldToast: collapsed pill shows a toast', () => {
  assert.equal(shouldToast({ ...seen, collapsed: true }), true);
});

test('shouldToast: open panel on screen shows none (the card says it)', () => {
  assert.equal(shouldToast(seen), false);
});

test('shouldToast: window not on screen shows a toast', () => {
  assert.equal(shouldToast({ ...seen, windowVisible: false }), true);
});

test('shouldToast: quiet never shows one', () => {
  for (const hidden of [false, true]) {
    for (const collapsed of [false, true]) {
      for (const windowVisible of [false, true]) {
        assert.equal(shouldToast({ quiet: true, hidden, collapsed, windowVisible }), false);
      }
    }
  }
});

test('toastAllowed: a toast queued while collapsed is refused at show time once the panel is open', () => {
  const toast = { sessionId: 'a', kind: 'waiting' };
  assert.equal(toastAllowed(toast, { ...seen, collapsed: true }), true);
  assert.equal(toastAllowed(toast, seen), false);
});

test('toastAllowed: notices and the forced demo toast pass the panel check, never quiet', () => {
  const notice = { sessionId: null, kind: 'notice' };
  const demo = { sessionId: 'd', kind: 'waiting', force: true };
  assert.equal(toastAllowed(notice, seen), true);
  assert.equal(toastAllowed(demo, seen), true);
  assert.equal(toastAllowed(notice, { ...seen, quiet: true }), false);
  assert.equal(toastAllowed(demo, { ...seen, quiet: true }), false);
});

test('keepsWhilePanelSeen: only notices and forced toasts', () => {
  assert.equal(keepsWhilePanelSeen({ kind: 'notice' }), true);
  assert.equal(keepsWhilePanelSeen({ kind: 'finished', force: true }), true);
  assert.equal(keepsWhilePanelSeen({ kind: 'finished' }), false);
  assert.equal(keepsWhilePanelSeen(null), false);
});
