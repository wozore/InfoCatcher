/**
 * generate-og-image.js — 零依赖 OG 图生成（不依赖 Canvas / 任何图片库）
 *
 * 手写 PNG 编码器：像素行 → zlib deflate 压缩 → IHDR/IDAT/IEND chunk → 落盘。
 * 输出 1200×630 品牌色占位图（上/左品牌蓝 #2563eb、下品牌绿 #059669、主体深色 #1a1d23）。
 * 含文字版本见 og-image.html（本脚本只产纯色占位）。
 * 副作用：向 outputPath 写入 PNG 文件，返回写入字节数。
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { DIRS } = require('../shared/paths');

const WIDTH = 1200;
const HEIGHT = 630;

// PNG chunk 校验用 CRC-32：IEEE 多项式 0xEDB88320（反射实现）。因零依赖，手写查表法而非引第三方库。
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

/**
 * 生成全部像素行：每行首字节为 filter 类型 0（None，PNG 规定逐行 filter），
 * 之后每像素 3 字节 RGB。上 8px 与左 16px 为品牌蓝边，下 8px 为品牌绿边，其余主体深色。
 */
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

/**
 * 组装并写出 PNG 文件。
 * 结构：8 字节 PNG 签名 + IHDR（宽/高/位深 8/颜色类型 2=truecolor）+ IDAT（deflateSync 压缩像素行）+ IEND。
 * @returns {number} 写入的字节数
 */
function generateOgImage(outputPath = path.join(DIRS.public, 'og-image.png')) {
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
