// generate-og-image.js — Zero-dependency OG image generator for InfoCatcher
// Produces 1200×630 PNG with brand colors. No text (font rendering not
// possible without canvas). Pair with og-image.html for a text version.
//
// Usage: node scripts/generate-og-image.js

const zlib = require('zlib');
const fs = require('fs');

const W = 1200, H = 630;

// Build raw pixel rows: each row = filter byte (0) + W*3 RGB bytes
const rows = [];
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(1 + W * 3);
  for (let x = 0; x < W; x++) {
    const off = 1 + x * 3;
    if (y < 8) {
      // Top accent bar — primary blue #2563eb
      row[off] = 0x25; row[off + 1] = 0x63; row[off + 2] = 0xeb;
    } else if (y >= H - 8) {
      // Bottom accent bar — emerald #059669
      row[off] = 0x05; row[off + 1] = 0x96; row[off + 2] = 0x69;
    } else if (x < 16) {
      // Left accent bar — primary blue #2563eb
      row[off] = 0x25; row[off + 1] = 0x63; row[off + 2] = 0xeb;
    } else {
      // Main background — dark #1a1d23
      row[off] = 0x1a; row[off + 1] = 0x1d; row[off + 2] = 0x23;
    }
  }
  rows.push(row);
}

const raw = Buffer.concat(rows);

// PNG signature
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// IHDR
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeB, data]);
  const crc = crc32(crcInput);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);   // width
ihdr.writeUInt32BE(H, 4);   // height
ihdr[8] = 8;                 // bit depth
ihdr[9] = 2;                 // color type: RGB
ihdr[10] = 0;                // compression
ihdr[11] = 0;                // filter
ihdr[12] = 0;                // interlace

// IDAT
const compressed = zlib.deflateSync(raw);

const out = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync('og-image.png', out);
console.log('og-image.png generated (%d×%d, %d bytes)', W, H, out.length);
