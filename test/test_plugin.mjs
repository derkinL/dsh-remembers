/**
 * 插件行为测试：用 mock ctx 模拟 DSH 调用这些钩子，服务是真的（HTTP）。
 *
 * 覆盖：profile 注入 / 召回注入 / 同内容去重 / 无命中不注入 / L0 原话写入
 *
 * 运行（服务需先起在 CMEM_URL 上）：
 *   CMEM_URL=http://127.0.0.1:18081 node test_plugin.mjs
 */

import assert from "node:assert/strict";

import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { apply, inject, name } from "../index.mjs";

const BASE = process.env.CMEM_URL || "http://127.0.0.1:18080";

// ---------------------------------------------------------------------------
// mock cordis context
// ---------------------------------------------------------------------------
const handlers = new Map();
const logs = [];
let effects = 0;

const ctx = {
  logger: { debug: (m) => logs.push(String(m)) },
  on: (event, fn) => handlers.set(event, fn),
  effect: () => { effects += 1; },
};

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

const userMsg = (text) => createUserMessage({ content: [{ type: "text", text }] });
const assistantMsg = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const decisionWith = (text) => ({ kind: "enter", messages: [userMsg(text)] });
const ok = (label, extra = "") => console.log(`  ✓ ${label}${extra ? "  " + extra : ""}`);

async function main() {
  // 服务必须先活着
  const health = await get("/health").catch(() => null);
  if (!health?.ok) {
    console.error(`服务没起来：${BASE}`);
    process.exit(1);
  }
  console.log(`服务就绪 memories=${health.stats.memories}`);

  // -------------------------------------------------------------------------
  apply(ctx, { endpoint: BASE, captureMinChars: 6 });
  console.log(`插件：${name}  inject=[${inject.join(",")}]  handlers=${[...handlers.keys()].join(",")}`);
  assert.ok(handlers.has("agent/pre-step"), "pre-step 钩子必须注册");
  assert.ok(handlers.has("agent/created"), "agent/created 钩子必须注册");
  assert.ok(handlers.has("turn/end"), "turn/end 钩子必须注册");

  // 播种：一条 L4、一条 L3
  await post("/ingest", { tier: "L4", subject: "user", text: "你叫她小宝，不许叫全名。你们约好每周日晚上聊天。" });
  await post("/ingest", { tier: "L3", subject: "user", text: "三月那次她加班到凌晨两点，打电话哭了很久，说不想干了。" });

  // -------------------------------------------------------------------------
  console.log("\n[1] 启动注入 L4");
  const injected = [];
  const session = { id: "s-plugin-test", header: {} };
  const agent = { session, status: "idle", inject: (m) => injected.push(m) };

  await handlers.get("agent/created")({ agent, source: "test" });
  assert.equal(injected.length, 1, "应该注入一条 profile");
  const profileText = injected[0].content[0].text;
  assert.match(profileText, /<dsh-remembers source="profile">/);
  assert.match(profileText, /小宝/);
  assert.equal(injected[0].source.kind, "plugin:dsh-remembers");
  ok("profile 注入", `source=${injected[0].source.kind} form=${injected[0].source.form}`);

  // 重复启动不应重复注入
  await handlers.get("agent/created")({ agent, source: "test" });
  assert.equal(injected.length, 1, "profile 只注入一次");
  ok("profile 不重复注入");

  // -------------------------------------------------------------------------
  console.log("\n[2] pre-step 召回");
  const out = await handlers.get("agent/pre-step")(
    { agent, signal: { aborted: false } },
    async () => decisionWith("她说不想干了"),
  );
  assert.equal(out.kind, "enter");
  assert.equal(out.messages.length, 2, "原消息 + 召回块");
  const recallText = out.messages[1].content[0].text;
  assert.match(recallText, /<dsh-remembers source="recall">/);
  assert.match(recallText, /加班到凌晨两点/);
  console.log("  召回块：");
  recallText.split("\n").forEach((l) => console.log("    " + l));
  ok("召回注入", `${recallText.length} 字符`);

  // 同内容去重
  const out2 = await handlers.get("agent/pre-step")(
    { agent, signal: { aborted: false } },
    async () => decisionWith("她说不想干了"),
  );
  assert.equal(out2.messages.length, 1, "同内容不应重复注入");
  ok("同内容去重");

  // 无命中不注入
  const out3 = await handlers.get("agent/pre-step")(
    { agent, signal: { aborted: false } },
    async () => decisionWith("量子纠缠退相干"),
  );
  assert.equal(out3.messages.length, 1, "无命中不应注入任何东西");
  ok("无命中不注入（诚实出口一路传到插件）");

  // subagent 会话跳过
  const subAgent = { session: { id: "sub", header: { origin: "subagent" } }, status: "idle", inject: () => {} };
  const outSub = await handlers.get("agent/pre-step")(
    { agent: subAgent, signal: { aborted: false } },
    async () => decisionWith("她说不想干了"),
  );
  assert.equal(outSub.messages.length, 1, "subagent 会话应跳过");
  ok("subagent 会话跳过");

  // -------------------------------------------------------------------------
  console.log("\n[3] 捕获原话 → L0");
  const before = (await get("/stats")).stats.memories;
  handlers.get("session/event")(session, {
    type: "user/message",
    data: userMsg("我今天加班到很晚，有点撑不住"),
  });
  handlers.get("session/event")(session, {
    type: "assistant/message",
    data: { message: assistantMsg("那先别扛了，说给我听。") },
  });
  handlers.get("turn/end")(session);
  await new Promise((r) => setTimeout(r, 1500));

  const after = (await get("/stats")).stats.memories;
  assert.equal(after, before + 1, "应写入一条 L0");
  ok("L0 写入", `${before} → ${after}`);

  const found = await post("/search", { query: "撑不住 加班", top_k: 3 });
  const raw = found.hits.find((h) => h.tier === "L0");
  assert.ok(raw, "刚写的原话应能立刻被检索到");
  assert.match(raw.text, /有点撑不住/);
  ok("原话可检索", `score=${raw.score}`);

  // 再触发一次 turn/end（空轮）不应重复写
  const mid = (await get("/stats")).stats.memories;
  handlers.get("turn/end")(session);
  await new Promise((r) => setTimeout(r, 800));
  const end = (await get("/stats")).stats.memories;
  assert.equal(end, mid, "空轮不应写入");
  ok("空轮不写入");

  // -------------------------------------------------------------------------
  console.log("\n[4] 其他");
  assert.ok(effects >= 1, "应注册清理 effect");
  ok("清理 effect 已注册", `count=${effects}`);
  const skippedLogs = logs.filter((l) => l.includes("recall_error") || l.includes("profile_error"));
  assert.equal(skippedLogs.length, 0, `不该有错误日志：${skippedLogs.join("; ")}`);
  ok("无错误日志", `共 ${logs.length} 条调试日志`);

  console.log("\n全部通过 ✅");
}

main().catch((error) => {
  console.error("\n测试失败：", error);
  process.exit(1);
});
