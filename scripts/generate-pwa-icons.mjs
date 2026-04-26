import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const COLORS = {
  washi: [244, 234, 216, 255],
  edge: [212, 200, 176, 255],
  sumi: [24, 17, 10, 255],
  shu: [196, 53, 24, 255],
  shuSoft: [196, 53, 24, 89],
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const length = Buffer.alloc(4)
  const crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

function roundedRectSdf(px, py, x, y, width, height, radius) {
  const qx = Math.abs(px - (x + width / 2)) - width / 2 + radius
  const qy = Math.abs(py - (y + height / 2)) - height / 2 + radius
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

function inRoundedRect(px, py, x, y, width, height, radius) {
  return roundedRectSdf(px, py, x, y, width, height, radius) <= 0
}

function inRoundedRectStroke(px, py, x, y, width, height, radius, strokeWidth) {
  const distance = roundedRectSdf(px, py, x, y, width, height, radius)
  return distance <= strokeWidth / 2 && distance >= -strokeWidth / 2
}

function rotate(px, py, cx, cy, degrees) {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = px - cx
  const dy = py - cy
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  }
}

function blend(bottom, top) {
  const alpha = top[3] / 255
  const inverse = 1 - alpha
  return [
    Math.round(top[0] * alpha + bottom[0] * inverse),
    Math.round(top[1] * alpha + bottom[1] * inverse),
    Math.round(top[2] * alpha + bottom[2] * inverse),
    Math.round(255 * (alpha + (bottom[3] / 255) * inverse)),
  ]
}

function sampleIcon(px, py, contentScale) {
  let color = [0, 0, 0, 0]

  if (inRoundedRect(px, py, 0, 0, 512, 512, 96)) {
    color = COLORS.washi
  }

  if (inRoundedRectStroke(px, py, 0, 0, 512, 512, 96, 6)) {
    color = COLORS.edge
  }

  const ux = 256 + (px - 256) / contentScale
  const uy = 256 + (py - 256) / contentScale

  const bladeA = rotate(ux, uy, 256, 255, 36)
  const bladeB = rotate(ux, uy, 256, 255, -36)
  if (
    inRoundedRect(bladeA.x, bladeA.y, -16, 244, 544, 22, 11) ||
    inRoundedRect(bladeB.x, bladeB.y, -16, 244, 544, 22, 11)
  ) {
    color = COLORS.sumi
  }

  const circleDistance = Math.hypot(ux - 256, uy - 256)
  if (circleDistance <= 52) color = COLORS.shu
  if (circleDistance <= 36) color = COLORS.washi
  if (circleDistance <= 16) color = COLORS.shu

  if (inRoundedRect(ux, uy, 96, 418, 320, 6, 3)) {
    color = blend(color, COLORS.shuSoft)
  }

  return color
}

function pngForSize(size, contentScale = 1) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const samples = 3

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0

    for (let x = 0; x < size; x += 1) {
      const accum = [0, 0, 0, 0]
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = ((x + (sx + 0.5) / samples) / size) * 512
          const py = ((y + (sy + 0.5) / samples) / size) * 512
          const color = sampleIcon(px, py, contentScale)
          accum[0] += color[0]
          accum[1] += color[1]
          accum[2] += color[2]
          accum[3] += color[3]
        }
      }

      const offset = rowStart + 1 + x * 4
      raw[offset] = Math.round(accum[0] / (samples * samples))
      raw[offset + 1] = Math.round(accum[1] / (samples * samples))
      raw[offset + 2] = Math.round(accum[2] / (samples * samples))
      raw[offset + 3] = Math.round(accum[3] / (samples * samples))
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const icons = [
  ['public/pwa-icon-180.png', 180, 1],
  ['public/pwa-icon-192.png', 192, 1],
  ['public/pwa-icon-512.png', 512, 1],
  ['public/pwa-icon-maskable-512.png', 512, 0.82],
]

for (const [file, size, scale] of icons) {
  writeFileSync(file, pngForSize(size, scale))
  console.log(`wrote ${file}`)
}
