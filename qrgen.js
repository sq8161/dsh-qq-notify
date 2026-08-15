// QR Code 编码器（纯 JS，无依赖）——用于在插件内直接渲染二维码
// 支持：Byte 模式、ECC L、版本 1-9 自动选择、固定掩码 0。
// 已用 npm `qrcode` 库逐模块比对 + `jsqr` 独立解码验证。
'use strict'

// ---------- GF(256)（QR 多项式 0x11d） ----------
const GF_EXP = new Array(512)
const GF_LOG = new Array(256)
;(function initGf() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

// 生成 n 阶 RS 生成多项式：g(x) = Π (x - α^i), i=0..n-1
function rsGeneratorPoly(n) {
  let poly = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i])
      next[j + 1] ^= poly[j]
    }
    poly = next
  }
  return poly
}

// RS 纠错：data 多项式乘 x^n 后对生成多项式取余
function rsEncode(data, eccCount) {
  const gen = rsGeneratorPoly(eccCount) // gen[k] = x^k 的系数（低次在前），gen[eccCount]=1
  const rem = new Array(eccCount).fill(0) // rem[j] = x^(eccCount-1-j) 的系数
  for (const byte of data) {
    const factor = byte ^ rem[0] // 移位后 x^eccCount 的系数
    rem.shift()
    rem.push(0)
    if (factor !== 0) {
      for (let j = 0; j < eccCount; j++) {
        rem[j] ^= gfMul(gen[eccCount - 1 - j], factor)
      }
    }
  }
  return rem
}

// ---------- 版本表（ECC L） ----------
// [总码字, 每块数据码字, 块数]
const VERSION_TABLE = {
  1: [26, 19, 1], 2: [44, 34, 1], 3: [70, 55, 1], 4: [100, 80, 1], 5: [134, 108, 1],
  6: [172, 68, 2], 7: [196, 78, 2], 8: [242, 97, 2], 9: [292, 116, 2],
}
const ALIGN_POSITIONS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
}

function selectVersion(dataLen) {
  for (let v = 1; v <= 9; v++) {
    const [total, dataPer, blocks] = VERSION_TABLE[v]
    const nData = dataPer * blocks
    // 字节模式开销：4 位模式 + 8 位长度 + 4 位终止符
    const usableBits = nData * 8 - 4 - 8 - 4
    if (dataLen * 8 <= usableBits) return v
  }
  return 0 // 内容过长
}

// ---------- BCH ----------
// 格式信息：15 位 (5 数据 + 10 纠错)，生成多项式 0x537，掩码 0x5412
function formatBits(eccBits, mask) {
  let data = ((eccBits << 3) | mask) << 10
  let g = 0x537
  for (let i = 14; i >= 10; i--) {
    if (data & (1 << i)) data ^= g << (i - 10)
  }
  return (((eccBits << 3) | mask) << 10 | data) ^ 0x5412
}

// 版本信息：18 位 (6 数据 + 12 纠错)，生成多项式 0x1f25
function versionBits(v) {
  let data = v << 12
  const g = 0x1f25
  for (let i = 17; i >= 12; i--) {
    if (data & (1 << i)) data ^= g << (i - 12)
  }
  return (v << 12) | data
}

// ---------- 矩阵构建 ----------
function buildMatrix(version, dataBytes, eccBytes) {
  const size = 21 + 4 * (version - 1)
  const modules = new Array(size)
  const reserved = new Array(size)
  for (let r = 0; r < size; r++) {
    modules[r] = new Array(size).fill(0)
    reserved[r] = new Array(size).fill(false)
  }
  // 1 = 深色，0 = 浅色；reserved 标记功能图案（含浅色格），数据区不得覆盖

  const setDark = (r, c, dark) => { modules[r][c] = dark ? 1 : 0 }
  const reserve = (r, c) => { reserved[r][c] = true }

  // 定位图案 + 分隔符
  const drawFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        reserve(rr, cc)
        const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6
        setDark(rr, cc, inFinder && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)))
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  // 定时图案（第 6 行/列）
  for (let i = 8; i < size - 8; i++) {
    reserve(6, i)
    setDark(6, i, i % 2 === 0)
    reserve(i, 6)
    setDark(i, 6, i % 2 === 0)
  }

  // 对齐图案（仅跳过与定位图案重叠的中心；可覆盖定时图案）
  const alignPos = ALIGN_POSITIONS[version]
  for (const r of alignPos) {
    for (const c of alignPos) {
      const inTopLeft = r <= 8 && c <= 8
      const inTopRight = r <= 8 && c >= size - 9
      const inBottomLeft = r >= size - 9 && c <= 8
      if (inTopLeft || inTopRight || inBottomLeft) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          reserve(r + dr, c + dc)
          setDark(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
        }
      }
    }
  }

  // 暗模块（第 size-8 行，第 8 列）
  reserve(size - 8, 8)
  setDark(size - 8, 8, true)

  // 格式信息（ECC L = 01, 掩码 0）与版本信息：先预留占位（数据流跳过这些单元），掩码后写入真值
  const fmt = formatBits(1, 0)
  const fmtCells = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  fmtCells.forEach(([r, c]) => { reserve(r, c); setDark(r, c, false) })
  for (let i = 0; i < 8; i++) { reserve(8, size - 1 - i); setDark(8, size - 1 - i, false) }
  for (let i = 8; i < 15; i++) { reserve(size - 15 + i, 8); setDark(size - 15 + i, 8, false) }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      reserve(Math.floor(i / 3), (i % 3) + size - 11)
      reserve((i % 3) + size - 11, Math.floor(i / 3))
      setDark(Math.floor(i / 3), (i % 3) + size - 11, false)
      setDark((i % 3) + size - 11, Math.floor(i / 3), false)
    }
  }

  // 数据码字 + 纠错码字
  const allCodewords = dataBytes.concat(eccBytes)
  let bitIndex = 0
  const totalBits = allCodewords.length * 8
  let row = size - 1
  let col = size - 1
  let upward = true
  while (col > 0) {
    if (col === 6) col--
    for (let k = 0; k < 2; k++) {
      const c = col - k
      if (row >= 0 && row < size && !reserved[row][c]) {
        let bit = 0
        if (bitIndex < totalBits) {
          const byte = allCodewords[bitIndex >> 3]
          bit = (byte >> (7 - (bitIndex & 7))) & 1
          bitIndex++
        }
        setDark(row, c, bit === 1)
      }
    }
    if (upward) {
      row--
      if (row < 0) { upward = false; col -= 2; row = 0 }
    } else {
      row++
      if (row >= size) { upward = true; col -= 2; row = size - 1 }
    }
  }

  // 掩码 0：(r + c) % 2 == 0 时翻转（仅数据区）
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && (r + c) % 2 === 0) modules[r][c] = modules[r][c] === 1 ? 0 : 1
    }
  }

  // 写入格式信息真值（第一份：左上；第二份：bits 0..7 横排 (8, size-1..size-8)，bits 8..14 竖排 (size-7..size-1, 8)）
  fmtCells.forEach(([r, c], i) => setDark(r, c, ((fmt >> (14 - i)) & 1) === 1))
  for (let i = 0; i < 8; i++) setDark(8, size - 1 - i, ((fmt >> i) & 1) === 1)
  for (let i = 8; i < 15; i++) setDark(size - 15 + i, 8, ((fmt >> i) & 1) === 1)

  // 写入版本信息真值（v >= 7）
  if (version >= 7) {
    const vb = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >> i) & 1) === 1
      setDark(Math.floor(i / 3), (i % 3) + size - 11, bit)
      setDark((i % 3) + size - 11, Math.floor(i / 3), bit)
    }
  }

  return modules
}

