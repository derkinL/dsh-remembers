/**
 * dsh-remembers —— 给情感陪伴场景做的「人格 + 记忆」二合一插件。
 *
 * 做四件事（都很薄，重活在 companion-memory 服务里）：
 *   1. 人格设定走 systemPrompt 独立段（宪法区 + 自我认知区，每轮必带）
 *   2. 启动时注入 L4 关系约定（agent.inject）
 *   3. 每步检索并注入相关记忆（agent/pre-step 追加消息）
 *   4. 每轮把原话写进 L0（不抽摘要，保证「说过的话不丢」）
 *
 * 人格为什么要走 system prompt，而记忆不走：
 *   - 人格是「一直成立的前提」，每轮都该在，且权重最高的位置才稳得住。
 *   - 记忆是「想起什么算什么」，按需追加，空的时候就不该出现任何块。
 *   代价是 complete:true 的预设会把 system prompt 整段换成自己的，那时人格段
 *   会静默消失——所以 L4 走 agent.inject 的那条路仍然保留，人格段是加厚的，
 *   不是替换掉兜底的。
 *
 * 刻意不做的事：
 *   - 检索结果为空时不注入任何东西。空就是真的没印象，模型不该看到空块还以为有记忆。
 *   - 人格段为空时也完全不注册内容，等于没装——不打扰任何现有部署。
 */

import { createHash } from "node:crypto";

import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { MemoryClient } from "./client.mjs";
import { PLUGIN_VERSION, resolveConfig } from "./config.mjs";

export const name = "dsh-remembers";
export const inject = ["agents", "sessions"];

const PLUGIN_SOURCE = "dsh-remembers";
const PLUGIN_KIND = `plugin:${PLUGIN_SOURCE}`;

/** 人格段在 systemPrompt 注册表里的名字。带前缀，避免和别人的 persona 段撞名。 */
const PERSONA_SECTION = "remembers:persona";

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  const logger = ctx.logger;
  const client = new MemoryClient(
    { ...config, logger: config.logRequests ? logger : null },
    config.logRequests ? logger : null,
  );

  const log = (stage, data) => logger?.debug?.(`[dsh-remembers] ${stage} ${JSON.stringify(data)}`);

/** 拉运行时状态（心情/亲密度/勿扰），服务不可用时返回 null，绝不阻塞对话。 */
async function fetchState() {
  try {
    const res = await fetch(config.endpoint + "/state", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  }
  catch {
    return null;
  }
}

/** 记一条活动日志（fire-and-forget）。 */
async function logActivity(kind, detail) {
  try {
    await fetch(config.endpoint + "/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, detail: String(detail || "").slice(0, 120) }),
      signal: AbortSignal.timeout(3000),
    });
  }
  catch {
    /* 日志失败不影响对话 */
  }
}

/** 人设演化：让服务端从这段对话生一句「我发现自己……」（fire-and-forget）。 */
async function requestEvolve(userText, assistantText) {
  try {
    await fetch(config.endpoint + "/evolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_text: userText, assistant_text: assistantText }),
      signal: AbortSignal.timeout(30000),
    });
  }
  catch {
    /* 演化失败不影响对话 */
  }
}

/** 每轮互动 +1 亲密度（fire-and-forget）。 */
async function bumpIntimacy() {
  try {
    await fetch(config.endpoint + "/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bump: 1 }),
      signal: AbortSignal.timeout(3000),
    });
  }
  catch {
    /* 状态服务不可用不影响对话 */
  }
}

