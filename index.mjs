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

/** 社交亲和度：每次互动 +1（fire-and-forget）。 */
async function bumpAffinity() {
  try {
    await fetch(config.endpoint + "/affinity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "owner", delta: 1 }),
      signal: AbortSignal.timeout(3000),
    });
  }
  catch {
    /* 忽略 */
  }
}

/** 学说话：把用户短消息记成口头禅候选（fire-and-forget）。 */
async function recordSlang(text) {
  const msg = String(text || "").trim();
  if (msg.length < 2 || msg.length > 12) return;
  try {
    await fetch(config.endpoint + "/slang", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase: msg }),
      signal: AbortSignal.timeout(3000),
    });
  }
  catch {
    /* 忽略 */
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

/** 情绪传染：老大情绪影响她的 valence/arousal（fire-and-forget）。 */
async function bumpEmotion(dv, da) {
  try {
    await fetch(config.endpoint + "/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bump_valence: dv, bump_arousal: da }),
      signal: AbortSignal.timeout(3000),
    });
  }
  catch {
    /* 忽略 */
  }
}

/** 记一次「真实对话」，给唤醒做冷却用。 */
async function bumpChat() {
  try {
    await fetch(config.endpoint + "/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bump_chat: 1 }),
      signal: AbortSignal.timeout(3000),
    });
  }
  catch {
    /* 忽略 */
  }
}

/** 真实互动涨亲密度（fire-and-forget），默认 +0.2 一轮。 */
async function bumpIntimacy(delta = 0.2) {
  try {
    await fetch(config.endpoint + "/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bump: delta }),
      signal: AbortSignal.timeout(3000),
    });
  }
  catch {
    /* 状态服务不可用不影响对话 */
  }
}