// ---------- 入口 ----------
// 返回 { version, size, matrix }；matrix[r][c]：1 深色 / 0 浅色
function encodeQr(text) {
  const data = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) data.push(code)
    else {
      // 非 ASCII：按 UTF-8 编码
      const bytes = []
      if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
      else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
      for (const b of bytes) data.push(b)
    }
  }

  const version = selectVersion(data.length)
  if (version === 0) throw new Error('内容过长，无法生成二维码')

  const [, dataPerBlock, blockCount] = VERSION_TABLE[version]
  const totalData = dataPerBlock * blockCount
  // 位流：模式(4) + 长度(8) + 数据 + 终止符 + 补齐
  const bits = []
  const pushBits = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1) }
  pushBits(4, 4)            // byte 模式
  pushBits(data.length, 8)  // 字符计数（v1-9 为 8 位）
  for (const b of data) pushBits(b, 8)
  pushBits(0, Math.min(4, totalData * 8 - bits.length)) // 终止符
  while (bits.length % 8 !== 0) bits.push(0)
  const padBytes = [0xec, 0x11]
  let pi = 0
  while (bits.length / 8 < totalData) {
    pushBits(padBytes[pi++ % 2], 8)
  }

  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    codewords.push(b)
  }

  const eccPerBlock = (VERSION_TABLE[version][0] - VERSION_TABLE[version][1] * blockCount) / blockCount
  // 分块 + 交错（数据区按块顺序，纠错区按块交错）
  const dataBlocks = []
  const eccBlocks = []
  for (let b = 0; b < blockCount; b++) {
    const block = codewords.slice(b * dataPerBlock, (b + 1) * dataPerBlock)
    dataBlocks.push(block)
    eccBlocks.push(rsEncode(block, eccPerBlock))
  }
  const interleaved = []
  for (let i = 0; i < dataPerBlock; i++) {
    for (let b = 0; b < blockCount; b++) interleaved.push(dataBlocks[b][i])
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (let b = 0; b < blockCount; b++) interleaved.push(eccBlocks[b][i])
  }

  const matrix = buildMatrix(version, interleaved.slice(0, totalData), interleaved.slice(totalData))
  return { version, size: matrix.length, matrix, reserved: reservedMatrix(version, matrix.length) }
}

// 供测试/调试：返回与 buildMatrix 相同的预留（功能图案）位置
function reservedMatrix(version, size) {
  const reserved = []
  for (let r = 0; r < size; r++) reserved[r] = new Array(size).fill(false)
  const reserve = (r, c) => { reserved[r][c] = true }
  const drawFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        reserve(rr, cc)
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)
  for (let i = 8; i < size - 8; i++) { reserve(6, i); reserve(i, 6) }
  const alignPos = ALIGN_POSITIONS[version]
  for (const r of alignPos) {
    for (const c of alignPos) {
      const inTopLeft = r <= 8 && c <= 8
      const inTopRight = r <= 8 && c >= size - 9
      const inBottomLeft = r >= size - 9 && c <= 8
      if (inTopLeft || inTopRight || inBottomLeft) continue
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) reserve(r + dr, c + dc)
    }
  }
  reserve(size - 8, 8)
  const fmtCells = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  fmtCells.forEach(([r, c]) => reserve(r, c))
  for (let i = 0; i < 8; i++) reserve(8, size - 1 - i)
  for (let i = 8; i < 15; i++) reserve(size - 15 + i, 8)
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      reserve(Math.floor(i / 3), (i % 3) + size - 11)
      reserve((i % 3) + size - 11, Math.floor(i / 3))
    }
  }
  return reserved
}

module.exports = { encodeQr }
