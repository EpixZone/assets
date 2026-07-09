// Epix icon generation pipeline.
// Run from the repo root: node scripts/generate-icons.mjs
// Needs the sharp and png-to-ico packages on the module path, e.g.
// `npm install --no-save sharp png-to-ico` before running.
//
// Renders images/icons/epix-icon.svg with sharp and composes platform icon
// sets under images/icons/generated/. No gradients, flat colors only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const ROOT = process.cwd();
const SRC_SVG = path.join(ROOT, 'images', 'icons', 'epix-icon.svg');
const OUT = path.join(ROOT, 'images', 'icons', 'generated');
const SCRATCH = process.env.EPIX_ICON_SCRATCH
  || '/private/tmp/claude-501/-Users-mud-github-assets/6960a7ae-fdc7-4ef9-82db-cf6d22181037/scratchpad';

const BLACK = '#020202';
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// ---------------------------------------------------------------------------
// Source mark handling.
// The source SVG has viewBox 0 0 72 72 but the rounded diamond tips overshoot
// the viewBox slightly. We re-wrap the four paths in a padded viewBox, measure
// the tight bounds once at high resolution, then render every size straight
// from vector data using a square viewBox centered on the mark. That keeps the
// mark uncropped, centered, and crisp at every pixel size.
// ---------------------------------------------------------------------------

const srcText = await fs.readFile(SRC_SVG, 'utf8');
const pathEls = srcText.match(/<path[\s\S]*?<\/path>/g);
if (!pathEls || pathEls.length !== 4) {
  throw new Error(`expected 4 <path> elements in ${SRC_SVG}, got ${pathEls ? pathEls.length : 0}`);
}
const PATHS = pathEls.join('');

function svgWrap(viewBox, px, inner) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${viewBox}">${inner}</svg>`
  );
}

async function measureTightViewBox() {
  const PAD_VB = '-4 -4 80 80';
  const PX = 2000;
  const { info } = await sharp(svgWrap(PAD_VB, PX, PATHS))
    .trim({ threshold: 1 })
    .png()
    .toBuffer({ resolveWithObject: true });
  const u = 80 / PX; // svg units per pixel
  const x0 = -4 + -info.trimOffsetLeft * u;
  const y0 = -4 + -info.trimOffsetTop * u;
  const w = info.width * u;
  const h = info.height * u;
  const side = Math.max(w, h);
  return `${x0 - (side - w) / 2} ${y0 - (side - h) / 2} ${side} ${side}`;
}

const MARK_VB = await measureTightViewBox();

// Render the bare mark at px x px (transparent background, mark fills the box).
// Small sizes are supersampled 4x and downscaled for cleaner edges. `inner`
// lets callers add flat overlays in the same 72-unit space as the mark paths.
async function renderMark(px, inner = PATHS) {
  const ss = px < 512 ? px * 4 : px;
  let img = sharp(svgWrap(MARK_VB, ss, inner));
  if (ss !== px) img = sharp(await img.png().toBuffer()).resize(px, px, { kernel: 'lanczos3' });
  return img.png().toBuffer();
}

// Mark pixel size for a given canvas. Rounded to the canvas parity (even
// canvas gets an even mark) so gravity-centre compositing leaves equal
// margins on every side instead of a half-pixel bias.
function markPx(size, pct) {
  const raw = size * pct;
  return size % 2 === 0 ? Math.round(raw / 2) * 2 : Math.round(raw);
}

