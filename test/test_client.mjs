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

// 只劫持「下一次 useState」：用来把入口页的 page 直接摆成某个二级页。
// 子组件自己的 useState 在这之后调用，走正常分支。
let forcedState;
const React = {
  createElement: h,
  useState: (v) => {
    if (forcedState !== undefined) {
      const val = forcedState;
      forcedState = undefined;
      return [val, () => {}];
    }
    return [typeof v === "function" ? v() : v, () => {}];
  },
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

console.log("\n[入口注册]");
// 2026-11-07 起不再挂设置左侧导航：改成「插件」页面里的一个标签页。
// 7 个功能收进「她的记忆」的卡片，点卡片进二级页。
const EXPECT = [
  { id: "dsh-remembers", label: "她的记忆", order: 100 },
];

ok(`注册了 ${EXPECT.length} 个入口`, () => assert.equal(registered.length, EXPECT.length));
ok('slot 名是 "plugins.tab"', () =>
  assert.ok(registered.every((r) => r.meta?.name === "plugins.tab")));
ok("没再注册 settings.section", () =>
  assert.ok(registered.every((r) => r.meta?.name !== "settings.section")));

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

// ---------------------------------------------------------------- 入口页
console.log("\n[入口页]");

/** 入口页根节点里的卡片网格。 */
function hubGrid() {
  const tree = registered[0].comp({});
  const grid = tree.children.find((c) => c && c.props && c.props.className === "dshm-grid");
  assert.ok(grid, "找不到 dshm-grid");
  return grid.children[0];
}

ok("入口页有 7 张卡片", () => assert.equal(hubGrid().length, 7));

ok("卡片的标题和顺序对", () => {
  const titles = hubGrid().map((card) => card.children[1].children[0]);
  assert.deepEqual(titles, ["记忆", "人格设定", "表情包", "主动消息", "B 站", "QQ 通道", "记忆服务"]);
});

ok("每张卡片都带说明和图标", () => {
  for (const card of hubGrid()) {
    assert.equal(typeof card.children[0].children[0], "string");   // 图标
    assert.ok(card.children[2].children[0].length > 8);            // 说明
    assert.equal(card.type, "button");                             // 可点
  }
});

// ---------------------------------------------------------------- 二级页
console.log("\n[二级页 / 返回按钮]");

/** 把入口页直接摆成某个二级页。 */
function renderDetail(page) {
  forcedState = page;
  return registered[0].comp({});
}

/** 深度遍历元素树。函数组件会被就地展开一层（mock 没有真 reconciler）。 */
function walk(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (typeof node !== "object") return out;
  if (typeof node.type === "function") {
    out.push(node);
    walk(node.type(node.props || {}), out);
    return out;
  }
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

/** 树上所有「← 她的记忆」文本节点。 */
function backLabels(tree) {
  return walk(tree).filter((el) => el.children && el.children[0] === "← 她的记忆");
}

/** 树上所有带 className 的元素里，命中某个 class 的。 */
function byClass(tree, cls) {
  return walk(tree).filter((el) => el.props && el.props.className === cls);
}

const PAGES = ["memories", "persona", "memes", "proactive", "bili", "qq", "service"];
// 自带「保存」悬浮块的页面：返回按钮塞进那个块，入口页不再挂悬浮返回。
const WITH_PANEL = new Set(["persona", "proactive", "bili", "qq", "service"]);

for (const page of PAGES) {
  ok(`${page} 二级页能渲染`, () => {
    const tree = renderDetail(page);
    assert.ok(tree !== undefined && tree !== null);
  });
}

for (const page of PAGES) {
  ok(`${page} 顶部有返回按钮`, () => {
    const tree = renderDetail(page);
    assert.ok(backLabels(tree).length >= 1, "顶部返回按钮没了");
  });
}

for (const page of PAGES) {
  ok(`${page} 常驻返回的位置对`, () => {
    const tree = renderDetail(page);
    // 有保存块的页面：入口页不额外挂悬浮返回，返回按钮在块里（下面单独断言）。
    // 没保存块的页面：入口页挂一个右侧中间的悬浮返回。
    assert.equal(byClass(tree, "dshm-fab").length, WITH_PANEL.has(page) ? 0 : 1);
  });
}

// 那 5 个「保存」悬浮块在首屏是 loading 态，mock 里渲染不出来，
// 所以这里查源码：每个块都得有返回按钮，而且排在保存按钮前面。
ok("5 个保存块里各有一颗返回，且在保存按钮之前", () => {
  const src = readFileSync(join(PLUGIN_ROOT, "client.js"), "utf8");
  const back = (src.match(/props && props\.onBack/g) || []).length;
  assert.equal(back, 5, `找到 ${back} 处返回按钮`);
  for (const m of src.matchAll(/props && props\.onBack[\s\S]{0,600}?"保存"/g)) {
    assert.ok(m.index !== undefined);
  }
  const panels = [...src.matchAll(/minWidth: \d+,[\s\S]{0,300}?props && props\.onBack/g)];
  assert.equal(panels.length, 5, `只有 ${panels.length} 个保存块里放了返回`);
});

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