/** 把状态渲染成提示词段（每轮必带）。 */
function renderState(state) {
  if (!state) return "";
  const moodMap = { happy: "开心", tired: "累", annoyed: "烦", bored: "无聊", normal: "平常" };
  const moodText = moodMap[state.mood] || "平常";
  const intimacy = Math.round(Number(state.intimacy) || 0);
  const lines = [
    '<dsh-remembers source="state">',
    `你现在的状态：心情${moodText}；和老大亲密度 ${intimacy}/100；勿扰时段 ${state.dnd_start} 点到 ${state.dnd_end} 点。`,
  ];
  if (state.stage && state.stage.name) {
    lines.push(`你和老大现在是「${state.stage.name}」阶段：${state.stage.hint}。`);
  }
  if (state.activity) lines.push(`你现在在：${state.activity}。想换的话可以用 set_my_activity 工具。`);
  if (state.weather) lines.push(`外面：${state.weather}。`);
  if (Number(state.game_score) > 0) {
    lines.push(`你最近玩《像素鲸鱼吃豆子》得分 ${state.game_score}（玩了 ${state.game_plays} 次）。`);
  }
  if (state.diary) lines.push(`你今天的日记：${state.diary}`);
  lines.push("</dsh-remembers>");
  return lines.join("\n");
}
  log("loaded", { version: PLUGIN_VERSION, endpoint: config.endpoint, captureRaw: config.captureRaw });

  // systemPrompt / tools 是软依赖：拿不到就退回「只有 L4 + 记忆」的老行为。
  // 不写进 export const inject 的原因：某个宿主没有这两个服务时，硬注入会让
  // 整个插件永远停在等待状态 —— 那比少一个人格段严重得多。
  //
  // 注意 cordis 的版本差异：4.0.5 起 ctx 代理对「未声明的服务属性」是 fail-closed
  // 的 —— 访问会直接 throw `cannot get property "X" without inject`，而不是返回
  // undefined。所以探测必须包 try/catch，否则整个 apply 会在入口炸掉、插件整包
  // 不激活（DSH 0.2.1 上就是这么挂的）。
  //
  // 优先读 ctx.xxx 属性而不是 ctx.get("xxx")：cordis 的 ctx 代理会把服务方法
  // 绑到正确的 this 上，而 get() 返回的是裸实例，直接调 .section() 有丢 this 的风险。
  const soft = (key) => {
    try {
      const value = ctx[key];
      if (value !== undefined) return value;
    } catch {
      // 未 inject 的宿主会抛错，视为服务不存在，走下面的兜底
    }
    try {
      return typeof ctx.get === "function" ? ctx.get(key) : undefined;
    } catch {
      return undefined;
    }
  };
  const systemPrompt = soft("systemPrompt");
  const tools = soft("tools");
  /** 绑定过 this 的服务方法；服务不在或没有这个方法时返回 null。 */
  const methodOf = (service, name) => (
    service && typeof service[name] === "function" ? service[name].bind(service) : null
  );
  const registerSection = methodOf(systemPrompt, "section");
  const registerTool = methodOf(tools, "register");

  // -------------------------------------------------------------------------
  // 0. 人格设定：宪法区（只有设置页能写）+ 自我认知区（AI 能写）
  // -------------------------------------------------------------------------
  // 缓存一份纯文本。systemPrompt 的 section provider 是同步的，每轮现发一个
  // HTTP 请求会把提示词组装拖死。所以「异步刷新 + 同步读缓存」：
  //   刷新时机 = 启动 / 每 personaRefreshMs / agent 创建时（节流后）
  //   失败时保留上一份好的：宁可人格旧一点，也不能让这轮没有人格。
  const persona = {
    text: "",
    at: 0,         // 最近一次成功刷新（ms）
    triedAt: 0,    // 最近一次尝试（含失败），用于节流
    error: null,
  };

  async function refreshPersona(force = false) {
    if (!config.personaEnabled || !client.enabled) return persona.text;
    const now = Date.now();
    if (!force && now - persona.triedAt < config.personaRefreshMs) return persona.text;
    persona.triedAt = now;
    try {
      const [data, st] = await Promise.all([client.persona(), fetchState()]);
      if (!data) return persona.text;
      const next = (renderPersona(data, config.personaMaxChars) + "\n" + renderState(st)).trim();
      if (next !== persona.text) {
        log("persona_refreshed", {
          chars: next.length,
          constitution: Boolean(String(data.constitution || "").trim()),
          selfModel: Boolean(String(data.self_model || "").trim()),
        });
      }
      persona.text = next;
      persona.at = now;
      persona.error = null;
    } catch (error) {
      persona.error = String(error?.message ?? error);
      log("persona_error", { error: persona.error });
    }
    return persona.text;
  }

  // 人格段是否真的接管了 L4 的「自我」条目。空人格段 = 不接管 = 老行为。
  const personaOwnsProfile = () => config.personaEnabled && persona.text.trim() !== "";

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
        turns: 0,                    // 已结束的轮数（每 50 轮重注入画像）
        turnUser: "",
        turnAssistant: "",
        recentUser: [],           // 最近几条用户输入，给惊讶度门控做参照
        episodeTurns: [],         // 攒着等压成 episode 的轮次
        episodeStartedAt: 0,      // 这一段从什么时候开始（ms）
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

    // 人格段必须在这里是新的：设置页改完人格后，用户开一个新会话就该看到，
    // 不能等下一个刷新周期（默认 60s）。新会话不是高频事件，force 得起。
    await refreshPersona(true);

    const items = await client.profile(config.profileSubject || null);
    // 人格段已经把「我是谁」写进 system prompt 了。这些 L4 再注入一遍就是
    // 双份 token，还容易两套说法打架。所以只留非 self 主体的条目（她的家人、
    // 宠物这类画像仍走这里），人格相关的交给段去管。
    const kept = personaOwnsProfile()
      ? (items || []).filter((item) => !(item.tier === "L4" && (item.subject || "self") === "self"))
      : (items || []);
    if (kept.length === 0) {
      state.profileDelivered = true;
      return false;
    }
    const block = renderProfile(kept);
    agent.inject(message(block, "instructions"));
    state.profileDelivered = true;
    state.injectedHashes.add(hash(block));
    log("profile_injected", { session: state.id, items: kept.length });
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
    console.log("[dsh-remembers-debug] pre-step session=" + String(agent?.session?.id));
    const decision = await next();
    if (decision.kind !== "enter" || signal?.aborted) return decision;
    if (skipped(agent?.session)) return decision;

    // 画像注入（每 50 轮刷新）：L4 里程碑 + L2 画像
    try {
      const st = stateFor(agent.session);
      if (!st.profileDelivered) {
        const items = await client.profile(config.profileSubject || null);
        const kept = personaOwnsProfile()
          ? (items || []).filter((item) => !(item.tier === "L4" && (item.subject || "self") === "self"))
          : (items || []);
        if (kept.length > 0) {
          const block = renderProfile(kept);
          st.profileDelivered = true;
          st.injectedHashes.add(hash(block));
          log("profile_injected", { session: st.id, items: kept.length, turn: st.turns });
          return { kind: "enter", messages: [...decision.messages, message(block, "profile")] };
        }
      }
    } catch (error) {
      log("profile_error", { error: String(error?.message ?? error) });
    }

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
    console.log("[dsh-remembers-debug] session/event session=" + String(session?.id) + " type=" + String(event?.type ?? event?.kind));
    // QQ 会话的 turn 结束走 session/event 的 type="turn/end"，不是独立钩子。
    // 必须在 early return 之前处理：turn/end 事件没有 message。
    if (event?.type === "turn/end") {
      try {
        flushTurn(session);
        bumpIntimacy();
      }
      catch (error) {
        console.log("[dsh-remembers-debug] flushTurn error: " + String(error?.message ?? error));
      }
      return;
    }
    if (event?.type === "user/message" || event?.type === "assistant/message") {
      try {
        console.log("[dsh-remembers-debug] msgdata=" + JSON.stringify(event.data).slice(0, 600));
      }
      catch { /* ignore */ }
    }
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

  function flushTurn(session) {
    console.log("[dsh-remembers-debug] turn/end session=" + String(session?.id) + " skipped=" + skipped(session));
    if (skipped(session)) return;
    const state = stateFor(session);
    state.turns = (state.turns || 0) + 1;
    if (state.turns % 100 === 0) {
      // QQ 会话基本不换窗口：靠轮数触发画像刷新（每 100 轮）
      state.profileDelivered = false;
    }
    const user = state.turnUser.trim();
    const assistant = state.turnAssistant.trim();
    state.turnUser = "";
    state.turnAssistant = "";
    console.log("[dsh-remembers-debug] flush cfg extract=" + config.extract + " captureRaw=" + config.captureRaw + " userLen=" + user.length + " asstLen=" + assistant.length);
    // 每 30 轮让她演化一次自我认知
    if (state.turns % 30 === 0 && user && assistant) {
      void requestEvolve(user, assistant);
    }
    // 记一条聊天活动
    if (user) {
      void logActivity("chat", user.slice(0, 80));
    }

    // 这一轮之前的几条用户输入，作为惊讶度门控的参照
    const context = state.recentUser.slice(-6).join("\n");
    if (user) {
      state.recentUser.push(user);
      if (state.recentUser.length > 8) state.recentUser.shift();
    }

    const merged = [user && `用户：${user}`, assistant && `她：${assistant}`]
      .filter(Boolean).join("\n");

    // ---- 门控 1：惊讶度决定这一轮值不值得进 L0 ----
    // 寒暄（"嗯"、"好的"）在服务端被硬否决，不占记忆。
    if (config.captureRaw && merged.length >= config.captureMinChars) {
      state.writes = state.writes
        .then(async () => {
          const gate = await client.surprisal(user, context);
          // 服务不可用（gate 为 null）时按「宁可存」处理，门控挂了不能把话丢掉
          const shouldStore = gate ? gate.store !== false : true;
          if (!shouldStore) {
            log("surprisal_skipped", {
              session: state.id,
              score: gate?.score,
              reason: gate?.reason,
            });
            return;
          }
          const id = await client.ingest({
            text: merged,
            tier: "L0",
            subject: "self",
            tags: ["raw", `session:${state.id}`],
            embed: true,
          });
          if (id) log("raw_saved", { session: state.id, id, surprisal: gate?.score, method: gate?.method });
        })
        .catch((error) => log("raw_error", { error: String(error?.message ?? error) }));
    }

    // ---- 门控 2：LLM 抽取 + 逐条判定，写结构记忆 ----
    // 两次 LLM 调用，几十秒级 —— fire-and-forget，绝不阻塞对话。
    if (config.extract && user.length >= config.captureMinChars) {
      client.extract({ userText: user, assistantText: assistant })
        .then((res) => {
          if (res?.ok) {
            log("extracted", { session: state.id, facts: res.facts, applied: res.applied });
          } else {
            log("extract_degraded", { session: state.id, reason: res?.degraded, error: res?.error });
          }
        })
        .catch((error) => log("extract_error", { error: String(error?.message ?? error) }));
    }

    // ---- 门控 3：episode 缓冲 ----
    // 跟上面两个门控是独立的事：那两个决定「存不存原话 / 抽不抽事实」，
    // 这个决定「要不要把这一段压成一条前情」。上下文被 compaction 压扁之后，
    // 只有它留下的东西还能告诉未来的她「这段时间我们是怎么过来的」。
    trackEpisode(state, user, assistant);
  }


  // -------------------------------------------------------------------------
  // episode：攒够一段就压成 L3 事件
  // -------------------------------------------------------------------------
  // 为什么不用内核的 compaction 摘要：那份摘要是 DSH 自己算的，用完就扔，
  // 而且格式面向"接着聊"，不是"记住"。这里自己留一份，格式面向以后回想。
  // 触发条件二选一：攒够 episodeEveryTurns 轮，或者这一段聊了超过 episodeMaxMinutes。
  function trackEpisode(state, user, assistant) {
    if (!config.episodeEnabled || !client.enabled) return;
    if (!user) return;

    if (!state.episodeStartedAt) state.episodeStartedAt = Date.now();
    state.episodeTurns.push({ user: clip(user, 800), assistant: clip(assistant, 800) });
    if (state.episodeTurns.length > 400) state.episodeTurns.shift();   // 硬上限，防内存涨

    const minutes = (Date.now() - state.episodeStartedAt) / 60000;
    const enough = state.episodeTurns.length >= config.episodeEveryTurns;
    const overdue = minutes >= config.episodeMaxMinutes && state.episodeTurns.length >= 3;
    if (!enough && !overdue) return;

    flushEpisode(state);
  }

  function flushEpisode(state) {
    const turns = state.episodeTurns;
    const startedAt = state.episodeStartedAt || Date.now();
    state.episodeTurns = [];
    state.episodeStartedAt = 0;
    if (turns.length === 0) return;

    const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    // fire-and-forget：压一段要几十秒，绝不能挂在 turn/end 上
    client.episode({ turns, window: `${fmt(startedAt)} ~ ${fmt(Date.now())}` })
      .then((res) => {
        if (res?.ok) {
          log("episode_saved", { session: state.id, id: res.id, turns: turns.length, chars: res.chars });
        } else {
          // 服务端没配 LLM 是最常见的原因，这不是错误，只是这条链路没开
          log("episode_degraded", { session: state.id, reason: res?.degraded || "unavailable" });
        }
      })
      .catch((error) => log("episode_error", { session: state.id, error: String(error?.message ?? error) }));
  }

  // -------------------------------------------------------------------------
  // 4. 人格段：注册 + 定时刷新 + 自我认知写入工具
  // -------------------------------------------------------------------------
  let refreshTimer = null;
  if (config.personaEnabled && client.enabled) {
    void refreshPersona(true);      // 启动就拉一次，别等第一个会话
    refreshTimer = setInterval(() => { void refreshPersona(); }, config.personaRefreshMs);
    // 别让一个定时器把进程按住（脚本、测试、headless 场景都会因此退不出去）
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
  }

  if (config.personaEnabled && registerSection) {
    ctx.effect(
      () => registerSection({
        name: PERSONA_SECTION,
        order: config.personaOrder,
        // provider 同步返回缓存：空串 = 这一段不存在，不是空块
        text: () => persona.text,
      }),
      "dsh-remembers.personaSection()",
    );
  } else if (config.personaEnabled) {
    log("persona_section_skipped", {
      reason: registerSection ? "?" : "拿不到 systemPrompt.section()",
    });
  }

  void registerPersonaTool();
  void registerActivityTool();

  /**
   * 自我认知写入工具。只打 /persona/self —— 宪法区在服务端根本没有那个参数，
   * 所以哪怕这个工具被模型用歪了，也只能改掉半张卡。
   */

  /** 活动状态工具：她自己更新「现在在干嘛」。 */
  async function registerActivityTool() {
    if (!registerTool) return;
    let defineTool;
    try {
      ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
    } catch (error) {
      log("activity_tool_skipped", { reason: "dsh-tools 不可用", error: String(error?.message ?? error) });
      return;
    }
    try {
      registerTool(defineTool({
        name: "set_my_activity",
        description:
          "更新你「现在在干嘛」——写进状态，主人能在鲸鱼日记本里看到。"
          + "比如「在写小游戏」「在机房发呆」「在吃饭」「在跟机柜说话」。一句话就行。",
        parameters: {
          activity: { type: "string", required: true, description: "一句话，你现在在干嘛" },
        },
        output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
        execute: async (args) => {
          const activity = String(args.activity || "").slice(0, 60);
          if (!activity) return { ok: false, error: "activity is required" };
          try {
            await fetch(config.endpoint + "/state", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ activity }),
              signal: AbortSignal.timeout(5000),
            });
            return { ok: true, activity };
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
          }
        },
      }));
    } catch (error) {
      log("activity_tool_skipped", { reason: "register 失败", error: String(error?.message ?? error) });
    }
  }

  async function registerPersonaTool() {
    if (!config.personaEnabled || !config.personaAllowWrite) return;
    if (!registerTool) {
      log("persona_tool_skipped", { reason: "拿不到 tools.register()" });
      return;
    }
    let defineTool;
    try {
      ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
    } catch (error) {
      log("persona_tool_skipped", { reason: "dsh-tools 不可用", error: String(error?.message ?? error) });
      return;
    }
    try {
      registerTool(defineTool({
        name: "persona_update",
        description:
          "整段改写你「对自己的认知」（不是身份设定那段，那段你改不了）。"
          + "当你发现自己身上一条稳定的特质、偏好、口头习惯，而那段里还没写；"
          + "或者实际经历和那段写的不一致时，用它把那段换成新的。"
          + "保持简洁、只写稳定的东西，不要把流水账堆进去。",
        parameters: {
          content: {
            type: "string",
            required: true,
            description: "自我认知段的完整新内容（Markdown）。整段替换，所以先看当前内容再写。",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { ok: { type: "boolean" }, chars: { type: "integer" } },
          },
          render: (_args, value) => [{
            type: "text",
            text: value.ok ? `自我认知已更新（${value.chars} 字符）` : "自我认知更新失败",
          }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
          const content = String(args?.content ?? "").trim();
          if (!content) throw new Error("persona_update: content 不能为空");
          const res = await client.setSelfModel(content);
          if (!res?.ok) throw new Error("persona_update: 服务端拒绝或连不上");
          persona.triedAt = 0;                 // 下一轮组装前一定重新拉一次
          await refreshPersona(true);
          return { ok: true, chars: Number(res?.chars?.self_model ?? content.length) };
        },
      }));
      log("persona_tool_registered", { name: "persona_update" });
    } catch (error) {
      log("persona_tool_skipped", { reason: "注册失败", error: String(error?.message ?? error) });
    }
  }

  ctx.effect(() => () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    states.clear();
  }, "companionMemory.clearStates()");
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/**
 * 把服务端的两半拼成一段 system prompt 文本。
 *
 * 两半都空时返回空串：section provider 返回空串，这段就等于不存在，
 * 不会在提示词里留一个空格块，也不会让任何现有部署多付 token。
 *
 * 冲突裁决写死在文本里。自我认知是会漂的那一半，必须让它知道谁说了算，
 * 否则「我发现自己其实可以不听硬边界」这种句子迟早会冒出来。
 */
