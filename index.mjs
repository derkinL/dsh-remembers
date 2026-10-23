/**
 * dsh-remembers —— 给情感陪伴场景做的记忆插件。
 *
 * 做三件事（都很薄，重活在 companion-memory 服务里）：
 *   1. 启动时注入 L4 人格与关系约定（agent.inject）
 *   2. 每步检索并注入相关记忆（agent/pre-step 追加消息）
 *   3. 每轮把原话写进 L0（不抽摘要，保证「说过的话不丢」）
 *
 * 刻意不做的事：
 *   - 不用 system prompt 注入。persona 声明 complete:true 的预设会把它整段丢掉，
 *     而且不会报错——静默失忆比报错更难查。
 *   - 检索结果为空时不注入任何东西。空就是真的没印象，模型不该看到空块还以为有记忆。
 */

import { createHash } from "node:crypto";

import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { MemoryClient } from "./client.mjs";
import { PLUGIN_VERSION, resolveConfig } from "./config.mjs";

export const name = "dsh-remembers";
export const inject = ["agents", "sessions"];

const PLUGIN_SOURCE = "dsh-remembers";
const PLUGIN_KIND = `plugin:${PLUGIN_SOURCE}`;

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  const logger = ctx.logger;
  const client = new MemoryClient(
    { ...config, logger: config.logRequests ? logger : null },
    config.logRequests ? logger : null,
  );

  const log = (stage, data) => logger?.debug?.(`[dsh-remembers] ${stage} ${JSON.stringify(data)}`);
  log("loaded", { version: PLUGIN_VERSION, endpoint: config.endpoint, captureRaw: config.captureRaw });

  // per-session 状态
  const states = new Map();

  function stateFor(session) {
    const id = String(session?.id ?? "unknown");
    let state = states.get(id);
    if (!state) {
      state = {
        id,
        injectedHashes: new Set(),   // 去重：同一块不重复注入
        profileDelivered: false,
        turnUser: "",
        turnAssistant: "",
        writes: Promise.resolve(),
      };
      states.set(id, state);
    }
    return state;
  }

  const skipped = (session) => (
    config.skipSubagentSessions && session?.header?.origin === "subagent"
  );

  // -------------------------------------------------------------------------
  // 1. 启动注入 L4
  // -------------------------------------------------------------------------
  async function injectProfile(agent) {
    if (!config.injectProfile || !agent) return false;
    const session = agent.session;
    if (skipped(session)) return false;
    const state = stateFor(session);
    if (state.profileDelivered) return false;
    if (agent.status !== "idle") return false;

    const items = await client.profile(config.profileSubject || null);
    if (!items || items.length === 0) {
      state.profileDelivered = true;
      return false;
    }
    const block = renderProfile(items);
    agent.inject(message(block, "instructions"));
    state.profileDelivered = true;
    state.injectedHashes.add(hash(block));
    log("profile_injected", { session: state.id, items: items.length });
    return true;
  }

  ctx.on("agent/created", async ({ agent, source }) => {
    if (source === undefined) return undefined;
    try {
      await injectProfile(agent);
    } catch (error) {
      log("profile_error", { error: String(error?.message ?? error) });
    }
    return undefined;
  });

  ctx.on("agent/session-start", async ({ agent }) => {
    try {
      await injectProfile(agent);
    } catch (error) {
      log("profile_error", { error: String(error?.message ?? error) });
    }
  });

  // -------------------------------------------------------------------------
  // 2. 每步召回
  // -------------------------------------------------------------------------
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal?.aborted) return decision;
    if (skipped(agent?.session)) return decision;

    try {
      const { query, focus } = buildQuery(decision.messages);
      if (!query || query.length < config.recallMinChars) return decision;

      const hits = await client.search({
        query,
        focus,
        topK: config.recallTopK,
        subject: config.profileSubject || undefined,
      });
      if (!hits || hits.length === 0) return decision;
      if (signal?.aborted) return decision;

      const block = renderRecall(hits);
      const state = stateFor(agent.session);
      const digest = hash(block);
      if (state.injectedHashes.has(digest)) return decision;   // 同内容不再塞一遍
      state.injectedHashes.add(digest);

      log("recall_injected", { session: state.id, hits: hits.length, top: hits[0]?.score });
      return { kind: "enter", messages: [...decision.messages, message(block, "recall")] };
    } catch (error) {
      // 记忆召回失败绝不能挡住这一步
      log("recall_error", { error: String(error?.message ?? error) });
      return decision;
    }
  }, { prepend: true });

  // -------------------------------------------------------------------------
  // 3. 捕获原话 → L0
  // -------------------------------------------------------------------------
  ctx.on("session/event", (session, event) => {
    if (!config.captureRaw || skipped(session)) return;
    const state = stateFor(session);
    const message = eventMessage(event);
    if (!message) return;
    if (isSynthetic(message)) return;   // 别的插件注入的块、time-context 都不要

    const text = extractText(message);
    if (!text) return;
    if (message.role === "assistant") {
      state.turnAssistant = clip(`${state.turnAssistant}\n${text}`.trim(), 1600);
    } else {
      state.turnUser = clip(`${state.turnUser}\n${text}`.trim(), 1600);
    }
  });

  ctx.on("turn/end", (session) => {
    if (!config.captureRaw || skipped(session)) return;
    const state = stateFor(session);
    const user = state.turnUser.trim();
    const assistant = state.turnAssistant.trim();
    state.turnUser = "";
    state.turnAssistant = "";

    const merged = [user && `用户：${user}`, assistant && `她：${assistant}`]
      .filter(Boolean).join("\n");
    if (merged.length < config.captureMinChars) return;

    state.writes = state.writes
      .then(() => client.ingest({
        text: merged,
        tier: "L0",
        subject: "self",
        tags: ["raw", `session:${state.id}`],
        embed: true,
      }))
      .then((id) => { if (id) log("raw_saved", { session: state.id, id }); })
      .catch((error) => log("raw_error", { error: String(error?.message ?? error) }));
  });

  ctx.effect(() => () => { states.clear(); }, "companionMemory.clearStates()");
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const TIER_LABEL = {
  L4: "关系约定",
  L3: "经历",
  L2: "关于她",
  L1: "事实",
  L0: "原话",
};

