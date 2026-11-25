// Camera tab: live preview with filters and the shutter button.

import { camera, bindPreview, filterStrip, cameraErrorMessage, FILTERS } from './camera.js';
import { prefs } from './net.js';
import { $ } from './ui.js';
import { snapIntent, clearSnapIntent, overlayOpen, currentTab } from './nav.js';
import { openEditor } from './editor.js';
import { social } from './social.js';
import { strangerTarget } from './meet.js';

const els = {};
let nameTimer = null;

function render() {
  const on = camera.active;
  els.gate.hidden = on;
  els.shutter.disabled = !on;
  els.flip.hidden = !on || !camera.hasMultipleCameras;
}

function renderTarget() {
  const t = snapIntent.target;
  let label = null;
  if (t?.type === 'friend') {
    const friend = social.friend(t.id);
    if (friend) label = `Snapping @${friend.username}`;
  } else if (t?.type === 'stranger' && strangerTarget()) {
    label = `Snapping ${strangerTarget().label}`;
  } else if (t?.type === 'story') {
    label = 'Adding to your story';
  }
  els.target.textContent = label || '';
  els.target.hidden = !label;
}

function flashFilterName(filter) {
  els.filterName.textContent = filter.hint ? `${filter.name} · ${filter.hint}` : filter.name;
  els.filterName.classList.add('is-visible');
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => els.filterName.classList.remove('is-visible'), 1200);
  els.filters.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

async function enable() {
  els.enable.disabled = true;
  try {
    await camera.acquire('tab');
    prefs.set('cameraOk', true);
    els.gateText.textContent = 'Turn on your camera to take snaps with filters.';
  } catch (err) {
    els.gateText.textContent = cameraErrorMessage(err);
  } finally {
    els.enable.disabled = false;
  }
  render();
}

function shoot() {
  const canvas = camera.snapshot();
  if (!canvas) return;
  els.root.classList.remove('is-flash');
  void els.root.offsetWidth;
  els.root.classList.add('is-flash');
  openEditor(canvas);
}

function stepFilter(dir) {
  const i = FILTERS.findIndex((f) => f.id === camera.filter.id);
  const next = FILTERS[(i + dir + FILTERS.length) % FILTERS.length];
  camera.setFilter(next.id);
  flashFilterName(next);
}

export function showCameraTab() {
  renderTarget();
  render();
  if (camera.active) {
    camera.acquire('tab');
    return;
  }
  // Re-open automatically if they've allowed the camera before.
  if (prefs.get('cameraOk', false)) enable();
}

export function hideCameraTab() {
  camera.release('tab');
  if (!overlayOpen()) clearSnapIntent();
}

export function initCameraTab() {
  Object.assign(els, {
    root: $('.cam'),
    video: $('#cam-video'),
    gate: $('#cam-gate'),
    gateText: $('#cam-gate-text'),
    enable: $('#cam-enable'),
    flip: $('#cam-flip'),
    filters: $('#cam-filters'),
    filterName: $('#cam-filter-name'),
    shutter: $('#cam-shutter'),
    target: $('#cam-target'),
  });

  bindPreview(els.video);
  filterStrip(els.filters, { onPick: flashFilterName });
  camera.addEventListener('change', render);
  els.enable.addEventListener('click', enable);
  els.shutter.addEventListener('click', shoot);
  els.flip.addEventListener('click', () => camera.flip().catch(() => {}));

  // Swipe sideways on the preview to change filters.
  let startX = null;
  els.video.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
  });
  els.video.addEventListener('pointerup', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) stepFilter(dx < 0 ? 1 : -1);
  });

  document.addEventListener('keydown', (e) => {
    if (currentTab() !== 'camera' || overlayOpen() || !camera.active) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      shoot();
    } else if (e.key === 'ArrowRight') stepFilter(1);
    else if (e.key === 'ArrowLeft') stepFilter(-1);
  });

  render();
}
