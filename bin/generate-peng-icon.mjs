#!/usr/bin/env node
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const output = process.argv[2];
if (!output) throw new Error("Usage: generate-peng-icon <output.png>");

const size = 1024;
const pixels = Buffer.alloc(size * size * 4);
const background = [14, 19, 27, 255];
const panel = [26, 36, 49, 255];
const mint = [92, 237, 201, 255];
const amber = [255, 173, 61, 255];

function roundedRectContains(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return Math.hypot(x - cx, y - cy) <= radius;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const strokeSegments = [
  [380, 285, 380, 735],
  [380, 685, 620, 685],
  [620, 685, 735, 620],
  [735, 620, 760, 500],
  [760, 500, 735, 350],
  [735, 350, 620, 285],
  [620, 285, 380, 285]
];

function blend(index, color, alpha = 1) {
  const amount = Math.max(0, Math.min(1, alpha));
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[index + channel] = Math.round(pixels[index + channel] * (1 - amount) + color[channel] * amount);
  }
  pixels[index + 3] = 255;
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const index = (y * size + x) * 4;
    pixels[index] = background[0];
    pixels[index + 1] = background[1];
    pixels[index + 2] = background[2];
    pixels[index + 3] = background[3];

    if (roundedRectContains(x + 0.5, y + 0.5, 48, 48, 976, 976, 220)) blend(index, panel);

    const glyphDistance = Math.min(...strokeSegments.map(([ax, ay, bx, by]) => distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by)));
    if (glyphDistance < 58) blend(index, mint, Math.min(1, 59 - glyphDistance));

    const amberDistance = Math.hypot(x + 0.5 - 736, y + 0.5 - 271);
    if (amberDistance < 37) blend(index, amber, Math.min(1, 38 - amberDistance));
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBuffer, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, payload, checksum]);
}

const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  scanlines[y * (size * 4 + 1)] = 0;
  pixels.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}

const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
writeFileSync(output, Buffer.concat([header, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
