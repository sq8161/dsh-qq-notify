// DSH QQ 通知插件 v19 - Host 半部（修复事件读取：payload → data；assistant/message 内容在 data.message.content）
// 自包含实现：腾讯官方 QQ Bot API + 原生扫码绑定（无第三方依赖、无 iframe、无外部二维码服务）
// 注意：本文件为开源镜像，实际运行时由动态插件系统加载（host 代码运行在 Cordis VM 沙箱，
// 无 require/Buffer/fetch，仅可用 ctx/harness/console/btoa/atob/TextEncoder/TextDecoder）。
const DEFAULT_PRESETS = [
  '【deepseek任务完成】\n项目：{project}\n时间：{time}\n请返回deepseek查看执行结果',
  '', '', '', ''
]
const CRED_REF = 'DSH_QQ_NOTIFY_APP_SECRET'
const CONFIG_DIR = '.dsh-qq-notify'
const CONFIG_FILE = 'dsh_qq_notify_config.json'
const DIAG_FILE = 'diag_events.json'
const COOKIE_FILE = 'qqn_cookies.txt'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const MSG_URL_BASE = 'https://api.sgroup.qq.com/v2/users/'
const BIND_CREATE_URL = 'https://q.qq.com/lite/create_bind_task'
const BIND_POLL_URL = 'https://q.qq.com/lite/poll_bind_result'
const QQ_HOME_URL = 'https://q.qq.com/'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function joinPath() {
  let parts = []
  for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]))
  return parts.join('\\').replace(/[\\/]+/g, '\\')
}

function basename(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

function pad2(n) { return n < 10 ? '0' + n : String(n) }

function formatTime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

function sanitizePresets(list) {
  const out = []
  for (let i = 0; i < 5; i++) {
    const v = Array.isArray(list) && typeof list[i] === 'string' ? list[i] : ''
    out.push(v.slice(0, 4000))
  }
  return out
}

// ---------- Base64（字节数组，沙箱无 Buffer） ----------
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function b64EncodeBytes(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 3) << 4) | (b1 >= 0 ? b1 >> 4 : 0)]
    out += b1 >= 0 ? B64_CHARS[((b1 & 15) << 2) | (b2 >= 0 ? b2 >> 6 : 0)] : '='
    out += b2 >= 0 ? B64_CHARS[b2 & 63] : '='
  }
  return out
}

function b64DecodeBytes(str) {
  const out = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < String(str).length; i++) {
    const c = String(str).charAt(i)
    if (c === '=') break
    const v = B64_CHARS.indexOf(c)
    if (v < 0) continue
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return out
}

function randomBytes(n) {
  const out = []
  let seed = Date.now() >>> 0
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    out.push(((seed >>> 16) ^ Math.floor(Math.random() * 256)) & 0xff)
  }
  return out
}

// ---------- AES-256-GCM（纯 JS，已用 Python cryptography 库交叉验证；独立副本见 aesgcm.js） ----------
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

function aesKeyExpand(keyBytes) {
  const Nk = 8, Nr = 14
  const w = new Array(4 * (Nr + 1))
  for (let i = 0; i < Nk; i++) {
    w[i] = (keyBytes[4 * i] << 24) | (keyBytes[4 * i + 1] << 16) | (keyBytes[4 * i + 2] << 8) | keyBytes[4 * i + 3]
  }
  let rcon = 1
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let temp = w[i - 1]
    if (i % Nk === 0) {
      temp = ((SBOX[(temp >>> 24) & 0xff] << 24) | (SBOX[(temp >>> 16) & 0xff] << 16) | (SBOX[(temp >>> 8) & 0xff] << 8) | SBOX[temp & 0xff])
      temp = ((temp << 8) | (temp >>> 24)) >>> 0
      temp ^= rcon << 24
      rcon = gmul(rcon, 2)
    } else if (i % Nk === 4) {
      temp = ((SBOX[(temp >>> 24) & 0xff] << 24) | (SBOX[(temp >>> 16) & 0xff] << 16) | (SBOX[(temp >>> 8) & 0xff] << 8) | SBOX[temp & 0xff]) >>> 0
    }
    w[i] = (w[i - Nk] ^ temp) >>> 0
  }
  return w
}

