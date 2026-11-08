/**
 * 表情包用量埋点的回归测试（1.2.1）。
 *
 * `qq_send_image` 是 dsh-onebot-qq 的工具，不是本插件注册的：
 * 只能从 assistant 消息的 tool-call 里认出「她发了哪张图」，然后 +1。
 * 原来只有模型主动调 mark_meme_used 才计数 —— 18 个会话里它只调了 6 次，
 * 实际 qq_send_image 发了 21 张，used_count 严重低估（这也是审阅时误判
 * 「表情包没人用」的直接原因）。
 */
import assert from "node:assert/strict";
import http from "node:http";

import { apply } from "../../index.mjs";

const hits = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    hits.push({ url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const hooks = new Map();
const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  on: (ev, fn) => { hooks.set(ev, fn); return () => {}; },
  effect: (fn) => { try { fn(); } catch { /* ignore */ } },
  get: () => undefined,
  systemPrompt: { section: () => () => {} },
  tools: { register: () => () => {} },
};

apply(ctx, { endpoint: `http://127.0.0.1:${port}` });
const onEvent = hooks.get("session/event");
assert.equal(typeof onEvent, "function", "没注册 session/event");

const session = { id: "onebot-private-10001" };
const assistantEvent = (toolArgs) => ({
  type: "assistant/message",
  data: {
    message: {
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "qq_send_image", arguments: JSON.stringify(toolArgs) },
        { type: "text", text: "给你看这个" },
      ],
    },
  },
});

// 1) 绝对路径（qq_send_image 实际传的就是这个）
onEvent(session, assistantEvent({ sources: ["/home/u/.dsh/media/onebot/memes/100.webp"] }));
// 2) 数组里混多个，取第一个命中的
onEvent(session, assistantEvent({ sources: ["/tmp/x.png", "/home/u/.dsh/media/onebot/memes/a b.gif"] }));
// 3) 不是表情包目录的图，不该计数
onEvent(session, assistantEvent({ sources: ["/home/u/Pictures/cat.jpg"] }));

await new Promise((r) => setTimeout(r, 400));
server.close();

const used = hits.filter((h) => h.url === "/memes/used");
assert.equal(used.length, 2, `应该记 2 次，实际 ${used.length}`);
assert.deepEqual(
  used.map((h) => JSON.parse(h.body).file),
  ["100.webp", "a b.gif"],
);

console.log("  ✓ qq_send_image → /memes/used（绝对路径 / 多来源 / 忽略非图库）");
console.log("\n通过 1 / 1");
