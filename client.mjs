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

  async #request(method, path, body) {
    if (!this.enabled) return null;
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (this.token) headers["X-Auth-Token"] = this.token;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
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
}