function aesEncryptBlock(w, input) {
  const state = input.slice()
  const Nr = 14
  const addRoundKey = (round) => {
    for (let c = 0; c < 4; c++) {
      const word = w[round * 4 + c]
      state[c * 4 + 0] ^= (word >>> 24) & 0xff
      state[c * 4 + 1] ^= (word >>> 16) & 0xff
      state[c * 4 + 2] ^= (word >>> 8) & 0xff
      state[c * 4 + 3] ^= word & 0xff
    }
  }
  const subBytes = () => { for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]] }
  const shiftRows = () => {
    const t = state.slice()
    state[1] = t[5]; state[5] = t[9]; state[9] = t[13]; state[13] = t[1]
    state[2] = t[10]; state[6] = t[14]; state[10] = t[2]; state[14] = t[6]
    state[3] = t[15]; state[7] = t[3]; state[11] = t[7]; state[15] = t[11]
  }
  const mixColumns = () => {
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

function gf128Mul(x, y) {
  const Z = new Array(16).fill(0)
  const V = y.slice()
  for (let i = 0; i < 128; i++) {
    if ((x[i >> 3] >> (7 - (i & 7))) & 1) {
      for (let j = 0; j < 16; j++) Z[j] ^= V[j]
    }
    const lsb = V[15] & 1
    for (let j = 15; j > 0; j--) V[j] = ((V[j] >> 1) | (V[j - 1] << 7)) & 0xff
    V[0] = (V[0] >> 1) & 0x7f
    if (lsb) V[0] ^= 0xe1
  }
  return Z
}

function aesGcmDecrypt(keyBytes, ivBytes, ct, tag) {
  const w = aesKeyExpand(keyBytes)
  const H = aesEncryptBlock(w, new Array(16).fill(0))
  const j0 = new Array(16).fill(0)
  for (let i = 0; i < 12; i++) j0[i] = ivBytes[i]
  j0[15] = 1
  const incr = (block) => {
    const b = block.slice()
    for (let i = 15; i >= 12; i--) {
      b[i] = (b[i] + 1) & 0xff
      if (b[i] !== 0) break
    }
    return b
  }
  const plain = new Array(ct.length).fill(0)
  let ctr = incr(j0)
  for (let i = 0; i < ct.length; i += 16) {
    const ks = aesEncryptBlock(w, ctr)
    for (let j = 0; j < 16 && i + j < ct.length; j++) plain[i + j] = ct[i + j] ^ ks[j]
    ctr = incr(ctr)
  }
  const padC = Math.ceil(ct.length / 16) * 16
  const data = new Array(padC + 16).fill(0)
  for (let i = 0; i < ct.length; i++) data[i] = ct[i]
  const bitLenC = ct.length * 8
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
  // GHASH
  let y = new Array(16).fill(0)
  for (let off = 0; off < data.length; off += 16) {
    const block = data.slice(off, off + 16)
    for (let i = 0; i < 16; i++) y[i] ^= block[i]
    y = gf128Mul(y, H)
  }
  const ekj0 = aesEncryptBlock(w, j0)
  const expected = new Array(16).fill(0)
  for (let i = 0; i < 16; i++) expected[i] = ekj0[i] ^ y[i]
  let ok = tag.length === 16
  if (ok) for (let i = 0; i < 16; i++) if (expected[i] !== tag[i]) { ok = false; break }
  if (!ok) throw new Error('AES-GCM tag verification failed')
  return plain
}

// ---------- 插件主体 ----------
return {
  async apply(ctx) {
    const subprocess = ctx.get('subprocess')
    const fs = ctx.get('fs')
    const credentials = ctx.get('credentials')
    const sessionTitle = ctx.get('sessionTitle')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const agents = ctx.get('agents')

    const workspaceRoot = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string'
      ? sandboxPolicy.workspaceRoot : ''

    const state = {
      enabled: true,
      active: 0,
      presets: DEFAULT_PRESETS.slice(),
      appId: '',
      userOpenid: '',
    }
    const tokenCache = { token: '', expiresAt: 0 }
    let lastAgent = null
    let lastTurn = 0
    let lastNotifyAt = 0
    let lastSessionId = ''
    let bindRun = null

    // ---------- 路径与持久化（三级兜底：workspaceRoot → 会话 cwd → fs 服务 cwd） ----------
    async function configBaseDir() {
      if (workspaceRoot) return workspaceRoot
      const header = lastAgent && lastAgent.session && (lastAgent.session.header || lastAgent.session.meta)
      const cwd = header && typeof header.cwd === 'string' ? header.cwd : ''
      if (cwd) return cwd
      if (fs) {
        try {
          const target = await fs.resolve('.')
          const p = fs.processPath ? fs.processPath(target) : ''
          if (p) return p
        } catch (e) { /* 忽略 */ }
      }
      return ''
    }

    async function configFilePath() {
      const base = await configBaseDir()
      return base ? joinPath(base, CONFIG_DIR, CONFIG_FILE) : ''
    }

    async function cookieJarPath() {
      const base = await configBaseDir()
      return base ? joinPath(base, CONFIG_DIR, COOKIE_FILE) : ''
    }

    async function loadState() {
      const path = await configFilePath()
      if (!path || !fs) return
      try {
        const target = await fs.resolve(path)
        const text = await fs.readText(target)
        const data = JSON.parse(text)
        if (data && typeof data === 'object') {
          if (typeof data.enabled === 'boolean') state.enabled = data.enabled
          if (typeof data.active === 'number' && data.active >= 0 && data.active <= 4) state.active = data.active
          if (Array.isArray(data.presets)) state.presets = sanitizePresets(data.presets)
          if (typeof data.appId === 'string') state.appId = data.appId
          if (typeof data.userOpenid === 'string') state.userOpenid = data.userOpenid
        }
      } catch (e) { /* 保留默认值 */ }
    }

    async function persistState() {
      const path = await configFilePath()
      if (!path || !fs) return false
      const policy = sandboxPolicy ? sandboxPolicy.resolve({}) : undefined
      const target = await fs.resolve(path)
      await fs.writeText(target, JSON.stringify({
        enabled: state.enabled,
        active: state.active,
        presets: state.presets,
        appId: state.appId,
        userOpenid: state.userOpenid,
      }, null, 2), undefined, undefined, policy)
      return true
    }

    // ---------- 凭据 ----------
    async function getSecret() {
      if (!credentials) return ''
      try {
        const r = await credentials.resolve(CRED_REF)
        return r ? r.value : ''
      } catch (e) { return '' }
    }

    async function hasSecret() {
      if (!credentials) return false
      try {
        const info = await credentials.describe(CRED_REF)
        return !!info.configured
      } catch (e) { return false }
    }

    async function setSecret(value) {
      if (!credentials) throw new Error('凭据服务不可用')
      await credentials.set(CRED_REF, value)
    }

    // ---------- HTTP（curl 子进程，自包含） ----------
    async function curlPost(url, body, authToken, opts) {
      if (!subprocess) throw new Error('子进程服务不可用（无法调用 curl）')
      let curlPath
      try {
        curlPath = await subprocess.resolveExecutable('curl')
      } catch (e) {
        throw new Error('未找到 curl 命令（Windows 10+ / macOS / Linux 均自带）')
      }
      const argv = [curlPath, '-sS', '--max-time', '30', '-X', 'POST', url, '-H', 'Content-Type: application/json']
      if (opts && opts.accept) argv.push('-H', 'Accept: application/json')
      if (opts && opts.qq) {
        // q.qq.com 反爬：浏览器 UA + Referer + cookie
        argv.push('-A', BROWSER_UA)
        argv.push('-e', QQ_HOME_URL)
        if (opts.jar) { argv.push('-b', opts.jar, '-c', opts.jar) }
      }
      if (authToken) argv.push('-H', 'Authorization: QQBot ' + authToken)
      argv.push('--write-out', '\n%{http_code}', '--data-binary', body)
      const handle = subprocess.spawn({
        argv: argv,
        cwd: workspaceRoot || '.',
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 131072 },
          stderr: { maxBytes: 131072 },
        },
        graceMs: 35000,
      })
      const outcome = await handle.done
      let outText = ''
      let errText = ''
      if (handle.collected && handle.collected.stdout) {
        try { outText = handle.collected.stdout.readFrom(0).text || '' } catch (e) { /* 忽略 */ }
      }
      if (handle.collected && handle.collected.stderr) {
        try { errText = handle.collected.stderr.readFrom(0).text || '' } catch (e) { /* 忽略 */ }
      }
      if (outcome.exitCode !== 0) {
        throw new Error('curl 调用失败 (exit ' + outcome.exitCode + ')：' + (errText || outText || '未知错误'))
      }
      const lines = outText.split('\n')
      const httpCode = lines.length > 0 ? lines[lines.length - 1].trim() : ''
      const bodyText = lines.slice(0, Math.max(0, lines.length - 1)).join('\n').trim()
      return { httpCode: httpCode, bodyText: bodyText }
    }

    // 预取 q.qq.com cookie（浏览器 UA），用于通过反爬校验
    async function ensureQqCookies() {
      if (!subprocess) return
      const jar = await cookieJarPath()
      if (!jar) return
      try {
        const curlPath = await subprocess.resolveExecutable('curl')
        const handle = subprocess.spawn({
          argv: [curlPath, '-sS', '--max-time', '20', '-A', BROWSER_UA, '-c', jar, QQ_HOME_URL],
          cwd: workspaceRoot || '.',
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 65536 },
            stderr: { maxBytes: 65536 },
          },
          graceMs: 25000,
        })
        await handle.done
      } catch (e) { /* 失败不阻断，后续请求仍带 UA/Referer */ }
    }

    async function ensureToken() {
      if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token
      const secret = await getSecret()
      if (!state.appId || !secret || !state.userOpenid) {
        throw new Error('QQ 机器人凭据未配置完整（需要 AppID、AppSecret、UserOpenID）')
      }
      const body = JSON.stringify({ appId: state.appId, clientSecret: secret })
      const res = await curlPost(TOKEN_URL, body, null, { accept: true })
      let data = null
      try { data = JSON.parse(res.bodyText) } catch (e) { /* 非 JSON */ }
      if (!data || !data.access_token) {
        throw new Error('获取 QQ access token 失败：' + (data && data.message ? data.message : res.bodyText || 'HTTP ' + res.httpCode))
      }
      tokenCache.token = data.access_token
      tokenCache.expiresAt = Date.now() + (Number(data.expires_in) || 7200) * 1000
      return tokenCache.token
    }

    // ---------- QQ 发送（腾讯官方 API） ----------
    async function sendViaQQ(text) {
      const token = await ensureToken()
      const seq = Math.floor(Math.random() * 65536)
      const capped = text.length > 1500 ? text.slice(0, 1500) : text
      const body = JSON.stringify({ content: capped, msg_type: 0, msg_seq: seq, msg_id: '' })
      const res = await curlPost(MSG_URL_BASE + state.userOpenid + '/messages', body, token, { accept: true })
      let data = null
      try { data = JSON.parse(res.bodyText) } catch (e) { /* 非 JSON */ }
      const okHttp = Number(res.httpCode) >= 200 && Number(res.httpCode) < 300
      const bizOk = !data || !data.code || data.code === 0
      if (okHttp && bizOk) return
      throw new Error('QQ 消息发送失败 (HTTP ' + res.httpCode + ')：' + ((data && (data.message || data.err_msg)) || res.bodyText || '未知错误'))
    }

    // ---------- 会话消息提取 ----------
    // DSH SessionEvent = { type, seq, time, data, ... }：payload 字段名是 data。
    // user/message 的 data 是 UserMessage { id, role, content: ContentBlock[], source }
    // assistant/message 的 data 是 { turn, step, message: AssistantMessage, usage? }
    function extractBlockText(block) {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      return ''
    }

    function collectContentText(content) {
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        for (const block of content) text += extractBlockText(block)
      }
      return text
    }

    function lastMessageText(session, type, maxLen) {
      if (!session) return ''
      const events = session.events || session.eventsSnapshot
      if (!Array.isArray(events)) return ''
      let fallback = ''
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (!ev || ev.type !== type) continue
        const data = ev.data
        if (!data || typeof data !== 'object') continue
        let text = ''
        if (type === 'user/message') {
          text = collectContentText(data.content)
          // 优先真人输入（source.kind === 'user'）；插件注入类先记作后备
          if (data.source && data.source.kind === 'user') {
            text = text.replace(/\s+/g, ' ').trim()
            if (text) return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
          } else if (!fallback) {
            fallback = text.replace(/\s+/g, ' ').trim()
          }
        } else if (type === 'assistant/message') {
          const msg = data.message
          if (msg && typeof msg === 'object') {
            text = collectContentText(msg.content).replace(/\s+/g, ' ').trim()
            if (text) return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
          }
        }
      }
      if (fallback) return fallback.length > maxLen ? fallback.slice(0, maxLen) + '…' : fallback
      return ''
    }

    // ---------- 诊断转储：把 eventsSnapshot 真实结构写入 .dsh-qq-notify/diag_events.json ----------
    async function dumpDiag(agent, turn, source) {
      if (!fs) return
      try {
        const base = await configBaseDir()
        if (!base) return
        const diagPath = joinPath(base, CONFIG_DIR, DIAG_FILE)
        const session = agent && agent.session
        const events = session && (session.events || session.eventsSnapshot)
        const policy = sandboxPolicy ? sandboxPolicy.resolve({}) : undefined
        const lastEvents = Array.isArray(events) ? events.slice(-8).map((ev) => {
          if (!ev || typeof ev !== 'object') return { raw: String(ev) }
          const out = { type: ev.type, seq: ev.seq, time: ev.time }
          const data = ev.data
          if (data && typeof data === 'object') {
            out.dataKeys = Object.keys(data).slice(0, 12)
            if (data.message && typeof data.message === 'object') {
              out.messageKeys = Object.keys(data.message).slice(0, 10)
              const content = data.message.content
              if (Array.isArray(content)) out.messageBlocks = content.slice(0, 3).map((b) => (b && typeof b === 'object' ? { type: b.type, textLen: typeof b.text === 'string' ? b.text.length : undefined } : String(b)))
            } else {
              const content = data.content
              if (Array.isArray(content)) out.blocks = content.slice(0, 3).map((b) => (b && typeof b === 'object' ? { type: b.type, textLen: typeof b.text === 'string' ? b.text.length : undefined } : String(b)))
              else if (typeof content === 'string') out.contentLen = content.length
            }
            if (data.source && typeof data.source === 'object') out.sourceKind = data.source.kind
          } else {
            out.dataType = data === undefined ? 'undefined' : typeof data
          }
          return out
        }) : []
        const target = await fs.resolve(diagPath)
        await fs.writeText(target, JSON.stringify({
          time: formatTime(new Date()),
          source: source,
          agentId: agent && agent.id ? String(agent.id) : null,
          sessionId: session && session.id ? String(session.id) : null,
          hasEvents: Array.isArray(events),
          eventCount: Array.isArray(events) ? events.length : null,
          allTypes: Array.isArray(events) ? events.map((e) => e && e.type).filter((t) => t !== undefined).slice(-500) : [],
          lastEvents: lastEvents,
        }, null, 2), undefined, undefined, policy)
        console.log('[qq-notify] 诊断已转储 diag_events.json (' + source + ')')
      } catch (e) {
        console.error('[qq-notify] 诊断转储失败:', e && e.message ? e.message : String(e))
      }
    }

    // ---------- 消息合成（工作区优先 session.header.cwd——会话真实工作区） ----------
    function composeText(agent, turn) {
      const template = state.presets[state.active] || ''
      if (!template.trim()) return ''
      const session = agent && agent.session
      const header = (session && (session.header || session.meta)) || {}
      let workspace = typeof header.cwd === 'string' ? header.cwd : ''
      if (!workspace) workspace = typeof workspaceRoot === 'string' && workspaceRoot ? workspaceRoot : ''
      let title = ''
      if (sessionTitle && session) {
        try {
          const snap = sessionTitle.get(session)
          if (snap && typeof snap.title === 'string') title = snap.title
        } catch (e) { /* 忽略 */ }
      }
      const options = agent && agent.options ? agent.options : {}
      const values = {
        workspace: workspace,
        project: workspace ? basename(workspace) : '未知项目',
        time: formatTime(new Date()),
        request: lastMessageText(session, 'user/message', 200),
        result: lastMessageText(session, 'assistant/message', 300),
        model: typeof options.model === 'string' ? options.model : '',
        provider: typeof options.provider === 'string' ? options.provider : '',
        sessionTitle: title,
        sessionId: String((session && session.id) || (agent && agent.id) || ''),
        turn: String(typeof turn === 'number' ? turn : ''),
      }
      return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
      )
    }

    // 顶层判断：优先 agents.roots()（权威，不依赖 session.meta），meta 作后备，最后保守放行
    function isTopLevelAgent(agent) {
      if (agents && agents.roots) {
        try {
          const roots = agents.roots()
          if (Array.isArray(roots) && roots.length > 0) {
            return roots.some((r) => r === agent)
          }
        } catch (e) { /* 忽略 */ }
      }
      const meta = agent && agent.session && agent.session.meta
      if (meta) {
        if (meta.origin === 'subagent') return false
        if (meta.parentSession) return false
        if (typeof meta.delegationDepth === 'number' && meta.delegationDepth > 0) return false
        return true
      }
      return true
    }

    // 按需解析当前代理：lastAgent → currentInitiator → roots → list 顶层兜底
    async function resolveCurrentAgent() {
      if (lastAgent) return lastAgent
      if (agents) {
        try {
          const init = agents.currentInitiator ? agents.currentInitiator() : undefined
          if (init) {
            lastAgent = init
            return init
          }
          const roots = agents.roots ? agents.roots() : []
          if (Array.isArray(roots) && roots.length > 0) {
            lastAgent = roots[roots.length - 1]
            return roots[roots.length - 1]
          }
          const list = agents.list ? agents.list() : []
          if (Array.isArray(list) && list.length > 0) {
            const tops = list.filter((a) => isTopLevelAgent(a))
            if (tops.length > 0) {
              lastAgent = tops[tops.length - 1]
              return tops[tops.length - 1]
            }
          }
        } catch (e) { /* 忽略 */ }
      }
      return null
    }

    async function notifyTurnEnd(agent, turn) {
      await dumpDiag(agent, turn, 'turn-end')
      if (!state.enabled) return
      const text = composeText(agent, turn)
      if (!text) return
      const sessionId = String((agent.session && agent.session.id) || agent.id || '')
      const now = Date.now()
      if (now - lastNotifyAt < 3000 && sessionId === lastSessionId) return
      lastNotifyAt = now
      lastSessionId = sessionId
      try {
        await sendViaQQ(text)
      } catch (e) {
        console.error('[qq-notify] 发送失败:', e && e.message ? e.message : String(e))
      }
    }

    // ---------- 对话结束事件（刷新 lastAgent 并触发通知） ----------
    ctx.on('agent/turn-stopping', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent) return
        const topLevel = isTopLevelAgent(agent)
        if (!topLevel) {
          console.log('[qq-notify] turn-stopping 跳过（非顶层）:', String(agent.id))
          return
        }
        lastAgent = agent
        if (typeof payload.turn === 'number') lastTurn = payload.turn
        notifyTurnEnd(agent, lastTurn).catch((e) => {
          console.error('[qq-notify] 通知处理失败:', e && e.message ? e.message : String(e))
        })
      } catch (e) {
        console.error('[qq-notify] 事件处理失败:', e && e.message ? e.message : String(e))
      }
    })

    // ---------- 原生扫码绑定（create/poll + AES-GCM 解密；浏览器 UA + cookie 绕过反爬） ----------
    wrap('bindStart', async () => {
      if (!subprocess) return { ok: false, error: '子进程服务不可用' }
      await ensureQqCookies()
      const aesKey = randomBytes(32)
      const keyB64 = b64EncodeBytes(aesKey)
      const qqOpts = { accept: true, qq: true, jar: await cookieJarPath() || undefined }
      const res = await curlPost(BIND_CREATE_URL, JSON.stringify({ key: keyB64 }), null, qqOpts)
      let data = null
      try { data = JSON.parse(res.bodyText) } catch (e) { /* 非 JSON */ }
      if (!data || data.retcode !== 0 || !data.data || !data.data.task_id) {
        throw new Error('创建绑定任务失败：' + ((data && (data.msg || data.message)) || res.bodyText.slice(0, 300) || ('HTTP ' + res.httpCode)))
      }
      const taskId = data.data.task_id
      const qrUrl = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=' + encodeURIComponent(taskId) + '&_wv=2'
      bindRun = { taskId: taskId, aesKey: aesKey, qrUrl: qrUrl, startedAt: Date.now(), done: false, exitCode: null, error: '', appId: '', userOpenid: '' }
      return { ok: true, qrUrl: qrUrl }
    })

    wrap('bindPoll', async () => {
      if (!bindRun) return { running: false, done: false, qrUrl: '', error: '' }
      if (bindRun.done) {
        return { running: false, done: true, qrUrl: bindRun.qrUrl, exitCode: bindRun.exitCode, error: bindRun.error, appId: bindRun.appId, userOpenid: bindRun.userOpenid }
      }
      if (Date.now() - bindRun.startedAt > 300000) {
        bindRun.done = true
        bindRun.exitCode = 1
        bindRun.error = '扫码绑定超时（5 分钟），请重新发起'
        return { running: false, done: true, qrUrl: bindRun.qrUrl, exitCode: 1, error: bindRun.error }
      }
      let data = null
      try {
        const qqOpts = { accept: true, qq: true, jar: await cookieJarPath() || undefined }
        const res = await curlPost(BIND_POLL_URL, JSON.stringify({ task_id: bindRun.taskId }), null, qqOpts)
        try { data = JSON.parse(res.bodyText) } catch (e) { /* 非 JSON */ }
        if (!data || data.retcode !== 0) {
          // 频率限制等瞬态错误：保持轮询，不中断绑定
          return { running: true, done: false, qrUrl: bindRun.qrUrl, error: ((data && (data.msg || data.message)) || res.bodyText || ('HTTP ' + res.httpCode)).slice(0, 200) }
        }
      } catch (e) {
        // 网络等瞬态错误：保持轮询
        return { running: true, done: false, qrUrl: bindRun.qrUrl, error: (e && e.message ? String(e.message) : String(e)).slice(0, 200) }
      }
      const d = data.data || {}
      const status = Number(d.status)
      if (status === 0 || status === 1) {
        return { running: true, done: false, qrUrl: bindRun.qrUrl, error: '' }
      }
      if (status === 3) {
        bindRun.done = true
        bindRun.exitCode = 1
        bindRun.error = '二维码已过期，请重新发起扫码绑定'
        return { running: false, done: true, qrUrl: bindRun.qrUrl, exitCode: 1, error: bindRun.error }
      }
      const appId = String(d.bot_appid || '')
      const openid = String(d.user_openid || '')
      const encSecret = String(d.bot_encrypt_secret || '')
      if (!appId || !openid || !encSecret) {
        bindRun.done = true
        bindRun.exitCode = 1
        bindRun.error = '绑定结果缺少字段（bot_appid / user_openid / bot_encrypt_secret）'
        return { running: false, done: true, qrUrl: bindRun.qrUrl, exitCode: 1, error: bindRun.error }
      }
      try {
        const payload = b64DecodeBytes(encSecret)
        const iv = payload.slice(0, 12)
        const ct = payload.slice(12, payload.length - 16)
        const tag = payload.slice(payload.length - 16)
        const secretBytes = aesGcmDecrypt(bindRun.aesKey, iv, ct, tag)
        const secret = new TextDecoder().decode(new Uint8Array(secretBytes))
        state.appId = appId
        state.userOpenid = openid
        await setSecret(secret)
        await persistState()
        bindRun.done = true
        bindRun.exitCode = 0
        bindRun.appId = appId
        bindRun.userOpenid = openid
        return { running: false, done: true, qrUrl: bindRun.qrUrl, exitCode: 0, error: '', appId: appId, userOpenid: openid }
      } catch (e) {
        bindRun.done = true
        bindRun.exitCode = 1
        bindRun.error = '凭据解密失败：' + (e && e.message ? e.message : String(e))
        return { running: false, done: true, qrUrl: bindRun.qrUrl, exitCode: 1, error: bindRun.error }
      }
    })

    // ---------- Client RPC ----------
    function wrap(method, fn) {
      harness.handle(method, async (args) => {
        try {
          return await fn(args || {})
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      })
    }

    wrap('getState', async () => {
      const secretOk = await hasSecret()
      return {
        ok: true,
        enabled: state.enabled,
        active: state.active,
        presets: state.presets.slice(),
        appId: state.appId,
        userOpenid: state.userOpenid,
        hasSecret: secretOk,
        bound: !!(state.appId && state.userOpenid && secretOk),
        configPath: await configFilePath(),
      }
    })

    wrap('saveState', async (args) => {
      if (typeof args.enabled === 'boolean') state.enabled = args.enabled
      if (typeof args.active === 'number' && args.active >= 0 && args.active <= 4) state.active = args.active
      if (Array.isArray(args.presets)) state.presets = sanitizePresets(args.presets)
      if (typeof args.appId === 'string') state.appId = args.appId.trim()
      if (typeof args.userOpenid === 'string') state.userOpenid = args.userOpenid.trim()
      let secretSaved = false
      if (typeof args.appSecret === 'string' && args.appSecret.trim()) {
        await setSecret(args.appSecret.trim())
        secretSaved = true
      }
      await persistState()
      const secretOk = secretSaved ? true : await hasSecret()
      return {
        ok: true,
        hasSecret: secretOk,
        bound: !!(state.appId && state.userOpenid && secretOk),
      }
    })

    wrap('testSend', async () => {
      const agent = await resolveCurrentAgent()
      if (!agent) {
        return { ok: false, error: '尚未捕获到当前对话上下文（请稍候或完成一次对话回合后重试）' }
      }
      await dumpDiag(agent, lastTurn, 'test')
      const text = composeText(agent, lastTurn)
      if (!text) return { ok: false, error: '当前使用的预设为空，无法发送' }
      try {
        await sendViaQQ(text)
        return { ok: true, text: text }
      } catch (e) {
        return { ok: false, error: e && e.message ? String(e.message) : String(e) }
      }
    })

    // 启动时优先通过 agents.currentInitiator 捕获当前会话代理（无需等待回合结束）
    try {
      const initiator = agents && agents.currentInitiator ? agents.currentInitiator() : undefined
      if (initiator) {
        lastAgent = initiator
        console.log('[qq-notify] 已通过 currentInitiator 捕获会话代理:', String(initiator.id))
      } else {
        console.log('[qq-notify] currentInitiator 暂不可用，等待 turn-stopping 捕获')
      }
    } catch (e) {
      console.error('[qq-notify] 捕获会话代理失败:', e && e.message ? e.message : String(e))
    }

    await loadState()
    // 启动时立即转储一次诊断（resolveCurrentAgent 兜底到 roots/list）
    try {
      const agent = await resolveCurrentAgent()
      if (agent) {
        await dumpDiag(agent, lastTurn, 'apply')
      } else {
        console.log('[qq-notify] 启动时未找到代理，跳过启动诊断')
      }
    } catch (e) {
      console.error('[qq-notify] 启动诊断失败:', e && e.message ? e.message : String(e))
    }
    console.log('[qq-notify] 插件已启动（v19）：工作区 =', workspaceRoot || '(无)', '配置 =', await configFilePath() || '(无)')
  },
}
