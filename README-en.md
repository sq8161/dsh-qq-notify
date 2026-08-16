# DSH QQ Notification Plugin

English | [中文](README-zh.md)

Sends a private-message notification to your own QQ through the **official Tencent QQ Bot API** at the end of every conversation turn in DeepSeek Harness (DSH). Supports 5 customizable presets, placeholder variables, and **built-in QR-code binding**.

**Zero external dependencies**: sending and binding use only the system's built-in `curl` plus a pure-JS AES-256-GCM implementation — no Python, no Node packages, no third-party libraries. The AppSecret is stored in the DSH credential store and never written to disk in plaintext.

## Features

- Listens to `agent/turn-stopping` and pushes a notification when a turn ends
- 5 preset slots (preset 1 is the default, the rest empty), radio-select + free editing
- Placeholder variables: `{workspace}` `{project}` `{time}` `{request}` `{result}` `{model}` `{provider}` `{sessionTitle}` `{sessionId}` `{turn}`
- A floating manual opened by the "?" button on the settings page lists every available variable
- **QR-code binding**: scan with the QQ mobile app to complete binding; credentials (AppID / AppSecret / UserOpenID) are decrypted and saved automatically
- Manual credential entry is also supported (AppSecret stored in the DSH credential store)
- Only top-level user sessions trigger notifications (sub-agent turns are filtered), with 3-second deduplication
- Send failures only log; they never interrupt the conversation

## Installation (one command, persists across restarts)

The repository is published as a dsh plugin package (`dsh-qq-notify`, declaring `dsh.bundle`). Install with a single command:

```bash
dsh plugin --profile web add github:sq8161/dsh-qq-notify#v1.0.1
```

**What happens after installation (user perspective):**

1. pnpm pulls the repository tarball for the `v1.0.1` tag from GitHub and installs it into the profile's `node_modules/dsh-qq-notify`
2. The `dsh plugin` reconcile step sees the package manifest declaring `dsh.bundle.patch` and automatically appends it to the profile's `dsh.profile.bundles` layer stack
3. After **restarting DSH**, the launcher loads the layers: the package's `cordis.patch.yml` registers the plugin as a row (`qq-notify`) in the host composition — the host logic activates, listening for turn ends and registering the `/qq-notify` RPC channel; the `dsh.client` declaration makes the browser module table load `lib/client.js`, adding a "QQ 通知" section to the settings page
4. The user opens **Settings → QQ Notify** → clicks **QR binding** (or enters credentials manually) for the one-time setup; afterwards every restart works automatically with no redeployment

Upgrade: `dsh plugin --profile web update dsh-qq-notify` → restart.

## Usage

1. **Bind** (recommended): on the settings page click "扫码绑定" (QR binding) → scan with the QQ mobile app → credentials are saved automatically
2. **Manual config**: fill in AppID, AppSecret (from the QQ Open Platform bot console) and UserOpenID, then save
3. **Presets**: select a preset, edit the text, save; placeholders are replaced with real conversation data when sending, unknown variables are kept as-is
4. **Test send**: click "测试发送" to verify the pipeline

## Available Variables

| Variable | Description |
| --- | --- |
| `{workspace}` | Full path of the session workspace |
| `{project}` | Workspace directory name (project name) |
| `{time}` | Turn-end time (local time, YYYY-MM-DD HH:mm:ss) |
| `{request}` | Most recent user input in this conversation (truncated to 200 chars) |
| `{result}` | Most recent assistant reply (truncated to 300 chars) |
| `{model}` | Current model |
| `{provider}` | Current model provider |
| `{sessionTitle}` | Current session title |
| `{sessionId}` | Session ID |
| `{turn}` | Number of the turn that ended |

Default preset:

```
【deepseek任务完成】
项目：{project}
时间：{time}
请返回deepseek查看执行结果
```

## Configuration & Privacy

- Non-sensitive config (presets, AppID, UserOpenID, enabled flag) is stored in the plugin install directory: `<profile>/node_modules/dsh-qq-notify/.dsh-qq-notify/dsh_qq_notify_config.json` (unrelated to the workspace; migrate manually after reinstalling the plugin)
- The AppSecret is stored in the DSH credential store (`~/.dsh/.credentials.yaml`), never in the config file
- The access token is cached in memory only and refreshes automatically on expiry
- The default preset contains only metadata (project name, time) — no conversation content
- `{request}` / `{result}` extract conversation content (your input and the assistant's reply). The default preset does not use them; if you do, assess the privacy implications yourself (messages are only sent to your own QQ private chat)

## Dependencies

- System `curl` (bundled with Windows 10+ / macOS / Linux)

## Implementation Notes

- Send pipeline matches [qqbot-agent-sdk](https://pypi.org/project/qqbot-agent-sdk/):
  1. `POST https://bots.qq.com/app/getAppAccessToken` with `{appId, clientSecret}` to obtain an access token
  2. `POST https://api.sgroup.qq.com/v2/users/{openid}/messages` with `{content, msg_type: 0, msg_seq, msg_id: ""}` and header `Authorization: QQBot <token>`
- QR binding pipeline (official binding protocol):
  1. `POST https://q.qq.com/lite/create_bind_task` (carrying a locally generated AES-256 key) → task_id
  2. QR URL `https://q.qq.com/qqbot/openclaw/connect.html?task_id=...&_wv=2`
  3. Poll `POST https://q.qq.com/lite/poll_bind_result` → on completion decrypt `bot_encrypt_secret` with AES-256-GCM to obtain the AppSecret
- q.qq.com applies anti-bot checks: binding requests use a browser User-Agent, and a GET to `https://q.qq.com/` pre-fetches cookies (`-c/-b` cookie jar stored at `.dsh-qq-notify/qqn_cookies.txt`) before calling the binding API to bypass the JS challenge page
- The QR code is generated by the plugin's **pure-JS QR encoder** (Byte mode / ECC L / versions 1-9 / mask 0) and rendered as inline SVG in the settings page — no iframes or third-party services; `qrgen.js` is a standalone copy of the encoder (with `reserved` debug output), cross-verified module-by-module against the npm `qrcode` library and independently decoded with `jsqr` (covering v1/v2/v5/v7/v9, including multi-block interleaving); `test-aesgcm-driver.js` and `.verify/verify-qrgen.js` are the corresponding verification scripts
- `aesgcm.js` is a standalone runnable AES-256-GCM implementation copy (with a CLI), cross-verified against Python's `cryptography` library with 10 random vectors (0-5000 bytes); wrong keys are rejected by tag verification; `test-aesgcm-driver.js` is the test driver
