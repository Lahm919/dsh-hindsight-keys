# dsh-hindsight-keys

DSH（DeepSeek Harness）插件：把 **Hindsight daemon 自己的 LLM key 池**可视化管起来 —— 在 DSH 设置页里增删 key、启停 key、切换主 key、切换轮换策略（`round-robin` / `failover`），点一下就写回 Hindsight 的 profile env 并重启 daemon。

> 它管的是 **Hindsight 记忆引擎** 调用大模型时用的 key（`HINDSIGHT_API_LLM_*`）。
> 如果你要管的是 **DSH 聊天模型本身** 的 key，那是另一个插件（例如 `@goodandready/dsh-key-rotation`），两者互不干扰。

- 版本：**0.3.1**
- 许可证：**Apache-2.0**
- 平台：Windows（实测）／macOS、Linux（未实测，见「已知限制」）

---

## 它解决什么问题

Hindsight 1.2.0 的 `multi_llm` 支持一个主 key + 若干备用 key：

```ini
HINDSIGHT_API_LLM_PROVIDER=opencode-go
HINDSIGHT_API_LLM_MODEL=deepseek-v4.1-flash
HINDSIGHT_API_LLM_BASE_URL=https://opencode.ai/zen/go/v1
HINDSIGHT_API_LLM_API_KEY=oc_sk_primary...
HINDSIGHT_API_LLM_1_API_KEY=oc_sk_member2...
HINDSIGHT_API_LLM_2_API_KEY=oc_sk_member3...
HINDSIGHT_API_LLM_STRATEGY={"mode":"round-robin","cooldown_seconds":120}
```

手写这份配置有几个坑：

1. 成员索引必须**从 1 连续**，中间断号后面的成员就静默失效；
2. `STRATEGY` 是一段 JSON，格式错了 daemon 不报错、只是不轮换；
3. 改完必须重启 daemon，而冷启动要 2～3 分钟，很容易以为「没生效」；
4. 想知道某把 key 到底还能不能用，只能翻日志。

本插件把这些都做成面板操作，并把 key 明文留在宿主侧。

---

## 功能

- **key 池管理**：添加（粘贴新 key 或从 `~/.credentials.yaml` 里按 ref 引用）、删除、启停、改名、排序；
- **主 key 切换**：选哪一把作为 `HINDSIGHT_API_LLM_API_KEY`（其余自动成为 `_1…_n` 成员）；
- **轮换策略**：`round-robin` / `failover` / `metadata` + `cooldown_seconds`，可选权重；
- **连通性探测**：并发 POST 一次最小 chat 请求，返回 HTTP 状态、耗时、错误文本；
- **一键写回 + 重启**：写 env → 备份 → 重启 daemon → 轮询到健康为止；
- **状态回显**：每次 apply / restart 的时间、是否 changed、备份文件名、每步耗时都在面板上。

---

## 安装

前提：已装 **DSH Desktop**（或 DSH web），并已装 **Hindsight coding-agent**（`hindsight-embed` / `hindsight-api` 1.2.0）。

```powershell
# 在本仓库根目录
.\install.ps1                      # 默认装到 %APPDATA%\dsh-desktop\harness，profile=web
.\install.ps1 -Profile web -Force
```

脚本做三件幂等的事：

1. 复制插件到 `<DSH_HOME>\plugins\dsh-hindsight-keys`；
2. 在 `<DSH_HOME>\profiles\<profile>\node_modules` 建 junction 指向它；
3. 在 `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` 末尾追加挂载行（并先备份该文件）。

**改完必须重启 DSH Desktop** —— 新增的 patch 行不会热挂载。

手动安装等价于上面三步；`cordis.patch.yml` 里需要这一行：

```yaml
- insert:
    - id: dsh-hindsight-keys
      name: dsh-hindsight-keys
```

卸载：`.\uninstall.ps1`（会移除挂载行与目录，保留 Hindsight 的 env 受管块；如需清理由面板「移除」key 即可）。

---

## 打开面板

重启后有两个入口，任选其一：

1. **设置 → 左侧导航「Hindsight API Key 池」**；
2. **设置 → 「内置插件」→ 标签页「Hindsight API Key 池」**。

也可以直接用浏览器打开（与 DSH web 同源、免登录、仅监听回环）：

```
http://127.0.0.1:<dsh-web 端口>/api/hindsight-keys/panel
```

