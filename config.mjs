/**
 * 插件配置。
 *
 * 优先级：cordis patch 里写的 config > 环境变量 > 默认值。
 * 所有名字都带 CMEM_ 前缀，避免和别的插件撞车。
 */

export const PLUGIN_VERSION = "1.0.0";

const ENV = {
  endpoint: ["CMEM_URL", "CMEM_ENDPOINT"],
  authToken: ["CMEM_AUTH_TOKEN"],
  recallTopK: ["CMEM_RECALL_TOP_K"],
  recallMinChars: ["CMEM_RECALL_MIN_CHARS"],
  captureRaw: ["CMEM_CAPTURE_RAW"],
  captureMinChars: ["CMEM_CAPTURE_MIN_CHARS"],
  extract: ["CMEM_EXTRACT"],
  skipSubagentSessions: ["CMEM_SKIP_SUBAGENT"],
  injectProfile: ["CMEM_INJECT_PROFILE"],
  profileSubject: ["CMEM_PROFILE_SUBJECT"],
  timeoutMs: ["CMEM_TIMEOUT_MS"],
  logRequests: ["CMEM_LOG"],
  personaEnabled: ["CMEM_PERSONA"],
  personaOrder: ["CMEM_PERSONA_ORDER"],
  personaMaxChars: ["CMEM_PERSONA_MAX_CHARS"],
  personaRefreshMs: ["CMEM_PERSONA_REFRESH_MS"],
  personaAllowWrite: ["CMEM_PERSONA_ALLOW_WRITE"],
  episodeEnabled: ["CMEM_EPISODE"],
  episodeEveryTurns: ["CMEM_EPISODE_TURNS"],
  episodeMaxMinutes: ["CMEM_EPISODE_MINUTES"],
};

function pick(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function resolveConfig(input = {}, env = process.env) {
  const raw = input && typeof input === "object" ? input : {};
  const value = (key) => (raw[key] !== undefined ? raw[key] : pick(env, ENV[key]));

  return {
    version: PLUGIN_VERSION,
    endpoint: String(value("endpoint") ?? "http://127.0.0.1:8080"),
    authToken: String(value("authToken") ?? ""),
    recallTopK: toInt(value("recallTopK"), 6, 1, 20),
    // 太短的输入不查：一句「嗯」查出来也多半是噪声，短句靠 focus 顶
    recallMinChars: toInt(value("recallMinChars"), 1, 1, 200),
    injectProfile: toBool(value("injectProfile"), true),
    profileSubject: value("profileSubject") ? String(value("profileSubject")) : "",
    // 自动把每轮原话写进 L0：不做 LLM 抽取，只保证「说过的话不丢」
    captureRaw: toBool(value("captureRaw"), true),
    captureMinChars: toInt(value("captureMinChars"), 12, 1, 2000),
    // 开关 2：LLM 抽取 + 逐条判定（服务端要配 CMEM_LLM_*）。默认关，因为要花钱
    extract: toBool(value("extract"), false),
    skipSubagentSessions: toBool(value("skipSubagentSessions"), true),
    timeoutMs: toInt(value("timeoutMs"), 2500, 200, 30000),
    logRequests: toBool(value("logRequests"), false),

    // 人格设定：走 systemPrompt 独立段，每轮必带
    personaEnabled: toBool(value("personaEnabled"), true),
    // 排序：0 是官方 persona 段的位置，5 让本插件排在它之后、工具指引之前
    personaOrder: toInt(value("personaOrder"), 5, -10000, 10000),
    personaMaxChars: toInt(value("personaMaxChars"), 4000, 200, 16000),
    // 刷新节流：人格段落只在服务端改过才有意义，60s 足够，别每轮打一次
    personaRefreshMs: toInt(value("personaRefreshMs"), 60000, 1000, 600000),
    // 给不给 AI 写「自我认知区」的权限。宪法区无论如何都写不到（服务端没有那个入口）
    personaAllowWrite: toBool(value("personaAllowWrite"), true),

    // episode：攒够一段对话就压成一条 L3 事件，防止上下文被 compaction 压扁后什么都不剩。
    // 服务端没配 LLM 时会静默跳过（日志记 episode_degraded），不影响对话。
    episodeEnabled: toBool(value("episodeEnabled"), true),
    // 攒够这么多轮就压一次。20 轮大概是一段完整话题的量
    episodeEveryTurns: toInt(value("episodeEveryTurns"), 20, 3, 200),
    // 或者从这一段开始算起超过这么久也压一次：夜里断断续续聊也能收住
    episodeMaxMinutes: toInt(value("episodeMaxMinutes"), 120, 5, 1440),
  };
}
