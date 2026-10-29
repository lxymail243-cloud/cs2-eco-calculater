'use strict';

/**
 * 生成桌面快捷方式用的图标：public/cs2bh.ico
 *
 * 零依赖 —— 自己写 PNG 编码器（zlib + CRC32），再把多个尺寸的 PNG
 * 塞进一个 ICO 容器（Vista 以后的 Windows 支持 PNG 压缩的图标）。
 *
 * 图形：深色圆角底 + 琥珀色准星环 + 白十字准星 + 中心点。
 * 用 4x 超采样做抗锯齿，16/32/48/64/128/256 六个尺寸各画一遍，
 * 保证任务栏小图标和桌面大图标都不糊。
 *
 *   node tools/makeicon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG 编码

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;                       // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- 画图

const BG = [0x12, 0x17, 0x22];   // 深色底
const AMBER = [0xF5, 0xA6, 0x23]; // 准星环 / 中心点
const WHITE = [0xE9, 0xEF, 0xF8]; // 十字准星

/** 点在圆角矩形内？坐标用 0..1 归一化 */
function inRoundedRect(nx, ny, radius) {
  const x = nx < 0.5 ? 0.5 - nx : nx - 0.5;
  const y = ny < 0.5 ? 0.5 - ny : ny - 0.5;
  if (x > 0.5 || y > 0.5) return false;
  const cx = Math.max(x - (0.5 - radius), 0);
  const cy = Math.max(y - (0.5 - radius), 0);
  return cx * cx + cy * cy <= radius * radius;
}

/** 归一化坐标 -> 颜色（含 alpha）。不含抗锯齿，交给超采样平均 */
function sample(nx, ny) {
  if (!inRoundedRect(nx, ny, 0.22)) return null;

  const dx = nx - 0.5;
  const dy = ny - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);

  // 准星环：半径 0.30，线宽 0.030
  if (d >= 0.282 && d <= 0.312) return AMBER;

  // 中心点：半径 0.042
  if (d <= 0.042) return AMBER;

  // 十字准星：四根短杆，从 0.13 到 0.27，线宽 0.026
  const half = 0.026;
  if (Math.abs(dx) <= half && Math.abs(dy) >= 0.13 && Math.abs(dy) <= 0.27) return WHITE;
  if (Math.abs(dy) <= half && Math.abs(dx) >= 0.13 && Math.abs(dx) <= 0.27) return WHITE;

  return BG;
}

function renderRgba(size, ss) {
  const W = size * ss;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x * ss + sx + 0.5;
          const py = y * ss + sy + 0.5;
          const c = sample(px / W, py / W);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const alpha = a / n;
      // 边缘按覆盖率把颜色往背景色压一点，避免出现灰边
      if (alpha > 0) {
        const cov = a / 255 / n;
        const br = BG[0] + (r / (a / 255) / 1 - BG[0]) * cov;
        const bg = BG[1] + (g / (a / 255) / 1 - BG[1]) * cov;
        const bb = BG[2] + (b / (a / 255) / 1 - BG[2]) * cov;
        out[i] = Math.max(0, Math.min(255, Math.round(br)));
        out[i + 1] = Math.max(0, Math.min(255, Math.round(bg)));
        out[i + 2] = Math.max(0, Math.min(255, Math.round(bb)));
      }
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

// ---------------------------------------------------------------- ICO 容器

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  let offset = 6 + 16 * entries.length;
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.buf.length;
    dirs.push(d);
  }
  return Buffer.concat([header, ...dirs, ...entries.map(function (e) { return e.buf; })]);
}

// ---------------------------------------------------------------- main

const SIZES = [16, 32, 48, 64, 128, 256];
const SS = 4;

const entries = SIZES.map(function (size) {
  const rgba = renderRgba(size, SS);
  return { size: size, buf: encodePng(rgba, size, size) };
});

const outDir = path.join(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'cs2bh.ico');
fs.writeFileSync(outFile, makeIco(entries));

console.log('已生成 ' + outFile);
entries.forEach(function (e) {
  console.log('  ' + e.size + 'x' + e.size + '   ' + e.buf.length + ' bytes');
});
console.log('合计 ' + fs.statSync(outFile).size + ' bytes');