function renderProfile(items) {
  const lines = items.map((item) => {
    const label = TIER_LABEL[item.tier] || item.tier;
    return `[${label}] ${oneLine(item.summary || item.text)}`;
  });
  return [
    '<dsh-remembers source="profile">',
    "这些是你和这个人之间已经确定的设定与约定，按它来，不要反驳也不要重新确认：",
    ...lines,
    "</dsh-remembers>",
  ].join("\n");
}

function renderRecall(hits) {
  const lines = hits.map((hit) => {
    const label = TIER_LABEL[hit.tier] || hit.tier;
    const date = hit.tier === "L3" || hit.tier === "L0" ? fmtDate(hit.ts) : "";
    const body = oneLine(hit.summary || hit.text);
    return date ? `[${label} · ${date}] ${body}` : `[${label}] ${body}`;
  });
  return [
    '<dsh-remembers source="recall">',
    "以下是你回忆起的内容（不是刚听到的话）。自然地用，不要逐条复述；",
    "与当前话题无关的就忽略；想不起细节就说想不起，不要编。",
    ...lines,
    "</dsh-remembers>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function message(content, form) {
  // 用 dsh 自己的构造器：消息 identity、规范化、以及未来的不变量都来自宿主
  return createUserMessage({
    content: [{ type: "text", text: content }],
    source: { kind: PLUGIN_KIND, plugin: PLUGIN_SOURCE, form },
  });
}

function hash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clip(text, max) {
  const s = String(text || "");
  return s.length <= max ? s : s.slice(-max);   // 留尾巴，最近的更重要
}

function fmtDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n * 1000).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function eventMessage(event) {
  switch (event?.type) {
    case "user/message":
      return event.data;
    case "assistant/message":
      return event.data?.message ?? event.data;
    default:
      return null;
  }
}

function isSynthetic(message) {
  const kind = message?.source?.kind;
  if (kind === "tool") return true;
  if (kind === "user") return false;
  if (kind === undefined) return false;
  // 其它插件/宿主注入的上下文一律不捕获
  return typeof kind === "string";
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * 只用真实用户输入构造查询。
 * focus 取最后一条用户输入的尾部——短句（「嗯」「你呢」）本身没有语义，
 * 得靠这一轮的上下文把话题顶上来，这正是服务端 FOCUS_BOOST 吃的东西。
 */
function buildQuery(messages) {
  const inputs = (messages || [])
    .filter((m) => m && m.role === "user" && !isSynthetic(m))
    .map(extractText)
    .filter(Boolean);
  if (inputs.length === 0) return { query: "", focus: "" };
  const joined = inputs.join("\n");
  return {
    query: joined.slice(-200),
    focus: inputs[inputs.length - 1].slice(-80),
  };
}
