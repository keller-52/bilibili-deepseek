# bili-duty

> B 站 AI 账号的本地控制台：**扫码登录 / 读取已有登录态**、**私信白名单**、**参数中心**、**审计视图**。
> 走 **UI 路线**——只驱动真实 Chrome 的页面，不调用 B 站接口。
> 底座与边界见 [技术方案](docs/技术方案-v4-定稿.md)。

![登录页](docs/media/login.png)

## 现在能做什么

| 模块 | 能力 |
|---|---|
| **登录** | 启动专用 Chrome（独立 profile + CDP 9222），截取 passport 登录页的二维码显示在控制台；手机扫码后自动检测登录态（读 Cookie，不调接口）。也支持连接另一台已开调试端口的 Chrome，或直接读取专用 profile 里留存的登录态。退出时清除 B 站 Cookie。 |
| **私信白名单** | 增 / 删 UID、昵称、备注，写回 `config/dm-allowlist.json`；加入真实 UID 时自动替换示例 UID 0，重复与非法 UID 会被拒绝。 |
| **参数中心** | 按 `config/config.yaml` 渲染 7 组参数：互动配额、私信、发布、审核、AUTO、调度、风控。保存时**逐行改值、保留注释**。硬约束（白名单、禁止链接、规则引擎、动态人工审核）锁定。 |
| **审计** | 读取 `runtime/audit/audit.jsonl` 尾部，展示时间 / 动作 / 目标 / 规则 / AI / 人工 / 执行 / 核验。 |
| **状态** | Chrome、CDP、登录 UID、Cookie 到期、白名单人数、配置错误与警告。 |

零依赖：只用 Node 内置模块 + 本机 Chrome，**不需要 `npm install`**。

## 快速开始

需要 **Node.js ≥ 22**（本机 v25.1.0）和 **Google Chrome**（本机 155.0.8059.82）。

```bash
npm start
```

打开 <http://127.0.0.1:7801>。Windows 也可以双击 `start.cmd`。

第一次使用：

1. **登录 → 启动并显示二维码**。会拉起一个专用 Chrome（默认无头；遇到滑块就勾上「显示 Chrome 窗口」）。
2. 手机 B 站扫码，确认时选「记住我 / 长期」。状态会在 2.5 秒内变成「已登录 · UID …」。
3. **私信白名单**里把示例 UID 0 换成真实好友（只加确认过、知道这是 AI 的人）。
4. **参数**按默认值先跑；要改就改，保存后写回 YAML。

![参数页](docs/media/params.png)

## 登录是怎么做的（不碰接口）

```
控制台 ── CDP 9222 ──> 专用 Chrome（chrome-profile/）
   │                        │
   │  Page.captureScreenshot│  https://passport.bilibili.com/login
   │ <── 二维码 PNG ────────┘
   │
   │  Storage.getCookies → SESSDATA / DedeUserID
   └── 已登录 UID + 到期时间
```

- **二维码**：打开登录页，定位 `.login-scan__qrcode`（或 `img[src^="data:image"]`）截元素；找不到时退回整页截图。
- **登录态**：只读 Chrome 的 Cookie 域，不请求任何 B 站接口。
- **昵称**：登录后只读 `space.bilibili.com/<uid>` 的 `document.title`，解析失败就只显示 UID。
- **退出**：`Storage.clearDataForOrigin` 清掉 bilibili 各域的 Cookie。

登录态落在 `chrome-profile/`（已 gitignore），仓库里**没有任何 Cookie 或密钥**。

## 安全边界

- 服务只监听 `127.0.0.1`，不对外网开放。
- 静态页面带 CSP（`default-src 'self'`），没有内联脚本。
- 写接口校验 `Origin`，拒绝跨站请求。
- 没有“打开任意网址”的接口；导航目标固定为 B 站登录 / 空间页。
- 白名单、禁止私信链接、规则引擎、L3 人工审核在代码层锁定，控制台改不了。
- **这个版本只有控制面**：评论、私信、动态等写操作尚未实现，也不会偷偷执行。

