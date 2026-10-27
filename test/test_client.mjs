/**
 * 浏览器半边测试（client.js）：模块协议 + 7 个设置段的注册面。
 *
 * 不跑真 React，用 minimal mock 把 client.js 的执行路径走通。
 * 运行：node test/test_client.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const code = readFileSync(join(PLUGIN_ROOT, "client.js"), "utf8");

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

// ---------------------------------------------------------------- mock 环境
const registered = [];
let loadDef = null;

const h = (type, props, ...kids) => ({ $$typeof: "el", type, props, children: kids });
const React = {
  createElement: h,
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
  Fragment: "Fragment",
};

const windowMock = {
  __ModuleLoader__: { load: (def) => { loadDef = def; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  location: { hostname: "127.0.0.1", pathname: "/", protocol: "http:", host: "127.0.0.1:49801" },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.window = windowMock;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  head: { appendChild: () => {} },
  addEventListener: () => {},
  body: { appendChild: () => {} },
};
globalThis.localStorage = windowMock.localStorage;

const req = (m) => {
  if (m === "react") return React;
  throw new Error("unexpected require: " + m);
};

new Function("window", "document", "localStorage", "require", code)(
  globalThis.window, globalThis.document, globalThis.localStorage, req,
);

// ---------------------------------------------------------------- 模块协议
console.log("\n[模块协议]");
ok("调用了 __ModuleLoader__.load", () => assert.ok(loadDef));
ok('id 是 "dsh-remembers"', () => assert.equal(loadDef.id, "dsh-remembers"));
ok("factory 是函数", () => assert.equal(typeof loadDef.factory, "function"));

const exportsObj = loadDef.factory(req);
ok("导出 apply", () => assert.equal(typeof exportsObj.apply, "function"));
ok('inject 声明了 slots', () => assert.deepEqual([...exportsObj.inject], ["slots"]));

// ---------------------------------------------------------------- 注册设置段
const slotsMock = {
  inject: (_n, fn) => fn(),
  register: (meta, comp) => { registered.push({ meta, comp }); return { dispose() {} }; },
};
const ctx = {
  get: (n) => (n === "slots" ? slotsMock : undefined),
  on: () => {},
  effect: (fn) => fn(),
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};
exportsObj.apply(ctx);

console.log("\n[设置段]");
// 当前是 7 段（API设置 / 人格 / 表情包 / 主动消息 / QQ通道 / B站 / 记忆）
// 原来这里断言 1，后来加了 6 个页签没同步 —— 就是那个红灯。现在跟实际一致。
const EXPECT = [
  { id: "dsh-remembers", label: "记忆服务 API 设置", order: 32 },
  { id: "dsh-remembers-persona", label: "人格设定", order: 33 },
  { id: "dsh-remembers-memes", label: "表情包", order: 35 },
  { id: "dsh-remembers-proactive", label: "主动消息", order: 36 },
  { id: "dsh-remembers-qq", label: "QQ 通道", order: 365 },
  { id: "dsh-remembers-bili", label: "B 站", order: 37 },
  { id: "dsh-remembers-memories", label: "记忆", order: 38 },
];

ok(`注册了 ${EXPECT.length} 个设置段`, () => assert.equal(registered.length, EXPECT.length));
ok('slot 名都是 "settings.section"', () =>
  assert.ok(registered.every((r) => r.meta?.name === "settings.section")));

for (const want of EXPECT) {
  const hit = registered.find((r) => r.meta?.id === want.id);
  ok(`有 ${want.id}（order=${want.order}）`, () => {
    assert.ok(hit, `找不到 id=${want.id}`);
    assert.equal(hit.meta.order, want.order);
    let label = hit.meta.label;
    if (typeof label === "function") label = label();
    assert.equal(label, want.label);
  });
}

ok("每个段都挂了组件函数", () =>
  assert.ok(registered.every((r) => typeof r.comp === "function")));

// ---------------------------------------------------------------- 组件能建树
console.log("\n[组件可渲染性]");
for (const r of registered) {
  const id = r.meta?.id;
  ok(`${id} 能产出元素树不抛错`, () => {
    const tree = r.comp({});
    assert.ok(tree !== undefined && tree !== null);
  });
}

// ---------------------------------------------------------------- 结果
console.log(`\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log("有失败项");
  process.exit(1);
}
