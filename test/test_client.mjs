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
// 2026-11-07 起：左边栏「插件」正下方多一条自己的入口 = 一个 main 面板
// + 一个 sidebar.panellist 图标（id 与 main 的 key 同值）。
const PANEL_ID = "dsh-remembers";
const mainEntry = () => registered.find((r) => r.meta?.name === "main" && r.meta?.key === PANEL_ID);
const panelEntry = () => registered.find((r) => r.meta?.name === "sidebar.panellist" && r.meta?.id === PANEL_ID);

ok("注册了 main 面板", () => assert.ok(mainEntry(), "找不到 main"));
ok("注册了侧栏图标", () => assert.ok(panelEntry(), "找不到 sidebar.panellist"));
ok("两者 id 一致", () => {
  assert.equal(mainEntry().meta.key, panelEntry().meta.id);
});
ok("侧栏图标排在「插件」(0) 和「自动化任务」(10) 之间", () => {
  const order = panelEntry().meta.order;
  assert.ok(order > 0 && order < 10, "order=" + order);
});
ok("侧栏图标有名字", () => {
  let label = panelEntry().meta.label;
  if (typeof label === "function") label = label();
  assert.equal(label, "她的记忆");
});
ok("没再挂 settings.section / plugins.tab", () =>
  assert.ok(registered.every((r) => r.meta?.name !== "settings.section" && r.meta?.name !== "plugins.tab")));

ok("每个入口都挂了组件函数", () =>
  assert.ok(registered.every((r) => typeof r.comp === "function")));

// ---------------------------------------------------------------- 入口页
console.log("\n[入口页]");

/** 主面板整页渲染出来的元素树。 */
function pageTree() {
  return mainEntry().comp({});
}

/** 入口页里的卡片网格（主面板外面还包了一层页面容器）。 */
function hubGrid() {
  const grid = walk(pageTree()).find((el) => el.props && el.props.className === "dshm-grid");
  assert.ok(grid, "找不到 dshm-grid");
  return grid.children[0];
}

ok("主面板外面有滚动容器", () => {
  const tree = pageTree();
  assert.ok(tree.props && tree.props.style && tree.props.style.overflowY === "auto");
});

ok("卡片一行三张", () => {
  const src = readFileSync(join(PLUGIN_ROOT, "client.js"), "utf8");
  assert.ok(src.includes("grid-template-columns:repeat(3,minmax(0,1fr))"), "不是三列");
});

ok("入口页有 9 张卡片", () => assert.equal(hubGrid().length, 9));

/** 递归找带某个 className 的最外层节点（卡片改成横排后层级不一样了）。 */
function findByClass(node, cls) {
  if (!node || typeof node !== "object") return null;
  if (node.props && node.props.className === cls) return node;
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const k of kids) {
    const hit = findByClass(k, cls);
    if (hit) return hit;
  }
  return null;
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const kids = Array.isArray(node.children) ? node.children : [];
  return kids.map(textOf).join("");
}

ok("卡片的标题和顺序对", () => {
  const titles = hubGrid().map((card) => textOf(findByClass(card, "dshm-title")));
  assert.deepEqual(titles, ["记忆", "人格设定", "表情包", "主动消息", "B 站", "贴吧", "QQ 通道", "学说话", "记忆服务"]);
});

ok("每张卡片都带说明和图标", () => {
  for (const card of hubGrid()) {
    // 第一层要么是图标块/图片，要么是横向布局里的 <img>
    const first = card.children[0];
    const isImg = first && first.type === "img";
    const tileText = first && first.props && first.props.className === "dshm-tile"
      ? textOf(first)
      : "";
    assert.ok(isImg || (tileText && tileText.length > 0), "图标缺失");
    // 说明文字：卡片里最后一段文本，长度要够
    const plain = textOf(card);
    assert.ok(plain.length > 12, "说明缺失");
    assert.equal(card.type, "button");                             // 可点
  }
});

// ---------------------------------------------------------------- 二级页
console.log("\n[二级页 / 返回按钮]");

/** 把入口页直接摆成某个二级页。 */
function renderDetail(page) {
  forcedState = page;
  return mainEntry().comp({});
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
// 标签在 data 加载完才渲染，mock 里首屏是 loading，所以查源码：
// 7 处 className="dshm-tab"（其中 TIERS 那处 map 出 6 件，共渲染 12 张）。
ok("B 站页左边工具、右边 UID/口味", () => {
  const src = readFileSync(join(PLUGIN_ROOT, "client.js"), "utf8");
  const left = src.indexOf('flex: "0 0 640px"');
  const tools = src.indexOf("她能用的 B 站工具");
  const uid = src.indexOf("你在 B 站的 UID");
  assert.ok(left > 0 && tools > left && uid > tools, "分栏顺序不对");
});
ok("记忆页的标签改成了固定卡片", () => {
  const src = readFileSync(join(PLUGIN_ROOT, "client.js"), "utf8");
  assert.ok(src.includes('className: "dshm-tabs"'), "没有标签网格");
  const n = (src.match(/className: "dshm-tab"/g) || []).length;
  assert.ok(n >= 6, "标签按钮源里有 " + n + " 处");
  assert.ok(src.includes('"data-on"'), "没有选中态标记");
  assert.ok(src.includes(".dshm-tab{height:34px"), "卡片没固定高度");
});
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
  const id = r.meta?.id ?? r.meta?.key ?? r.meta?.name;
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
