// AES-256-GCM 解密实现（纯 JS，无依赖）——用于 QQ 扫码绑定的凭据解密
// 密文布局：base64( IV(12) || ciphertext || tag(16) )
'use strict'

const SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
]

const RSBOX = new Array(256)
for (let i = 0; i < 256; i++) RSBOX[SBOX[i]] = i

// 有限域 GF(2^8) 乘（AES 多项式 0x11b）
function gmul(a, b) {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p
}

function keyExpansion(keyBytes) {
  // AES-256: 32 字节密钥 -> 60 个字 (240 字节) 轮密钥
  const Nk = 8, Nr = 14
  const w = new Uint32Array(4 * (Nr + 1))
  for (let i = 0; i < Nk; i++) {
    w[i] = (keyBytes[4 * i] << 24) | (keyBytes[4 * i + 1] << 16) | (keyBytes[4 * i + 2] << 8) | keyBytes[4 * i + 3]
  }
  let rcon = 1
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let temp = w[i - 1]
    if (i % Nk === 0) {
      // RotWord + SubWord + Rcon
      temp = ((SBOX[(temp >>> 24) & 0xff] << 24) |
              (SBOX[(temp >>> 16) & 0xff] << 16) |
              (SBOX[(temp >>> 8) & 0xff] << 8) |
              SBOX[temp & 0xff])
      temp = ((temp << 8) | (temp >>> 24)) >>> 0
      temp ^= rcon << 24
      rcon = gmul(rcon, 2)
    } else if (i % Nk === 4) {
      // SubWord（AES-256 特有）
      temp = ((SBOX[(temp >>> 24) & 0xff] << 24) |
              (SBOX[(temp >>> 16) & 0xff] << 16) |
              (SBOX[(temp >>> 8) & 0xff] << 8) |
              SBOX[temp & 0xff]) >>> 0
    }
    w[i] = (w[i - Nk] ^ temp) >>> 0
  }
  return w
}

function encryptBlock(w, input) {
  // input: 16 字节明文, 输出 16 字节密文
  const state = new Array(16)
  for (let i = 0; i < 16; i++) state[i] = input[i]
  const Nr = 14

  function addRoundKey(round) {
    for (let c = 0; c < 4; c++) {
      const word = w[round * 4 + c]
      state[c * 4 + 0] ^= (word >>> 24) & 0xff
      state[c * 4 + 1] ^= (word >>> 16) & 0xff
      state[c * 4 + 2] ^= (word >>> 8) & 0xff
      state[c * 4 + 3] ^= word & 0xff
    }
  }

  function subBytes() { for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]] }
  function shiftRows() {
    // 行 1 左移 1, 行 2 左移 2, 行 3 左移 3（按列存储）
    const t = state.slice()
    state[1] = t[5]; state[5] = t[9]; state[9] = t[13]; state[13] = t[1]
    state[2] = t[10]; state[6] = t[14]; state[10] = t[2]; state[14] = t[6]
    state[3] = t[15]; state[7] = t[3]; state[11] = t[7]; state[15] = t[11]
  }
  function mixColumns() {
    for (let c = 0; c < 4; c++) {
      const i = c * 4
      const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3]
      state[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3
      state[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3
      state[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3)
      state[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2)
    }
  }

  addRoundKey(0)
  for (let round = 1; round <= Nr; round++) {
    subBytes()
    shiftRows()
    if (round < Nr) mixColumns()
    addRoundKey(round)
  }
  return state
}

// ---------- GCM ----------
// GF(2^128) 乘法（GCM 多项式 x^128 + x^7 + x^2 + x + 1）
function gf128Mul(x, y) {
  const X = new Uint8Array(x)
  const Y = new Uint8Array(y)
  const Z = new Uint8Array(16)
  const V = new Uint8Array(Y)
  for (let i = 0; i < 128; i++) {
    if ((X[i >> 3] >> (7 - (i & 7))) & 1) {
      for (let j = 0; j < 16; j++) Z[j] ^= V[j]
    }
    let lsb = V[15] & 1
    for (let j = 15; j > 0; j--) V[j] = ((V[j] >> 1) | (V[j - 1] << 7)) & 0xff
    V[0] = (V[0] >> 1) & 0x7f
    if (lsb) V[0] ^= 0xe1
  }
  return Z
}

