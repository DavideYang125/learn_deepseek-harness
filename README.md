# 学习 deepseek-harness —— 完整学习文档

> 本目录是你的学习专区，配套一个**可运行的最小版 harness**（[`harness/harness.ts`](harness/harness.ts)）和一个**进度打卡文档**（[`学习进度.md`](学习进度.md)）。
> 学完概念 → 读最小版 → 跑实践 → 再回去读你项目 `../deepseek-harness` 的 monorepo 源码，一路打通。

---

## 目录

1. [这份文档怎么用](#1-这份文档怎么用)
2. [deepseek-harness 是什么](#2-deepseek-harness-是什么)
3. [核心功能清单](#3-核心功能清单)
4. [核心技术拆解](#4-核心技术拆解)
5. ["自进化"到底是怎么回事](#5-自进化到底是怎么回事)
6. [总架构图](#6-总架构图)
7. [从零手写最小版：逐段讲解 + 实践](#7-从零手写最小版逐段讲解--实践)
8. [结合你当前项目：monorepo 映射表](#8-结合你当前项目monorepo-映射表)
9. [学习路线（按周）](#9-学习路线按周)
10. [参考资料](#10-参考资料)

---

## 1. 这份文档怎么用

- **第 2~6 节**：概念层。先读，建立正确心智模型。
- **第 7 节**：动手层。最小版 harness 每个部分都标注了对应概念，每节带一个 `实践 N`，**建议边读边跑**。
- **第 8 节**：对照层。把你的 monorepo 真实路径填进映射表，逐包阅读。
- **第 9 节**：节奏。按周推进，进度记在[`学习进度.md`](学习进度.md)。
- 全程用一句话提醒自己：**harness 是你写的确定性代码（循环/解析/执行/落盘），agent 是模型在 harness 约束下的行为。你学的是把"约束框架"做扎实。**

---

## 2. deepseek-harness 是什么

它最初是 Peter Steinberger（GitHub: `steipete/deepseek-harness`）做的一个**单文件自主编码 Agent**——用约 1000 行 TypeScript，只调用 DeepSeek Reasoner（R1 系）API，实现一个能自己写代码、跑测试、反复修 bug 直到完成目标的 agent 循环。

出圈卖点就两个词：**self-evolving（自进化）** 和 **self-enlarging context（自增上下文）**。它证明了：不需要复杂框架，一个简单循环 + 一个强推理模型就能做出很聪明的 agent。

**你现在项目里的 `../deepseek-harness` 是这个项目的现代版 monorepo**（`packages/`、`apps/`、`native/` 等），把当年单文件里的职责拆成了几十个子包。概念是相通的——所以先学单文件的最小版，再看 monorepo 怎么把它工程化。

---

## 3. 核心功能清单

| 功能 | 说明 | 在最小版里的位置 |
|---|---|---|
| **Agentic 循环** | 思考 → 选工具 → 执行 → 观察 → 再思考，直到 `done` | `main()` 的 for 循环 |
| **工具执行** | 真实操作文件系统和进程：`read_file` / `write_file` / `run_command` / `list_files` | `executeTool()` |
| **代码验证闭环** | 写完代码立刻编译/运行，把报错喂回给模型修 | `run_command` + 结果回填 |
| **自增上下文** | 每步把完整状态序列化到磁盘，模型"记不住"靠重新读盘"回忆" | `saveState()` / `loadState()` |
| **Token 预算递增** | 每次迭代可输出 token 数递增，越写越长 | `maxTokens += GROWTH` |
| **断点续跑** | 状态落盘，中断/重启后接着干 | `state.json` |
| **自进化（跨会话）** | 把经验写进学习文件，下次运行自动加载 | 第 7 节 实践 6 |
| **推理内容捕获** | 专门处理 DeepSeek Reasoner 的 `reasoning_content` 思考过程 | `chat()` 返回值 |

---

## 4. 核心技术拆解

1. **手工实现的 tool-use 循环（agentic loop）**——不用任何框架，核心就一个 `while`/`for` 循环。这是最容易低估、也最值得学透的部分。
2. **状态序列化（state-on-disk）**——"自增上下文"的真正原理，全项目最值得抄的一招：**把内存当外存用**。上下文窗口有限，但磁盘无限；模型只需记住"关键文件在哪"，需要时 `read_file` 读回来。
3. **结构化输出 + 鲁棒解析**——强制模型输出 JSON，解析失败就把错误回喂让它自己纠正（而不是崩掉程序）。
4. **针对 DeepSeek Reasoner 的提示词工程**——处理 `reasoning_content`、角色管理、思考回喂。
5. **动态 token 预算**——把"一次性给足"改成"越写越多"，前几轮不敢铺开写，后面才敢写大段代码。

---

## 5. "自进化"到底是怎么回事

**它没有、也不需要训练/微调模型。** 所谓 self-evolving 是三个层面的**程序级进化**，要分清：

| 层面 | 机制 | 效果 |
|---|---|---|
| **运行时上下文进化** | 状态文件越来越大，后续步骤知道的事越来越多 | 一次任务内"越干越聪明" |
| **源码自修改** | 提示词里包含 harness 自身源码，明确告诉模型"你可以改我" | 能给自己加新工具、修 bug，改完下一轮生效 |
| **跨会话经验积累** | 完成任务后把经验写入文件，下次运行注入提示词 | 第二次跑同类任务明显更稳 |

**一句话：它是"程序会自己改自己 + 把经验记下来"，不是"模型权重自己变"。** 这是必须建立的第一条正确预期。

---

## 6. 总架构图

```
┌────────────────────────────────────────────────────────┐
│  HARNESS（你自己写的 ~150 行代码，即 harness/harness.ts）│
│                                                        │
│   ┌─────────┐   messages   ┌──────────────────────┐   │
│   │ main    │ ────────────►│  DeepSeek Reasoner   │   │
│   │ loop    │ ◄────────────│  reasoning_content   │   │
│   └────┬────┘   content     │  + content + done    │   │
│        │                    └──────────────────────┘   │
│        ▼                                               │
│   ┌─────────┐  JSON {thought, action, done}            │
│   │ parseJson│──失败─► 错误回喂给模型重试               │
│   └────┬────┘                                          │
│        ▼                                               │
│   ┌─────────┐  工具调用                                  │
│   │ execute │──► 沙箱: workspace/ + state.json + 进程  │
│   └─────────┘                                          │
└────────────────────────────────────────────────────────┘
         ▲ 自进化方向（实践 6）：经验文件 + harness 自身源码
```

数据流一句话：`messages(含历史) → LLM → {thought, action, done} → 执行 → 结果回填 messages → 下一轮`。

---

## 7. 从零手写最小版：逐段讲解 + 实践

最小版已经写好，见 [`harness/harness.ts`](harness/harness.ts)。**先跑通再看代码，效果最好：**

```bash
cd harness
# 1) 复制 .env.example 为 .env 并填入 key
cp .env.example .env
# 2) 运行一个简单任务
node --experimental-strip-types harness.ts "在工作区写一个 hello.js，用 node 运行，输出 Hello Agent"
```

> Node 22.6+ 可直接跑 `.ts`（上面这个命令就行）；也可以 `npm i` 后 `npx tsx harness.ts`。
> 注意：**想重跑新任务就删掉 `state.json`**，否则会从断点继续。

### ① API 客户端（`chat()`）
只做一件事：调 DeepSeek，把 `content`（回答）和 `reasoning_content`（思考）分开拿回。后一个字段是 Reasoner 专属，也是后面"思考回喂"的前提。

> 🛠️ **实践 1**：跑一个简单任务，观察日志里 `🤔` 打印的思考与最终回答的区别。在 `.env` 里设 `DEEPSEEK_MODEL=deepseek-v4-pro` 再跑一次，对比行为差异。（注：`deepseek-chat`/`deepseek-reasoner` 旧名已于 2026-07-24 后停用，现在统一用 `deepseek-v4-flash`/`deepseek-v4-pro`）

### ② 工具 schema + 系统提示词（`TOOLS` / `SYSTEM`）
模型不能直接"用工具"，它只能**描述**想用什么工具、传什么参数。`TOOLS` 是能力清单，`SYSTEM` 是把它"包装成人设 + 输出协议"。**协议（JSON 格式）是你完全自己掌控的，这是学会"协议设计"的最好入口。**

> 🛠️ **实践 2**：临时注释掉 `executeTool` 的调用，只打印模型返回的 JSON。你会看到它"想动但动不了"——协议已通，执行未接。

### ③ 工具执行器（`executeTool()`）
让 agent 真的能读写文件、跑命令。两个工程要点：
- **失败返回内容而不是抛异常**——抛异常会杀死循环，返回 stderr 才能让模型看到错误并自我修复。
- **输出截断**（`.slice(0, 8000)`）——否则一次 `run_command` 的输出就能撑爆上下文。

> 🛠️ **实践 3**：故意让任务"写一个编译报错的 .ts 文件并验证编译"，亲眼看它走完"写→错→看报错→修→对"的闭环。这是 agent 最核心的体验。

### ④ 结构化输出解析（`parseJson()`）
模型常输出 ```json 包裹、前后带废话。粗暴抓第一个 `{}` 块即可，解析失败就把错误作为 user 消息回喂，让它自己纠正。

> 🛠️ **实践 4**：在 `parseJson` 里 `throw` 一个假错误，观察主循环是"回喂重试"而不是退出。这是健壮性分水岭。

### ⑤ 状态落盘（`saveState` / `loadState`）——最值得学的一招
每轮把 `messages` 全量写进 `state.json`。于是：
- **断点续跑**：中途崩了，重启读回继续；
- **等效无限上下文**：模型不必把海量内容全塞进上下文，只需记住"写在哪了"，要用时 `read_file` 读回来。

> 🛠️ **实践 5**：跑长任务到一半 Ctrl+C，重新运行，确认从断点继续。再观察 `state.json` 内容结构。

### ⑥ Token 预算递增（`maxTokens`）
`10_000 → 每轮 +5_000 → 封顶 200_000`。模型前几轮不敢铺开写，后面才敢写大段代码。

> 🛠️ **实践 6（自进化，需自己动手）**：加一个 `write_learning` 工具把经验追加进 `LEARNINGS.md`，下次启动时把 `LEARNINGS.md` 注入 `SYSTEM`。再挑战：把工具清单改成数据驱动（`tools.json`），让模型给自己加一个 `grep` 工具并下一轮生效——你就亲手复现了"源码自修改"。

---

## 8. 结合你当前项目：monorepo 映射表

你的 `../deepseek-harness` 是 monorepo（pnpm workspace），把单文件职责拆成了多个子包。**最小版每个概念在 monorepo 里都有对应包。** 下面路径按当前仓库实际结构列出，阅读时以 `ls` 确认为准。

| 最小版概念 | monorepo 里的包 | 怎么找重点 |
|---|---|---|
| 主循环 | `packages/core/agent-loop/` | 读它的 loop 源码，找和最小版 `main()` 对应的循环 |
| 系统提示词 | `packages/core/system-prompt/` | 看它如何拼装人设 + 协议 |
| 工具 schema / 执行 | `packages/core/tools/`、`packages/shell/`、`packages/code-runtime/` | tools 定义能力，shell/code-runtime 是执行后端 |
| LLM 客户端 + reasoning | `packages/llm/llm-deepseek/` | 看 DeepSeek provider 怎么处理 `reasoning_content` |
| 会话 / 状态 / 存储 | `packages/session/`、`packages/core/session/`、`packages/storage/` | 对应 `state.json` 的工程化版本 |
| 自增上下文（spill） | `packages/spill/`（`spill/`、`spill-local/`、`spill-policy/`）、`packages/context/`、`packages/compaction/` | **重点**：spill = "工具结果外溢到存储"——正是最小版"上下文增长"的升级版 |
| 沙箱 / 代码运行 | `packages/sandbox/`、`packages/native/landlock-run/` | 对应 `workspace/`，只是加了隔离 |
| 子任务 / 规划 | `packages/subagent/`、`packages/workflow/`、`packages/todo/`、`packages/plan/` | 最小版没有，是它的能力扩展 |
| 反馈 / 学习 | `packages/feedback/` | 对应"经验积累"方向 |
| 工具生态 | `packages/mcp/`、`packages/lsp/` | MCP/LSP 工具接入 |
| CLI 入口 | `apps/cli/`、`packages/host/` | 从入口看整个系统怎么被拉起 |

**建议对照学法**：以"最小版概念 → monorepo 包 → 具体文件"为路径，每个包回答三个问题：它被谁调用？输入输出是什么？删掉它会怎样？——然后用它替换到第 6 节的架构图里，你会看到一张更完整的图。

---

## 9. 学习路线（按周）

| 周 | 目标 | 任务 | 验收 |
|---|---|---|---|
| **第 1 周** | 跑通 API + 协议 | 实践 1、2；读 2~6 节 | 能画出数据流图；跑通一次对话 |
| **第 2 周** | 完整闭环 | 实践 3、4；读最小版全部代码 | 跑通"写→错→修→对"闭环；理解错误回喂 |
| **第 3 周** | 状态与上下文 | 实践 5；读 `state.json` 与 Token 预算逻辑 | 断点续跑成功；能讲清"内存当外存用" |
| **第 4 周** | 自进化 | 实践 6；读 `packages/spill/` | 亲手加出 `LEARNINGS` 或自加工具 |
| **第 5 周+** | 对照 monorepo | 第 8 节映射表逐包阅读 | 填完映射表，能给 monorepo 讲"这一包对应最小版哪一段" |

进度全部记录在 [`学习进度.md`](学习进度.md)，每完成一项就打勾。

---

## 10. 参考资料

- **原版**：`steipete/deepseek-harness`（GitHub）——当年那个单文件，读它的代码注释，很多 design decision 写得坦诚
- **DeepSeek API 文档**：`api-docs.deepseek.com`——重点读 `reasoning_content`、`max_tokens`、thinking 模式（low/high/max effort）、以及 `/updates` 变更日志（模型名变更第一时间看这里）
- **Anthropic《Building effective agents》**——讲清 "workflow vs agent"，所有 agent 架构入门必读
- **ReAct 论文**（Yao et al.）——"思考-行动-观察"模式原始出处，本 harness 的循环就是它的工程化
- **Tool use / function calling 文档**——工具协议设计的通用做法
- **本地 monorepo**：`../deepseek-harness/README.md` 及其各包 `README`——最好的"进阶到工程化"素材