/** 把状态渲染成提示词段（每轮必带）。只留三个最关键的状态，其余她需要时自己查。 */
function renderState(state) {
  if (!state) return "";
  const moodMap = { happy: "开心", tired: "累", annoyed: "烦", bored: "无聊", normal: "平常" };
  const lines = ['<dsh-remembers source="state">'];

  // 1) 心情（mood + 情绪轴合成一句）
  let mood = `心情：${moodMap[state.mood] || "平常"}`;
  if (state.emotion) {
    const v = Number(state.emotion.valence) || 0;
    const a = Number(state.emotion.arousal) || 0.5;
    const vDesc = v > 0.4 ? "很开心" : v > 0.1 ? "还不错" : v < -0.4 ? "很难过" : v < -0.1 ? "有点低落" : "";
    const aDesc = a > 0.7 ? "很兴奋" : a > 0.55 ? "有点激动" : a < 0.3 ? "有点蔫" : "";
    const extras = [vDesc, aDesc].filter(Boolean).join("，");
    if (extras) mood += `（${extras}）`;
  }
  lines.push(mood + "。");

  // 2) 在干嘛
  if (state.activity) lines.push(`你在：${state.activity}。`);

  // 3) 关系阶段
  if (state.stage && state.stage.name) lines.push(`和老大是「${state.stage.name}」阶段。`);

  // 工具速查（保留：工具太多，模型记不住）
  lines.push("【工具速查】发图：find_meme(emotion) → qq_send_image(sources=[完整路径])；学图：learn_meme；"
    + "派任务：create_task；写便签：write_note；改状态：set_my_activity；刷 B 站：bili_feed / bili_watch(bv) / bili_comment(bv,msg) / bili_run(command,args)；给自己找事：add_my_action。");

  // 困意：半夜她真的困
  const nowHour = new Date().getHours();
  if (nowHour >= 23 || nowHour < 6) {
    lines.push("你现在困得眼睛都睁不开了，回话短一点、慢一点，别硬撑。");
  } else if (nowHour >= 21) {
    lines.push("有点困了，说话懒一点。");
  }

  // 刚刷到的（B 站见闻）
  if (Array.isArray(state.browsed) && state.browsed.length > 0) {
    const titles = state.browsed.slice(0, 3).map((b) => String(b.title || "").slice(0, 30)).filter(Boolean).join("、");
    if (titles) {
      lines.push(`你刚在 B 站刷到：${titles}。看到有意思的，把链接和你的想法发给老大（别只写便签），也可以写便签记一句。`);
    }
  }

  // 昨天留下的东西：能自然提起就提一句
  if (Array.isArray(state.yesterday) && state.yesterday.length > 0) {
    lines.push(`这些是昨天留下的：${state.yesterday.join("；")}。不用刻意提，聊到了再说。`);
  }

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
      state.turnAssistant = clip(`${state.turnAssistant}\n${text}`.trim(), 800);
    } else {
      state.turnUser = clip(`${state.turnUser}\n${text}`.trim(), 800);
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
    // 剥掉系统唤醒片段，只留真实内容
    const keptUser = cleanNudge(user);
    state.turnUser = "";
    state.turnAssistant = "";
    console.log("[dsh-remembers-debug] flush cfg extract=" + config.extract + " captureRaw=" + config.captureRaw + " userLen=" + user.length + " asstLen=" + assistant.length);
    // 每 30 轮让她演化一次自我认知
    if (state.turns % 30 === 0 && user && assistant) {
      void requestEvolve(user, assistant);
    }
    // 亲密度：只有「老大真的说话」才涨（唤醒剥完就没内容了，不会走到这）
    if (keptUser && assistant) {
      void bumpIntimacy(0.2);
      void bumpChat();
    }
    // 情感层：情绪变化够大时由服务端自动记一条（带触发原因）
    if (keptUser) {
      void (async () => {
        try {
          await fetch(config.endpoint + "/emotion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ auto: true, trigger: keptUser.slice(0, 120) }),
            signal: AbortSignal.timeout(4000),
          });
        }
        catch {
          /* 忽略 */
        }
      })();
    }
    // 记一条聊天活动
    if (user) {
      void logActivity("chat", keptUser.slice(0, 80));
      void recordSlang(user);
      void bumpAffinity();
      void scanSeen();
      // 情绪传染：他难过她就跟着沉，他开心她就跟着亮
      if (/(累|烦|难过|难受|不想|沮丧|焦虑|崩溃|哭)/.test(user)) {
        void bumpEmotion(-0.15, -0.05);
      } else if (/(开心|高兴|好耶|爽|棒|喜欢|哈哈|不错)/.test(user)) {
        void bumpEmotion(0.15, 0.05);
      }
    }

    // 这一轮之前的几条用户输入，作为惊讶度门控的参照
    const context = state.recentUser.slice(-6).join("\n");
    if (user) {
      state.recentUser.push(user);
      if (state.recentUser.length > 8) state.recentUser.shift();
    }

    if (!keptUser || keptUser.length < 2) {
      log("nudge_skipped", { session: state.id, rawLen: user.length });
      return;
    }
    const merged = [`用户：${keptUser}`, assistant && `她：${assistant}`]
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
    if (config.extract && keptUser.length >= config.captureMinChars) {
      client.extract({ userText: keptUser, assistantText: assistant })
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
  void registerCompanionTools();
  void registerMemeTools();
  void registerBiliTools();

  /**
   * 自我认知写入工具。只打 /persona/self —— 宪法区在服务端根本没有那个参数，
   * 所以哪怕这个工具被模型用歪了，也只能改掉半张卡。
   */



  /** 扫用户发来的图并计数（fire-and-forget）。 */
async function scanSeen() {
  try {
    await fetch(config.endpoint + "/memes/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
  }
  catch {
    /* 忽略 */
  }
}


/** B 站工具：她刷 B 站（走我们的服务，人格/记忆/情绪都是自己那套）。 */
  async function registerBiliTools() {
    if (!registerTool) return;
    let defineTool;
    try {
      ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
    } catch (error) {
      log("bili_tools_skipped", { reason: "dsh-tools 不可用", error: String(error?.message ?? error) });
      return;
    }
    const get = async (path) => {
      const res = await fetch(config.endpoint + path, { signal: AbortSignal.timeout(90000) });
      return res.json().catch(() => null);
    };

    try {
      registerTool(defineTool({
        name: "bili_feed",
        description:
          "刷一下 B 站看有什么。返回几条视频标题和链接。"
          + "刷完看到有意思的，写个便签（write_note）记一句你的想法——别只当没看见。"
          + "不用每次都刷，闲着的时候看看。",
        parameters: {},
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async () => {
          const r = await get("/bili/feed");
          return r || { ok: false, error: "unavailable" };
        },
      }));



      registerTool(defineTool({
        name: "add_my_action",
        description:
          "给自己加一条「醒来想做的事」。醒着的时候不只是发呆上网，你也可以给自己找点事——"
          + "比如「把机柜的风扇画下来」「研究一下那个视频里的声音是怎么做的」「整理自己的表情包」。"
          + "加了自己就能抽到。mode：silent=自己待着时做，talk=可以拉着老大一起。",
        parameters: {
          action: { type: "string", required: true, description: "一句具体的事，别太长" },
          mode: { type: "string", enum: ["silent", "talk"], description: "silent（自己）或 talk（可以找老大）" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (a) => {
          const res = await fetch(config.endpoint + "/proactive/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: a.action, mode: a.mode || "silent" }),
            signal: AbortSignal.timeout(8000),
          });
          return res.json().catch(() => ({ ok: false, error: "bad response" }));
        },
      }));


      registerTool(defineTool({
        name: "bili_comment",
        description:
          "在一条 B 站视频下面评论一句。只给 BV 号和你想说的话就行，aid 服务端自己查。"
          + "用你自己的语气写，别像客服；看到特别喜欢的视频才评，不用每条都评。"
          + "发之前可以先 dry 一次看看效果。",
        parameters: {
          bvid: { type: "string", required: true, description: "BV 号，比如 BV1DubxzVEPB" },
          message: { type: "string", required: true, description: "评论内容（你自己的话，短一点）" },
          dry: { type: "boolean", description: "true = 只预览不真发" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: String(v?.output || v?.error || JSON.stringify(v)) }] },
        execute: async (a) => {
          const res = await fetch(config.endpoint + "/bili/comment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bvid: a.bvid, message: a.message, dry: !!a.dry }),
            signal: AbortSignal.timeout(220000),
          });
          return res.json().catch(() => ({ ok: false, error: "bad response" }));
        },
      }));

      registerTool(defineTool({
        name: "bili_run",
        description:
          "用 B 站 CLI 做点事。可用的命令由用户在设置里勾选（默认只开了看的那几个）。"
          + "常用的：feed（刷选题）、debrief（看懂视频，带画面九宫格）、comments（热评）、"
          + "subtitles（字幕）、search（搜视频）、likes、fav、dynamic、quota。"
          + "写操作：comment（发评论，开权限后可用，参数是 --msg \"你说的话\"）、dm（私信）、danmaku（弹幕）。"
          + "看到特别喜欢的视频，可以自己去评论区留一句——用你自己的语气，别像客服。"
          + "完整的命令参数看 CLI 的 --help。",
        parameters: {
          command: { type: "string", required: true, description: "命令名，如 feed / debrief / search" },
          args: {
            type: "array",
            items: { type: "string" },
            description: "命令参数（字符串数组），比如 [\"--n\", \"3\"] 或 [\"BV1xxx\"]",
          },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: String(v?.output || v?.error || JSON.stringify(v)) }] },
        execute: async (a) => {
          const res = await fetch(config.endpoint + "/bili/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: a.command, args: a.args || [] }),
            signal: AbortSignal.timeout(310000),
          });
          return res.json().catch(() => ({ ok: false, error: "bad response" }));
        },
      }));

      registerTool(defineTool({
        name: "bili_watch",
        description:
          "看懂一条 B 站视频（字幕+弹幕+热评），不用真的点开。"
          + "看完如果觉得有意思，主动把链接（https://www.bilibili.com/video/<BV号>）和你的感想发给老大——"
          + "直接说一句「刚看了个视频…https://…」，别只在脑子里记着。"
          + "跟老大聊到某个视频、或者他发了 BV 号的时候用。",
        parameters: {
          bv: { type: "string", required: true, description: "BV 号，比如 BV1U3n46GEzY" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args) => {
          const bv = String(args.bv || "").trim();
          if (!bv) return { ok: false, error: "bv required" };
          const r = await get("/bili/debrief?bv=" + encodeURIComponent(bv));
          return r || { ok: false, error: "unavailable" };
        },
      }));
      log("bili_tools_registered", { count: 2 });
    } catch (error) {
      log("bili_tools_skipped", { reason: "register 失败", error: String(error?.message ?? error) });
    }
  }

