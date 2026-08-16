# DSH QQ 通知插件

[English](README-en.md) | 中文

在 DeepSeek Harness（DSH）中，每次对话回合结束时，通过**腾讯官方 QQ Bot API** 向你的 QQ 私聊推送一条提醒通知。支持 5 个自定义预设、占位变量、**内置扫码绑定**。

**零外部依赖**：发送与绑定全部使用系统自带的 `curl` + 内置的纯 JS AES-256-GCM 实现，无需 Python、Node 包或任何第三方库；AppSecret 存入 DSH 凭据库，不落盘明文。

## 功能特性

- 监听 `agent/turn-stopping`（对话回合结束）自动推送通知
- 对话等待用户时也会推送提醒（模型提问、操作审批、计划确认三类中断）
- 5 个预设槽位（预设 1 为默认预设，其余为空），单选启用 + 自由编辑
- 占位变量：`{workspace}` `{project}` `{time}` `{request}` `{result}` `{model}` `{provider}` `{sessionTitle}` `{sessionId}` `{turn}`
- 设置页右上角「?」按钮弹出悬浮使用手册，列出全部可用变量
- **扫码绑定**：手机 QQ 扫码即完成绑定，凭据（AppID / AppSecret / UserOpenID）自动解密并保存
- 也支持手动填写凭据（AppSecret 存入 DSH 凭据库）
- 只对顶层用户会话发送（自动过滤子代理回合），3 秒内去重
- 发送失败只记日志，不影响对话

## 安装（一键，随 DSH 持久化）

仓库已发布为 dsh 插件包（`dsh-qq-notify`，含 `dsh.bundle` 声明），一条命令安装：

```bash
dsh plugin --profile web add github:sq8161/dsh-qq-notify#v1.0.1
```

**安装后发生了什么（用户视角）：**

1. pnpm 从 GitHub 拉取 `v1.0.1` tag 对应的仓库 tarball，安装到 profile 的 `node_modules/dsh-qq-notify`
2. `dsh plugin` 的 reconcile 检查到该包 manifest 声明了 `dsh.bundle.patch`，自动把它追加进 profile 的 `dsh.profile.bundles` 层
3. **重启 DSH** 后，启动器按层加载：包的 `cordis.patch.yml` 把插件注册为宿主组合的一行（`qq-notify`），宿主逻辑激活——监听回合结束、注册 `/qq-notify` RPC 通道；`dsh.client` 声明让浏览器模块表加载 `lib/client.js`，设置页出现「QQ 通知」区块
4. 用户打开 **设置 → QQ 通知** → 点击 **扫码绑定**（或手动填凭据），完成一次性配置；之后每次重启自动生效，无需重新部署

升级版本：`dsh plugin --profile web update dsh-qq-notify` → 重启。

## 使用

1. **绑定**（推荐）：设置页点击「扫码绑定」→ 点击出现的二维码链接 → 手机 QQ 扫码授权 → 凭据自动保存
2. **手动配置**：填写 AppID、AppSecret（QQ 开放平台机器人后台）与 UserOpenID，点保存
3. **预设**：单选启用某个预设，编辑文本后点保存；占位变量在发送时替换为对话实际信息，未识别的变量原样保留
4. **测试发送**：点击「测试发送」验证链路

## 可用变量

| 变量 | 说明 |
| --- | --- |
| `{workspace}` | 会话工作区完整路径 |
| `{project}` | 工作区目录名（项目名） |
| `{time}` | 对话结束时间（本地时间 YYYY-MM-DD HH:mm:ss） |
| `{request}` | 本次对话最近一条用户输入（截断至 200 字） |
| `{result}` | 最近一条助手回复（截断至 300 字） |
| `{model}` | 当前使用的模型 |
| `{provider}` | 当前使用的模型提供商 |
| `{sessionTitle}` | 当前会话标题 |
| `{sessionId}` | 会话 ID |
| `{turn}` | 结束的回合序号 |

默认预设：

```
【deepseek任务完成】
项目：{project}
时间：{time}
请返回deepseek查看执行结果
```

## 配置与隐私

- 非敏感配置（预设、AppID、UserOpenID、开关）保存在插件安装目录：`<profile>/node_modules/dsh-qq-notify/.dsh-qq-notify/dsh_qq_notify_config.json`（与工作区无关，重装插件后请手动迁移）
- AppSecret 保存在 DSH 凭据库（`~/.dsh/.credentials.yaml`），不写入配置文件
- access token 仅缓存在内存中，过期自动刷新
- 默认预设只包含项目名与时间等元信息，不含对话内容
- `{request}` / `{result}` 会提取对话内容（含你的输入与助手回复），默认预设不使用它们；如需使用请自行评估隐私（消息仅发往你自己的 QQ 私聊）

## 依赖

- 系统自带 `curl`（Windows 10+ / macOS / Linux 均内置）

## 实现说明

- 发送链路与 [qqbot-agent-sdk](https://pypi.org/project/qqbot-agent-sdk/) 一致：
  1. `POST https://bots.qq.com/app/getAppAccessToken`（`{appId, clientSecret}`）获取 access token
  2. `POST https://api.sgroup.qq.com/v2/users/{openid}/messages`（`{content, msg_type: 0, msg_seq, msg_id: ""}`，鉴权头 `Authorization: QQBot <token>`）
- 扫码绑定链路（官方扫码绑定协议）：
  1. `POST https://q.qq.com/lite/create_bind_task`（携带本地生成的 AES-256 密钥）→ task_id
  2. 二维码链接 `https://q.qq.com/qqbot/openclaw/connect.html?task_id=...&_wv=2`
  3. 轮询 `POST https://q.qq.com/lite/poll_bind_result` → 完成后用 AES-256-GCM 解密 `bot_encrypt_secret` 得到 AppSecret
- q.qq.com 有反爬校验：绑定请求使用浏览器 User-Agent，并先 GET `https://q.qq.com/` 预取 cookie（`-c/-b` cookie jar，保存在 `.dsh-qq-notify/qqn_cookies.txt`）再调用绑定 API，规避 JS 挑战页
- 二维码由插件内置的**纯 JS QR 编码器**生成（Byte 模式 / ECC L / 版本 1-9 / 掩码 0），以 SVG 直接渲染在设置页内，不依赖 iframe 或第三方服务；`qrgen.js` 为可独立运行的编码器副本（含 `reserved` 调试输出），已用 npm `qrcode` 库逐模块比对 + `jsqr` 独立解码验证（覆盖 v1/v2/v5/v7/v9，含双块交错），`test-aesgcm-driver.js` 与 `.verify/verify-qrgen.js` 为对应验证脚本
- `aesgcm.js` 是独立可运行的 AES-256-GCM 实现副本（含 CLI），已用 Python `cryptography` 库的 10 组随机向量（0~5000 字节）交叉验证通过，错误密钥会被 tag 校验拒绝；`test-aesgcm-driver.js` 为对应测试驱动
