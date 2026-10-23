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
  };
}