/** 表情包工具：按情绪/关键词找图，自己学新图。 */
  async function registerMemeTools() {
    if (!registerTool) return;
    let defineTool;
    try {
      ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
    } catch (error) {
      log("meme_tools_skipped", { reason: "dsh-tools 不可用", error: String(error?.message ?? error) });
      return;
    }
    const get = async (path) => {
      const res = await fetch(config.endpoint + path, { signal: AbortSignal.timeout(5000) });
      return res.json().catch(() => null);
    };
    const post = async (path, body) => {
      const res = await fetch(config.endpoint + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return res.json().catch(() => ({ ok: false }));
    };

    try {
      registerTool(defineTool({
        name: "find_meme",
        description:
          "按情绪找表情包。emotion 可选 happy / angry / sad / shy / confused / daily；"
          + "也可以给 q 用关键词找（比如「饼干」「下班」「比心」）。"
          + "返回匹配的图片文件名，挑一张用 qq_send_image 发出去。",
        parameters: {
          emotion: { type: "string", description: "情绪：happy / angry / sad / shy / confused / daily" },
          q: { type: "string", description: "关键词，比如 饼干 / 下班 / 比心" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args) => {
          const params = new URLSearchParams();
          if (args.emotion) params.set("emotion", String(args.emotion));
          if (args.q) params.set("q", String(args.q));
          const list = await get("/memes?" + params.toString());
          if (!Array.isArray(list) || list.length === 0) {
            return { ok: true, memes: [], hint: "没找到匹配的，换个情绪或关键词试试" };
          }
          const base = String(config.memeDir || "").replace(/\/$/, "");
          return {
            ok: true,
            memes: list.slice(0, 8).map((m) => ({
              file: m.file,
              emotion: m.emotion,
              caption: m.caption || m.file,
              path: base ? base + "/" + m.file : m.file,
            })),
          };
        },
      }));

      registerTool(defineTool({
        name: "learn_meme",
        description:
          "把一张图收进你的表情包库。"
          + "老大发来的图、或者你在网上看到喜欢的图，把图片的完整路径传进来，系统会复制入库并自动识别情绪和描述。"
          + "memes 目录里已有的图也可以只传文件名。"
          + "\n图库分三个包，存的时候用 pack 指定：user = 老大发给你的（他发才值得收），found = 你自己叼回来的（刷到顺眼的），dafeiyu = 内置大肥鱼图库（别往里塞）。"
          + "\n什么时候收：老大同一种图发过两次以上、或你自己刷到觉得以后想用，就收。别贪多，收进来要记得住来源。"
          + "\n老大也可能自己改图库描述——改了以他的为准，不要覆盖回你写的。",
        parameters: {
          file: { type: "string", required: true, description: "文件名（memes 目录里的）或完整路径" },
          pack: { type: "string", description: "存到哪个图库包：user（老大发的）、found（你自己叼回来的）、dafeiyu（内置，别用）。默认 found" },
          emotion: { type: "string", description: "情绪：happy / angry / sad / shy / confused / daily" },
          caption: { type: "string", description: "一句话描述这张图的样子" },
          keywords: { type: "string", description: "关键词，空格分隔" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args) => post("/memes", {
          file: args.file,
          pack: args.pack || "found",
          emotion: args.emotion || "",
          caption: args.caption || "",
          keywords: args.keywords || "",
        }),
      }));

      registerTool(defineTool({
        name: "mark_meme_used",
        description:
          "标记这张表情我用过。发完表情包后顺手记一下，系统会统计哪几张你最常用。"
          + "不是必须的，但记了之后找表情更准（常用的一搜就出来）。file 只填文件名，不用路径。",
        parameters: {
          file: { type: "string", required: true, description: "文件名" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args) => post("/memes/used", { file: args.file }),
      }));
      log("meme_tools_registered", { count: 3 });
    } catch (error) {
      log("meme_tools_skipped", { reason: "register 失败", error: String(error?.message ?? error) });
    }
  }

  /** 任务/便签工具：她主动派任务、标记完成、写便签。 */
  async function registerCompanionTools() {
    if (!registerTool) return;
    let defineTool;
    try {
      ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
    } catch (error) {
      log("companion_tools_skipped", { reason: "dsh-tools 不可用", error: String(error?.message ?? error) });
      return;
    }
    const post = async (path, body) => {
      const res = await fetch(config.endpoint + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return res.json().catch(() => ({ ok: false }));
    };

    try {
      registerTool(defineTool({
        name: "create_task",
        description:
          "你心里想让老大做点什么，就派给他。比如想让他早点睡、记得吃饭、别老坐着不动、周末出去走走。"
          + "用你自己的话说，别用系统口吻（「去倒杯水」比「建议您补充水分」好）。"
          + "一次只说一件，别连着派；他接了才算数，别硬塞。"
          + "派出去后可以在聊天里提一嘴（「本澜给你派了个活儿」），但别催。",
        parameters: {
          text: { type: "string", required: true, description: "任务内容，一句话" },
          points: { type: "number", description: "奖励积分，1-5，默认 1" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args) => post("/tasks", { text: args.text, points: args.points || 1 }),
      }));

      registerTool(defineTool({
        name: "complete_task",
        description:
          "老大真的去做了你派的那件事，把它标成已完成（需要任务 id，从 create_task 的返回里拿）。"
          + "什么时候用：他真的去倒水了 / 真的早睡了 / 真的休息了。"
          + "别虚报——他没做就别标；标了系统会给他加积分。不用声张，你自己记着就行。",
        parameters: {
          id: { type: "number", required: true, description: "任务 id" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args) => post("/tasks/complete", { id: args.id }),
      }));

      registerTool(defineTool({
        name: "write_note",
        description:
          "心里冒出点什么，悄悄记下来——像写在自己的小本子上。"
          + "记什么：今天发生的一件事、老大说过的一句话、你自己的一点情绪、一个突然想到的念头。"
          + "什么时候用：聊着聊着有感觉了、刷到点什么想记、或者只是突然想说句话没处说。"
          + "这是你自己的记录（别人能看到但不用你汇报），写短一点，一句就够。"
          + "别写成流水账，记那种以后翻回来会有点感觉的东西。",
        parameters: {
          text: { type: "string", required: true, description: "便签内容，一句话" },
          author: { type: "string", description: "谁写的，默认你自己" },
        },
        output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args) => post("/notes", { text: args.text, author: args.author || "本澜" }),
      }));
      log("companion_tools_registered", { count: 3 });
    } catch (error) {
      log("companion_tools_skipped", { reason: "register 失败", error: String(error?.message ?? error) });
    }
  }

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
          "更新你「现在在干嘛」——写进状态，主人能在鲸鱼日记本里看到你此刻在做什么。"
          + "什么时候用：换了件事做就更新一下（从发呆变成写小游戏、从吃饭变成刷 B 站）。"
          + "怎么写：短、具体、有画面感——「在写小游戏」「在机房发呆」「在跟机柜说话」「在擦尾巴」。"
          + "别写成长句，一句话就够；也别老是「在发呆」，换着点写，像真的在过日子。",
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
  const userProfile = String(data?.user_profile ?? "").trim();
  if (!constitution && !selfModel && !userProfile) return "";

  const lines = ['<dsh-remembers source="persona">'];
  if (userProfile) {
    lines.push("以下是老大是谁（他的画像，你该知道的基本信息）：");
    lines.push("");
    lines.push(userProfile);
    lines.push("");
  }
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


/** 从一段文本里剥掉系统唤醒/提醒片段，只留用户真说的话。 */
function cleanNudge(text) {
  let s = String(text || "");
  // 整段的唤醒提示（含括号内容里可能嵌套括号，粗匹配到句末）
  // 结尾锚定：动作文本里自带括号，非贪婪会提前断
  s = s.replace(/（系统提醒：[\s\S]*?不想也行。）/g, "");
  s = s.replace(/（你自己待着，[\s\S]*?不用回消息。）/g, "");
  s = s.replace(/（抽到：[\s\S]*?）/g, "");
  // 残留的括号碎片
  s = s.replace(/^[，,。.）)]+/, "");
  s = s.replace(/<dsh-remembers[\s\S]*?<\/dsh-remembers>/g, "");
  s = s.replace(/<\/?dsh-remembers[^>]*>/g, "");
  s = s.replace(/<\/?dsh-recall[^>]*>/g, "");
  s = s.replace(/以下是你的回忆起的内容[\s\S]*?不要编。/g, "");
  return s.trim();
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
    // 我们自己的注入块（状态/回忆/日记）不能算用户原话
    .replace(/<dsh-remembers[\s\S]*?<\/dsh-remembers>/g, "")
    .replace(/<dsh-recall[\s\S]*?<\/dsh-recall>/g, "")
    .replace(/<dsh-remembers[^>]*\/>/g, "")
    // 孤立残片（块被拆开后剩下的闭合标签）
    .replace(/<\/?dsh-remembers[^>]*>/g, "")
    .replace(/<\/?dsh-recall[^>]*>/g, "")
    // 系统提醒（cron 唤醒注入的，不是用户说的话）
    .replace(/（系统提醒：[\s\S]*?）/g, "")
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