// Mark centered on a transparent size x size canvas, mark side = size * pct.
async function markOnTransparent(size, pct, inner = PATHS) {
  const mark = await renderMark(markPx(size, pct), inner);
  return sharp({ create: { width: size, height: size, channels: 4, background: TRANSPARENT } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Background shapes (flat #020202, no gradients).
// ---------------------------------------------------------------------------

function circleBg(size) {
  return svgWrap(`0 0 ${size} ${size}`, size,
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${BLACK}"/>`);
}

function roundedBg(size, radiusPct) {
  const r = size * radiusPct;
  return svgWrap(`0 0 ${size} ${size}`, size,
    `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${BLACK}"/>`);
}

async function composeOnBg(bgPng, size, markPct) {
  const mark = await renderMark(markPx(size, markPct));
  return sharp(bgPng)
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Compositions.
// ---------------------------------------------------------------------------

const styles = {
  // Bare mark on transparent, mark fills ~92% of the canvas.
  mark: (size, pct = 0.92) => markOnTransparent(size, pct),

  // Black circle filling the canvas, mark at ~62% (existing identity).
  circle: async (size, pct = 0.62) =>
    composeOnBg(await sharp(circleBg(size)).png().toBuffer(), size, pct),

  // Full-bleed black square, mark at ~62%.
  square: async (size, pct = 0.62) => {
    const bg = await sharp({ create: { width: size, height: size, channels: 4, background: BLACK } })
      .png()
      .toBuffer();
    return composeOnBg(bg, size, pct);
  },

  // Black rounded rect, corner radius 22.5% of size, mark at ~60% (macOS style).
  rounded: async (size, pct = 0.6, radiusPct = 0.225) =>
    composeOnBg(await sharp(roundedBg(size, radiusPct)).png().toBuffer(), size, pct),
};

// Flat one-color silhouette of the diamond union (center hole preserved):
// render the mark, take its alpha channel, and use it as the mask over a
// solid color. Anti-aliased alpha is kept so edges stay smooth.
async function silhouette(size, markPct, color) {
  const composed = await markOnTransparent(size, markPct);
  const alpha = await sharp(composed).ensureAlpha().extractChannel(3).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Wordmark handling.
// images/logos/epix-logo.svg holds the four EPIX letter paths wrapped in a
// drop-shadow filter. Only the <path> elements are extracted, which drops the
// filter (flat design, no shadows); the flat letter fills live on the paths
// themselves. The tight box is measured the same way as the mark's.
// ---------------------------------------------------------------------------

const WM_SVG = path.join(ROOT, 'images', 'logos', 'epix-logo.svg');
const wmText = await fs.readFile(WM_SVG, 'utf8');
const wmPathEls = wmText.match(/<path[\s\S]*?<\/path>/g);
if (!wmPathEls || wmPathEls.length !== 4) {
  throw new Error(`expected 4 <path> elements in ${WM_SVG}, got ${wmPathEls ? wmPathEls.length : 0}`);
}
const WM_PATHS = wmPathEls.join('');
if (WM_PATHS.includes('filter')) throw new Error('wordmark paths must not reference filters');

function svgWrapRect(viewBox, pxW, pxH, inner) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" viewBox="${viewBox}">${inner}</svg>`
  );
}

// Tight content box of arbitrary inner SVG content, in viewBox units. The
// probe viewBox must fully contain the content with some transparent margin.
async function measureTightBox(inner, vx, vy, vw, vh) {
  const PXW = 2000;
  const pxh = Math.max(1, Math.round((PXW * vh) / vw));
  const { info } = await sharp(svgWrapRect(`${vx} ${vy} ${vw} ${vh}`, PXW, pxh, inner))
    .trim({ threshold: 1 })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    x: vx + -info.trimOffsetLeft * (vw / PXW),
    y: vy + -info.trimOffsetTop * (vh / pxh),
    w: info.width * (vw / PXW),
    h: info.height * (vh / pxh),
  };
}

// epix-logo.svg viewBox is 0 0 708 229; probe with a padded box around it.
const WM_BOX = await measureTightBox(WM_PATHS, -10, -10, 728, 249);
const [mvx, mvy, mvs] = MARK_VB.split(' ').map(Number);
const MARK_BOX = { x: mvx, y: mvy, w: mvs, h: mvs };

// Transform group that places `inner` (whose tight box is `box`) so the box's
// top-left lands at x/y scaled to targetH tall.
function placeAt(inner, box, x, y, targetH) {
  const s = targetH / box.h;
  return `<g transform="translate(${x - box.x * s} ${y - box.y * s}) scale(${s})">${inner}</g>`;
}

// Render inner SVG content on a W x H transparent canvas, supersampled 2x.
async function renderScene(W, H, inner) {
  const buf = await sharp(svgWrapRect(`0 0 ${W} ${H}`, W * 2, H * 2, inner)).png().toBuffer();
  return sharp(buf).resize(W, H, { kernel: 'lanczos3' }).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Output helpers.
// ---------------------------------------------------------------------------

async function write(rel, buf) {
  const p = path.join(OUT, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buf);
  const st = await fs.stat(p);
  if (st.size === 0) throw new Error(`empty output: ${rel}`);
  console.log(`wrote ${rel} (${st.size} bytes)`);
  return p;
}

// ---------------------------------------------------------------------------
// Build everything.
// ---------------------------------------------------------------------------

// Preview favicons, both styles, native sizes.
const faviconSizes = [16, 32, 48];
const favMark = {};
const favCircle = {};
for (const s of faviconSizes) {
  favMark[s] = await styles.mark(s);
  favCircle[s] = await styles.circle(s);
  await write(`preview/favicon-mark-${s}.png`, favMark[s]);
  await write(`preview/favicon-circle-${s}.png`, favCircle[s]);
}

// Final web favicons: "mark" style. At 16px the circle style leaves the mark
// only ~10px wide and it turns to mush; the bare mark stays readable.
for (const s of faviconSizes) await write(`web/favicon-${s}.png`, favMark[s]);
await write('web/favicon.ico', await pngToIco([favMark[16], favMark[32], favMark[48]]));

// Apple touch icon (square style).
await write('web/apple-touch-icon-180.png', await styles.square(180));

// Maskable icons: square style with mark at 55% so the 80% safe-zone crop keeps it.
await write('web/maskable-192.png', await styles.square(192, 0.55));
await write('web/maskable-512.png', await styles.square(512, 0.55));

// Extension icons (circle style); beta uses the same art.
for (const s of [16, 48, 128]) {
  const buf = await styles.circle(s);
  await write(`extension/icon-${s}.png`, buf);
  await write(`extension/icon-beta-${s}.png`, buf);
}

// ---------------------------------------------------------------------------
// Wallet extension UI assets. Drop-in replacements: canvas sizes match the
// files they replace, so no layout code in the wallet needs to change.
// ---------------------------------------------------------------------------

// logo-256: circle identity (splash, permission pages, QR centers, background
// notification icon). Beta ships the same art, like the icon-beta-* trio.
{
  const logo = await styles.circle(256);
  await write('wallet/logo-256.png', logo);
  await write('wallet/logo-beta-256.png', logo);
}

// locked-logo-128: bare mark with the apps-icon center-square treatment and a
// white padlock glyph; shown by the in-page toast while the wallet is locked.
{
  const lockOverlay =
    `<rect x="16.5" y="16.7" width="38.25" height="38.1" fill="${BLACK}"/>` +
    '<g transform="translate(35.625 35.75)" fill="none" stroke="#FEFEFE" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M-4.6 -2V-4.9A4.6 4.6 0 0 1 4.6 -4.9V-2"/>' +
    '<rect x="-7.5" y="-2" width="15" height="11.5" rx="2.6"/>' +
    '</g>';
  await write('wallet/locked-logo-128.png', await markOnTransparent(128, 0.92, PATHS + lockOverlay));
}

// intro-logo: horizontal mark + EPIX wordmark lockup on the same 1668x512
// canvas as the art it replaces (register header, ledger grant). Mark full
// height at the left edge, wordmark flush right, like the original layout.
// The colored letters read on both themes, so light ships the same render.
{
  const W = 1668;
  const H = 512;
  const wmH = 320;
  const wmW = (WM_BOX.w / WM_BOX.h) * wmH;
  const lockup =
    placeAt(PATHS, MARK_BOX, 0, 0, H) +
    placeAt(WM_PATHS, WM_BOX, W - wmW, (H - wmH) / 2, wmH);
  const buf = await renderScene(W, H, lockup);
  await write('wallet/intro-logo.png', buf);
  await write('wallet/intro-logo-light.png', buf);
}

// brand-text: EPIX wordmark alone, contained on the original canvas sizes.
for (const [name, W, H] of [
  ['brand-text.png', 634, 256],
  ['brand-text-fit-logo-height.png', 448, 256],
]) {
  const s = Math.min(W / WM_BOX.w, H / WM_BOX.h);
  const w = WM_BOX.w * s;
  const h = WM_BOX.h * s;
  await write(`wallet/${name}`, await renderScene(W, H, placeAt(WM_PATHS, WM_BOX, (W - w) / 2, (H - h) / 2, h)));
}

// Wallet unlock lottie: the four diamonds slide in from their compass
// directions and fade up. Shape layers with flat fills only; same 400x320
// canvas as the files it replaces. Light ships the same animation.
{
  const r4 = (n) => Math.round(n * 10000) / 10000;

  // Convert one absolute M/L/H/V/C/Z path into a lottie bezier shape.
  function pathToShape(d) {
    const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g);
    const v = [];
    const tin = [];
    const tout = [];
    let k = 0;
    let cmd = '';
    const num = () => Number(tokens[k++]);
    const push = (x, y) => {
      v.push([r4(x), r4(y)]);
      tin.push([0, 0]);
      tout.push([0, 0]);
    };
    while (k < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[k])) {
        cmd = tokens[k++];
        if (cmd === 'Z' || cmd === 'z') break;
        continue;
      }
      const last = v[v.length - 1];
      if (cmd === 'M' || cmd === 'L') push(num(), num());
      else if (cmd === 'H') push(num(), last[1]);
      else if (cmd === 'V') push(last[0], num());
      else if (cmd === 'C') {
        const c1x = num(), c1y = num(), c2x = num(), c2y = num(), ex = num(), ey = num();
        tout[v.length - 1] = [r4(c1x - last[0]), r4(c1y - last[1])];
        push(ex, ey);
        tin[v.length - 1] = [r4(c2x - ex), r4(c2y - ey)];
      } else throw new Error(`unsupported path command: ${cmd}`);
    }
    // The source paths draw an explicit segment back to the start; fold it
    // into the closed shape.
    if (v.length > 1) {
      const [fx, fy] = v[0];
      const [lx, ly] = v[v.length - 1];
      if (Math.abs(fx - lx) < 1e-4 && Math.abs(fy - ly) < 1e-4) {
        tin[0] = tin[tin.length - 1];
        v.pop();
        tin.pop();
        tout.pop();
      }
    }
    return { c: true, v, i: tin, o: tout };
  }

  const W = 400;
  const H = 320;
  const OP = 32;
  const MARK_H = 200;
  const SLIDE = 48;
  const cx = mvx + mvs / 2;
  const cy = mvy + mvs / 2;
  const sc = r4((MARK_H / mvs) * 100);

  const layers = pathEls.map((el, idx) => {
    const d = el.match(/ d="([^"]+)"/)[1];
    const hex = el.match(/fill="#([0-9a-fA-F]{6})"/)[1];
    // Ceil at 6 decimals: lottie-web floors channel * 255, so this keeps the
    // exact brand color bytes.
    const rgb = [0, 2, 4].map((o) => Math.ceil((parseInt(hex.slice(o, o + 2), 16) / 255) * 1e6) / 1e6);
    const shape = pathToShape(d);
    let dx = shape.v.reduce((s, p) => s + p[0], 0) / shape.v.length - cx;
    let dy = shape.v.reduce((s, p) => s + p[1], 0) / shape.v.length - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nm = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
    const t0 = idx * 3;
    return {
      ddd: 0,
      ind: idx + 1,
      ty: 4,
      nm,
      sr: 1,
      ks: {
        o: {
          a: 1,
          k: [
            { t: t0, s: [0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } },
            { t: t0 + 8, s: [100] },
          ],
        },
        r: { a: 0, k: 0 },
        p: {
          a: 1,
          k: [
            {
              t: t0,
              s: [r4(W / 2 + dx * SLIDE), r4(H / 2 + dy * SLIDE), 0],
              o: { x: [0.2], y: [0.9] },
              i: { x: [0.5], y: [1] },
            },
            { t: t0 + 14, s: [W / 2, H / 2, 0] },
          ],
        },
        a: { a: 0, k: [r4(cx), r4(cy), 0] },
        s: { a: 0, k: [sc, sc, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          nm,
          it: [
            { ty: 'sh', nm: 'path', ks: { a: 0, k: shape } },
            { ty: 'fl', nm: 'fill', c: { a: 0, k: [...rgb, 1] }, o: { a: 0, k: 100 }, r: 1 },
            {
              ty: 'tr',
              p: { a: 0, k: [0, 0] },
              a: { a: 0, k: [0, 0] },
              s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 },
              o: { a: 0, k: 100 },
            },
          ],
        },
      ],
      ip: 0,
      op: OP,
      st: 0,
    };
  });

  const anim = {
    v: '5.7.4',
    fr: 24,
    ip: 0,
    op: OP,
    w: W,
    h: H,
    nm: 'epix-unlock',
    ddd: 0,
    assets: [],
    layers,
  };
  const json = Buffer.from(JSON.stringify(anim));
  JSON.parse(json.toString()); // must stay valid JSON
  await write('wallet/lottie/unlock/logo.json', json);
  await write('wallet/lottie/unlock/logo-light.json', json);
}

// ---------------------------------------------------------------------------
// Wallet empty-state illustrations ("Phase 2" art): flat geometry built from
// the diamond motif. Drop-in 300x300 canvases (rendered at 100 CSS px).
// ---------------------------------------------------------------------------
{
  // Centroid of each of the four mark pieces, measured by rendering each path
  // alone (the path data uses curves, so a raster bbox beats parsing).
  const pieces = [];
  for (const el of pathEls) {
    const PX = 500;
    const { info } = await sharp(svgWrap('-4 -4 80 80', PX, el))
      .trim({ threshold: 1 })
      .png()
      .toBuffer({ resolveWithObject: true });
    const u = 80 / PX;
    pieces.push({
      el,
      cx: -4 + (-info.trimOffsetLeft + info.width / 2) * u,
      cy: -4 + (-info.trimOffsetTop + info.height / 2) * u,
    });
  }

  // A 72-unit-space scene on a transparent square canvas, supersampled 4x.
  async function renderScene72(px, vb, inner) {
    const buf = await sharp(svgWrap(vb, px * 4, inner)).png().toBuffer();
    return sharp(buf).resize(px, px, { kernel: 'lanczos3' }).png().toBuffer();
  }

  // main-empty-balance: the four pieces drift apart around a dashed, still
  // empty center - nothing here yet. Flat dots echo the old planet's moons.
  async function emptyBalance(neutral) {
    const GAP = 7;
    const exploded = pieces
      .map(({ el, cx, cy }) => {
        const dx = cx - 36;
        const dy = cy - 36;
        const len = Math.hypot(dx, dy) || 1;
        const tx = ((dx / len) * GAP).toFixed(2);
        const ty = ((dy / len) * GAP).toFixed(2);
        return `<g transform="translate(${tx} ${ty})">${el}</g>`;
      })
      .join('');
    const inner = `${exploded}
      <rect x="25" y="25" width="22" height="22" rx="3" fill="none"
        stroke="${neutral}" stroke-width="2" stroke-dasharray="3.8 3"/>
      <circle cx="0" cy="8" r="3" fill="#69E9F5"/>
      <circle cx="73" cy="2" r="2.3" fill="#8A4BDB"/>
      <circle cx="76" cy="64" r="2" fill="#31BDC6"/>
      <circle cx="-3" cy="62" r="1.7" fill="${neutral}"/>`;
    return renderScene72(300, '-17 -17 106 106', inner);
  }
  await write('wallet/img/main-empty-balance.png', await emptyBalance('#73737E'));
  await write('wallet/img/main-empty-balance-light.png', await emptyBalance('#9C9CA6'));

  // main-empty-staking: rounded diamonds climbing teal -> indigo, growth as
  // an ascending run of the brand shape.
  {
    const diamond = (X, Y, s, color) =>
      `<rect x="${X - s / 2}" y="${Y - s / 2}" width="${s}" height="${s}" rx="${(s * 0.18).toFixed(2)}"
        transform="rotate(45 ${X} ${Y})" fill="${color}"/>`;
    const inner = [
      diamond(13, 59, 11, '#31BDC6'),
      diamond(30, 45, 14.5, '#69E9F5'),
      diamond(48, 30, 18, '#8A4BDB'),
      diamond(66, 13, 21.5, '#5954CD'),
    ].join('');
    await write('wallet/img/main-empty-staking.png', await renderScene72(300, '-8 -8 96 96', inner));
  }

  // Unlock splash (1440x1720, the size the unlock page's background math
  // expects): the epix-bg.png language - big rounded diamonds poking in from
  // the edges on near-black - plus a decentralized-network mesh of small
  // diamond nodes, with the mark sitting as one node in the web.
  {
    const W = 1440;
    const H = 1720;
    const diamond = (X, Y, s, fill, opacity = 1) =>
      `<rect x="${X - s / 2}" y="${Y - s / 2}" width="${s}" height="${s}" rx="${(s * 0.18).toFixed(1)}"
        transform="rotate(45 ${X} ${Y})" fill="${fill}" opacity="${opacity}"/>`;

    // One mesh for both themes; only background and line strength differ.
    const NODES = {
      A: [200, 300, 26, '#69E9F5'],
      B: [450, 180, 20, '#8A4BDB'],
      C: [900, 150, 24, '#31BDC6'],
      D: [1230, 320, 30, '#5954CD'],
      E: [1300, 700, 20, '#69E9F5'],
      F: [150, 760, 22, '#5954CD'],
      G: [420, 880, 18, '#31BDC6'],
      H: [1050, 900, 26, '#8A4BDB'],
      I: [720, 180, 16, '#31BDC6'],
      J: [980, 520, 18, '#69E9F5'],
      K: [380, 520, 20, '#5954CD'],
      L: [1180, 1090, 16, '#31BDC6'],
      M: [260, 1080, 16, '#8A4BDB'],
      X: [720, 560, 0, ''], // the mark's slot in the mesh
    };
    const EDGES = [
      ['A', 'B'], ['B', 'I'], ['I', 'C'], ['C', 'D'], ['D', 'J'],
      ['J', 'X'], ['X', 'K'], ['K', 'A'], ['K', 'F'], ['F', 'G'],
      ['G', 'M'], ['G', 'X'], ['X', 'I'], ['J', 'H'], ['H', 'L'],
      ['D', 'E'], ['E', 'H'], ['B', 'K'], ['C', 'J'], ['F', 'M'],
    ];

    async function unlockSplash(bg, lineColor, lineOpacity) {
      const edges = EDGES.map(([a, b], i) => {
        const [x1, y1] = NODES[a];
        const [x2, y2] = NODES[b];
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
          stroke="${lineColor}" stroke-width="2.5" opacity="${(lineOpacity * (i % 3 === 0 ? 0.7 : 1)).toFixed(2)}"/>`;
      }).join('');
      const nodes = Object.values(NODES)
        .filter(([, , s]) => s > 0)
        .map(([x, y, s, c]) => diamond(x, y, s, c))
        .join('');
      // The mark as the network's local node, centered where the mesh meets.
      const ms = 240 / 72;
      const mark = `<g transform="translate(${720 - 36 * ms} ${560 - 36 * ms}) scale(${ms.toFixed(3)})">${PATHS}</g>`;
      const inner = `
        <rect width="${W}" height="${H}" fill="${bg}"/>
        ${diamond(720, -430, 720, '#69E9F5')}
        ${diamond(-430, 860, 720, '#8A4BDB')}
        ${diamond(1870, 860, 720, '#31BDC6')}
        ${diamond(720, 2150, 720, '#5954CD')}
        ${edges}
        ${nodes}
        ${diamond(720, 560, 200, bg)}
        ${mark}`;
      const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`
      );
      return sharp(svg).png().toBuffer();
    }
    // Backgrounds match the wallet themes exactly (gray-700 dark,
    // light-background light) so the splash blends into the page where the
    // scaled image ends.
    await write('wallet/img/unlock-dark.png', await unlockSplash('#09090A', '#8A4BDB', 0.45));
    await write('wallet/img/unlock-light.png', await unlockSplash('#FCFAFF', '#5954CD', 0.4));
  }

  // Register-flow lottie animations, replacing the Keplr-branded gradient
  // originals: intro.json (the mark assembles, then Vote / Claim / Transact /
  // Stake badges pop in and float) and creating(-light).json (the mark
  // assembles and breathes). Badge labels are Inter SemiBold outlines from
  // the wallet's own bundled font, so this section needs an epix-wallet
  // checkout next to this repo and skips itself otherwise.
  {
    const FONT = '/Users/mud/github/epix-wallet/apps/extension/src/public/assets/font/Inter-SemiBold.ttf';
    const fontExists = await fs.access(FONT).then(() => true, () => false);
    if (!fontExists) {
      console.warn('skipping register lotties: wallet Inter font not found at', FONT);
    } else {
      const ot = (await import('opentype.js')).default;
      const font = ot.parse((await fs.readFile(FONT)).buffer.slice(0));
      const r4 = (n) => Math.round(n * 1e4) / 1e4;
      const [mvx, mvy, mvs] = MARK_VB.split(' ').map(Number);
      const markCx = mvx + mvs / 2;
      const markCy = mvy + mvs / 2;
      const lottieRgb = (hex) =>
        [0, 2, 4].map((o) => Math.ceil((parseInt(hex.slice(o + 1, o + 3), 16) / 255) * 1e6) / 1e6);

      // opentype/svg command stream -> lottie bezier contours (Q elevated to C).
      function commandsToContours(cmds) {
        const contours = [];
        let v = [], ti = [], to = [];
        const commit = () => {
          if (v.length > 1) {
            const [fx, fy] = v[0];
            const [lx, ly] = v[v.length - 1];
            if (Math.abs(fx - lx) < 1e-4 && Math.abs(fy - ly) < 1e-4) {
              ti[0] = ti[ti.length - 1];
              v.pop(); ti.pop(); to.pop();
            }
            contours.push({ c: true, v: v.map((p) => p.map(r4)), i: ti.map((p) => p.map(r4)), o: to.map((p) => p.map(r4)) });
          }
          v = []; ti = []; to = [];
        };
        for (const c of cmds) {
          if (c.type === 'M') { commit(); v.push([c.x, c.y]); ti.push([0, 0]); to.push([0, 0]); }
          else if (c.type === 'L') { v.push([c.x, c.y]); ti.push([0, 0]); to.push([0, 0]); }
          else if (c.type === 'Q') {
            const [px, py] = v[v.length - 1];
            to[to.length - 1] = [px + (2 / 3) * (c.x1 - px) - px, py + (2 / 3) * (c.y1 - py) - py];
            v.push([c.x, c.y]); to.push([0, 0]);
            ti.push([c.x + (2 / 3) * (c.x1 - c.x) - c.x, c.y + (2 / 3) * (c.y1 - c.y) - c.y]);
          } else if (c.type === 'C') {
            const [px, py] = v[v.length - 1];
            to[to.length - 1] = [c.x1 - px, c.y1 - py];
            v.push([c.x, c.y]); to.push([0, 0]);
            ti.push([c.x2 - c.x, c.y2 - c.y]);
          } else if (c.type === 'Z') { commit(); }
        }
        commit();
        return contours;
      }

      // SVG path data (the mark pieces use M/L/H/V/C) -> command objects.
      function svgDToCommands(d) {
        const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
        const cmds = [];
        let k = 0, cmd = '';
        let cur = [0, 0];
        const num = () => parseFloat(tokens[k++]);
        while (k < tokens.length) {
          if (/[a-zA-Z]/.test(tokens[k])) { cmd = tokens[k++]; if (cmd === 'Z' || cmd === 'z') { cmds.push({ type: 'Z' }); continue; } continue; }
          if (cmd === 'M' || cmd === 'L') { cur = [num(), num()]; cmds.push({ type: cmd, x: cur[0], y: cur[1] }); if (cmd === 'M') cmd = 'L'; }
          else if (cmd === 'H') { cur = [num(), cur[1]]; cmds.push({ type: 'L', x: cur[0], y: cur[1] }); }
          else if (cmd === 'V') { cur = [cur[0], num()]; cmds.push({ type: 'L', x: cur[0], y: cur[1] }); }
          else if (cmd === 'C') { const x1 = num(), y1 = num(), x2 = num(), y2 = num(); cur = [num(), num()]; cmds.push({ type: 'C', x1, y1, x2, y2, x: cur[0], y: cur[1] }); }
          else throw new Error(`unsupported path command: ${cmd}`);
        }
        return cmds;
      }

      // A word's outline contours (glyph-by-glyph: Inter's GSUB tables trip
      // opentype.js's shaper, and plain Latin labels need none of it).
      function wordContours(text, size) {
        const cmds = [];
        let x = 0, prev = null;
        for (const ch of text) {
          const g = font.charToGlyph(ch);
          if (prev) x += (font.getKerningValue(prev, g) / font.unitsPerEm) * size;
          cmds.push(...g.getPath(x, 0, size).commands);
          x += (g.advanceWidth / font.unitsPerEm) * size;
          prev = g;
        }
        const contours = commandsToContours(cmds);
        let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
        for (const c of contours) for (const [px, py] of c.v) {
          x1 = Math.min(x1, px); y1 = Math.min(y1, py);
          x2 = Math.max(x2, px); y2 = Math.max(y2, py);
        }
        return { contours, bbox: { x1, y1, x2, y2 } };
      }

      const shapeGroup = (nm, contours, hex, extraTr = {}) => ({
        ty: 'gr',
        nm,
        it: [
          ...contours.map((k) => ({ ty: 'sh', nm: 'p', ks: { a: 0, k } })),
          { ty: 'fl', nm: 'fill', c: { a: 0, k: [...lottieRgb(hex), 1] }, o: { a: 0, k: 100 }, r: 1 },
          {
            ty: 'tr',
            p: { a: 0, k: extraTr.p || [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: 0 },
            o: { a: 0, k: 100 },
          },
        ],
      });

      // The four mark pieces assembling at (cx, cy), mark height markH.
      function markLayers(W, H, cx, cy, markH, OP, opts = {}) {
        const SLIDE = opts.slide ?? markH * 0.45;
        const sc = r4((markH / mvs) * 100);
        return pathEls.map((el, idx) => {
          const d = el.match(/ d="([^"]+)"/)[1];
          const hex = '#' + el.match(/fill="#([0-9a-fA-F]{6})"/)[1];
          const contours = commandsToContours(svgDToCommands(d));
          let dx = 0, dy = 0, n = 0;
          for (const c of contours) for (const [px, py] of c.v) { dx += px; dy += py; n++; }
          dx = dx / n - markCx;
          dy = dy / n - markCy;
          const len = Math.hypot(dx, dy) || 1;
          dx /= len; dy /= len;
          const t0 = idx * 2.5;
          // Every non-final keyframe needs o/i easing or lottie-web fails to
          // interpolate the segment and renders nothing.
          const hold = { o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } };
          const pos = [{ t: t0, s: [r4(cx + dx * SLIDE), r4(cy + dy * SLIDE), 0], o: { x: [0.2], y: [0.9] }, i: { x: [0.5], y: [1] } }, { t: t0 + 14, s: [cx, cy, 0], ...hold }];
          if (opts.breathe) {
            // Pieces drift apart slightly and settle again, looping.
            const amp = markH * 0.06;
            pos.push(
              { t: 28, s: [cx, cy, 0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } },
              { t: 46, s: [r4(cx + dx * amp), r4(cy + dy * amp), 0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } },
              { t: 64, s: [cx, cy, 0] }
            );
          }
          return {
            ddd: 0, ind: idx + 1, ty: 4, nm: `piece-${idx}`, sr: 1,
            ks: {
              o: { a: 1, k: [{ t: t0, s: [0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } }, { t: t0 + 8, s: [100] }] },
              r: { a: 0, k: 0 },
              p: { a: 1, k: pos },
              a: { a: 0, k: [r4(markCx), r4(markCy), 0] },
              s: { a: 0, k: [sc, sc, 100] },
            },
            ao: 0,
            shapes: [shapeGroup(`piece-${idx}`, contours, hex)],
            ip: 0, op: OP, st: 0,
          };
        });
      }

      // intro.json: 400x400, 10s loop.
      {
        const W = 400, H = 400, OP = 240;
        const BADGES = [
          { word: 'Transact', x: 200, y: 58, r: 40, bg: '#31BDC6', fg: '#09090A' },
          { word: 'Claim', x: 307, y: 160, r: 36, bg: '#69E9F5', fg: '#09090A' },
          { word: 'Stake', x: 200, y: 262, r: 37, bg: '#8A4BDB', fg: '#FFFFFF' },
          { word: 'Vote', x: 93, y: 160, r: 35, bg: '#5954CD', fg: '#FFFFFF' },
        ];
        const FLOAT_START = 72;
        const badgeLayers = BADGES.map((b, idx) => {
          let size = 15;
          let word = wordContours(b.word, size);
          const limit = b.r * 2 - 16;
          const w15 = word.bbox.x2 - word.bbox.x1;
          if (w15 > limit) {
            size = Math.floor(15 * (limit / w15));
            word = wordContours(b.word, size);
          }
          const bb = word.bbox;
          const t0 = 26 + idx * 7;
          const dir = idx % 2 === 0 ? -1 : 1;
          const ease = { o: { x: [0.42], y: [0] }, i: { x: [0.58], y: [1] } };
          const floats = [];
          for (let seg = 0; seg <= 6; seg++) {
            const t = FLOAT_START + seg * 28;
            const y = seg % 2 === 0 ? b.y : b.y + dir * 6 * (seg % 4 === 1 ? 1 : -1);
            floats.push(seg < 6 ? { t, s: [b.x, r4(y), 0], ...ease } : { t, s: [b.x, r4(y), 0] });
          }
          return {
            ddd: 0, ind: 10 + idx, ty: 4, nm: `badge-${b.word}`, sr: 1,
            ks: {
              o: { a: 1, k: [{ t: t0, s: [0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } }, { t: t0 + 5, s: [100] }] },
              r: { a: 0, k: 0 },
              p: { a: 1, k: [{ t: t0, s: [b.x, b.y, 0], ...ease }, ...floats] },
              a: { a: 0, k: [0, 0, 0] },
              s: {
                a: 1,
                k: [
                  { t: t0, s: [0, 0, 100], o: { x: [0.2], y: [0.9] }, i: { x: [0.5], y: [1] } },
                  { t: t0 + 7, s: [112, 112, 100], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } },
                  { t: t0 + 11, s: [100, 100, 100] },
                ],
              },
            },
            ao: 0,
            // Earlier entries draw on top: label first, circle underneath.
            shapes: [
              shapeGroup('label', word.contours, b.fg, { p: [r4(-(bb.x1 + bb.x2) / 2), r4(-(bb.y1 + bb.y2) / 2)] }),
              {
                ty: 'gr',
                nm: 'circle',
                it: [
                  { ty: 'el', nm: 'e', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [b.r * 2, b.r * 2] } },
                  { ty: 'fl', nm: 'fill', c: { a: 0, k: [...lottieRgb(b.bg), 1] }, o: { a: 0, k: 100 }, r: 1 },
                  { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
                ],
              },
            ],
            ip: 0, op: OP, st: 0,
          };
        });
        const anim = {
          v: '5.7.4', fr: 24, ip: 0, op: OP, w: W, h: H, nm: 'epix-intro', ddd: 0, assets: [],
          layers: [...badgeLayers, ...markLayers(W, H, 200, 160, 110, OP)],
        };
        const json = Buffer.from(JSON.stringify(anim));
        JSON.parse(json.toString());
        await write('wallet/lottie/register/intro.json', json);
      }

      // creating(-light).json: 600x600, 3s loop, assembly + breathing.
      {
        const OP = 72;
        const anim = {
          v: '5.7.4', fr: 24, ip: 0, op: OP, w: 600, h: 600, nm: 'epix-creating', ddd: 0, assets: [],
          layers: markLayers(600, 600, 300, 300, 220, OP, { breathe: true }),
        };
        const json = Buffer.from(JSON.stringify(anim));
        JSON.parse(json.toString());
        await write('wallet/lottie/register/creating.json', json);
        await write('wallet/lottie/register/creating-light.json', json);
      }
    }
  }
}

