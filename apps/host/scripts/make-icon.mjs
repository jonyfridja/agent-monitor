// Generates the app icon (build/icon.icns + build/icon.png) with no image assets: a dark rounded tile with an
// outlined phone — the second screen — showing a status dot. Same design as the tray glyph (src/icons.ts).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/icons.ts';

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, '..', 'build');
const iconset = join(build, 'icon.iconset');
const S = 1024;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Signed distances in unit-square coordinates, scaled to pixels by the caller for anti-aliasing.
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const sdSegment = (x, y, ax, ay, bx, by) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
};

function shade(x, y) {
  // Returns [r,g,b,a] (straight alpha, 0..1 for a) at unit coords, composing layers back to front.
  let out = [0, 0, 0, 0];
  const over = (rgb, cover) => {
    const a = clamp01(cover);
    if (a <= 0) return;
    const na = a + out[3] * (1 - a);
    out = [0, 1, 2].map((i) => (rgb[i] * a + out[i] * out[3] * (1 - a)) / (na || 1)).concat(na);
  };
  const px = (d) => 0.5 - d * S; // signed distance (unit) → pixel coverage

  const body = sdRoundRect(x, y, 0.5, 0.5, 0.4, 0.4, 0.18);
  const t = clamp01((y - 0.1) / 0.8);
  const bg = [0, 1, 2].map((i) => hex('#233040')[i] * (1 - t) + hex('#0c1016')[i] * t);
  over(bg, px(body));
  over(hex('#3a4a5c'), Math.min(px(body), 0.5 - (-body - 0.004) * S) * 0.6); // hairline highlight on the rim

  // The phone: outline, a "home bar", a status dot on the screen and a short line of text under it.
  const outline = Math.abs(sdRoundRect(x, y, 0.5, 0.5, 0.155, 0.3, 0.07)) - 0.019;
  over(hex('#cbd5e1'), px(outline));
  over(hex('#cbd5e1'), px(sdSegment(x, y, 0.44, 0.718, 0.56, 0.718) - 0.015));
  over(hex('#f5a524'), px(sdCircle(x, y, 0.5, 0.427, 0.0775)));
  over(hex('#8a97a6'), px(sdSegment(x, y, 0.42, 0.573, 0.58, 0.573) - 0.0135));
  return out;
}

// Render once at 1024, then box-downscale for the other sizes.
const master = new Uint8Array(S * S * 4);
for (let py = 0; py < S; py++) {
  for (let pxx = 0; pxx < S; pxx++) {
    const [r, g, b, a] = shade((pxx + 0.5) / S, (py + 0.5) / S);
    const i = (py * S + pxx) * 4;
    master[i] = Math.round(r);
    master[i + 1] = Math.round(g);
    master[i + 2] = Math.round(b);
    master[i + 3] = Math.round(a * 255);
  }
}

function downscale(size) {
  if (size === S) return master;
  const f = S / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * S + x * f + dx) * 4;
          const al = master[i + 3];
          r += master[i] * al; g += master[i + 1] * al; b += master[i + 2] * al; a += al; // premultiplied average
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / (f * f));
    }
  }
  return out;
}

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
const sizes = { 'icon_16x16': 16, 'icon_16x16@2x': 32, 'icon_32x32': 32, 'icon_32x32@2x': 64, 'icon_128x128': 128, 'icon_128x128@2x': 256, 'icon_256x256': 256, 'icon_256x256@2x': 512, 'icon_512x512': 512, 'icon_512x512@2x': 1024 };
const cache = new Map();
for (const [name, size] of Object.entries(sizes)) {
  if (!cache.has(size)) cache.set(size, encodePng(size, size, downscale(size)));
  writeFileSync(join(iconset, `${name}.png`), cache.get(size));
}
writeFileSync(join(build, 'icon.png'), cache.get(512)); // used for the Dock icon in dev / the Dock fallback
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')]);
rmSync(iconset, { recursive: true, force: true });
console.log('wrote build/icon.icns and build/icon.png');
