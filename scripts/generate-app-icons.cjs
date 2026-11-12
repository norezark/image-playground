'use strict';
// Small code-drawn app icon; uses only Node's built-ins.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const dir = path.resolve(__dirname, '../public/icons');
fs.mkdirSync(dir, { recursive: true });
function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, bytes, checksum]);
}
for (const size of [192, 512]) {
  const pixels = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const frame = u > 0.19 && u < 0.81 && v > 0.21 && v < 0.79
      && (u < 0.22 || u > 0.78 || v < 0.24 || v > 0.76);
    const sun = (u - 0.65) ** 2 + (v - 0.37) ** 2 < 0.047 ** 2;
    const mountain = u > 0.26 && u < 0.74 && v < 0.70
      && (v > 0.46 + Math.abs(u - 0.40) * 1.2 || v > 0.55 + Math.abs(u - 0.63) * 1.1);
    const color = frame || sun || mountain ? [88, 166, 255] : [22, 27, 34];
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    for (let c = 0; c < 3; c++) pixels[offset + c] = color[c];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  fs.writeFileSync(path.join(dir, `icon-${size}.png`), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