// macOS .icns via iconutil (rounded style).
{
  const iconset = path.join(SCRATCH, 'AppIcon.iconset');
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });
  const entries = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, size] of entries) {
    await fs.writeFile(path.join(iconset, name), await styles.rounded(size));
  }
  const icnsPath = path.join(OUT, 'macos', 'AppIcon.icns');
  await fs.mkdir(path.dirname(icnsPath), { recursive: true });
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath]);
  const st = await fs.stat(icnsPath);
  if (st.size < 10000) throw new Error(`AppIcon.icns looks too small: ${st.size} bytes`);
  console.log(`wrote macos/AppIcon.icns (${st.size} bytes)`);
}

// Windows .ico: square style with 12% corner radius.
{
  const bufs = [];
  for (const s of [16, 24, 32, 48, 64, 128, 256]) {
    bufs.push(await styles.rounded(s, 0.62, 0.12));
  }
  await write('windows/app.ico', await pngToIco(bufs));
}

// Linux (circle style).
for (const s of [48, 64, 128, 256, 512]) {
  await write(`linux/epix-${s}.png`, await styles.circle(s));
}

// Android launchers (circle style).
const mipmaps = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [dpi, s] of Object.entries(mipmaps)) {
  await write(`android/mipmap-${dpi}/ic_launcher.png`, await styles.circle(s));
}

