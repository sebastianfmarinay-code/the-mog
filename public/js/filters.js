// Live camera filters, drawn onto a canvas every frame.
//
// Colour grades use the canvas `filter` property where the browser supports
// it, with blend-mode fallbacks. The stylised ones (Thermal, Pixel, VHS,
// Twin) work on pixels or redraw the frame, so they look the same everywhere.

const SUPPORTS_CTX_FILTER = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.filter = 'grayscale(1)';
    return ctx.filter === 'grayscale(1)';
  } catch {
    return false;
  }
})();

export const FILTERS = [
  { id: 'none', name: 'Normal' },
  {
    id: 'golden',
    name: 'Golden',
    css: 'saturate(1.25) contrast(1.05) brightness(1.04) sepia(0.22)',
    tint: ['rgba(255,176,64,0.55)', 'rgba(255,84,48,0.35)'],
    blend: 'soft-light',
  },
  { id: 'mono', name: 'Mono', css: 'grayscale(1) contrast(1.12)', gray: true },
  {
    id: 'dream',
    name: 'Dream',
    css: 'saturate(1.35) brightness(1.08) contrast(0.95)',
    tint: ['rgba(255,110,200,0.9)', 'rgba(90,140,255,0.9)'],
    blend: 'screen',
    alpha: 0.32,
  },
  { id: 'noir', name: 'Noir', css: 'grayscale(1) contrast(1.7) brightness(0.92)', gray: true, vignette: 0.75 },
  {
    id: 'arctic',
    name: 'Arctic',
    css: 'saturate(0.85) brightness(1.06) contrast(1.05)',
    tint: ['rgba(140,210,255,0.6)', 'rgba(60,120,255,0.45)'],
    blend: 'soft-light',
  },
  { id: 'thermal', name: 'Thermal', kind: 'thermal' },
  { id: 'vhs', name: 'VHS', kind: 'vhs' },
  { id: 'twin', name: 'Twin', kind: 'twin' },
  { id: 'pixel', name: 'Pixel', kind: 'pixel', hint: 'Hides your face' },
];

export const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

// Scratch canvases are reused between frames.
const scratch = new Map();
function scratchCanvas(name, w, h, opts) {
  let entry = scratch.get(name);
  if (!entry) {
    const canvas = document.createElement('canvas');
    entry = { canvas, ctx: canvas.getContext('2d', opts) };
    scratch.set(name, entry);
  }
  if (entry.canvas.width !== w || entry.canvas.height !== h) {
    entry.canvas.width = w;
    entry.canvas.height = h;
  }
  return entry;
}

// Thermal palette: luminance 0..255 -> RGB.
const THERMAL = (() => {
  const stops = [
    [0, [8, 0, 40]],
    [0.22, [70, 0, 140]],
    [0.42, [210, 0, 120]],
    [0.62, [255, 80, 0]],
    [0.8, [255, 200, 0]],
    [1, [255, 255, 230]],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k += 1;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c += 1) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return lut;
})();

let scanPattern = null;
function scanlines(ctx) {
  if (!scanPattern) {
    const { canvas, ctx: p } = scratchCanvas('scan', 2, 4);
    p.clearRect(0, 0, 2, 4);
    p.fillStyle = 'rgba(0,0,0,0.22)';
    p.fillRect(0, 0, 2, 1);
    p.fillRect(0, 2, 2, 1);
    scanPattern = ctx.createPattern(canvas, 'repeat');
  }
  return scanPattern;
}

function drawGraded(ctx, src, w, h, filter) {
  if (filter.css && SUPPORTS_CTX_FILTER) ctx.filter = filter.css;
  ctx.drawImage(src, 0, 0, w, h);
  ctx.filter = 'none';

  if (filter.gray && !SUPPORTS_CTX_FILTER) {
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (filter.tint) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, filter.tint[0]);
    g.addColorStop(1, filter.tint[1]);
    ctx.globalCompositeOperation = filter.blend || 'soft-light';
    ctx.globalAlpha = filter.alpha ?? 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  if (filter.vignette) {
    const r = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${filter.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

function drawThermal(ctx, src, w, h) {
  const sw = Math.max(64, Math.round(w / 4));
  const sh = Math.max(48, Math.round((sw * h) / w));
  const { canvas, ctx: s } = scratchCanvas('thermal', sw, sh, { willReadFrequently: true });
  s.drawImage(src, 0, 0, sw, sh);
  const img = s.getImageData(0, 0, sw, sh);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = THERMAL[l * 3];
    d[i + 1] = THERMAL[l * 3 + 1];
    d[i + 2] = THERMAL[l * 3 + 2];
  }
  s.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, w, h);
}

function drawPixel(ctx, src, w, h) {
  const cols = 26;
  const sw = cols;
  const sh = Math.max(1, Math.round((cols * h) / w));
  const { canvas, ctx: s } = scratchCanvas('pixel', sw, sh);
  s.drawImage(src, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
}

function drawVhs(ctx, src, w, h, time) {
  if (SUPPORTS_CTX_FILTER) ctx.filter = 'saturate(1.5) contrast(1.15) brightness(1.05)';
  ctx.drawImage(src, 0, 0, w, h);
  ctx.filter = 'none';

  // Colour fringing: red shifted right, cyan shifted left.
  const tw = Math.max(1, Math.round(w / 2));
  const th = Math.max(1, Math.round(h / 2));
  const offset = Math.max(2, Math.round(w / 140));
  for (const [name, color, dx] of [['red', '#ff0000', offset], ['cyan', '#00ffff', -offset]]) {
    const { canvas, ctx: t } = scratchCanvas(name, tw, th);
    t.globalCompositeOperation = 'source-over';
    t.drawImage(src, 0, 0, tw, th);
    t.globalCompositeOperation = 'multiply';
    t.fillStyle = color;
    t.fillRect(0, 0, tw, th);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.35;
    ctx.drawImage(canvas, dx, 0, w, h);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // A tracking band that drifts down the frame.
  const bandH = Math.round(h * 0.05);
  const bandY = Math.round(((time / 18) % (h + bandH)) - bandH);
  ctx.drawImage(ctx.canvas, 0, bandY, w, bandH, Math.round(w * 0.012), bandY, w, bandH);

  ctx.fillStyle = scanlines(ctx);
  ctx.fillRect(0, 0, w, h);

  const size = Math.max(12, Math.round(w / 26));
  ctx.font = `700 ${size}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  ctx.fillText('PLAY ▶', size, size);
  const secs = Math.floor(time / 1000);
  const stamp = `${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`SP 0:${stamp}`, w - size, h - size);
  ctx.textAlign = 'left';
  ctx.shadowBlur = 0;
}

function drawTwin(ctx, src, w, h, time, sw, sh) {
  ctx.drawImage(src, 0, 0, sw / 2, sh, 0, 0, w / 2, h);
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0, sw / 2, sh, 0, 0, w / 2, h);
  ctx.restore();
}

/**
 * Draw one frame of `src` (a video or canvas whose natural size is sw x sh)
 * onto `ctx` at w x h with the given filter.
 */
export function renderFilter(ctx, src, w, h, filter, time = 0, sw = w, sh = h) {
  ctx.save();
  switch (filter.kind) {
    case 'thermal':
      drawThermal(ctx, src, w, h);
      break;
    case 'pixel':
      drawPixel(ctx, src, w, h);
      break;
    case 'vhs':
      drawVhs(ctx, src, w, h, time);
      break;
    case 'twin':
      drawTwin(ctx, src, w, h, time, sw, sh);
      break;
    default:
      drawGraded(ctx, src, w, h, filter);
  }
  ctx.restore();
}
