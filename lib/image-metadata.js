'use strict';
const { inflateSync } = require('node:zlib');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function imageDimensions(buffer) {
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= buffer.length;) {
      const type = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + size > buffer.length) return null;
      if (type === 'VP8X' && size >= 10) return { width: buffer.readUIntLE(start + 4, 3) + 1, height: buffer.readUIntLE(start + 7, 3) + 1 };
      if (type === 'VP8L' && size >= 5) {
        const bits = buffer.readUInt32LE(start + 1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (type === 'VP8 ' && size >= 10) return { width: buffer.readUInt16LE(start + 6) & 0x3fff, height: buffer.readUInt16LE(start + 8) & 0x3fff };
      offset = start + size + (size % 2);
    }
  }
  if (buffer[0] === 255 && buffer[1] === 216) {
    let dimensions;
    let orientation = 1;
    for (let offset = 2; offset + 4 <= buffer.length;) {
      if (buffer[offset++] !== 255) break;
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const size = buffer.readUInt16BE(offset);
      if (size < 2 || offset + size > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) {
        dimensions = { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      if (marker === 0xe1 && buffer.toString('ascii', offset + 2, offset + 8) === 'Exif\0\0') {
        const tiff = buffer.subarray(offset + 8, offset + size);
        const little = tiff.toString('ascii', 0, 2) === 'II';
        const u16 = pos => little ? tiff.readUInt16LE(pos) : tiff.readUInt16BE(pos);
        const u32 = pos => little ? tiff.readUInt32LE(pos) : tiff.readUInt32BE(pos);
        try {
          const ifd = u32(4);
          for (let i = 0, count = u16(ifd); i < count; i++) {
            const entry = ifd + 2 + i * 12;
            if (u16(entry) === 0x112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) orientation = u16(entry + 8);
          }
        } catch { /* Ignore malformed EXIF; the image decoder will validate the source. */ }
      }
      offset += size;
    }
    if (dimensions && orientation >= 5 && orientation <= 8) return { width: dimensions.height, height: dimensions.width };
    return dimensions || null;
  }
  return null;
}

// Canvas exports 8-bit non-interlaced RGBA PNGs. Decode filters to check actual
// transparent pixels rather than accepting an opaque image with an alpha channel.
function hasTransparentPixels(buffer, { width, height }) {
  if (buffer[24] !== 8 || ![4, 6].includes(buffer[25]) || buffer[28] !== 0) return false;
  const bytesPerPixel = buffer[25] === 6 ? 4 : 2;
  const stride = width * bytesPerPixel;
  const chunks = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const size = buffer.readUInt32BE(offset);
    if (offset + size + 12 > buffer.length) return false;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) return false;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) return false;
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const b = previous[x];
      const c = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      row[x] = (row[x] + [0, a, b, Math.floor((a + b) / 2), paeth][filter]) & 255;
    }
    for (let x = bytesPerPixel - 1; x < stride; x += bytesPerPixel) if (row[x] < 255) return true;
    previous = row;
  }
  return false;
}

function validateMarkupImage(data, firstImage) {
  if (typeof data?.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data.dataUrl)) {
    throw new Error('描き込み画像には透過PNGを指定してください。');
  }
  const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
  if (buffer.length > 50 * 1024 * 1024 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('描き込み画像は50MB以下の透過PNGにしてください。');
  const dimensions = imageDimensions(buffer);
  const source = firstImage && imageDimensions(firstImage.buffer);
  if (!dimensions || !source || !dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 16777216
    || dimensions.width !== source.width || dimensions.height !== source.height) {
    throw new Error('描き込みと先頭の入力画像は同じサイズ（最大16,777,216画素）にしてください。');
  }
  try {
    if (hasTransparentPixels(buffer, dimensions)) return { buffer, mimeType: 'image/png', filename: 'markup.png' };
  } catch { /* Report a user-facing validation error instead of zlib internals. */ }
  throw new Error('描き込みには透過ピクセルを含むPNGを指定してください。');
}

module.exports = { imageDimensions, validateMarkupImage };