// Android adaptive layers.
await write('android/adaptive-foreground-432.png', await markOnTransparent(432, 0.6));
await write('android/adaptive-background-432.png',
  await sharp({ create: { width: 432, height: 432, channels: 4, background: BLACK } }).png().toBuffer());
await write('android/adaptive-monochrome-432.png', await silhouette(432, 0.6, '#FFFFFF'));

// iOS app icon: square style, fully opaque, no alpha channel in the file.
{
  const buf = await sharp(await styles.square(1024))
    .flatten({ background: BLACK })
    .removeAlpha()
    .png()
    .toBuffer();
  await write('ios/AppIcon-1024.png', buf);
}

// Tray silhouettes.
const TRAY_PCT = 0.9;
await write('tray/trayTemplate-22.png', await silhouette(22, TRAY_PCT, '#000000'));
await write('tray/trayTemplate-44.png', await silhouette(44, TRAY_PCT, '#000000'));
await write('tray/tray-white-22.png', await silhouette(22, TRAY_PCT, '#FFFFFF'));
await write('tray/tray-white-44.png', await silhouette(44, TRAY_PCT, '#FFFFFF'));

// ---------------------------------------------------------------------------
// Contact sheet: every tile upscaled 4x with nearest-neighbor on a flat
// mid-gray background so black, white, and colored art all stay visible.
// Grid order (left to right):
//   row 1: favicon-mark-16, favicon-mark-32, favicon-mark-48,
//          favicon-circle-16, favicon-circle-32, favicon-circle-48
//   row 2: extension-48, trayTemplate-22, tray-white-22,
//          trayTemplate-44, tray-white-44
//   row 3: rounded-256, square-256, adaptive-monochrome-432
// ---------------------------------------------------------------------------
{
  async function up4(buf) {
    const meta = await sharp(buf).metadata();
    return {
      buf: await sharp(buf).resize(meta.width * 4, meta.height * 4, { kernel: 'nearest' }).png().toBuffer(),
      w: meta.width * 4,
      h: meta.height * 4,
    };
  }

  const rows = [
    await Promise.all([
      up4(favMark[16]), up4(favMark[32]), up4(favMark[48]),
      up4(favCircle[16]), up4(favCircle[32]), up4(favCircle[48]),
    ]),
    await Promise.all([
      up4(await styles.circle(48)),
      up4(await silhouette(22, TRAY_PCT, '#000000')),
      up4(await silhouette(22, TRAY_PCT, '#FFFFFF')),
      up4(await silhouette(44, TRAY_PCT, '#000000')),
      up4(await silhouette(44, TRAY_PCT, '#FFFFFF')),
    ]),
    await Promise.all([
      up4(await styles.rounded(256)),
      up4(await styles.square(256)),
      up4(await silhouette(432, 0.6, '#FFFFFF')),
    ]),
  ];

  const GAP = 32;
  const composites = [];
  let y = GAP;
  let sheetW = 0;
  for (const row of rows) {
    let x = GAP;
    const rowH = Math.max(...row.map((t) => t.h));
    for (const t of row) {
      composites.push({ input: t.buf, left: x, top: y + Math.round((rowH - t.h) / 2) });
      x += t.w + GAP;
    }
    sheetW = Math.max(sheetW, x);
    y += rowH + GAP;
  }

  const sheet = await sharp({
    create: { width: sheetW, height: y, channels: 4, background: '#72747B' },
  })
    .composite(composites)
    .png()
    .toBuffer();
  await write('preview/contact-sheet.png', sheet);
}

console.log('done');