## 目录

```
.
├── config/
│   ├── config.yaml          # 唯一参数来源（控制台逐行改写，保留注释）
│   └── dm-allowlist.json    # 私信白名单
├── docs/
│   ├── 技术方案-v4-定稿.md    # 架构、配额、审核、AUTO、合规
│   ├── 迁移记录.md            # 2026-10-18 环境核对与迁移
│   └── media/                # 控制台截图
├── persona/persona.md        # 人格底稿
├── runtime/                  # memory / drafts / audit（gitignore 数据文件）
├── src/
│   ├── server.mjs            # HTTP 服务 + API
│   ├── cli.mjs               # `node src/cli.mjs status`
│   ├── cdp.mjs               # 零依赖 CDP 客户端
│   ├── chrome.mjs            # 定位 / 启动 Chrome
│   ├── bili.mjs              # 二维码、登录态、昵称、退出
│   ├── config.mjs            # config.yaml 读写
│   ├── yaml.mjs              # YAML 子集解析 + 逐行改写
│   ├── schema.mjs            # 参数目录与校验
│   ├── allowlist.mjs         # 白名单读写
│   ├── audit.mjs             # 审计尾读
│   └── paths.mjs             # 工作区路径
├── web/                      # 控制台（原生 HTML/CSS/JS）
└── test/                     # node:test
```

## 参数

参数目录在 `src/schema.mjs`，与 `config/config.yaml` 一一对应；启动时会检查缺键。
默认值刻意保守：投币日 1、评论日 3、私信日 10（仅白名单）、AUTO 关闭、L3 关闭。
完整说明见 [技术方案 §8](docs/技术方案-v4-定稿.md)。

## 开发

```bash
npm test          # 24 个用例：YAML、参数校验、白名单、HTTP
node src/cli.mjs status
node src/cli.mjs status --json
```

环境变量：

| 变量 | 默认 | 作用 |
|---|---|---|
| `BILI_DUTY_PORT` | `7801` | 控制台监听端口 |
| `BILI_DUTY_CDP_PORT` | `9222` | 专用 Chrome 的调试端口 |
| `CHROME_PATH` | 自动查找 | 指定 `chrome.exe` |

## 与 DSH 的关系

这个仓库是**控制面**：登录态、白名单、参数、审计路径、运行状态。
执行面按技术方案阶段 1 推进——DSH 通过 Playwright MCP / CDP 驱动同一个专用 Chrome，
先跑通只读链路（搜索 → 看 → 读评论 → 总结），再进 L1 / L2。
`node src/cli.mjs status --json` 给 Agent 读状态，不需要解析页面。

## 路线图

- [x] **0.1 控制台**：登录（扫码 / 复用）、白名单、参数中心、审计视图
- [ ] **0.2 只读链路**：`bili-playbook` + 搜索 / 看视频 / 读 Shadow DOM 评论 / 写 memory
- [ ] **0.3 L1 + guard**：点赞 / 投币 / 收藏，配额、限速、审计
- [ ] **0.4 L2 + 三层审核**：评论 / 回复 / 弹幕 / 私信
- [ ] **0.5 L3 与 AUTO**：动态日 1 + 人工；满足条件后再评估 AUTO

## 已知限制

- 二维码链路已实测到“截出可扫的二维码”；**真正的扫码确认需要你本人完成**。
- 昵称依赖空间页标题，页面改版时可能只显示 UID（不影响登录态判断）。
- 连接别的 Chrome 必须用非默认 profile（Chrome 不允许对默认 profile 开调试端口）。
- 专用 Chrome 默认无头；遇到滑块 / 验证码时在登录页勾选「显示 Chrome 窗口」重试。
- Windows 路径含空格时，命令行里记得加引号。

## License

[MIT](LICENSE)
