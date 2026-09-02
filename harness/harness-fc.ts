/**
 * 官方 function calling 版最小 harness —— 与 harness.ts（裸 JSON 协议）同构对照
 *
 * 两个文件跑同一个任务，对比"裸 JSON 协议 vs 官方 function calling"的 wire 差异。
 * 用法（和 harness.ts 一样，但状态文件独立为 state-fc.json，二者互不干扰）：
 *   cp .env.example .env（已建过则跳过）
 *   node --experimental-strip-types harness-fc.ts "在工作区写一个 greet.js，用 node 运行，输出 Hello FC"
 *
 * 与 harness.ts 的差异映射（协议层全变了，其余骨架一致）：
 *   ① 工具清单：提示词文字 → 请求体 tools 参数（function calling 官方通道）
 *   ② 读工具请求：parseJson(正则抠文本) → 读消息的 tool_calls 结构化字段
 *   ③ 回填工具结果：user 文本伪装 → role:'tool' + tool_call_id 精确配对
 *   ④ 结束判定：看 done:true → 看"本轮没有 tool_calls、直接输出正文"
 *   thought/action/done 在官方通道里对应：reasoning_content / tool_calls / 自然文本收尾
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dirname, "workspace");
const STATE_FILE = join(__dirname, "state-fc.json"); // 独立状态文件，不抢 harness.ts 的 state.json
const API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash"; // 可用 .env 的 DEEPSEEK_MODEL 覆盖
const MAX_ITER = 30;

// ---------- 0. 极简 .env 加载（同 harness.ts） ----------
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

// ---------- 1. 工具 schema：这次是完整 JSON Schema，直接塞进 API tools ----------
// 对比 harness.ts：那里工具以纯文字写进 SYSTEM，这里以结构化参数交给 API。
const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作目录执行 shell 命令并返回输出。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
          cwd: { type: "string", description: "工作目录，默认 workspace" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写文件到工作目录（会覆盖）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的路径" },
          content: { type: "string", description: "文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取工作目录中的文件。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出工作目录中的文件。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "子目录，默认根" } },
      },
    },
  },
];

// 系统提示词变得很薄：不再需要"可用工具 + 输出 JSON 协议"，那是 API tools 参数的职责。
const SYSTEM = `你是自主编码 agent。你的工作目录是：${WORKSPACE}
用提供的工具完成任务并验证结果。不要编造工具输出，一切以真实返回为准。`;

// ---------- 2. API 客户端：请求带 tools，返回拆出 reasoning / tool_calls ----------
async function chat(messages: any[], maxTokens: number) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
      messages,
      tools: TOOLS, // ① 工具走官方通道，不进提示词
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data: any = await res.json();
  const msg = data.choices[0].message;
  return {
    content: msg.content ?? "",
    reasoning: msg.reasoning_content ?? "",
    toolCalls: msg.tool_calls ?? [], // ② 结构化字段：id / function.name / function.arguments
  };
}

// ---------- 3. 工具执行器（与 harness.ts 一致） ----------
function executeTool(name: string, args: any): string {
  switch (name) {
    case "run_command":
      try {
        return execSync(args.command, { encoding: "utf8", cwd: args.cwd ?? WORKSPACE }).slice(0, 8000);
      } catch (e) {
        return `EXIT ${(e as any).status}\n${(e as any).stdout ?? ""}\n${(e as any).stderr ?? ""}`;
      }
    case "write_file": {
      const p = join(WORKSPACE, args.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, args.content);
      return `OK 已写入 ${args.path}（${args.content.length} 字符）`;
    }
    case "read_file":
      return readFileSync(join(WORKSPACE, args.path), "utf8").slice(0, 8000);
    case "list_files":
      return readdirSync(join(WORKSPACE, args.path ?? ".")).join("\n");
    default:
      return `未知工具：${name}`;
  }
}

// ---------- 4. 状态落盘（同 harness.ts，只是文件名不同） ----------
function saveState(state: any) { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function loadState(): any {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

// ---------- 5. 主循环：官方 function calling ----------
async function main() {
  loadDotEnv();
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填入你的 key。");
    process.exit(1);
  }
  mkdirSync(WORKSPACE, { recursive: true });

  const mission = process.argv[2] ?? "在工作区写一个 greet.js，用 node 运行，输出 Hello FC";

  let state = loadState();
  if (state) console.log("ℹ️  发现 state-fc.json，从断点继续");
  else state = {
    mission,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `任务：${mission}` },
    ],
  };
  const messages: any[] = state.messages;

  let maxTokens = 10_000;
  const GROWTH = 5_000;
  const CAP = 200_000;

  for (let i = 0; i < MAX_ITER; i++) {
    console.log(`\n── 迭代 ${i + 1}/${MAX_ITER} ──`);

    const { content, reasoning, toolCalls } = await chat(messages, maxTokens);
    if (reasoning) console.log(`💭 思考 ${reasoning.length} 字符（仅展示）`);

    // ④ 结束判定：没有 tool_calls = 模型直接给最终回答
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content });
      console.log("\n✅ 完成：", content || "（空回答）");
      saveState(state);
      break;
    }

    // ③a 回存这条 assistant 消息（含 tool_calls）。
    // DeepSeek 官方规则：含 tool_calls 的轮次必须回带 reasoning_content；纯文本轮不带（省 token）。
    messages.push({
      role: "assistant",
      content, // 纯工具调用轮 DeepSeek 的 content 是 ""，绝不能用 null
      tool_calls: toolCalls,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });

    // ③b 逐个执行本轮的所有工具调用（支持并行），结果用 tool_call_id 精确配对回填
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let result: string;
      try {
        const args = JSON.parse(tc.function?.arguments ?? "{}");
        result = executeTool(name, args);
        console.log(`🔧 ${name}(${JSON.stringify(args).slice(0, 120)})`);
      } catch (e: any) {
        result = `EXIT 参数解析失败：${e.message}`; // 参数坏了也回填，让模型自己纠正
      }
      console.log(`   → ${result.slice(0, 160).replace(/\n/g, " ")}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    saveState(state);
    maxTokens = Math.min(maxTokens + GROWTH, CAP);
  }
}

main().catch((e) => { console.error("💥 程序错误：", e); process.exit(1); });
