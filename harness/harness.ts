/**
 * 最小可运行版 deepseek-harness —— 单文件、零依赖、只为学习
 *
 * 用法（在 harness/ 目录下）：
 *   1. 复制 .env.example 为 .env，填入 DEEPSEEK_API_KEY
 *   2. 运行（Node 22.6+ 内置 TS 支持）：
 *        node --experimental-strip-types harness.ts "你的任务"
 *      或者装 tsx 后：
 *        npx tsx harness.ts "你的任务"
 *
 * 示例任务：
 *   node --experimental-strip-types harness.ts "在工作区写一个 hello.js 并用 node 运行，输出 Hello Agent"
 *
 * 概念对照（详见上级 README.md 第 7 节）：
 *   chat()         → ① API 客户端（流式 SSE：边收边打印）+ 捕获 reasoning_content（思考仅展示，不回传）
 *   TOOLS + SYSTEM → ② 工具 schema + 系统提示词（agent 的人设与能力清单）
 *   executeTool()  → ③ 工具执行器（文件/命令真实生效）
 *   parseJson()    → ④ 结构化输出解析（模型输出 JSON，失败就回喂重试）
 *   saveState/load → ⑤ 状态落盘：断点续跑 + 自增上下文（"越干越聪明"的关键）
 *   maxTokens 递增 → ⑥ Token 预算递增（先小后大，越写越长）
 *   spillIfNeeded → ⑦ 工具输出溢出：超限结果落盘，模型只看头尾预览 + 取回指引
 *   maybeCompact  → ⑧ 上下文压缩：历史超阈值时，把中段摘要成一条消息
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dirname, "workspace"); // agent 真正干活、产出文件的地方（沙箱）
const STATE_FILE = join(__dirname, "state.json"); // 每步快照，支持断点续跑
const API_URL = "https://api.deepseek.com/chat/completions";
// 2026-08 起官方模型名只有 deepseek-v4-flash（快/便宜）和 deepseek-v4-pro（更强）。
// 旧名 deepseek-chat / deepseek-reasoner 目前仍被服务端当别名接受，但已不在官方清单，随时可能下线。
const DEFAULT_MODEL = "deepseek-v4-flash"; // 可用 .env 里的 DEEPSEEK_MODEL 覆盖
const MAX_ITER = 30; // 循环上限，防止死循环

// —— 上下文管理两件套（monorepo 对应 packages/spill + packages/compaction）——
const SPILL_DIR = join(WORKSPACE, "spill"); // 超大工具输出的完整原文存这里（模型用 read_file 取回）
const MAX_INLINE = Number(process.env.SPILL_MAX_INLINE ?? 2000); // 单个工具结果超过这个字符数就 spill
const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD ?? 4000); // 估算 token 超过这个数就压缩历史
const KEEP_TAIL = 6; // 压缩时保留最近几条消息不动（模型的"短期记忆"）

// ---------- 0. 极简 .env 加载（避免引入 dotenv 依赖） ----------
function loadDotEnv() {
  const p = join(__dirname, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// ---------- 1. API 客户端：流式（SSE）——边收边打印，不再干等整段 ----------
// monorepo 对应物：agent.ts step() 的 `for await (const chunk of stream)` + BlockAssembler。
// 非流式是 `await res.json()` 一把等完；流式把回复切成小块（delta）持续推送，
// 价值 = 首字延迟（TTFT）远小于总耗时，且思考过程能实时看到。
async function chat(messages: any[], maxTokens: number) {
  const t0 = Date.now();
  let ttft: number | undefined; // time-to-first-token：第一个字到达用了多久
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
      messages,
      max_tokens: maxTokens,
      stream: true, // ① 打开流式
      stream_options: { include_usage: true }, // ⑤ 最后一块额外带 token 用量
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  if (!res.body) throw new Error("响应没有 body，无法流式读取");

  // ② SSE 解析三件套：
  //    TextDecoder(stream:true) —— 防止中文字符（多字节 UTF-8）被网络分块切成乱码
  //    buf 攒半截事件          —— 一个网络 chunk 可能只有半个 SSE 事件，攒够再处理
  //    \n\n 是事件边界          —— SSE 协议规定事件之间用空行分隔
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage: any;
  let showedReasoning = false;
  let showedContent = false;

  // ③ Node 18+ 的 res.body 是 async iterable，写法和 monorepo 的流式消费同款
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data: ")) continue; // 跳过注释行（: keep-alive）等非数据行
        const payload = line.slice(6);
        if (payload === "[DONE]") continue; // ④ 流结束哨兵
        const json = JSON.parse(payload);
        if (json.usage) usage = json.usage; // include_usage 的最后一块 choices 为空，只有用量
        const delta = json.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) {
          if (ttft === undefined) ttft = Date.now() - t0;
          if (!showedReasoning) { process.stdout.write("\n💭 "); showedReasoning = true; }
          reasoning += delta.reasoning_content;
          process.stdout.write(delta.reasoning_content); // 思考实时上屏
        }
        if (delta.content) {
          if (ttft === undefined) ttft = Date.now() - t0;
          if (!showedContent) { process.stdout.write("\n📄 "); showedContent = true; }
          content += delta.content;
          process.stdout.write(delta.content); // 正文实时上屏
        }
      }
    }
  }
  process.stdout.write("\n");
  // V4 系列 thinking 模式默认开启，会在 content 之外额外返回 reasoning_content（思考过程）
  return { content, reasoning, usage, ttft: ttft ?? -1, total: Date.now() - t0 };
}

// ---------- 2. 工具 schema + 系统提示词 ----------
const TOOLS = [
  { name: "run_command", description: "在工作目录执行 shell 命令并返回输出。", args: { command: "string", cwd: "string?" } },
  { name: "write_file", description: "写文件到工作目录（会覆盖）。", args: { path: "string", content: "string" } },
  { name: "read_file", description: "读取工作目录中的文件。", args: { path: "string" } },
  { name: "list_files", description: "列出工作目录中的文件。", args: { path: "string?" } },
];

const SYSTEM = `
你是自主编码 agent。你的工作目录是：${WORKSPACE}
可用工具：${JSON.stringify(TOOLS)}
每次只输出一个 JSON 对象，不要输出任何其他文字：
{"thought":"这一步我在想什么","action":{"name":"工具名","args":{...}},"done":false}
任务完成时输出：{"thought":"总结","action":null,"done":true}
`;

// ---------- 3. 工具执行器：失败也返回内容，绝不抛异常 ----------
function executeTool(name: string, args: any): string {
  switch (name) {
    case "run_command":
      try {
        const out = execSync(args.command, { encoding: "utf8", cwd: args.cwd ?? WORKSPACE });
        return out; // 不在这里截断——超限与否交给统一的 spill 策略（见 spillIfNeeded）
      } catch (e) {
        // 关键：失败返回 stderr 而非抛异常，让模型"看到错误并自我修复"
        return `EXIT ${(e as any).status}\n${(e as any).stdout ?? ""}\n${(e as any).stderr ?? ""}`;
      }
    case "write_file": {
      const p = join(WORKSPACE, args.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, args.content);
      return `OK 已写入 ${args.path}（${args.content.length} 字符）`;
    }
    case "read_file":
      return readFileSync(join(WORKSPACE, args.path), "utf8"); // 限量策略同样交给 spillIfNeeded
    case "list_files":
      return readdirSync(join(WORKSPACE, args.path ?? ".")).join("\n");
    default:
      return `未知工具：${name}`;
  }
}

// ---------- 3b. 工具输出 spill：超限的完整输出落盘，模型只看"头尾预览 + 取回指引" ----------
// monorepo 对应物：packages/spill/spill-policy（tools/post-execute 结果转换器）。
// 旧版是 result.slice(0, 8000)：尾巴被静默丢弃，模型既看不全、也不知道丢了东西。
// spill 版：完整原文写进 workspace/spill/，模型拿到头尾预览 + 文件名，需要细节时自己 read_file 取回。
function spillIfNeeded(name: string, output: string): string {
  if (output.length <= MAX_INLINE) return output;
  // read 工具豁免：如果 read_file 的结果也 spill，模型为了看全得去 read 溢出文件，
  // 结果又超限又 spill…… 死循环。monorepo 对 read 有完全相同的豁免（read 自行负责限量）。
  if (name === "read_file") return output.slice(0, 8000);
  mkdirSync(SPILL_DIR, { recursive: true });
  const fname = `spill-${Date.now().toString(36)}-${name}.txt`;
  writeFileSync(join(SPILL_DIR, fname), output);
  const head = output.slice(0, Math.floor(MAX_INLINE / 2));
  const tail = output.slice(-Math.floor(MAX_INLINE / 2));
  return `${head}\n…（中间省略 ${output.length - MAX_INLINE} 字符）…\n${tail}\n[完整输出已存到 workspace/spill/${fname}，需要细节时用 read_file 读取该文件]`;
}

// ---------- 4. 结构化输出解析：鲁棒 + 失败可回喂重试 ----------
function parseJson(raw: string): any {
  const m = raw.match(/\{[\s\S]*\}/); // 粗暴抓取第一个 JSON 块（容忍 ```json 包裹或前后废话）
  if (!m) throw new Error("输出里没有 JSON 对象");
  const obj = JSON.parse(m[0]);
  if (!("done" in obj)) throw new Error("缺少 done 字段");
  return obj;
}

// ---------- 5. 状态落盘：断点续跑 / 自增上下文 ----------
function saveState(state: any) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function loadState(): any {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

// ---------- 5b. 上下文压缩：历史太长时，把中段摘要成一条消息（monorepo: packages/compaction）----------
// 触发时机和 monorepo 一致：发请求之前检查（它的 pressure 触发挂在 agent/pre-step）。
// 动作：保留 [0]system、[1]任务、最近 KEEP_TAIL 条，中段交给一次独立的摘要 LLM 调用，
// 替换成一条 user 消息。摘要失败不致命——原样发送，下轮再试（尽力而为，同 monorepo 容错哲学）。

// 粗略 token 估算：中文约 2 字符/token、英文约 4 字符/token，折中除 2。
// monorepo 用真正的 tokenMeter；教学版一个除法就够说明问题。
function estimateTokens(messages: any[]): number {
  return Math.ceil(messages.reduce((n, m) => n + String(m.content ?? "").length, 0) / 2);
}

async function summarize(text: string): Promise<string> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "你是对话压缩器。把输入的 agent 工作记录压缩成不超过 300 字的要点，必须保留：任务目标、已完成的事、关键文件名/命令/结论、未完成的事。直接输出要点。",
        },
        { role: "user", content: text },
      ],
      max_tokens: 1000,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`摘要 API ${res.status}`);
  return (await res.json()).choices[0].message.content;
}

async function maybeCompact(messages: any[]) {
  const before = estimateTokens(messages);
  if (before < COMPACT_THRESHOLD) return;
  const body = messages.slice(2, -KEEP_TAIL); // 中段（保留 system、任务、尾部）
  if (body.length === 0) return;
  try {
    const text = body.map((m: any) => `[${m.role}] ${m.content}`).join("\n\n");
    const summary = await summarize(text);
    messages.splice(2, body.length, {
      role: "user",
      content: `[早期进展摘要（系统自动压缩，替代之前 ${body.length} 条消息）]\n${summary}`,
    });
    console.log(`🗜️  上下文压缩：${body.length} 条消息 → 1 条摘要（估算 ${before} → ${estimateTokens(messages)} tokens）`);
  } catch (e: any) {
    console.log(`🗜️  压缩失败（${e.message}），本轮原样发送`);
  }
}

// ---------- 6. 主循环：整个 agent 的心脏 ----------
async function main() {
  loadDotEnv();
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填入你的 key。");
    process.exit(1);
  }
  mkdirSync(WORKSPACE, { recursive: true });

  const mission = process.argv[2] ?? "在工作区写一个 hello.js，用 node 运行，输出 Hello Agent";

  // 断点续跑：有 state.json 就接着上次继续（想重来就删掉 state.json）
  let state = loadState();
  if (state) {
    console.log("ℹ️  发现 state.json，从断点继续");
  } else {
    state = {
      mission,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `任务：${mission}` },
      ],
    };
  }
  const messages: any[] = state.messages;

  // Token 预算递增：前几轮小，后面越来越大，模型才敢铺开写长代码
  let maxTokens = 10_000;
  const GROWTH = 5_000;
  const CAP = 200_000;

  for (let i = 0; i < MAX_ITER; i++) {
    console.log(`\n── 迭代 ${i + 1}/${MAX_ITER} ──`);

    await maybeCompact(messages); // 发请求前检查压力，超阈值就把旧历史压成摘要

    // 思考与正文已在 chat() 里实时流式打印，这里只补一行"体检数据"
    const { content, reasoning, usage, ttft, total } = await chat(messages, maxTokens);
    console.log(
      `⚡ 首字 ${ttft}ms ／ 总 ${total}ms ｜ 💭 ${reasoning.length} 字 ｜ 📊 tokens 输入 ${usage?.prompt_tokens ?? "?"} + 输出 ${usage?.completion_tokens ?? "?"}`,
    );
    // 注意：DeepSeek API 不允许把 reasoning_content 放进输入消息（会返回 400）。
    // 官方做法是只回传 content 保持上下文连贯，思考过程不回传。
    messages.push({ role: "assistant", content });

    let step: any;
    try {
      step = parseJson(content);
    } catch (e: any) {
      // 解析失败：把错误回喂给模型，让它自己纠正，而不是杀掉程序
      messages.push({ role: "user", content: `你的输出无法解析：${e.message}。请只输出合法 JSON。` });
      continue;
    }

    console.log("🤔", step.thought ?? "");
    if (step.done) {
      console.log("\n✅ 完成：", step.thought ?? "（无总结）");
      saveState(state);
      break;
    }
    if (!step.action?.name) {
      messages.push({ role: "user", content: "done 为 false 但缺少 action，请给出要调用的工具。" });
      continue;
    }

    // 执行后统一过 spill 策略（monorepo 是 post-execute 转换器，不写死在每个工具里）
    const result = spillIfNeeded(step.action.name, executeTool(step.action.name, step.action.args));
    console.log(`🔧 ${step.action.name} → ${result.slice(0, 160).replace(/\n/g, " ")}`);
    messages.push({ role: "user", content: `工具 ${step.action.name} 返回：\n${result}` });

    saveState(state); // 每轮落盘 → 可中断、可续跑、上下文持续增长
    maxTokens = Math.min(maxTokens + GROWTH, CAP);
  }
}

main().catch((e) => {
  console.error("💥 程序错误：", e);
  process.exit(1);
});
