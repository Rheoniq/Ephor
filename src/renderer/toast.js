'use strict';

// Ephor toast renderer. The name and kind come from query params and are
// untrusted: they are only ever set with textContent.

(function () {
  const KINDS = { waiting: 'needs you', finished: 'finished' };
  const params = new URLSearchParams(window.location.search);
  const name = (params.get('name') || '').trim() || 'Untitled session';
  const kind = Object.prototype.hasOwnProperty.call(KINDS, params.get('kind'))
    ? params.get('kind')
    : null;

  document.getElementById('toast-name').textContent = name;
  document.getElementById('toast-kind').textContent = kind ? KINDS[kind] : '';
  if (kind) document.getElementById('toast').dataset.kind = kind;

  // The window is click-through except while the pointer is over the cross:
  // main forwards mouse moves, so enter and leave still fire here.
  const close = document.getElementById('toast-close');
  if (window.toast) {
    close.addEventListener('mouseenter', () => window.toast.setClickable(true));
    close.addEventListener('mouseleave', () => window.toast.setClickable(false));
    close.addEventListener('click', () => window.toast.close());
  }
})();