function ghashBlocks(h, blocks) {
  // blocks: Uint8Array, 长度 16 的整数倍
  const y = new Uint8Array(16)
  for (let off = 0; off < blocks.length; off += 16) {
    const block = blocks.subarray(off, off + 16)
    for (let i = 0; i < 16; i++) y[i] ^= block[i]
    const r = gf128Mul(y, h)
    y.set(r)
  }
  return y
}

function gcmDecrypt(keyBytes, ivBytes, ciphertext, tag) {
  const w = keyExpansion(keyBytes)
  // H = E(K, 0^128)
  const H = encryptBlock(w, new Uint8Array(16))
  // J0 = IV || 0x00000001
  const j0 = new Uint8Array(16)
  j0.set(ivBytes, 0)
  j0[15] = 1
  // 计数器块 = J0 加 1
  const incr = (block) => {
    const b = new Uint8Array(block)
    for (let i = 15; i >= 12; i--) {
      b[i] = (b[i] + 1) & 0xff
      if (b[i] !== 0) break
    }
    return b
  }
  // 解密
  const plain = new Uint8Array(ciphertext.length)
  const nBlocks = Math.ceil(ciphertext.length / 16)
  let ctr = incr(j0)
  for (let i = 0; i < nBlocks; i++) {
    const ks = encryptBlock(w, ctr)
    const base = i * 16
    for (let j = 0; j < 16 && base + j < ciphertext.length; j++) {
      plain[base + j] = ciphertext[base + j] ^ ks[j]
    }
    ctr = incr(ctr)
  }
  // GHASH 校验 tag
  // AAD 为空；数据 = ciphertext + len(A)||len(C) (64-bit big-endian each)
  const padC = Math.ceil(ciphertext.length / 16) * 16
  const data = new Uint8Array(padC + 16)
  data.set(ciphertext, 0)
  const bitLenC = ciphertext.length * 8
  const hiLen = Math.floor(bitLenC / 4294967296)
  const loLen = bitLenC >>> 0
  data[padC + 8] = (hiLen >>> 24) & 0xff
  data[padC + 9] = (hiLen >>> 16) & 0xff
  data[padC + 10] = (hiLen >>> 8) & 0xff
  data[padC + 11] = hiLen & 0xff
  data[padC + 12] = (loLen >>> 24) & 0xff
  data[padC + 13] = (loLen >>> 16) & 0xff
  data[padC + 14] = (loLen >>> 8) & 0xff
  data[padC + 15] = loLen & 0xff
  const s = ghashBlocks(H, data)
  // tag = E(K, J0) ^ S
  const ekj0 = encryptBlock(w, j0)
  const expected = new Uint8Array(16)
  for (let i = 0; i < 16; i++) expected[i] = ekj0[i] ^ s[i]
  let ok = tag.length === 16
  if (ok) for (let i = 0; i < 16; i++) if (expected[i] !== tag[i]) { ok = false; break }
  if (!ok) throw new Error('AES-GCM tag verification failed')
  return plain
}

// ---------- CLI: node aesgcm.js <key_b64> <payload_b64> ----------
// payload = base64(IV(12) || ciphertext || tag(16))
function b64decode(s) {
  const bin = Buffer.from(s, 'base64')
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength)
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const keyB64 = process.argv[2]
  const payloadB64 = process.argv[3]
  const key = b64decode(keyB64)
  const payload = b64decode(payloadB64)
  if (key.length !== 32) throw new Error('key must be 32 bytes')
  if (payload.length < 12 + 16) throw new Error('payload too short')
  const iv = payload.subarray(0, 12)
  const ct = payload.subarray(12, payload.length - 16)
  const tag = payload.subarray(payload.length - 16)
  const plain = gcmDecrypt(key, iv, ct, tag)
  process.stdout.write(Buffer.from(plain).toString('utf8'))
}

module.exports = { gcmDecrypt, keyExpansion, encryptBlock, gf128Mul }
