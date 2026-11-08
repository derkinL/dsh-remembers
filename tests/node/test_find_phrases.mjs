/**
 * find_phrases 的空结果降级（1.2.2）。
 *
 * 踩过的坑：工具描述里写的分类（接梗/吐槽/自嘲…）和语料库真实分类
 * （搞笑/可爱/抽象/燃/阴阳/破防/治愈/复古/职场/摸鱼）对不上，
 * 她按描述传 tag=接梗 会拿到 0 条 —— 看起来像「工具坏了」。
 * 现在空结果自动降级 tag+q → q-only → tag-only，并回报 fallback。
 */
import assert from "node:assert/strict";
import http from "node:http";

import { apply } from "../../index.mjs";

// 只对 q=加班 返回结果；带 tag 一律空（模拟分类不匹配）
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const tag = url.searchParams.get("tag") || "";
  const q = url.searchParams.get("q") || "";
  const items = !tag && q === "加班" ? [{ id: 1, raw: "班味", tag: "职场" }] : [];
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, items, total: items.length }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const tools = [];
const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  on: () => () => {},
  effect: (fn) => { try { fn(); } catch { /* ignore */ } },
  get: () => undefined,
  systemPrompt: { section: () => () => {} },
  tools: { register: (t) => { tools.push(t); return () => {}; } },
};
apply(ctx, { endpoint: `http://127.0.0.1:${port}` });
await new Promise((r) => setTimeout(r, 800));

const tool = tools.find((t) => t.name === "find_phrases");
assert.ok(tool, "没注册 find_phrases");

// 1) 分类对不上 + 有场景 → 降级到 q-only
const r1 = await tool.execute({ tag: "接梗", q: "加班", n: 2 });
assert.equal(r1.items.length, 1, "应该降级后拿到 1 条");
assert.equal(r1.fallback, "q-only");

// 2) 分类对得上（假服务里没结果）→ 也降级，但不报错
const r2 = await tool.execute({ tag: "搞笑", q: "加班" });
assert.equal(r2.items.length, 1);

// 3) 只给 tag 且没结果 → 原样返回，不崩
const r3 = await tool.execute({ tag: "根本不存在的分类" });
assert.equal(r3.items.length, 0);

server.close();
console.log("  ✓ tag 不匹配自动降级 q-only / 无结果不崩");
console.log("\n通过 1 / 1");
