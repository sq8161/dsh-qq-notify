// dsh-qq-notify 浏览器插件（安装包版）— 对应单文件镜像 client.js（v17）
// 打包为 __ModuleLoader__ 模块：React 由 shell 模块表提供；RPC 经
// ctx.connection.rpc 调用 /qq-notify 通道；样式以 <style data-plugin-css> 注入。
window.__ModuleLoader__.load({
  id: 'dsh-qq-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    const PRESET_LABELS = ['预设 1（默认）', '预设 2', '预设 3', '预设 4', '预设 5']
    const DEFAULT_PRESETS = [
      '【deepseek任务完成】\n项目：{project}\n时间：{time}\n请返回deepseek查看执行结果',
      '', '', '', ''
    ]
    // 手册变量按名称首字母 A-Z 排列
    const MANUAL_VARS = [
      ['{model}', '当前使用的模型'],
      ['{project}', '工作区目录名'],
      ['{provider}', '当前使用的模型提供商'],
      ['{request}', '本次对话最近一条用户输入（截断至 200 字）'],
      ['{result}', '最近一条助手回复（截断至 300 字）'],
      ['{sessionId}', '会话 ID'],
      ['{sessionTitle}', '当前会话标题'],
      ['{time}', '对话结束时间（本地时间 YYYY-MM-DD HH:mm:ss）'],
      ['{turn}', '结束的回合序号'],
      ['{workspace}', '工作区根目录完整路径'],
    ]

    // ---------- QR Code 编码器（Byte 模式 / ECC L / 版本 1-9 / 掩码 0） ----------
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

    function rsEncode(data, eccCount) {
      const gen = rsGeneratorPoly(eccCount)
      const rem = new Array(eccCount).fill(0)
      for (const byte of data) {
        const factor = byte ^ rem[0]
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

    const QR_VERSION_TABLE = {
      1: [26, 19, 1], 2: [44, 34, 1], 3: [70, 55, 1], 4: [100, 80, 1], 5: [134, 108, 1],
      6: [172, 68, 2], 7: [196, 78, 2], 8: [242, 97, 2], 9: [292, 116, 2],
    }
    const QR_ALIGN_POSITIONS = {
      1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
      6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
    }

    function qrSelectVersion(dataLen) {
      for (let v = 1; v <= 9; v++) {
        const [, dataPer, blocks] = QR_VERSION_TABLE[v]
        const usableBits = dataPer * blocks * 8 - 4 - 8 - 4
        if (dataLen * 8 <= usableBits) return v
      }
      return 0
    }

    function qrFormatBits(eccBits, mask) {
      let data = ((eccBits << 3) | mask) << 10
      const g = 0x537
      for (let i = 14; i >= 10; i--) {
        if (data & (1 << i)) data ^= g << (i - 10)
      }
      return ((((eccBits << 3) | mask) << 10) | data) ^ 0x5412
    }

    function qrVersionBits(v) {
      let data = v << 12
      const g = 0x1f25
      for (let i = 17; i >= 12; i--) {
        if (data & (1 << i)) data ^= g << (i - 12)
      }
      return (v << 12) | data
    }

    function qrBuildMatrix(version, dataBytes, eccBytes) {
      const size = 21 + 4 * (version - 1)
      const modules = []
      const reserved = []
      for (let r = 0; r < size; r++) {
        modules[r] = new Array(size).fill(0)
        reserved[r] = new Array(size).fill(false)
      }
      const setDark = (r, c, dark) => { modules[r][c] = dark ? 1 : 0 }
      const reserve = (r, c) => { reserved[r][c] = true }

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

      for (let i = 8; i < size - 8; i++) {
        reserve(6, i); setDark(6, i, i % 2 === 0)
        reserve(i, 6); setDark(i, 6, i % 2 === 0)
      }

      const alignPos = QR_ALIGN_POSITIONS[version]
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

      reserve(size - 8, 8)
      setDark(size - 8, 8, true)

      const fmt = qrFormatBits(1, 0)
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

      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!reserved[r][c] && (r + c) % 2 === 0) modules[r][c] = modules[r][c] === 1 ? 0 : 1
        }
      }

      fmtCells.forEach(([r, c], i) => setDark(r, c, ((fmt >> (14 - i)) & 1) === 1))
      for (let i = 0; i < 8; i++) setDark(8, size - 1 - i, ((fmt >> i) & 1) === 1)
      for (let i = 8; i < 15; i++) setDark(size - 15 + i, 8, ((fmt >> i) & 1) === 1)
      if (version >= 7) {
        const vb = qrVersionBits(version)
        for (let i = 0; i < 18; i++) {
          const bit = ((vb >> i) & 1) === 1
          setDark(Math.floor(i / 3), (i % 3) + size - 11, bit)
          setDark((i % 3) + size - 11, Math.floor(i / 3), bit)
        }
      }
      return modules
    }

    function encodeQr(text) {
      const data = []
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code < 0x80) data.push(code)
        else {
          const bytes = []
          if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
          else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
          else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
          for (const b of bytes) data.push(b)
        }
      }
      const version = qrSelectVersion(data.length)
      if (version === 0) throw new Error('内容过长，无法生成二维码')
      const [, dataPerBlock, blockCount] = QR_VERSION_TABLE[version]
      const totalData = dataPerBlock * blockCount
      const bits = []
      const pushBits = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1) }
      pushBits(4, 4)
      pushBits(data.length, 8)
      for (const b of data) pushBits(b, 8)
      pushBits(0, Math.min(4, totalData * 8 - bits.length))
      while (bits.length % 8 !== 0) bits.push(0)
      const padBytes = [0xec, 0x11]
      let pi = 0
      while (bits.length / 8 < totalData) pushBits(padBytes[pi++ % 2], 8)
      const codewords = []
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
        codewords.push(b)
      }
      const eccPerBlock = (QR_VERSION_TABLE[version][0] - QR_VERSION_TABLE[version][1] * blockCount) / blockCount
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
      const matrix = qrBuildMatrix(version, interleaved.slice(0, totalData), interleaved.slice(totalData))
      return { version, size: matrix.length, matrix }
    }

    function el(type, props) {
      const args = [type, props]
      for (let i = 2; i < arguments.length; i++) args.push(arguments[i])
      return React.createElement.apply(null, args)
    }

    // SVG 渲染二维码
    function QrSvg(props) {
      const qr = encodeQr(props.text)
      const n = qr.size
      const size = props.size || 232
      const cell = size / n
      const rects = []
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.matrix[r][c]) {
            rects.push(el('rect', { key: r + '-' + c, x: c * cell, y: r * cell, width: cell + 0.6, height: cell + 0.6 }))
          }
        }
      }
      return el('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, shapeRendering: 'crispEdges', style: { display: 'block' } }, rects)
    }

    // 样式注入（data-plugin-css 去重）
    function injectStyles(css) {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-qq-notify/styles'
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-qq-notify'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    const inject = ['slots', 'connection']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 经 /qq-notify 通道调用宿主方法；宿主返回的业务结果仍为 { ok, ... } 形状
      function hostCall(method, args) {
        return ctx.connection.rpc.call('/qq-notify', method, args || {}).then((r) => {
          if (r && r.ok) return r.value
          const msg = r && r.error && r.error.message ? r.error.message : '调用失败'
          return { ok: false, error: msg }
        })
      }

      injectStyles(`
.dsh-qqn-page { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px; max-width: 720px; }
.dsh-qqn-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1); }
.dsh-qqn-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-qqn-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.dsh-qqn-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 2px 0 0; }
.dsh-qqn-btn { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); padding: 5px 12px; font-size: 13px; cursor: pointer; }
.dsh-qqn-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.dsh-qqn-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dsh-qqn-qmark { width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex: none; }
.dsh-qqn-qmark:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-qqn-input { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); padding: 5px 8px; font-size: 13px; min-width: 220px; box-sizing: border-box; }
.dsh-qqn-textarea { width: 100%; min-height: 110px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); padding: 8px; font-size: 13px; font-family: inherit; box-sizing: border-box; resize: vertical; }
.dsh-qqn-radio { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsh-qqn-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-qqn-qr { font-size: 12px; color: var(--dsw-alias-brand-primary); word-break: break-all; }
.dsh-qqn-qr-area { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-top: 10px; }
.dsh-qqn-qr-box { background: #fff; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px; }
.dsh-qqn-help-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
.dsh-qqn-help-window { width: min(560px, calc(100vw - 48px)); max-height: 78vh; overflow: auto; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 18px 20px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); }
.dsh-qqn-help-window h4 { margin: 0 0 10px; font-size: 15px; color: var(--dsw-alias-label-primary); }
.dsh-qqn-help-window table { border-collapse: collapse; margin: 8px 0; width: 100%; }
.dsh-qqn-help-window td { padding: 3px 12px 3px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); vertical-align: top; }
.dsh-qqn-help-window code { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 1px 5px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsh-qqn-help-window p, .dsh-qqn-help-window li { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.7; margin: 4px 0; }
.dsh-qqn-help-window ul { margin: 4px 0; padding-left: 18px; }
.dsh-qqn-success { width: min(380px, calc(100vw - 48px)); background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 20px 22px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); text-align: center; }
.dsh-qqn-success h4 { margin: 0 0 8px; font-size: 16px; color: var(--dsw-alias-label-primary); }
.dsh-qqn-success p { margin: 4px 0; font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }
.dsh-qqn-success .dsh-qqn-btn { margin-top: 12px; }
.dsh-qqn-toast { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483001; display: flex; align-items: center; gap: 10px; max-width: min(520px, calc(100vw - 48px)); background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-state-success-primary); border-radius: 10px; padding: 10px 14px; font-size: 13px; color: var(--dsw-alias-label-primary); box-shadow: 0 8px 28px rgba(0,0,0,0.35); }
.dsh-qqn-toast-error { border-color: var(--dsw-alias-state-error-primary); }
.dsh-qqn-toast-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 13px; cursor: pointer; padding: 2px 4px; line-height: 1; flex: none; }
.dsh-qqn-toast-close:hover { color: var(--dsw-alias-label-primary); }
`)

      function SuccessDialog(props) {
        return el('div', { className: 'dsh-qqn-help-backdrop', onClick: props.onClose },
          el('div', { className: 'dsh-qqn-success', onClick: (e) => e.stopPropagation() },
            el('h4', null, '🎉 绑定成功'),
            el('p', null, 'QQ 机器人凭据已自动保存。'),
            el('p', null, 'AppID：' + (props.appId || '-')),
            el('p', null, '每次对话回合结束时将自动向你推送通知。'),
            el('button', { className: 'dsh-qqn-btn dsh-qqn-btn-primary', onClick: props.onClose }, '知道了')
          )
        )
      }

      function HelpPanel(props) {
        return el('div', { className: 'dsh-qqn-help-backdrop', onClick: props.onClose },
          el('div', { className: 'dsh-qqn-help-window', onClick: (e) => e.stopPropagation() },
            el('h4', null, 'DSH QQ 通知 · 使用手册'),
            el('p', null, '功能：每次对话回合结束时，插件用当前启用的预设合成一条通知，通过腾讯官方 QQ Bot API 发送到你自己的 QQ。'),
            el('p', null, el('b', null, '可用变量（{} 内会被替换为对话实际信息）：')),
            el('table', {}, el('tbody', {},
              MANUAL_VARS.slice().sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map((v) => el('tr', { key: v[0] }, el('td', {}, el('code', null, v[0])), el('td', {}, v[1])))
            )),
            el('p', null, el('b', null, '预设：'), '共 5 个槽位，预设 1 为默认预设（可编辑），其余 4 个默认为空；单选启用、编辑后保存。未识别的变量原样保留。'),
            el('p', null, el('b', null, 'QQ 凭据：'), '两种方式：'),
            el('ul', null,
              el('li', null, '点击“扫码绑定”：页面内弹出二维码，手机 QQ 扫码即完成绑定，凭据自动保存（推荐）'),
              el('li', null, '手动填写 AppID、AppSecret（QQ 开放平台机器人后台）与 UserOpenID 后保存（AppSecret 存入 DSH 凭据库，不写入配置文件）')
            ),
            el('p', null, el('b', null, '配置位置：'), '非敏感配置保存在工作区 .dsh-qq-notify/ 目录；AppSecret 保存在 DSH 凭据库（~/.dsh/.credentials.yaml）。'),
            el('p', null, el('b', null, '隐私：'), '默认预设只包含项目名与时间等元信息；{request}/{result} 会包含对话内容，使用时请注意。'),
            el('div', { style: { textAlign: 'right', marginTop: 10 } },
              el('button', { className: 'dsh-qqn-btn', onClick: props.onClose }, '关闭')
            )
          )
        )
      }

      function QQNotifySettings() {
        const [loaded, setLoaded] = React.useState(false)
        const [enabled, setEnabled] = React.useState(true)
        const [active, setActive] = React.useState(0)
        const [presets, setPresets] = React.useState(DEFAULT_PRESETS.slice())
        const [appId, setAppId] = React.useState('')
        const [appSecret, setAppSecret] = React.useState('')
        const [userOpenid, setUserOpenid] = React.useState('')
        const [hasSecret, setHasSecret] = React.useState(false)
        const [bound, setBound] = React.useState(false)
        const [helpOpen, setHelpOpen] = React.useState(false)
        const [successOpen, setSuccessOpen] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [toast, setToast] = React.useState(null)
        const [bindState, setBindState] = React.useState(null)

        React.useEffect(() => {
          let alive = true
          hostCall('getState').then((s) => {
            if (!alive || !s || !s.ok) return
            setEnabled(!!s.enabled)
            setActive(typeof s.active === 'number' ? s.active : 0)
            setPresets(Array.isArray(s.presets) && s.presets.length === 5 ? s.presets.slice() : DEFAULT_PRESETS.slice())
            setAppId(typeof s.appId === 'string' ? s.appId : '')
            setUserOpenid(typeof s.userOpenid === 'string' ? s.userOpenid : '')
            setHasSecret(!!s.hasSecret)
            setBound(!!s.bound)
            setLoaded(true)
            console.log('[qq-notify] 设置已加载，已绑定：', !!s.bound, 'AppID:', s.appId || '-')
          }).catch((e) => {
            console.error('[qq-notify] 加载设置失败:', e && e.message ? e.message : String(e))
          })
          return () => { alive = false }
        }, [])

        // 弹窗提示：成功 3.2 秒 / 失败 5 秒后自动消失，也可点 ✕ 关闭
        const showToast = (text, isError) => {
          setToast({ id: Date.now() + Math.random(), text: String(text), isError: !!isError })
        }
        React.useEffect(() => {
          if (!toast) return
          const timer = window.setTimeout(() => { setToast(null) }, toast.isError ? 5000 : 3200)
          return () => { window.clearTimeout(timer) }
        }, [toast ? toast.id : null])

        const binding = !!(bindState && bindState.running)
        React.useEffect(() => {
          if (!binding) return
          let inFlight = false
          const timer = window.setInterval(() => {
            if (inFlight) return
            inFlight = true
            hostCall('bindPoll').then((r) => {
              if (!r) return
              if (r.ok === false) {
                setBindState({ running: false, done: true, qrUrl: '', error: r.error || '' })
                setBusy(false)
                showToast(r.error || '绑定失败', true)
                return
              }
              setBindState(r)
              if (!r.running) {
                setBusy(false)
                if (r.exitCode === 0) {
                  // 绑定成功：清空二维码区域，弹出成功通知
                  setBindState(null)
                  hostCall('getState').then((s) => {
                    console.log('[qq-notify] 绑定成功，AppID:', s && s.appId ? s.appId : '-')
                    if (s && s.ok) {
                      setAppId(s.appId || '')
                      setUserOpenid(s.userOpenid || '')
                      setHasSecret(!!s.hasSecret)
                      setBound(!!s.bound)
                      setSuccessOpen(true)
                    }
                  }).catch(() => { setSuccessOpen(true) })
                } else {
                  // 绑定失败（超时/过期/解密失败）：清空二维码区域，弹窗报错
                  setBindState({ running: false, done: true, qrUrl: '', error: r.error || '绑定失败' })
                  showToast(r.error || '绑定失败', true)
                }
              }
            }).catch((e) => {
              console.error('[qq-notify] 轮询绑定状态失败:', e && e.message ? e.message : String(e))
              /* 保持轮询 */
            }).finally(() => { inFlight = false })
          }, 3000)
          return () => { window.clearInterval(timer) }
        }, [binding])

        const save = () => {
          setBusy(true)
          const args = { enabled: enabled, active: active, presets: presets }
          if (appId.trim()) args.appId = appId.trim()
          if (userOpenid.trim()) args.userOpenid = userOpenid.trim()
          if (appSecret) args.appSecret = appSecret
          hostCall('saveState', args).then((r) => {
            setBusy(false)
            if (r && r.ok) {
              setAppSecret('')
              setHasSecret(!!r.hasSecret)
              setBound(!!r.bound)
              showToast('设置已保存' + (r.bound ? '（凭据完整，可发送）' : '（凭据未完整，无法发送）'), !r.bound)
            } else showToast((r && r.error) || '保存失败', true)
          }).catch(() => { setBusy(false); showToast('保存失败', true) })
        }

        const testSend = () => {
          setBusy(true)
          hostCall('testSend').then((r) => {
            setBusy(false)
            if (r && r.ok) {
              showToast('测试消息已发送到你的 QQ，请查看手机', false)
              console.log('[qq-notify] 测试消息发送成功')
            } else {
              showToast((r && r.error) || '测试发送失败', true)
              console.error('[qq-notify] 测试发送失败:', r && r.error ? r.error : '未知错误')
            }
          }).catch(() => { setBusy(false); showToast('测试发送失败', true) })
        }

        const bindStart = () => {
          setBusy(true)
          showToast('正在创建扫码绑定任务，请稍候……', false)
          hostCall('bindStart').then((r) => {
            setBusy(false)
            if (!r || !r.ok) { showToast((r && r.error) || '绑定启动失败', true); return }
            setBindState({ running: true, done: false, qrUrl: r.qrUrl || '', error: '' })
            showToast('二维码已生成，请用手机 QQ 扫码完成绑定', false)
            console.log('[qq-notify] 绑定任务已创建')
          }).catch((e) => { setBusy(false); showToast('绑定启动失败', true); console.error('[qq-notify] 绑定启动失败:', e && e.message ? e.message : String(e)) })
        }

        const restoreDefaults = () => {
          setPresets(DEFAULT_PRESETS.slice())
          setActive(0)
          showToast('已恢复默认预设（预设 1），记得点击保存', false)
        }

        if (!loaded) return el('div', { className: 'dsh-qqn-page' }, el('div', { className: 'dsh-qqn-sub' }, '正在读取 QQ 通知设置……'))

        return el('div', { className: 'dsh-qqn-page' },
          el('div', { className: 'dsh-qqn-row' },
            el('h3', { className: 'dsh-qqn-title' }, 'QQ 通知'),
            el('label', { className: 'dsh-qqn-radio', style: { marginLeft: 'auto' } },
              el('input', { type: 'checkbox', checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
              enabled ? '通知已启用' : '通知已停用'
            ),
            el('button', { className: 'dsh-qqn-qmark', onClick: () => setHelpOpen(true), title: '使用手册（可用变量）' }, '?')
          ),
          el('div', { className: 'dsh-qqn-sub' }, '每次对话回合结束时，通过已绑定的 QQ 机器人向你推送提醒'),
          el('div', { className: 'dsh-qqn-card' },
            el('div', { className: 'dsh-qqn-row' },
              el('span', { className: 'dsh-qqn-title' }, 'QQ 机器人凭据'),
              bound
                ? el('span', { className: 'dsh-qqn-status' }, '已配置（AppID ' + appId + '），可发送通知')
                : el('span', { className: 'dsh-qqn-status' }, (appId || hasSecret ? '凭据不完整' : '未配置') + '，无法发送')
            ),
            el('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
              el('div', { className: 'dsh-qqn-row' },
                el('span', { className: 'dsh-qqn-status', style: { width: 110 } }, 'AppID'),
                el('input', { className: 'dsh-qqn-input', value: appId, onChange: (e) => setAppId(e.target.value), placeholder: '机器人 AppID' })
              ),
              el('div', { className: 'dsh-qqn-row' },
                el('span', { className: 'dsh-qqn-status', style: { width: 110 } }, 'AppSecret'),
                el('input', { className: 'dsh-qqn-input', type: 'password', value: appSecret, onChange: (e) => setAppSecret(e.target.value), placeholder: hasSecret ? '已配置（留空则保持不变）' : '机器人 AppSecret' })
              ),
              el('div', { className: 'dsh-qqn-row' },
                el('span', { className: 'dsh-qqn-status', style: { width: 110 } }, 'UserOpenID'),
                el('input', { className: 'dsh-qqn-input', value: userOpenid, onChange: (e) => setUserOpenid(e.target.value), placeholder: '接收者的 OpenID' })
              )
            ),
            el('div', { className: 'dsh-qqn-row', style: { marginTop: 10 } },
              el('button', { className: 'dsh-qqn-btn dsh-qqn-btn-primary', disabled: busy || binding, onClick: bindStart }, '扫码绑定'),
              el('button', { className: 'dsh-qqn-btn', disabled: busy || binding, onClick: save }, '保存凭据与设置'),
              el('button', { className: 'dsh-qqn-btn', disabled: busy || binding, onClick: testSend }, '测试发送')
            ),
            binding || (bindState && bindState.qrUrl)
              ? el('div', { className: 'dsh-qqn-qr-area' },
                  bindState && bindState.qrUrl
                    ? el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 } },
                        el('div', { className: 'dsh-qqn-qr-box' },
                          el(QrSvg, { text: bindState.qrUrl, size: 232 })
                        ),
                        el('div', { className: 'dsh-qqn-sub' }, '用手机 QQ 扫描上方二维码完成绑定'),
                        el('a', { className: 'dsh-qqn-qr', href: bindState.qrUrl, target: '_blank', rel: 'noreferrer', style: { fontSize: 11 } }, '二维码无法显示？点此在浏览器中打开')
                      )
                    : el('div', { className: 'dsh-qqn-status' }, binding ? '等待扫码……' : ''),
                  binding && bindState && bindState.error
                    ? el('div', { className: 'dsh-qqn-status', style: { marginTop: 4 } }, '轮询等待中：' + bindState.error)
                    : null
                )
              : null
          ),
          el('div', { className: 'dsh-qqn-card' },
            el('div', { className: 'dsh-qqn-row' },
              el('span', { className: 'dsh-qqn-title' }, '通知预设（共 5 个，当前启用第 ' + (active + 1) + ' 个）'),
              el('button', { className: 'dsh-qqn-btn', style: { marginLeft: 'auto' }, disabled: busy, onClick: restoreDefaults }, '恢复默认'),
              el('button', { className: 'dsh-qqn-btn dsh-qqn-btn-primary', disabled: busy, onClick: save }, '保存')
            ),
            el('div', { style: { marginTop: 8 } },
              [0, 1, 2, 3, 4].map((i) =>
                el('label', { key: 'p' + i, className: 'dsh-qqn-radio' },
                  el('input', { type: 'radio', name: 'qqn-preset', checked: active === i, onChange: () => setActive(i) }),
                  PRESET_LABELS[i],
                  presets[i] && presets[i].trim() ? '' : el('span', { className: 'dsh-qqn-status' }, '（空）')
                )
              )
            ),
            el('textarea', {
              className: 'dsh-qqn-textarea',
              style: { marginTop: 8 },
              value: presets[active] || '',
              placeholder: '在此输入通知文本，可使用 {workspace} {project} {time} {request} 等变量，点击右上角“？”查看全部变量',
              onChange: (e) => {
                const next = presets.slice()
                next[active] = e.target.value
                setPresets(next)
              },
            }),
            el('div', { className: 'dsh-qqn-sub', style: { marginTop: 4 } }, '发送前 {变量} 会被替换为对话的实际信息；未识别的变量会原样保留')
          ),
          toast ? el('div', { className: toast.isError ? 'dsh-qqn-toast dsh-qqn-toast-error' : 'dsh-qqn-toast' },
            el('span', { style: { flex: 1 } }, toast.text),
            el('button', { className: 'dsh-qqn-toast-close', onClick: () => setToast(null) }, '✕')
          ) : null,
          helpOpen ? el(HelpPanel, { onClose: () => setHelpOpen(false) }) : null,
          successOpen ? el(SuccessDialog, { appId: appId, onClose: () => setSuccessOpen(false) }) : null
        )
      }

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'qq-notify', order: 30, label: 'QQ 通知' },
        () => React.createElement(QQNotifySettings, null)
      ))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
