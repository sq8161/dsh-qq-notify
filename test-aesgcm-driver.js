// 测试驱动：读取 vectors.json（key/payload/expectB64），逐个解密并输出 base64 结果
'use strict'
const fs = require('fs')
const { gcmDecrypt } = require('./aesgcm.js')

const vectorsPath = process.argv[2]
const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'))

let fails = 0
const results = vectors.map((v) => {
  const key = Buffer.from(v.key, 'base64')
  const payload = Buffer.from(v.payload, 'base64')
  const iv = payload.subarray(0, 12)
  const ct = payload.subarray(12, payload.length - 16)
  const tag = payload.subarray(payload.length - 16)
  try {
    const plain = gcmDecrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(ct), new Uint8Array(tag))
    const got = Buffer.from(plain).toString('base64')
    const ok = got === v.expectB64
    if (!ok) fails++
    return { ok, got }
  } catch (e) {
    fails++
    return { ok: false, error: String(e && e.message || e) }
  }
})

console.log(JSON.stringify(results))
process.exit(fails === 0 ? 0 : 1)
