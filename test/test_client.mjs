/**
 * client.js 的离线验证。
 *
 * 不用真浏览器：mock 掉 window.__ModuleLoader__、react 和 ctx，
 * 确认三件事：
 *   1. 模块协议形状对（load({id, factory})，factory(require) 返回 exports）
 *   2. exports.apply / exports.inject 存在且 inject 含 slots
 *   3. apply(ctx) 真的调了 slots.register("settings.section", 组件)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const source = fs.readFileSync(path.join(HERE, "..", "client.js"), "utf8");

// ---- mock 环境 -----------------------------------------------------------
let captured = null;

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
};

const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (mod) => { captured = mod; },
    },
    localStorage: {
      _d: {},
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
    },
    console,
    fetch: async () => { throw new Error("no network in test"); },
  },
  console,
  fetch: async () => { throw new Error("no network in test"); },
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

// ---- 1. 模块协议 ---------------------------------------------------------
assert.ok(captured, "没有调用 window.__ModuleLoader__.load");
assert.equal(captured.id, "dsh-remembers", "模块 id 不对");
assert.equal(typeof captured.factory, "function", "factory 不是函数");
console.log("  ✓ 模块协议：load({id, factory})，id=" + captured.id);

const requireMock = (name) => {
  if (name === "react") return fakeReact;
  throw new Error("unexpected require: " + name);
};
const exportsObj = captured.factory(requireMock);

// ---- 2. 导出面 -----------------------------------------------------------
assert.equal(typeof exportsObj.apply, "function", "exports.apply 缺失");
assert.ok(Array.isArray(exportsObj.inject), "exports.inject 缺失");
assert.ok(exportsObj.inject.includes("slots"), "inject 里没有 slots");
console.log("  ✓ 导出面：apply() + inject=[" + exportsObj.inject.join(", ") + "]");

// ---- 3. apply 注册设置段 -------------------------------------------------
const registered = [];
const ctx = {
  get: (name) => (name === "slots"
    ? {
        inject: (slotName, thunk) => {
          // 模拟 DSH：投影时才求值
          thunk();
        },
        register: (meta, component) => {
          registered.push({ meta, component });
          return { dispose() {} };
        },
      }
    : undefined),
};

exportsObj.apply(ctx);

assert.equal(registered.length, 1, "应该注册 1 个设置段，实际 " + registered.length);
const { meta, component } = registered[0];
assert.equal(meta.name, "settings.section", "slot 名不对");
assert.equal(meta.id, "dsh-remembers", "段 id 不对");
assert.equal(typeof meta.label, "function", "label 应该是函数（投影时翻译）");
assert.equal(meta.label(), "记忆服务", "label 文本不对");
assert.equal(typeof component, "function", "注册的不是组件函数");
console.log("  ✓ 注册设置段：name=" + meta.name + " id=" + meta.id + " label=" + JSON.stringify(meta.label()) + " order=" + meta.order);

// ---- 4. 组件能产出一棵元素树（不真的渲染） -------------------------------
// 用 fake React 调用一次组件函数，确认它不会立刻抛
const tree = component({});
assert.ok(tree && typeof tree === "object", "组件返回的不是元素");
const flat = JSON.stringify(tree);
assert.ok(flat.includes("正在读取配置"), "loading 态没出现");
console.log("  ✓ 组件可调用（首帧是「正在读取配置…」）");

// ---- 5. 字段与按钮（静态检查源码） ---------------------------------------
// 组件的首帧是 loading 态，真正的表单要等 fetch 回来才渲染，所以这里
// 检查源码而不是元素树。真实渲染留给浏览器里验。
for (const needle of ["服务地址", "提供商", "API 密钥", "自定义设置", "取消", "保存", "惊讶度阈值"]) {
  assert.ok(source.includes(needle), "源码里缺少字段/按钮：" + needle);
}
console.log("  ✓ 字段与按钮齐全：服务地址 / 提供商 / API 密钥 / 自定义设置 / 惊讶度阈值 / 取消 / 保存");

// ---- 6. 安全约定：密钥不回显 ---------------------------------------------
assert.ok(source.includes("type: \"password\""), "密钥输入框应该是 password");
assert.ok(source.includes("留空保持原密钥"), "缺少「留空保持原密钥」的提示");
assert.ok(!/console\.log\([^)]*llm_key/.test(source), "不要在控制台打印密钥");
console.log("  ✓ 安全约定：password 输入框、留空保持原值、不打印密钥");

console.log("\n全部通过 ✅  client.js 的注册链路是对的");
