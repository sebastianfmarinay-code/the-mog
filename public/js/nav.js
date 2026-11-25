// Tab navigation and "who is the next snap for" intent.

export const TABS = ['meet', 'chats', 'camera', 'stories', 'me'];

export function currentTab() {
  const tab = location.hash.slice(1);
  return TABS.includes(tab) ? tab : 'meet';
}

export function go(tab) {
  if (currentTab() === tab && location.hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = tab;
  }
}

/**
 * Set when someone taps a camera button inside a chat, so the send sheet can
 * preselect that person and we can jump back afterwards.
 *   target: { type: 'stranger' } | { type: 'friend', id } | { type: 'story' } | null
 */
export const snapIntent = { target: null, returnTo: null };

export function snapTo(target, returnTo) {
  snapIntent.target = target;
  snapIntent.returnTo = returnTo || null;
  go('camera');
}

export function clearSnapIntent() {
  snapIntent.target = null;
  snapIntent.returnTo = null;
}

/** True while a full-screen overlay (editor, viewer, sheet, dialog) is open. */
export function overlayOpen() {
  return Boolean(
    document.querySelector('#editor:not([hidden]), #viewer:not([hidden]), #send-sheet:not([hidden]), dialog[open]'),
  );
}
