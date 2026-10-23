/**
 * companion-memory HTTP 客户端。
 *
 * 所有请求都「失败即降级」：记忆服务挂了不能影响对话本身。
 * 超时用 AbortSignal.timeout，避免一个卡死的请求拖住 pre-step。
 */

export class MemoryClient {
  constructor(config, logger = null) {
    this.baseUrl = String(config.endpoint || "").replace(/\/+$/, "");
    this.token = config.authToken || "";
    this.timeoutMs = Number(config.timeoutMs) || 2500;
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  log(stage, data) {
    this.logger?.debug?.(`[dsh-remembers] ${stage} ${JSON.stringify(data)}`);
  }

  async #request(method, path, body, timeoutMs) {
    if (!this.enabled) return null;
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (this.token) headers["X-Auth-Token"] = this.token;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
      });
      if (!res.ok) {
        this.log("http_error", { path, status: res.status });
        return null;
      }
      return await res.json();
    } catch (error) {
      this.log("request_failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 惊讶度门控：这一轮值不值得写进 L0。
   * 返回 {store, score, base, method}；服务不可用返回 null —— 调用方按「宁可存」
   * 处理，门控挂了不能把话丢掉。
   */
  async surprisal(text, context) {
    return this.#request("POST", "/surprisal", { text, context });
  }

  /**
   * LLM 抽取 + 逐条判定（ADD/UPDATE/DELETE/NONE）。
   * 两次 LLM 调用，可能几十秒 —— 调用方不要 await。
   */
  async extract({ userText, assistantText, subject = "self" }) {
    return this.#request("POST", "/extract", {
      user_text: userText,
      assistant_text: assistantText,
      subject,
    }, 120000);
  }

  /** 健康检查；用于启动时决定是否继续注入。 */
  async health() {
    return this.#request("GET", "/health");
  }

  /** L4 人格与关系设定，每轮必带。 */
  async profile(subject) {
    const suffix = subject ? `?subject=${encodeURIComponent(subject)}` : "";
    const res = await this.#request("GET", `/profile${suffix}`);
    return res?.items ?? null;
  }

  /** 混合检索。空数组 = 真的没印象，调用方必须尊重这个信号。 */
  async search({ query, focus, topK, subject }) {
    const res = await this.#request("POST", "/search", {
      query,
      focus,
      top_k: topK,
      subject,
    });
    return res?.hits ?? null;
  }

  /** 写入一条记忆。 */
  async ingest({ text, tier, subject, summary, tags, embed = true }) {
    const res = await this.#request("POST", "/ingest", {
      text,
      tier,
      subject,
      summary,
      tags,
      embed,
    });
    return res?.id ?? null;
  }

  /**
   * 人格设定：宪法区 + 自我认知区。
   * 两半都空 = 还没设过，插件那侧会整段不注入。服务不可用返回 null。
   */
  async persona() {
    const res = await this.#request("GET", "/persona");
    return res?.ok ? res : null;
  }

  /** 设置页保存：两半都能写。没传的字段服务端保持原值。 */
  async setPersona({ constitution, selfModel } = {}) {
    const body = {};
    if (constitution !== undefined) body.constitution = constitution;
    if (selfModel !== undefined) body.self_model = selfModel;
    return this.#request("POST", "/persona", body);
  }

  /** 只写自我认知区。宪法区没有对应参数，服务端层面就改不了。 */
  async setSelfModel(text) {
    return this.#request("POST", "/persona/self", { text });
  }

  /**
   * 把一段对话压成一条 L3 事件记录（episode）。
   * 要调 LLM，所以超时给足；服务端没配 LLM 时返回 {ok:false,degraded}。
   */
  async episode({ turns, subject = "self", window }) {
    return this.#request("POST", "/episode", { turns, subject, window }, 120000);
  }
}