> 如果导航里看不到入口：先硬刷新（`Ctrl+Shift+R`）。插件更新后前端 bundle 的 `rev` 变了，只刷新普通页面可能仍用缓存。

---

## 面板怎么用

| 操作 | 说明 |
| --- | --- |
| 勾选「启用」 | 决定这把 key 是否进入受管块。至少保留一把；主 key 必须在启用状态。 |
| 单选主 key | 被选中的写进 `HINDSIGHT_API_LLM_API_KEY`，其余按顺序写成 `_1…_n`。 |
| 添加 key | 粘贴新 key（只存在宿主侧与 env），或从凭据库按 ref 引用。 |
| 探测 | 对池里**所有** key（含未启用的）发一次最小请求；未启用的结果会标注 `未启用`。 |
| 仅保存 | 只写 env + 备份，不重启 daemon。 |
| 保存并重启 daemon | 写 env 后 stop → 等端口关闭 → start → 轮询健康，成功后提示耗时。 |
| 重启 daemon | 不改 env，只重启。 |

策略模式：

- `round-robin`：轮流用，配额摊得最平；
- `failover`：一直用主 key，失败才换下一把；
- `metadata`：交给 Hindsight 自己按模型元数据选。

`cooldown_seconds`：某把 key 调用失败后，多少秒内排到最后（默认 120）。

---

## 它具体改了什么

只改 **受管块**，块外一个字节都不动（保留 CRLF、注释、其它环境变量）：

```ini
# >>> dsh-hindsight-keys: managed block, edit via the plugin >>>
HINDSIGHT_API_LLM_PROVIDER=opencode-go
HINDSIGHT_API_LLM_MODEL=deepseek-v4.1-flash
HINDSIGHT_API_LLM_BASE_URL=https://opencode.ai/zen/go/v1
HINDSIGHT_API_LLM_API_KEY=oc_sk_...
HINDSIGHT_API_LLM_1_PROVIDER=...
...
HINDSIGHT_API_LLM_STRATEGY={"mode":"round-robin","cooldown_seconds":120}
# <<< dsh-hindsight-keys: managed block <<<
```

- 环境文件：`${HINDSIGHT_HOME:-~/.hindsight}/profiles/${HINDSIGHT_PROFILE:-coding-agent}.env`
- 池状态：`${HINDSIGHT_HOME}/hindsight-keys.json`
- 每次写入前备份：`coding-agent.env.bak-YYYYMMDDHHMMSS`，只保留最近 10 份。

---

## HTTP 路由

挂在 DSH web 服务器上（回环），面板与外部脚本都可直接调：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/hindsight-keys/state` | 池 + 掩码后的 key + 策略 + 最近 apply/restart + `build` |
| POST | `/api/hindsight-keys/apply` | 改池/策略并写 env；`restart:true` 时随后重启 |
| POST | `/api/hindsight-keys/probe` | 探测全部（或指定 `ids`）的 key |
| POST | `/api/hindsight-keys/restart` | 只重启 daemon |
| GET | `/api/hindsight-keys/panel` | 面板 HTML |

`state` 里的 `build` 是宿主代码的构建标记（0.3.1 = `build-2026-11-19T09-00Z`）。**升级后先看这个字段**：没变说明插件代码没被重新加载，重启 DSH Desktop。

---

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `HINDSIGHT_HOME` | `~/.hindsight` | 池状态与 env 的根目录 |
| `HINDSIGHT_PROFILE` | `coding-agent` | 用哪个 profile |
| `HINDSIGHT_UVX` | `uvx` | 重启 daemon 时调用的命令 |
| `HINDSIGHT_EMBED_SPEC` | `hindsight-embed@1.1.0` | 重启时用的包 |
| `HINDSIGHT_EMBED_PYTHON` | `3.12` | `uvx --python` |
| `DSH_HOME` | 由 DSH 注入 | 安装脚本用 |

如果 daemon 不是用 `uvx … hindsight-embed daemon` 起的（例如直接跑 `uvx hindsight-api@1.2.0 --port 9077`），重启步骤会按 `HINDSIGHT_UVX`／`HINDSIGHT_EMBED_SPEC` 的配置执行，请按实际启动方式设置这两个变量。

---

## 故障排查

**探测返回 `fetch failed`（code 0，约 10 秒）**
网络层失败（DNS/代理/连接被重置），不是 key 无效。重试一次多半就恢复；持续失败请检查代理。

**探测返回 402 / `Insufficient account funds`**
key 本身有效，但账户余额不足。充值后在面板里重新启用。

**保存后仍显示未启用**
0.3.1 起，`探测` 会覆盖未启用的 key，且 `state` 回显 `enabled` 以服务端为准。如果面板显示与服务端不一致，硬刷新页面。

**日志里 `LLM member 0/1/2 failed on call: Request timed out.; trying it last for 120s`**
这是 Hindsight `multi_llm` 的正常冷却机制：某成员超时后 120 秒内排到最后，不是 key 坏了。调大 `cooldown_seconds` 或在面板里把慢 key 停用。

**daemon 重启很久（约 2～3 分钟）**
冷启动要导入 Python 包并校验数据库。0.3.1 改成「健康即成功」并轮询最多 5 分钟，面板最多等 10 分钟，不会再误报失败。

**端口**
daemon 健康检查默认 `http://127.0.0.1:9077/health`；DSH web 默认端口见启动日志。

