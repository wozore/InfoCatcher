// Zero-dependency OG image generator for InfoCatcher.
// Produces a 1200×630 brand-color placeholder image; pair with og-image.html
// for the version containing text.

'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const WIDTH = 1200;
const HEIGHT = 630;

function createCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
}

const CRC_TABLE = createCrcTable();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createImageRows() {
  const rows = [];
  for (let y = 0; y < HEIGHT; y++) {
    const row = Buffer.alloc(1 + WIDTH * 3);
    for (let x = 0; x < WIDTH; x++) {
      const offset = 1 + x * 3;
      if (y < 8 || x < 16) {
        row[offset] = 0x25; row[offset + 1] = 0x63; row[offset + 2] = 0xeb;
      } else if (y >= HEIGHT - 8) {
        row[offset] = 0x05; row[offset + 1] = 0x96; row[offset + 2] = 0x69;
      } else {
        row[offset] = 0x1a; row[offset + 1] = 0x1d; row[offset + 2] = 0x23;
      }
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function generateOgImage(outputPath = path.resolve(__dirname, '..', '..', 'og-image.png')) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;

  const image = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createChunk('IHDR', header),
    createChunk('IDAT', zlib.deflateSync(createImageRows())),
    createChunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(outputPath, image);
  return image.length;
}

if (require.main === module) {
  const bytes = generateOgImage();
  console.log('og-image.png generated (%d×%d, %d bytes)', WIDTH, HEIGHT, bytes);
}

module.exports = { generateOgImage };
