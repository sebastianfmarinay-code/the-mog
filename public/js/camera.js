// One shared camera for the Camera tab and video chat.
//
// With no filter, the raw camera track is used directly. With a filter, frames
// are drawn onto a canvas and its captured stream is used instead. Listeners
// get a 'change' event whenever the outgoing video track changes, so video
// chat can swap it into the live call with RTCRtpSender.replaceTrack().

import { FILTERS, filterById, renderFilter } from './filters.js';
import { prefs } from './net.js';

const MAX_SIDE = 960;
const SNAP_MAX_SIDE = 1440;

class Camera extends EventTarget {
  constructor() {
    super();
    this.raw = null;
    this.facing = 'user';
    this.filter = filterById(prefs.get('filter', 'none'));
    this.users = new Set();
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.canvasStream = null;
    this.frame = 0;
    this.starting = null;
    this.hasMultipleCameras = false;
  }

  get active() {
    return Boolean(this.raw && this.raw.getVideoTracks().some((t) => t.readyState === 'live'));
  }

  get mirrored() {
    return this.facing === 'user';
  }

  get videoTrack() {
    if (!this.active) return null;
    if (this.filter.id === 'none' || !this.canvasStream) return this.raw.getVideoTracks()[0];
    return this.canvasStream.getVideoTracks()[0];
  }

  get audioTrack() {
    return this.raw ? this.raw.getAudioTracks()[0] || null : null;
  }

  /** Stream for <video> previews: the processed picture, no audio. */
  previewStream() {
    const track = this.videoTrack;
    return track ? new MediaStream([track]) : null;
  }

  /**
   * Start the camera on behalf of `user` ('tab', 'meet', …). The camera keeps
   * running until every user has released it.
   */
  async acquire(user) {
    this.users.add(user);
    if (this.active) return;
    if (!this.starting) this.starting = this._open().finally(() => (this.starting = null));
    try {
      await this.starting;
    } catch (err) {
      this.users.delete(user);
      throw err;
    }
  }

  release(user) {
    this.users.delete(user);
    if (!this.users.size) this.stop();
  }

  async _open() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('Camera unavailable');
      err.name = window.isSecureContext ? 'NotSupportedError' : 'InsecureContext';
      throw err;
    }
    const video = { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 720 } };
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (err) {
      // No microphone? Snaps still work with video only.
      if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video });
      } else {
        throw err;
      }
    }
    if (this.raw) this.raw.getTracks().forEach((t) => t.stop());
    this.raw = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    await this._waitForSize();
    this._resizeCanvas();
    if (!this.canvasStream && typeof this.canvas.captureStream === 'function') {
      this.canvasStream = this.canvas.captureStream(30);
    }
    this._loop();
    this._emit();
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        this.hasMultipleCameras = devices.filter((d) => d.kind === 'videoinput').length > 1;
        this._emit();
      })
      .catch(() => {});
  }

  _waitForSize() {
    if (this.video.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      this.video.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 1500);
    });
  }

  _resizeCanvas() {
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _loop() {
    cancelAnimationFrame(this.frame);
    if (!this.active || this.filter.id === 'none') return;
    const draw = (t) => {
      if (!this.active || this.filter.id === 'none') return;
      this._resizeCanvas();
      const { width: w, height: h } = this.canvas;
      renderFilter(this.ctx, this.video, w, h, this.filter, t, this.video.videoWidth, this.video.videoHeight);
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }

  setFilter(id) {
    const next = filterById(id);
    if (next === this.filter) return;
    const wasNone = this.filter.id === 'none';
    this.filter = next;
    prefs.set('filter', next.id);
    this._loop();
    // The outgoing track only changes when switching to or from "Normal".
    if (wasNone !== (next.id === 'none')) this._emit();
    this.dispatchEvent(new Event('filter'));
  }

  async flip() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    if (this.active) {
      this.raw.getVideoTracks().forEach((t) => t.stop());
      await this._open();
    } else {
      this._emit();
    }
  }

  stop() {
    cancelAnimationFrame(this.frame);
    if (this.raw) this.raw.getTracks().forEach((t) => t.stop());
    this.raw = null;
    this.video.srcObject = null;
    this._emit();
  }

  /** Grab the current frame, with the filter, as it looks in the preview. */
  snapshot() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, SNAP_MAX_SIDE / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);

    // Mirror the source first (selfies look like the preview), then filter,
    // so any text a filter draws isn't backwards.
    let src = this.video;
    if (this.mirrored) {
      const flipped = document.createElement('canvas');
      flipped.width = w;
      flipped.height = h;
      const f = flipped.getContext('2d');
      f.translate(w, 0);
      f.scale(-1, 1);
      f.drawImage(this.video, 0, 0, w, h);
      src = flipped;
    }
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const [sw, sh] = src === this.video ? [vw, vh] : [w, h];
    renderFilter(out.getContext('2d'), src, w, h, this.filter, performance.now(), sw, sh);
    return out;
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }
}

export const camera = new Camera();
export { FILTERS };

/** Show the camera preview in a <video>, kept in sync with filter/flip changes. */
export function bindPreview(videoEl) {
  const update = () => {
    const stream = camera.previewStream();
    const current = videoEl.srcObject;
    const track = stream && stream.getVideoTracks()[0];
    if (!track) {
      videoEl.srcObject = null;
    } else if (!current || current.getVideoTracks()[0] !== track) {
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
    }
    videoEl.classList.toggle('is-mirrored', camera.mirrored);
  };
  camera.addEventListener('change', update);
  update();
  return update;
}

/** A horizontal row of filter chips. Returns a function that re-renders it. */
export function filterStrip(container, { onPick } = {}) {
  const render = () => {
    container.replaceChildren(
      ...FILTERS.map((f) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `filter-chip filter-chip--${f.id}`;
        btn.setAttribute('aria-pressed', String(camera.filter.id === f.id));
        btn.setAttribute('aria-label', `${f.name} filter${f.hint ? ` — ${f.hint}` : ''}`);
        btn.title = f.hint ? `${f.name} — ${f.hint}` : f.name;
        const swatch = document.createElement('span');
        swatch.className = 'filter-chip__swatch';
        const label = document.createElement('span');
        label.className = 'filter-chip__label';
        label.textContent = f.name;
        btn.append(swatch, label);
        btn.addEventListener('click', () => {
          camera.setFilter(f.id);
          onPick?.(f);
        });
        return btn;
      }),
    );
  };
  camera.addEventListener('filter', render);
  render();
  return render;
}

export function cameraErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow it in your browser settings (tap the icon next to the address bar), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return "We couldn't find a camera on this device.";
    case 'NotReadableError':
      return 'Your camera is busy in another app. Close it and try again.';
    case 'InsecureContext':
      return 'The camera only works over https:// or on localhost.';
    default:
      return "The camera isn't available in this browser.";
  }
}
