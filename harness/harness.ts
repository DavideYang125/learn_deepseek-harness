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
 *   chat()         → ① API 客户端 + 捕获 reasoning_content（思考过程）
 *   TOOLS + SYSTEM → ② 工具 schema + 系统提示词（agent 的人设与能力清单）
 *   executeTool()  → ③ 工具执行器（文件/命令真实生效）
 *   parseJson()    → ④ 结构化输出解析（模型输出 JSON，失败就回喂重试）
 *   saveState/load → ⑤ 状态落盘：断点续跑 + 自增上下文（"越干越聪明"的关键）
 *   maxTokens 递增 → ⑥ Token 预算递增（先小后大，越写越长）
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dirname, "workspace"); // agent 真正干活、产出文件的地方（沙箱）
const STATE_FILE = join(__dirname, "state.json"); // 每步快照，支持断点续跑
const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-reasoner"; // 可改成 deepseek-chat 对比差异
const MAX_ITER = 30; // 循环上限，防止死循环

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

// ---------- 1. API 客户端：把"思考"和"回答"分开拿回来 ----------
async function chat(messages: any[], maxTokens: number) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data: any = await res.json();
  const msg = data.choices[0].message;
  // deepseek-reasoner 会在 content 之外额外返回 reasoning_content（思考过程）
  return { content: msg.content ?? "", reasoning: msg.reasoning_content ?? "" };
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
        return out.slice(0, 8000); // 截断，防止单次输出撑爆上下文
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
      return readFileSync(join(WORKSPACE, args.path), "utf8").slice(0, 8000);
    case "list_files":
      return readdirSync(join(WORKSPACE, args.path ?? ".")).join("\n");
    default:
      return `未知工具：${name}`;
  }
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

    const { content, reasoning } = await chat(messages, maxTokens);
    // 把思考过程也存进历史（DeepSeek 官方建议回喂以延续推理思路）。
    // 若你的 API 版本不接受该字段，删掉 reasoning_content 这一行即可。
    messages.push({ role: "assistant", content, reasoning_content: reasoning });

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

    const result = executeTool(step.action.name, step.action.args);
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
