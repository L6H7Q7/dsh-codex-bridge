# dsh-codex-bridge

为运行中的 DeepSeek Harness 桌面版提供本地 HTTP 消息入口。Codex 或其他本机客户端可以新建对话、发送文本、查询状态并读取回复。会话通过 Harness 官方服务创建和保存，供桌面 UI 展示。

这是非官方插件，依赖 Harness 内部服务。已在 Windows 本机安装环境（2026-10-01）验证热加载、自动注册项目、新建会话、发送与回复；其他版本、平台尚未验证。桌面 UI 的实时呈现需在自己的安装环境确认。

## 功能

- 启用时自动创建、注册 Codex-DeepSeek 专用项目，目录已存在则复用。
- 默认在 Codex-DeepSeek 项目中新建会话；可列出、读取和向所有分组及未归组的已有会话投递文本。
- queue 模式排队发送，不主动中断当前回合。
- 查询请求对应回合及审批状态，读取消息正文。
- 同一插件生命周期内并发去重和内容冲突检测。
- 仅接受 loopback 服务、合法 Host 和同源 Origin，拒绝跨站请求。
- 停用入口后保留项目和会话数据。

**安全边界：接口没有认证，其他本机进程也可调用，发送的任务可能触发模型费用及 Agent 工具操作。桥接访问范围不等于文件系统隔离，实际权限取决于 Harness preset 与审批设置。不要用代理、端口转发或隧道把它暴露到网络。**

## 下载与部署

1. 在 GitHub 选择 Code → Download ZIP，解压；或者用 Git 克隆仓库。
2. 需要已安装并运行 DeepSeek Harness 桌面版，且已配置可用模型与凭据。插件无第三方依赖，不需要 npm install。
3. 查看 `index.js` 顶部的 `PROJECT_DIR`。默认目标是 `D:\AI\WorkSpace\Codex-DeepSeek`；如果没有 D 盘或想用其他位置，先修改这个常量，例如：

   ```js
   export const PROJECT_DIR = 'C:\\Users\\YourName\\Documents\\Codex-DeepSeek';
   ```

   插件会创建这个目录，无需提前创建。JS 字符串中的反斜杠须正确转义。

4. 按 Win+R 输入 `%USERPROFILE%\.dsh\profiles\desktop`，创建 `local\codex-bridge`，把 **index.js 与 package.json 一起**复制进去：

   ```text
   desktop/
     cordis.patch.yml
     local/codex-bridge/
       index.js
       package.json
   ```

   `package.json` 的 name/version 是请求扩展包清单所需元数据；缺少它可能导致 `REQUEST_EXTENSION`。无需修改上层 profile 的 package.json。

5. 备份 `cordis.patch.yml`，在原文件末尾追加，保留已有配置：

   ```yaml
   - insert:
       - id: codex-bridge
         name: ./local/codex-bridge/index.js
   ```

6. 当前已测试环境会自动热加载，无需退出程序。无需把插件加入 bundles，也无需修改 hmr.root。出现加载错误时移除本次追加段，检查 Harness 日志；不要反复挂载相同 ID。
7. PowerShell 检查入口（19387 是测试环境端口，其他环境请确认实际端口）：

   ```powershell
   $base = 'http://127.0.0.1:19387/local/codex-bridge'
   Invoke-RestMethod "$base/v1/health"
   ```

   预期 `ok: true`、`ready: true`，project.cwd 为专用目录。桌面侧栏应出现 Codex-DeepSeek 项目。

安装前可选用独立 Node.js 24+ 执行 `node --check index.js`；运行插件本身使用 Harness 的 Node 环境。

## 使用

完整 PowerShell 示例见 [examples/send-message.ps1](examples/send-message.ps1)。它会真实发送一条消息，可能产生费用。

```powershell
# 新建会话。运行示例前先阅读脚本。
.\examples\send-message.ps1 -Text '你好，这是新会话测试'

# 在已有会话继续发送；默认产生新的 requestId。
.\examples\send-message.ps1 -SessionId 'session-实际ID' -Text '继续讨论'

# 网络异常后重试原消息：复用相同会话ID、请求ID及文本。
.\examples\send-message.ps1 -SessionId 'session-实际ID' -RequestId '原请求ID' -Text '原消息'
```

脚本只打印受理信息，不把 accepted 当作回复完成。查询状态和正文：

```powershell
Invoke-RestMethod "$base/v1/status?sessionId=实际会话ID&requestId=实际请求ID"
$result = Invoke-RestMethod "$base/v1/events?sessionId=实际会话ID&sinceSeq=-1"
$result.events | Where-Object type -eq 'assistant/message' | Select-Object seq,text
```