---

## 安全模型

- 浏览器**永远拿不到明文 key**：`state` 只返回掩码（形如 `oc_sk_ab4cb6…b7f3`）与 8 位指纹；
- 面板回传 `{id,label,enabled}` 时，宿主按 `id` 复用已存的明文，不需要把 key 再送回浏览器；
- 明文只存在两处：受管的 env 文件、`hindsight-keys.json`（均为本机文件）；
- 路由无额外鉴权，依赖 DSH web 只监听 `127.0.0.1`。**如果把 DSH web 暴露到公网，请自行加反向代理与鉴权。**

---

## 开发与测试

```bash
npm test          # = node test/host-logic.test.mjs
```

13 个离线用例，全部跑在临时目录里的**合成 env fixture** 上，不读你的 `~/.hindsight`、不需要真实 key：

```
13/13 passed · 1 backup(s) in temp home
```

覆盖：从 env 迁移、受管块渲染/剥离、CRLF 保留、备份、禁用后块收缩、`applyChanges` 的增删改与主 key 迁移、weights 长度校验、空池与未知 ref 报错、指纹与掩码稳定性。

---

## 更新日志

### 0.3.1 — 2026-11-19

- **修复「启用后重启失败」的误报**：旧版以 `uvx start` 的退出码判定成功，冷启动超过 180 秒必然超时（`code:-2`），面板于是提示失败，而 daemon 其实已经起来了。改为 stop → 等端口关闭 → start → **轮询健康**，健康即成功；超时上限放宽到 5 分钟。
- **修复面板轮询窗口太短**：原来只等 2 分钟，短于实际冷启动；现在最多 10 分钟，并显示 `正在重启 daemon… Ns`。
- **修复竞态**：`restartDaemon` 开始时先同步写入 `lastRestart.status = 'running'`，面板首次轮询不会再读到 `restarting:false` 而提前放弃。
- **探测覆盖未启用的 key**：`probeAll` 不再过滤 `enabled`，未启用项标注 `disabled`，方便先探测再决定要不要启用。
- 面板提示更准确：env 无变化但要求重启时，提示「env 无变化，正在重启 daemon」。
- **不再假装重启成功**：`stop` 之后端口仍未关闭时直接报错（它可能不是由 `uvx … daemon` 启动的），而不是对着旧进程误报成功。
- `BUILD_MARKER` 更新为 `build-2026-11-19T09-00Z`。
- 测试改为合成 fixture（不再依赖作者机器的 env 路径与本地桥），13/13 通过。
- 许可证改为 Apache-2.0。

### 0.3.0

开发中的一批修复并入 0.3.1，未单独发布。

### 0.2.0 — 2026-11-05

首个可用版本：池管理、策略切换、探测、写 env + 重启。

---

## 已知限制

- **仅 Windows 实测**。重启路径里 `uvx` 用了 `shell: true` 的 Windows 分支；macOS / Linux 未验证，欢迎 PR。
- 只支持 `multi_llm` 这一种 key 池形态（`HINDSIGHT_API_LLM_*`），不处理 embedding / rerank 的独立 key。
- 面板不做鉴权（见「安全模型」）。
- daemon 冷启动慢是 Hindsight 自身导入耗时，插件只能等。

## 许可证

[Apache-2.0](./LICENSE)
