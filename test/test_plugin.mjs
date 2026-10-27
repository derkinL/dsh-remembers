/**
 * 主机半边测试（index.mjs）：apply() 之后到底注册了什么。
 *
 * 不需要记忆服务在跑 —— MemoryClient 只在真正调用时才发请求。
 * 运行：node test/test_plugin.mjs
 */
import assert from "node:assert/strict";

import { apply, inject, name } from "../index.mjs";

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try {
    fn();
    pass += 1;
    console.log("  ✓ " + label);
  } catch (e) {
    fail += 1;
    console.log("  ✗ " + label + "\n      " + String(e.message).split("\n")[0]);
  }
}

// ---------------------------------------------------------------- 模块协议
console.log("\n[模块协议]");
ok("name 是 dsh-remembers", () => assert.equal(name, "dsh-remembers"));
ok("inject 声明了 agents / sessions", () =>
  assert.deepEqual([...inject].sort(), ["agents", "sessions"]));
ok("apply 是函数", () => assert.equal(typeof apply, "function"));

// ---------------------------------------------------------------- 造 mock ctx
const sections = [];
const tools = [];
const hooks = new Map();
const logs = [];

const ctx = {
  logger: {
    debug: (m) => logs.push(String(m)),
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
  },
  on: (ev, fn) => { hooks.set(ev, fn); return () => {}; },
  effect: (fn) => { try { fn(); } catch (e) { logs.push("effect_failed: " + e.message); } },
  get: () => undefined,
  systemPrompt: { section: (spec) => { sections.push(spec); return () => {}; } },
  tools: { register: (t) => { tools.push(t); return () => {}; } },
};

apply(ctx, { endpoint: "http://127.0.0.1:8081" });

// ---------------------------------------------------------------- 系统提示段
console.log("\n[系统提示段]");
ok("注册了 1 个 section", () => assert.equal(sections.length, 1));
ok("section 名是 remembers:persona", () =>
  assert.equal(sections[0]?.name, "remembers:persona"));
ok("section order 是 5", () => assert.equal(sections[0]?.order, 5));
ok("section 文本非空", () =>
  assert.ok(String(sections[0]?.text || "").length > 0));

// ---------------------------------------------------------------- 钩子
console.log("\n[钩子]");
for (const ev of ["agent/created", "agent/session-start", "agent/pre-step", "session/event"]) {
  ok(`注册了 ${ev}`, () => assert.equal(typeof hooks.get(ev), "function"));
}

// ---------------------------------------------------------------- 工具（异步注册）
// 工具是 await import(@deepseek-ai/dsh-tools) 之后才注册的，给点时间
await new Promise((r) => setTimeout(r, 800));

console.log("\n[工具]");
const EXPECT_TOOLS = [
  "bili_feed", "add_my_action", "bili_comment", "bili_run", "bili_watch",
  "find_meme", "learn_meme", "mark_meme_used",
  "create_task", "complete_task", "write_note", "learn_word",
  "read_diary", "read_activities", "set_my_activity", "persona_update",
];
ok(`注册了 ${EXPECT_TOOLS.length} 个工具`, () =>
  assert.equal(tools.length, EXPECT_TOOLS.length));

const got = tools.map((t) => t?.name).sort();
ok("工具名集合一致", () =>
  assert.deepEqual(got, [...EXPECT_TOOLS].sort()));

for (const t of tools) {
  if (!t) continue;
  if (!t.description || String(t.description).length < 10) {
    fail += 1;
    console.log(`  ✗ 工具 ${t.name} 描述太短`);
  }
}
ok("每个工具都有描述", () => assert.ok(tools.every((t) => t?.description)));
ok("每个工具都有 execute", () => assert.ok(tools.every((t) => typeof t?.execute === "function")));

// learn_word 必须强调「带意义」—— 上一轮修的重点，别改回去
const learnWord = tools.find((t) => t?.name === "learn_word");
ok("learn_word _description 要求带 meaning", () =>
  assert.ok(/必须把意思一起记下来|必须带 meaning/.test(String(learnWord?.description || ""))));

// bili_comment 不该再说「先 dry」
const biliComment = tools.find((t) => t?.name === "bili_comment");
ok("bili_comment 描述里没有把 dry 设成必做", () =>
  assert.ok(!/先\s*dry\s*一次/.test(String(biliComment?.description || ""))));

// ---------------------------------------------------------------- 结果
console.log(`\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log("有失败项");
  process.exit(1);
}