然后在桌面 UI 的 Codex-DeepSeek 项目中打开相应会话。保存返回的 sessionId 与 requestId，以便续聊或重试。

## 接口

基础路径：`http://127.0.0.1:<端口>/local/codex-bridge`。POST 要求 `application/json`，文本按 UTF-8 发送。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/health` | 插件和项目就绪状态 |
| GET | `/v1/sessions` | 列出完整会话ID、分组元数据及会话归属 |
| POST | `/v1/sessions` | 新建或安全接管会话，body 为可选 sessionId |
| POST | `/v1/messages` | 文本投递：sessionId、text、可选 requestId/clientTimeZone，mode 只允许 queue |
| GET | `/v1/status?sessionId=…&requestId=…` | 查询请求与回合状态 |
| GET | `/v1/events?sessionId=…&sinceSeq=-1` | 按序号读取裁剪后的消息和回合事件 |

`accepted:true` 仅代表受理。`phase:turn-complete` 表示回合结束，只有 `outcome:completed` 表示正常完成。queued、admission-pending、unknown 均不能当作成功或取消；admission-pending 可能是消息已取出队列尚未落盘，也可能已移除。

## 限制与重试

- 读取、状态查询及消息发送覆盖所有分组与未归组会话；创建会话仍默认使用 Codex-DeepSeek。不支持附件、steer 或回合取消。
- POST body 上限 256 KiB，文本上限 64 Ki 字符；事件正文最多回传 16 Ki 字符，超出会标记截断。
- 服务约 30 秒处理超时。504 或连接断开后的受理结果可能未知，应查询状态，或复用原 ID 与完整内容重试；不要盲目换新 ID。
- 新建会话时客户端应先生成稳定的 sessionId，重试复用；不带 ID 每次创建新会话。
- 同插件生命周期内，同 requestId 不同会话或内容返回409。插件热加载/重启会清空本地去重表；官方检查可拦历史同 ID，但不保证跨重启内容冲突检测或跨代并发 exactly-once。缓存也有容量上限。
- 权限、审批和模型由桌面官方默认 preset/会话配置管理。cold 会话续聊通过官方安全 resume；写句柄冲突返回错误，不解除锁。

## 停用、回退与更新

从 `cordis.patch.yml` 移除本插件挂载段即可停用。项目目录、工作区注册和聊天记录保留；GET health 应恢复404。备份不要覆盖，撤回时不要用旧文件覆盖其他后续修改。

更新前先停用挂载，再替换两个插件文件，重新挂载并检查健康状态。默认 HMR 不监听插件源码文件，不能保证只替换 JS 就自动生效。

## 全部分组访问

GET `/v1/sessions` 使用官方 `sessionQuery.listSessions()` 列出 live/persisted 完整会话语料，包括所有分组与未归组会话。返回字段：

| 字段 | 含义 |
| --- | --- |
| `scope` | 固定为 `all-sessions`；健康接口也返回此字段 |
| `sessionIds` | 完整会话 ID 列表 |
| `workspaces` | 分组元数据：`workspaceId`、`title`、`cwd`、`sessionIds` |
| `sessions` | 会话元数据：`sessionId`、`cwd`、`workspaceId`；未归组会话的 `workspaceId` 为 null |
| 顶层 `workspaceId` / `cwd` | 默认创建项目的信息，不表示会话列表的范围 |

`/v1/events`、`/v1/status` 和 `/v1/messages` 接受完整语料中的已有会话；未知会话返回404。访问不会移动会话、改写分组或绕过官方 resume、写锁、preset 与审批。新建会话仍默认使用 Codex-DeepSeek。

## 已验证与待验证

原版已实测：热加载、自动注册项目、默认 standard preset、新建会话、文本发送及模型回复、同 ID 去重、冲突409、Host/Origin403、Content-Type415、超限413、官方 API 认证保持及停用后404。原版跨项目403限制已由全分组访问取代。

2026-10-12 全分组版本已通过语法检查及内存模拟：完整会话列表、跨组与未归组读取、模拟发送、未知会话404及 disposed 状态拒绝。重启 Harness 后，健康接口返回 `scope: all-sessions`，实际跨分组与未归组的事件读取、状态查询通过抽样验证。新版跨分组发送仅通过模拟检查，未发送真实测试消息。

更新时，原路径卸载再挂载仍可能复用旧模块。此次验证中，仅重新挂载未加载新版，重启 Harness 后新版生效；更新后应检查 `/v1/health` 的 `scope` 字段及实际接口行为。

没有安装第三方依赖。源码审阅和内存验证不替代其他版本的兼容性测试；长会话性能、跨重启完整去重和不同平台尚未保证。仓库只包含插件及说明，不包含 Harness 原程序、凭据或聊天记录。
