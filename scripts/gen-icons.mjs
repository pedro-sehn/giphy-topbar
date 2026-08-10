// Renders the app/tray icons from code so no binary assets need to be committed.
// Usage: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = join(root, 'src-tauri', 'icons');
mkdirSync(iconDir, { recursive: true });

/* ---------- minimal PNG encoder ---------- */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- signed distance fields, in a 16x16 design space ---------- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);

function sdRoundBox(p, center, half, r) {
  const q = [Math.abs(p[0] - center[0]) - (half[0] - r), Math.abs(p[1] - center[1]) - (half[1] - r)];
  const outside = len([Math.max(q[0], 0), Math.max(q[1], 0)]);
  return outside + Math.min(Math.max(q[0], q[1]), 0) - r;
}

function sdSegment(p, a, b) {
  const pa = sub(p, a);
  const ba = sub(b, a);
  const h = Math.min(1, Math.max(0, (pa[0] * ba[0] + pa[1] * ba[1]) / (ba[0] ** 2 + ba[1] ** 2)));
  return len([pa[0] - ba[0] * h, pa[1] - ba[1] * h]);
}

// The mark: a film frame containing a "G" ring with an opening, plus an "I" bar.
function markDistance(p) {
  const stroke = 1.6 / 2;

  const frame = Math.abs(sdRoundBox(p, [8, 8], [6.5, 5.5], 2.5)) - stroke;

  const c = [8.6, 8];
  const d = sub(p, c);
  const angle = Math.atan2(d[1], d[0]);
  // Leave a gap on the right side of the ring, where the crossbar enters.
  const inGap = Math.abs(angle) < 0.45;
  const ring = inGap ? Infinity : Math.abs(len(d) - 2.6) - stroke;

  const crossbar = sdSegment(p, [8.9, 8], [11.0, 8]) - stroke;
  const bar = sdSegment(p, [5.4, 5.9], [5.4, 10.1]) - stroke;

  return Math.min(frame, ring, crossbar, bar);
}

const SS = 4; // supersampling factor per axis

function render(size, { color, background, padding = 0 }) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 16 / (size * (1 - padding * 2));
  const offset = (size * padding * scale);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let markHits = 0;
      let bgHits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = [
            (x + (sx + 0.5) / SS) * scale - offset,
            (y + (sy + 0.5) / SS) * scale - offset
          ];
          if (markDistance(p) <= 0) markHits++;
          if (background && sdRoundBox(p, [8, 8], [8, 8], 3.6) <= 0) bgHits++;
        }
      }

      const total = SS * SS;
      const i = (y * size + x) * 4;
      const markA = markHits / total;
      const bgA = background ? bgHits / total : 0;

      // Composite the mark over the (optional) rounded-square background.
      const a = markA + bgA * (1 - markA);
      if (a > 0) {
        for (let ch = 0; ch < 3; ch++) {
          rgba[i + ch] = Math.round(
            (color[ch] * markA + (background ? background[ch] : 0) * bgA * (1 - markA)) / a
          );
        }
      }
      rgba[i + 3] = Math.round(a * 255);
    }
  }

  return encodePng(rgba, size);
}

/* ---------- outputs ---------- */

// Tray: black-on-transparent template image; macOS recolors it for light/dark menu bars.
for (const [name, size] of [['tray.png', 22], ['tray@2x.png', 44]]) {
  writeFileSync(join(iconDir, name), render(size, { color: [0, 0, 0] }));
}

// App icon: white mark on the Giphy purple, inset so it sits well in the rounded square.
const appOpts = { color: [255, 255, 255], background: [151, 71, 255], padding: 0.16 };
const appSizes = [32, 128, 256, 512, 1024];
for (const size of appSizes) {
  writeFileSync(join(iconDir, `${size}x${size}.png`), render(size, appOpts));
}
writeFileSync(join(iconDir, '128x128@2x.png'), render(256, appOpts));
writeFileSync(join(iconDir, 'icon.png'), render(1024, appOpts));

// macOS bundle icon. iconutil needs a .iconset directory of exact-named sizes.
if (process.platform === 'darwin') {
  const set = join(iconDir, 'icon.iconset');
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  const iconset = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
  ];
  for (const [name, size] of iconset) {
    writeFileSync(join(set, name), render(size, appOpts));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(iconDir, 'icon.icns')]);
  rmSync(set, { recursive: true, force: true });
}

console.log(`icons written to ${iconDir}`);