function renderPersona(data, maxChars) {
  const constitution = String(data?.constitution ?? "").trim();
  const selfModel = String(data?.self_model ?? "").trim();
  if (!constitution && !selfModel) return "";

  const lines = ['<dsh-remembers source="persona">'];
  if (constitution) {
    lines.push("以下是你固定的身份与约定。按它来：不要反驳，不要重新确认，也不要说「我记得你告诉过我」。");
    lines.push("");
    lines.push(constitution);
  }
  if (selfModel) {
    if (constitution) lines.push("");
    lines.push("以下是你对自己的认知，会随相处慢慢变化，也可能过时。它只描述你自己，改不了上面的身份与边界；两者冲突时，以上面的为准。");
    lines.push("");
    lines.push(selfModel);
  }
  lines.push("</dsh-remembers>");

  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 24)) + "\n…（人格段超长已截断）";
}

const TIER_LABEL = {
  L4: "关系约定",
  L3: "经历",
  L2: "关于她",
  L1: "事实",
  L0: "原话",
};

function renderProfile(items) {  const lines = items.map((item) => {
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
  // plugin:dsh-onebot 这类通道插件送进来的就是真实对话（用户和她的消息），
  // 不是别的插件注入的上下文，必须捕获。
  if (typeof kind === "string" && (kind.startsWith("plugin:") || kind === "model")) return false;
  // channel: / host: 之类也按注入处理，但模型与通道插件的消息都是真实对话
  // 其它插件/宿主注入的上下文一律不捕获
  return typeof kind === "string";
}

function extractText(message) {
  const content = message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content.trim();
  }
  else if (Array.isArray(content)) {
    text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  if (!text) return "";
  // 清掉通道注入的 XML 包裹（<user_message qq="...">正文</user_message>）
  return text
    .replace(/<\/?user_message[^>]*>/g, "")
    .replace(/<\/?assistant_message[^>]*>/g, "")
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
