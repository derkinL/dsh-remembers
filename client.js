/**
 * dsh-remembers 的设置页（浏览器半边）。
 *
 * 形态照着 DSH 自己的「模型 → 第三方模型提供商」那块：
 * 提供商下拉 → API 密钥 → 未配置时的提示 → 「自定义设置」折叠 → 取消 / 保存。
 *
 * 三点说明：
 *  1. 手写 React.createElement，不跑构建。DSH 的 client 插件就是
 *     `window.__ModuleLoader__.load({id, factory})` + `exports.apply/inject`。
 *  2. 只用原生元素加内联样式，不依赖 `@deepseek-ai/dsh-client-ui-primitives`
 *     是否被 seed —— 尺寸和配色尽量贴 DSH 的 `--dsw-*` 变量。
 *  3. 密钥只往服务端写，永不回显。服务端返回的是 `sk-03a…8719` 这种掩码，
 *     输入框留空 = 保持原值。
 */
window.__ModuleLoader__.load({
  id: "dsh-remembers",
  factory: (e) => {
    const module = { exports: {} };
    const exports = module.exports;   // CommonJS 语义：exports 是 module.exports 的别名
    try {
      const React = e("react");
      const h = React.createElement;

      // 公网访问时不能写死 127.0.0.1（那是用户自己的电脑）——
      // 按当前页面地址推导：主套 /mem，第二套 /lan/mem（caddy 反代到 8081/8082）
      function defaultServiceUrl() {
        try {
          const loc = window.location;
          const host = loc.hostname;
          if (host === "127.0.0.1" || host === "localhost") return "http://127.0.0.1:8080";
          const path = loc.pathname || "/";
          const base = path.startsWith("/lan/") ? "/lan/mem" : "/mem";
          const origin = loc.protocol + "//" + loc.host;
          return origin + base;
        } catch {
          return "http://127.0.0.1:8080";
        }
      }
      const URL_KEY = "dsh-remembers:serviceUrl";

      const PRESETS = {
        deepseek: {
          label: "DeepSeek",
          llm_base: "https://api.deepseek.com/v1",
          llm_model: "deepseek-flash",
          hint: "DeepSeek 官方 API。密钥在 platform.deepseek.com 申请。",
        },
        aliyun: {
          label: "阿里云百炼（含 embedding）",
          llm_base: "https://ws-bzw864scfibokwzf.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
          llm_model: "qwen-plus",
          embed_model: "qwen3.7-text-embedding-flash",
          hint: "阿里云一套 key 同时给对话模型和向量模型用。",
        },
        custom: {
          label: "自定义（OpenAI 兼容）",
          llm_base: "",
          llm_model: "",
          hint: "任何 OpenAI 兼容端点都可以，末尾记得带 /v1。",
        },
      };

      // -- 小工具 -----------------------------------------------------------

      function serviceUrl() {
        try {
          return window.localStorage.getItem(URL_KEY) || defaultServiceUrl();
        } catch {
          return defaultServiceUrl();
        }
      }

      function saveServiceUrl(url) {
        try {
          window.localStorage.setItem(URL_KEY, url);
        } catch {
          /* 隐私模式写不了，忽略 */
        }
      }

      async function call(path, init) {
        const res = await fetch(serviceUrl() + path, {
          ...(init || {}),
          headers: { "Content-Type": "application/json; charset=utf-8", ...(init && init.headers) },
          // 2026-10-27：原来没有超时。服务卡住时整页一直转圈、按钮点不动，
          // 也看不出是卡了还是慢。给一个上限，超时就当请求失败、页面给出错误。
          signal: (init && init.signal) || AbortSignal.timeout(20000),
        });
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new Error("服务返回的不是 JSON：" + text.slice(0, 120));
        }
        if (!res.ok) {
          throw new Error((data && (data.error || data.degraded)) || "HTTP " + res.status);
        }
        return data;
      }

      // -- 样式（对齐 DSH 的设置页观感） -------------------------------------

      // 全局按钮反馈（hover 变淡、按下缩放）
      if (typeof document !== "undefined" && !document.getElementById("dsh-mem-btn-style")) {
        const _st = document.createElement("style");
        _st.id = "dsh-mem-btn-style";
        _st.textContent =
          "button{transition:background .12s ease,border-color .12s ease,transform .1s ease,opacity .12s ease}" +
          "button:active{transform:scale(.97)}" +
          "button:disabled{opacity:.55;cursor:not-allowed}";
        document.head.appendChild(_st);
      }

      // 「她的记忆」导航（2026-11-07）：原来 7 个设置页签收进一个入口，用卡片点进去。
      // 卡片照教师工作台那套：白底 + l4 边框 + 0 2px 8px 投影，hover 上浮 4px、标题转亮蓝。
      // 内联样式做不到 :hover，所以单独挂一份 class。
      if (typeof document !== "undefined" && !document.getElementById("dsh-mem-hub-style")) {
        const _hub = document.createElement("style");
        _hub.id = "dsh-mem-hub-style";
        _hub.textContent = [
          ".dshm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}",
          "@media (max-width:760px){.dshm-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
          "@media (max-width:480px){.dshm-grid{grid-template-columns:minmax(0,1fr)}}",
          ".dshm-card{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:100%;",
          "padding:12px 14px;text-align:left;font-family:inherit;cursor:pointer;",
          "border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:12px;",
          "background:var(--dsw-alias-bg-base,#fff);box-shadow:0 2px 8px rgba(0,0,0,.05);",
          "transition:transform .2s ease,box-shadow .2s ease}",
          ".dshm-card:hover{transform:translateY(-4px);box-shadow:0 10px 24px rgba(0,0,0,.09)}",
          ".dshm-card:active{transform:translateY(0);box-shadow:0 2px 8px rgba(0,0,0,.05)}",
          // 勾选框统一换成开关样式（整个插件面板内有效，不污染宿主其它界面）
      ".dshm-ui input[type=\"checkbox\"]{-webkit-appearance:none;appearance:none;flex:0 0 auto;",
      "width:34px;height:20px;border-radius:999px;background:rgba(0,0,0,.18);position:relative;",
      "cursor:pointer;transition:background .15s;margin:0;border:none;vertical-align:middle}",
      ".dshm-ui input[type=\"checkbox\"]::after{content:\"\";position:absolute;top:2px;left:2px;",
      "width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.22);",
      "transition:left .15s}",
      ".dshm-ui input[type=\"checkbox\"]:checked{background:#4084ff}",
      ".dshm-ui input[type=\"checkbox\"]:checked::after{left:16px}",
      ".dshm-ui input[type=\"checkbox\"]:disabled{opacity:.45;cursor:not-allowed}",
      ".dshm-card:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4084ff);outline-offset:2px}",
          ".dshm-card:hover .dshm-title{color:var(--dsw-alias-state-business-primary,#4084ff)}",
          ".dshm-tile{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;",
          "border-radius:9px;background:rgba(64,132,255,.08);font-size:16px;line-height:1}",
          ".dshm-back{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:4px 8px;margin-left:-8px;",
          "border:none;border-radius:8px;background:transparent;cursor:pointer;font-family:inherit;font-size:12px;",
          "color:var(--dsw-alias-label-secondary,#6b7280)}",
          // 没保存块的页面：用和「保存」一模一样的白块装那颗返回，不做悬浮动效。
          ".dshm-fab{position:fixed;right:24px;top:50%;transform:translateY(-50%);z-index:9999;",
          "display:flex;flex-direction:column;gap:8px;box-sizing:border-box;min-width:140px;",
          "padding:12px 16px;border-radius:12px;border:1px solid rgba(0,0,0,.08);background:#fff;",
          "box-shadow:0 8px 24px rgba(0,0,0,.12)}",
          ".dshm-tabs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}",
          "@media (max-width:900px){.dshm-tabs{grid-template-columns:repeat(4,minmax(0,1fr))}}",
          "@media (max-width:600px){.dshm-tabs{grid-template-columns:repeat(3,minmax(0,1fr))}}",
          ".dshm-tab{height:34px;display:flex;align-items:center;justify-content:center;gap:5px;min-width:0;padding:0 8px;",
          "border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:10px;background:#fff;cursor:pointer;",
          "font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#111827);white-space:nowrap;",
          "overflow:hidden;text-overflow:ellipsis;transition:border-color .15s ease,background .15s ease}",
          ".dshm-tab:hover{border-color:rgba(64,132,255,.55)}",
          ".dshm-tab[data-on=\"1\"]{border-color:#4084ff;background:rgba(64,132,255,.06);font-weight:600;color:#2f6fe0}",
        ].join("");
        document.head.appendChild(_hub);
      }

      const S = {
        wrap: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 960, width: "100%", margin: "0 auto" },
        desc: { fontSize: 13, lineHeight: 1.6, color: "var(--dsw-color-text-secondary, #6b7280)" },
        card: {
          border: "1px solid var(--dsw-color-border-subtle, rgba(0,0,0,.08))",
          borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10,
          background: "var(--dsw-color-bg-subtle, #fafafa)",
        },
        field: { display: "flex", flexDirection: "column", gap: 6 },
        label: { fontSize: 13, fontWeight: 500, color: "var(--dsw-color-text-primary, #111827)" },
        input: {
          width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13,
          borderRadius: 8, border: "1px solid var(--dsw-color-border, rgba(0,0,0,.14))",
          background: "var(--dsw-color-bg, #fff)", color: "var(--dsw-color-text-primary, #111827)",
          outline: "none", fontFamily: "inherit", minWidth: 0,
        },
        select: {
          width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13,
          borderRadius: 8, border: "1px solid var(--dsw-color-border, rgba(0,0,0,.14))",
          background: "var(--dsw-color-bg, #fff)", color: "var(--dsw-color-text-primary, #111827)",
        },
        hint: { fontSize: 12, lineHeight: 1.6, color: "var(--dsw-color-text-warning, #b45309)" },
        muted: { fontSize: 12, color: "var(--dsw-color-text-secondary, #6b7280)" },
        row: { display: "flex", gap: 10, alignItems: "center" },
        footer: { display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 4 },
        btn: (primary) => ({
          padding: "8px 18px", fontSize: 13, borderRadius: 8, cursor: "pointer",
          // 按钮永远不换行、不被压缩：以前「保存并测试」在窄列里会折成两行，
          // 卡片跟着变高，页面就抖一下
          whiteSpace: "nowrap", flexShrink: 0,
          border: primary ? "1px solid transparent" : "1px solid var(--dsw-color-border, rgba(0,0,0,.14))",
          background: primary ? "var(--dsw-color-accent, #111827)" : "var(--dsw-color-bg, #fff)",
          color: primary ? "var(--dsw-color-accent-text, #fff)" : "var(--dsw-color-text-primary, #111827)",
          fontFamily: "inherit",
        }),

        disclosure: {
          display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          fontSize: 13, color: "var(--dsw-color-text-secondary, #6b7280)",
          background: "none", border: "none", padding: 0, fontFamily: "inherit",
        },
        notice: (kind) => ({
          fontSize: 12, lineHeight: 1.6, padding: "8px 12px", borderRadius: 8,
          background: kind === "ok" ? "rgba(16,185,129,.10)" : "rgba(239,68,68,.10)",
          color: kind === "ok" ? "#047857" : "#b91c1c",
        }),
        badge: (on) => ({
          display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
          color: on ? "#047857" : "#b45309",
        }),
        dot: (on) => ({
          width: 7, height: 7, borderRadius: "50%",
          background: on ? "#10b981" : "#f59e0b", display: "inline-block",
        }),
      };

      // -- 组件 -------------------------------------------------------------

      function Field(props) {
        return h("div", { style: S.field },
          h("label", { style: S.label }, props.label,
            props.optional ? h("span", { style: { ...S.muted, marginLeft: 6 } }, "（可选）") : null),
          props.children,
          props.hint ? h("div", { style: S.hint }, props.hint) : null,
        );
      }

      function SettingsSection(props) {
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState("");
        const [current, setCurrent] = React.useState(null);
        const [status, setStatus] = React.useState(null);
        const [configPath, setConfigPath] = React.useState("");
        const [advanced, setAdvanced] = React.useState(false);
        const [saving, setSaving] = React.useState(false);
        const [notice, setNotice] = React.useState(null);
        const [endpoint, setEndpoint] = React.useState(serviceUrl());
        const [pubStatus, setPubStatus] = React.useState(null);
        const [pubMsg, setPubMsg] = React.useState(null);
        const [pubPort, setPubPort] = React.useState("28582");
        const [draft, setDraft] = React.useState({
          provider: "deepseek",
          llm_key: "",
          llm_base: PRESETS.deepseek.llm_base,
          llm_model: PRESETS.deepseek.llm_model,
          embed_base: "",
          embed_model: "",
          embed_key: "",
          extract: true,
          surprisal_threshold: 0.35,
        });

        const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

        const load = React.useCallback(async () => {
          setLoading(true);
          setError("");
          try {
            const data = await call("/config");
            setCurrent(data.current);
            setStatus(data.status);
            setConfigPath(data.path || "");
            setNotice(null);
            setDraft((d) => ({
              ...d,
              llm_base: data.current.llm_base || "",
              llm_model: data.current.llm_model || "",
              llm_key: "",
              embed_base: data.current.embed_base || "",
              embed_model: data.current.embed_model || "",
              embed_key: "",
              extract: !!data.current.extract,
              surprisal_threshold: data.current.surprisal_threshold,
            }));
          } catch (err) {
            setError(
              "连不上记忆服务（" + serviceUrl() + "）。先确认它在跑：`systemctl status dsh-remembers` 或 `python server.py`。",
            );
          } finally {
            setLoading(false);
          }
        }, []);

        React.useEffect(() => { load(); }, [load]);

        const chooseProvider = (key) => {
          const p = PRESETS[key];
          if (p === undefined) return;
          set({ provider: key, llm_base: p.llm_base, llm_model: p.llm_model });
        };


        const removeAction = (texts, enabled, i, setTexts, setEnabled) => {
          const newTexts = texts.filter((_, j) => j !== i);
          const newEnabled = {};
          newTexts.forEach((_, j) => {
            const srcIdx = j < i ? j : j + 1;
            newEnabled[j] = enabled[srcIdx] !== false;
          });
          setTexts(newTexts);
          setEnabled(newEnabled);
        };

        const save = async () => {
          setSaving(true);
          setNotice(null);
          try {
            saveServiceUrl(endpoint);
            const body = {
              llm_base: draft.llm_base,
              llm_model: draft.llm_model,
              embed_base: draft.embed_base,
              embed_model: draft.embed_model,
              extract: !!draft.extract,
              surprisal_threshold: Number(draft.surprisal_threshold),
            };
            // 留空 = 保持原密钥；服务端也会忽略掩码回传
            if (draft.llm_key.trim()) body.llm_key = draft.llm_key.trim();
            if (draft.embed_key.trim()) body.embed_key = draft.embed_key.trim();
            const res = await call("/config", { method: "POST", body: JSON.stringify(body) });
            setStatus(res.status);
            setNotice({ kind: "ok", text: "已保存，立即生效（不用重启）" });
            await load();
          } catch (err) {
            setNotice({ kind: "error", text: "保存失败：" + (err && err.message ? err.message : String(err)) });
          } finally {
            setSaving(false);
          }
        };

        const cancel = () => {
          setDraft((d) => ({
            ...d,
            llm_key: "",
            embed_key: "",
            llm_base: current ? current.llm_base : d.llm_base,
            llm_model: current ? current.llm_model : d.llm_model,
            extract: current ? !!current.extract : d.extract,
            surprisal_threshold: current ? current.surprisal_threshold : d.surprisal_threshold,
          }));
          setNotice(null);
        };

        if (loading) {
          return h("div", { style: S.wrap }, h("div", { style: S.muted }, "正在读取配置…"));
        }

        const llmReady = status ? status.llm_enabled : false;
        const embedReady = status ? status.embedding_enabled : false;
        const extractOn = status ? status.extract_enabled : false;
        const preset = PRESETS[draft.provider] || PRESETS.custom;

        return h("div", { style: S.wrap },

          // 状态行
          h("div", { style: S.row },
            h("span", { style: S.badge(llmReady) }, h("span", { style: S.dot(llmReady) }), "对话模型"),
            h("span", { style: S.badge(embedReady) }, h("span", { style: S.dot(embedReady) }), "向量模型"),
            h("span", { style: S.badge(extractOn) }, h("span", { style: S.dot(extractOn) }), "自动抽取"),
            status && status.llm_model ? h("span", { style: S.muted }, status.llm_model) : null,
          ),

          h("div", { style: S.desc },
            "记忆服务要用一个对话模型来抽取事实、一个向量模型来算语义相似度。",
            "填一次就能一直用，密钥只存在服务端。",
          ),

          error ? h("div", { style: S.notice("error") }, error) : null,

          h("div", { style: S.card },

            h(Field, { label: "服务地址" },
              h("input", {
                style: S.input,
                value: endpoint,
                spellCheck: false,
                onChange: (ev) => setEndpoint(ev.target.value),
              }),
              h("div", { style: S.muted },
                "记忆服务地址会按当前页面自动推导（主套 /mem，第二套 /lan/mem）。本机开发默认 127.0.0.1:8080。"),
            ),

            h(Field, { label: "提供商" },
              h("select", {
                style: S.select,
                value: draft.provider,
                onChange: (ev) => chooseProvider(ev.target.value),
              }, Object.keys(PRESETS).map((k) => h("option", { key: k, value: k }, PRESETS[k].label))),
            ),

            h(Field, {
              label: "API 密钥",
              hint: current && current.llm_key_set
                ? "当前： " + current.llm_key_masked + "　留空则保持原值"
                : "还没配置。填好后点保存。",
            },
              h("input", {
                style: S.input,
                type: "password",
                value: draft.llm_key,
                placeholder: current && current.llm_key_set ? "留空保持原密钥" : "sk-...",
                spellCheck: false,
                autoComplete: "off",
                onChange: (ev) => set({ llm_key: ev.target.value }),
              }),
            ),

            !llmReady && !error
              ? h("div", { style: S.hint }, preset.hint)
              : null,

            // 「自定义设置」折叠
            h("div", null,
              h("button", {
                type: "button",
                style: S.disclosure,
                onClick: () => setAdvanced((v) => !v),
              }, h("span", null, advanced ? "▾" : "▸"), "自定义设置"),

              advanced
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 14, marginTop: 14 } },

                    h(Field, { label: "对话模型 Base URL", optional: true },
                      h("input", {
                        style: S.input, value: draft.llm_base, spellCheck: false,
                        onChange: (ev) => set({ llm_base: ev.target.value }),
                      }),
                    ),

                    h(Field, { label: "对话模型名", optional: true },
                      h("input", {
                        style: S.input, value: draft.llm_model, spellCheck: false,
                        onChange: (ev) => set({ llm_model: ev.target.value }),
                      }),
                    ),

                    h(Field, {
                      label: "向量模型 Base URL", optional: true,
                      hint: "和对话模型不是同一家时才需要单独填；阿里云那套两边可以共用同一个 key。",
                    },
                      h("input", {
                        style: S.input, value: draft.embed_base, spellCheck: false,
                        placeholder: "留空 = 和对话模型同源",
                        onChange: (ev) => set({ embed_base: ev.target.value }),
                      }),
                    ),

                    h(Field, { label: "向量模型名", optional: true },
                      h("input", {
                        style: S.input, value: draft.embed_model, spellCheck: false,
                        placeholder: "qwen3.7-text-embedding-flash",
                        onChange: (ev) => set({ embed_model: ev.target.value }),
                      }),
                    ),

                    h(Field, {
                      label: "向量模型 API 密钥", optional: true,
                      hint: current && current.embed_key_set
                        ? "当前： " + current.embed_key_masked + "　留空则保持原值"
                        : "留空 = 和对话模型用同一个密钥",
                    },
                      h("input", {
                        style: S.input, type: "password", value: draft.embed_key,
                        autoComplete: "off", spellCheck: false,
                        placeholder: current && current.embed_key_set ? "留空保持原密钥" : "留空 = 同上",
                        onChange: (ev) => set({ embed_key: ev.target.value }),
                      }),
                    ),

                  )
                : null,
            ),
          ),

          h("div", {
            style: {
              position: "fixed", right: 24, top: "50%", transform: "translateY(-50%)",
              display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8,
              background: "#ffffff", padding: "12px 16px", borderRadius: 12,
              border: "1px solid rgba(0,0,0,.08)", boxShadow: "0 8px 24px rgba(0,0,0,.12)", zIndex: 9999,
              minWidth: 140,
            },
          },
            props && props.onBack
              ? h("button", { type: "button", style: S.btn(false), onClick: props.onBack }, "← 她的记忆")
              : null,
            notice ? h("div", { style: { fontSize: 12, color: notice.kind === "error" ? "#c0392b" : "#2fa36b", textAlign: "center" } }, notice.text) : null,
            h("button", { type: "button", style: S.btn(true), onClick: save, disabled: saving },
              saving ? "保存中…" : "保存"),
          ),

          configPath
            ? h("div", { style: S.muted }, "配置文件：" + configPath + "（权限 600，密钥只在这里）")
            : null,
        );
      }

      // -- 人格设定（二合一里的「人」那一半） --------------------------------

      // ---------------------------------------------------------------------
      // 表情包：列表 + 上传（自动识别）+ 删除
      // ---------------------------------------------------------------------
      function MemeSection() {
        const [list, setList] = React.useState([]);
        const [busy, setBusy] = React.useState(false);
        const [msg, setMsg] = React.useState(null);
        const [editing, setEditing] = React.useState(null);
        const [pack, setPack] = React.useState("");
        const [packs, setPacks] = React.useState([]);
        const [view, setView] = React.useState("list");
        const [newPack, setNewPack] = React.useState(null);
        const [editPack, setEditPack] = React.useState(null);
        // 发表情包的频率：0 / 0.2 / 0.5 / 1.0。会和 find_meme 的描述一起告诉她
        const [memeRate, setMemeRate] = React.useState(null);
        // 文字颜 / emoji：总开关默认关闭，关着就完全不干预
        const [textStyleEnabled, setTextStyleEnabled] = React.useState(false);
        const [kaomojiRate, setKaomojiRate] = React.useState(0.2);
        const [emojiRate, setEmojiRate] = React.useState(0.2);

        const STYLE_OPTIONS = [
          { v: 0, label: "不用", hint: "一个都不加" },
          { v: 0.2, label: "20%", hint: "大约每 5 句一个" },
          { v: 0.5, label: "50%", hint: "大约每 2 句一个" },
          { v: 1, label: "100%", hint: "每句都带" },
        ];

        const RATE_OPTIONS = [
          { v: 0, label: "不发", hint: "只说话，不发图" },
          { v: 0.2, label: "20%", hint: "大约每 5 句一张" },
          { v: 0.5, label: "50%", hint: "大约每 2 句一张" },
          { v: 1, label: "100%", hint: "每句都配一张" },
        ];

        const loadRate = async () => {
          try {
            const r = await call("/proactive");
            const v = Number(r && r.memeRate);
            setMemeRate(Number.isFinite(v) ? v : 0.2);
            setTextStyleEnabled(Boolean(r && r.textStyleEnabled));
            const k = Number(r && r.kaomojiRate);
            setKaomojiRate(Number.isFinite(k) ? k : 0.2);
            const e = Number(r && r.emojiRate);
            setEmojiRate(Number.isFinite(e) ? e : 0.2);
          } catch {
            setMemeRate(0.2);
          }
        };

        const postProactive = async (body, note) => {
          try {
            await call("/proactive", { method: "POST", body: JSON.stringify(body) });
            if (note) setMsg(note);
          } catch (err) {
            setMsg("保存失败：" + (err && err.message ? err.message : String(err)));
          }
        };

        const saveRate = async (v) => {
          setMemeRate(v);
          try {
            await call("/proactive", { method: "POST", body: JSON.stringify({ memeRate: v }) });
            setMsg("表情包频率已设为：" + (v <= 0 ? "不发" : Math.round(v * 100) + "%"));
          } catch (err) {
            setMsg("保存失败：" + (err && err.message ? err.message : String(err)));
          }
        };

        const startEdit = (m) => {
          setEditing({ file: m.file, emotion: m.emotion || "", caption: m.caption || "", keywords: m.keywords || "" });
        };

        const saveEdit = async () => {
          if (!editing) return;
          try {
            await call("/memes", { method: "POST", body: JSON.stringify(editing) });
            setMsg("已保存：" + editing.file);
            setEditing(null);
            await load();
          } catch (err) {
            setMsg("保存失败：" + (err && err.message ? err.message : String(err)));
          }
        };

        const load = async () => {
          try {
            const url = "/memes?limit=300" + (pack ? "&pack=" + encodeURIComponent(pack) : "");
            const l = await call(url);
            setList(Array.isArray(l) ? l : []);
          } catch {
            setList([]);
          }
        };

        const loadPacks = async () => {
          try {
            const r = await call("/memes/packs");
            setPacks(Array.isArray(r) ? r : []);
          } catch {
            setPacks([]);
          }
        };

        React.useEffect(() => {
          void loadPacks();
          void loadRate();
        }, []);

        React.useEffect(() => {
          if (view === "detail") void load();
        }, [pack, view]);

        const upload = (ev) => {
          const file = ev.target.files && ev.target.files[0];
          if (!file) return;
          setBusy(true);
          setMsg(null);
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const res = await call("/memes/upload", {
                method: "POST",
                body: JSON.stringify({ filename: file.name, data: reader.result }),
              });
              setMsg("已上传：" + (res && res.caption ? res.caption : file.name));
              await load();
            } catch (err) {
              setMsg("失败：" + (err && err.message ? err.message : String(err)));
            } finally {
              setBusy(false);
            }
          };
          reader.readAsDataURL(file);
        };

        const remove = async (f) => {
          if (!window.confirm("删掉 " + f + "？")) return;
          try {
            await call("/memes/delete", { method: "POST", body: JSON.stringify({ file: f }) });
            await load();
          } catch {
            /* ignore */
          }
        };

        const EMO = { happy: "开心", angry: "生气", sad: "难过", shy: "害羞", confused: "疑惑", daily: "日常" };

        const addPack = async () => {
          if (!newPack || !newPack.id.trim()) return;
          setBusy(true);
          try {
            await call("/memes/packs/add", {
              method: "POST",
              body: JSON.stringify({ id: newPack.id.trim(), name: (newPack.name || newPack.id).trim() }),
            });
            setNewPack(null);
            await loadPacks();
          } catch (err) {
            setMsg("新建失败：" + (err && err.message ? err.message : String(err)));
          } finally {
            setBusy(false);
          }
        };

        // ===== 图库列表视图 =====
        if (view === "list") {
          // 左栏管「怎么发」（频率、文字颜），右栏摆图库卡片
          return h("div", { style: { display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" } },
            h("div", { style: { flex: "0 0 420px", minWidth: 340, display: "flex", flexDirection: "column", gap: 12 } },
            h("div", { style: S.desc },
              "她的表情包库，按图库分。点一个图库进去看里面的图。",
            ),
            // ---- 发表情包的频率 ----
            h("div", { style: { ...S.card, marginBottom: 14 } },
              h("div", { style: S.label }, "发表情包的频率"),
              h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
                "她多久主动发一张。这个频率会跟表情包工具一起告诉她，每轮都提醒，不会忘。"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 } },
                ...RATE_OPTIONS.map((o) => {
                  const on = memeRate !== null && Math.abs(Number(memeRate) - o.v) < 0.001;
                  return h("div", {
                    key: "meme-rate-" + o.v,
                    onClick: () => void saveRate(o.v),
                    style: {
                      padding: "10px 8px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                      border: on ? "1px solid #4084ff" : "1px solid rgba(0,0,0,.10)",
                      background: on ? "rgba(64,132,255,.06)" : "#fff",
                      transition: "border-color .15s, background .15s",
                    },
                  },
                    h("div", { style: { fontSize: 13, fontWeight: 600, color: on ? "#4084ff" : "#333" } }, o.label),
                    h("div", { style: { fontSize: 11, color: "#999", marginTop: 2 } }, o.hint),
                  );
                }),
              ),
            ),
            // ---- 文字颜 / emoji（总开关 + 两个频率）----
            h("div", { style: { ...S.card, marginBottom: 14 } },
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 } },
                h("div", { style: S.label }, "文字颜 / emoji"),
                h("div", {
                  onClick: () => {
                    const next = !textStyleEnabled;
                    setTextStyleEnabled(next);
                    void postProactive(
                      { textStyleEnabled: next },
                      "文字颜 / emoji 已" + (next ? "开启" : "关闭"),
                    );
                  },
                  style: {
                    display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                    padding: "4px 10px", borderRadius: 999,
                    border: textStyleEnabled ? "1px solid #4084ff" : "1px solid rgba(0,0,0,.12)",
                    background: textStyleEnabled ? "rgba(64,132,255,.06)" : "#fff",
                    transition: "border-color .15s, background .15s",
                  },
                },
                  h("div", {
                    style: {
                      width: 14, height: 14, borderRadius: 999, boxSizing: "border-box",
                      border: textStyleEnabled ? "4px solid #4084ff" : "1px solid rgba(0,0,0,.25)",
                      background: "#fff",
                    },
                  }),
                  h("span", { style: { fontSize: 12, color: textStyleEnabled ? "#4084ff" : "#666" } },
                    textStyleEnabled ? "已开启" : "已关闭"),
                ),
              ),
              h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 12 } },
                "默认关闭。关着的时候不给她任何指令，她想怎么说话就怎么说话。"),
              h("div", {
                style: {
                  opacity: textStyleEnabled ? 1 : 0.4,
                  pointerEvents: textStyleEnabled ? "auto" : "none",
                  transition: "opacity .15s",
                },
              },
                h("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, "文字颜 (￣▽￣)"),
                h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 14 } },
                  ...STYLE_OPTIONS.map((o) => {
                    const on = Math.abs(Number(kaomojiRate) - o.v) < 0.001;
                    return h("div", {
                      key: "kao-" + o.v,
                      onClick: () => {
                        setKaomojiRate(o.v);
                        void postProactive({ kaomojiRate: o.v }, "文字颜：" + o.label);
                      },
                      style: {
                        padding: "10px 8px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                        border: on ? "1px solid #4084ff" : "1px solid rgba(0,0,0,.10)",
                        background: on ? "rgba(64,132,255,.06)" : "#fff",
                        transition: "border-color .15s, background .15s",
                      },
                    },
                      h("div", { style: { fontSize: 13, fontWeight: 600, color: on ? "#4084ff" : "#333" } }, o.label),
                      h("div", { style: { fontSize: 11, color: "#999", marginTop: 2 } }, o.hint),
                    );
                  }),
                ),
                h("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, "emoji 😊"),
                h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 } },
                  ...STYLE_OPTIONS.map((o) => {
                    const on = Math.abs(Number(emojiRate) - o.v) < 0.001;
                    return h("div", {
                      key: "emo-" + o.v,
                      onClick: () => {
                        setEmojiRate(o.v);
                        void postProactive({ emojiRate: o.v }, "emoji：" + o.label);
                      },
                      style: {
                        padding: "10px 8px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                        border: on ? "1px solid #4084ff" : "1px solid rgba(0,0,0,.10)",
                        background: on ? "rgba(64,132,255,.06)" : "#fff",
                        transition: "border-color .15s, background .15s",
                      },
                    },
                      h("div", { style: { fontSize: 13, fontWeight: 600, color: on ? "#4084ff" : "#333" } }, o.label),
                      h("div", { style: { fontSize: 11, color: "#999", marginTop: 2 } }, o.hint),
                    );
                  }),
                ),
              ),
            ),
            ),

            h("div", { style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 } },
            h("div", { style: { display: "flex", gap: 8, marginBottom: 0, flexWrap: "wrap" } },
              h("button", {
                style: { ...S.btn(true), padding: "6px 14px", fontSize: 13 },
                onClick: () => setNewPack({ id: "", name: "" }),
              }, "新建图库包"),
              h("button", {
                style: { ...S.btn(false), padding: "6px 14px", fontSize: 13 },
                onClick: () => void loadPacks(),
              }, "刷新"),
            ),
            msg ? h("div", { style: S.muted }, msg) : null,
            h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 12 } },
              packs.map((pk) =>
                h("div", {
                  key: pk.pack,
                  onClick: () => { setPack(pk.pack === "all" ? "" : pk.pack); setView("detail"); },
                  onMouseEnter: (e) => {
                    e.currentTarget.style.transform = "translateY(-2px)";
                    e.currentTarget.style.boxShadow = "0 5px 14px rgba(0,0,0,.12)";
                  },
                  onMouseLeave: (e) => {
                    e.currentTarget.style.transform = "";
                    e.currentTarget.style.boxShadow = "";
                  },
                  style: {
                    border: "1px solid var(--dsw-alias-border-l4, rgba(0,0,0,.16))",
                    borderRadius: 12, overflow: "hidden", cursor: "pointer",
                    background: "var(--dsw-color-bg, #fff)",
                    display: "flex", flexDirection: "column",
                    boxShadow: "0 2px 8px rgba(0,0,0,.05)",
                    transition: "transform .12s ease, box-shadow .12s ease",
                  },
                },
                  h("div", {
                    style: {
                      width: "100%", height: 112,
                      backgroundColor: "var(--dsw-color-bg-secondary, #f3f4f6)",
                      backgroundImage: pk.cover
                        ? "url(" + serviceUrl() + "/memes/file/" + encodeURIComponent(pk.cover) + ")"
                        : "none",
                      backgroundSize: "cover",
                      backgroundPosition: "center 28%",
                      backgroundRepeat: "no-repeat",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 24,
                      color: "var(--dsw-color-text-secondary, #9ca3af)",
                    },
                  }, pk.cover ? null : (pk.pack === "all" ? "🗂️" : "🐟")),
                  h("div", { style: { padding: "8px 10px", display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 } },
                    h("div", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, pk.name),
                    h("div", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #6b7280)", marginLeft: "auto", flexShrink: 0 } }, pk.count + " 张"),
                  ),
                ),
              ),
            ),
            newPack ? h("div", {
              style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
              onClick: (ev) => { if (ev.target === ev.currentTarget) setNewPack(null); },
            },
              h("div", { style: { background: "var(--dsw-color-bg, #fff)", borderRadius: 12, padding: 20, width: 340, display: "flex", flexDirection: "column", gap: 10 } },
                h("div", { style: { fontSize: 15, fontWeight: 600 } }, "新建图库包"),
                h("input", {
                  placeholder: "图库 ID（英文/数字，如 my_pack）",
                  value: newPack.id,
                  onChange: (ev) => setNewPack({ ...newPack, id: ev.target.value }),
                  style: { ...S.input },
                }),
                h("input", {
                  placeholder: "显示名（如：我的收藏）",
                  value: newPack.name,
                  onChange: (ev) => setNewPack({ ...newPack, name: ev.target.value }),
                  style: { ...S.input },
                }),
                h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
                  h("button", { style: S.btn(false), onClick: () => setNewPack(null) }, "取消"),
                  h("button", { style: S.btn(true), onClick: () => void addPack() }, "创建"),
                ),
              ),
            ) : null,
            ),
          );
        }

        return h("div", { style: S.wrap },
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" } },
            h("button", {
              style: { ...S.btn(false), padding: "5px 12px", fontSize: 13 },
              onClick: () => { setView("list"); setPack(""); },
            }, "← 图库列表"),
            h("span", { style: { ...S.muted, fontSize: 12 } },
              "当前图库：" + (packs.find((p) => p.pack === pack)?.name || pack || "全部表情包") + " · " + list.length + " 张"),
            h("button", {
              style: { ...S.btn(false), padding: "5px 12px", fontSize: 12, marginLeft: "auto" },
              onClick: () => {
                const pid = pack || "all";
                const cur = packs.find((x) => x.pack === pid);
                setEditPack({ id: pid, name: cur ? cur.name : (pid === "all" ? "全部表情包" : pid), cover: cur ? cur.cover : "" });
              },
            }, "编辑图库"),
            (pack && pack !== "all") ? h("button", {
              style: { ...S.btn(false), padding: "5px 12px", fontSize: 12, color: "#e5484d" },
              onClick: async () => {
                if (!window.confirm("删除图库「" + (packs.find((p) => p.pack === pack)?.name || pack) + "」？（里面的图不会删，只是藏起来）")) return;
                try {
                  await call("/memes/packs/remove", { method: "POST", body: JSON.stringify({ id: pack }) });
                  setPack(""); setView("list");
                  await loadPacks();
                } catch (err) {
                  setMsg("删除失败：" + (err && err.message ? err.message : String(err)));
                }
              },
            }, "删除图库") : null,
          ),
          h("div", { style: S.desc },
            "上传后自动识别情绪和描述（视觉模型），她就能按情绪找图。",
          ),
          h("div", { style: S.row },
            h("label", {
              style: {
                ...S.btn(true), padding: "6px 14px", fontSize: 13, cursor: busy ? "not-allowed" : "pointer",
                display: "inline-block", opacity: busy ? 0.6 : 1,
              },
            },
              busy ? "正在上传…" : "新增表情包",
              h("input", {
                type: "file",
                accept: "image/*",
                onChange: upload,
                disabled: busy,
                style: { display: "none" },
              }),
            ),
            busy ? h("span", { style: S.muted }, "正在上传 + 识别…") : null,
          ),
          msg ? h("div", { style: S.muted }, msg) : null,
          h("div", {
            style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 },
          },
            list.map((m) => h("div", {
              key: m.file,
              onMouseEnter: (e) => {
                e.currentTarget.style.transform = "translateY(-3px)";
                e.currentTarget.style.boxShadow = "0 8px 18px rgba(0,0,0,.06)";
              },
              onMouseLeave: (e) => {
                e.currentTarget.style.transform = "";
                e.currentTarget.style.boxShadow = "";
              },
              style: {
                border: "1px solid var(--dsw-color-border-subtle, rgba(0,0,0,.08))",
                borderRadius: 10, padding: 6, display: "flex", flexDirection: "column", gap: 4,
                background: "var(--dsw-color-bg, #fff)",
                transition: "transform .16s ease, box-shadow .16s ease",
                willChange: "transform",
              },
            },
              h("img", {
                src: serviceUrl() + "/memes/file/" + encodeURIComponent(m.file),
                loading: "lazy",
                onError: (ev) => {
                  ev.target.style.display = "none";
                  if (ev.target.nextSibling) ev.target.nextSibling.style.display = "block";
                },
                style: { width: "100%", height: 90, objectFit: "contain", borderRadius: 6, background: "#f3f4f6" },
              }),
              h("div", {
                style: { display: "none", height: 90, alignItems: "center", justifyContent: "center", fontSize: 11, color: "#9ca3af", textAlign: "center", padding: 4 },
              }, m.file + "（加载失败）"),
              h("div", { style: { fontSize: 11, fontWeight: 500 } }, EMO[m.emotion] || "未分类"),
              h("div", {
                style: {
                  fontSize: 11, color: "var(--dsw-color-text-secondary, #6b7280)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                },
              }, m.caption || m.file),
              h("div", { style: { display: "flex", gap: 4 } },
                h("button", {
                  style: { ...S.btn(false), padding: "2px 8px", fontSize: 11, flex: 1 },
                  onClick: () => startEdit(m),
                }, "编辑"),
                h("button", {
                  style: { ...S.btn(false), padding: "2px 8px", fontSize: 11, flex: 1 },
                  onClick: () => void remove(m.file),
                }, "删除"),
              ),
            )),
          ),
          editPack ? h("div", {
            style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
            onClick: (ev) => { if (ev.target === ev.currentTarget) setEditPack(null); },
          },
            h("div", { style: { background: "var(--dsw-color-bg, #fff)", borderRadius: 12, padding: 20, width: 460, maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 12 } },
              h("div", { style: { fontSize: 15, fontWeight: 600 } }, "编辑图库"),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                h("span", { style: { ...S.muted, fontSize: 12 } }, "名称"),
                h("input", {
                  value: editPack.name,
                  onChange: (ev) => setEditPack({ ...editPack, name: ev.target.value }),
                  style: { ...S.input },
                }),
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 } },
                h("span", { style: { ...S.muted, fontSize: 12 } }, "封面（从图库里选一张，点一下选中）"),
                h("div", {
                  style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 6, overflowY: "auto", maxHeight: 320, padding: 2 },
                },
                  list.map((m) =>
                    h("div", {
                      key: m.file,
                      onClick: () => setEditPack({ ...editPack, cover: m.file }),
                      style: {
                        height: 72, borderRadius: 8, cursor: "pointer", overflow: "hidden",
                        border: editPack.cover === m.file ? "2px solid #4084ff" : "1px solid rgba(0,0,0,.08)",
                        backgroundImage: "url(" + serviceUrl() + "/memes/file/" + encodeURIComponent(m.file) + ")",
                        backgroundSize: "cover",
                        backgroundPosition: "center 28%",
                      },
                    }),
                  ),
                ),
              ),
              h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" } },
                h("button", {
                  style: { ...S.btn(false), padding: "4px 10px", fontSize: 12 },
                  onClick: () => setEditPack({ ...editPack, cover: "" }),
                }, "恢复默认封面"),
                h("div", { style: { display: "flex", gap: 8 } },
                  h("button", { style: S.btn(false), onClick: () => setEditPack(null) }, "取消"),
                  h("button", {
                    style: S.btn(true),
                    onClick: async () => {
                      setBusy(true);
                      try {
                        await call("/memes/packs/update", {
                          method: "POST",
                          body: JSON.stringify({ id: editPack.id, name: editPack.name, cover: editPack.cover }),
                        });
                        setEditPack(null);
                        await loadPacks();
                      } catch (err) {
                        setMsg("保存失败：" + (err && err.message ? err.message : String(err)));
                      } finally {
                        setBusy(false);
                      }
                    },
                  }, "保存"),
                ),
              ),
            ),
          ) : null,
          editing ? h("div", {
            style: {
              position: "fixed", inset: 0, background: "rgba(0,0,0,.35)",
              display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
            },
            onClick: (ev) => { if (ev.target === ev.currentTarget) setEditing(null); },
          },
            h("div", {
              style: {
                background: "var(--dsw-color-bg, #fff)", borderRadius: 12, padding: 18,
                width: 420, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 10,
              },
            },
              h("div", { style: { fontWeight: 600, fontSize: 14 } }, "编辑表情包"),
              h("img", {
                src: serviceUrl() + "/memes/file/" + encodeURIComponent(editing.file) + "?t=" + Date.now(),
                style: {
                  maxWidth: "100%", maxHeight: 180, objectFit: "contain",
                  borderRadius: 8, background: "#f3f4f6", alignSelf: "center",
                },
              }),
              h("div", { style: S.muted }, editing.file),
              h("div", { style: S.field },
                h("div", { style: S.label }, "分类"),
                h("select", {
                  style: S.select,
                  value: editing.emotion,
                  onChange: (ev) => setEditing({ ...editing, emotion: ev.target.value }),
                },
                  h("option", { value: "" }, "未分类"),
                  Object.keys(EMO).map((k) => h("option", { key: k, value: k }, EMO[k])),
                ),
              ),
              h("div", { style: S.field },
                h("div", { style: S.label }, "描述"),
                h("textarea", {
                  style: { ...S.input, minHeight: 60, resize: "vertical" },
                  value: editing.caption,
                  onChange: (ev) => setEditing({ ...editing, caption: ev.target.value }),
                }),
              ),
              h("div", { style: S.field },
                h("div", { style: S.label }, "关键词（空格分隔）"),
                h("input", {
                  style: S.input,
                  value: editing.keywords,
                  onChange: (ev) => setEditing({ ...editing, keywords: ev.target.value }),
                }),
              ),
              h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 } },
                h("button", { style: S.btn(false), onClick: () => setEditing(null) }, "取消"),
                h("button", { style: S.btn(true), onClick: () => void saveEdit() }, "保存"),
              ),
            ),
          ) : null,
        );
      }

      // ---------------------------------------------------------------------
      // 主动消息：唤醒规则（她醒来之后干嘛由她自己决定）
      // ---------------------------------------------------------------------
      function ProactiveSection(props) {
        const [cfg, setCfg] = React.useState(null);
        const [qqBusy, setQqBusy] = React.useState(false);
        const [qqMsg, setQqMsg] = React.useState(null);
        const [silentActions, setSilentActions] = React.useState([]);
        const [silentActionEnabled, setSilentActionEnabled] = React.useState({});
        const [talkActionEnabled, setTalkActionEnabled] = React.useState({});
        const [talkActions, setTalkActions] = React.useState([]);
        const [newAction, setNewAction] = React.useState({ silent: "", talk: "" });

        // 删除一条动作（文本 + 启用状态一起删，索引要重排）
        const removeAction = (texts, enabled, i, setTexts, setEnabled) => {
          const newTexts = texts.filter((_, j) => j !== i);
          const newEnabled = {};
          newTexts.forEach((_, j) => {
            const srcIdx = j < i ? j : j + 1;
            newEnabled[j] = enabled[srcIdx] !== false;
          });
          setTexts(newTexts);
          setEnabled(newEnabled);
        };
        const [msg, setMsg] = React.useState(null);
        const [err, setErr] = React.useState(null);

        const load = async () => {
          setErr(null);
          try {
            const c = await call("/proactive");
            const parseActions = (arr) => {
              const texts = [];
              const enabled = {};
              (Array.isArray(arr) ? arr : []).forEach((a, i) => {
                if (a && typeof a === "object") {
                  texts.push(String(a.text || ""));
                  enabled[i] = a.enabled !== false;
                } else {
                  texts.push(String(a || ""));
                  enabled[i] = true;
                }
              });
              return { texts, enabled };
            };
            const sp = parseActions(c.silentActions);
            const tp = parseActions(c.talkActions);
            setCfg(c);
            setSilentActions(sp.texts);
            setTalkActions(tp.texts);
            setSilentActionEnabled(sp.enabled);
            setTalkActionEnabled(tp.enabled);
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
            setCfg(null);
          }
        };

        React.useEffect(() => {
          void load();
        }, []);

        const save = async () => {
          if (!cfg) return;
          try {
            const packActions = (texts, enabled) =>
              texts.map((txt, i) => ({ text: txt, enabled: enabled[i] !== false }));
            await call("/proactive", {
              method: "POST",
              body: JSON.stringify({
                ...cfg,
                silentActions: packActions(silentActions, silentActionEnabled),
                talkActions: packActions(talkActions, talkActionEnabled),
              }),
            });
            setMsg("已保存");
            setErr(null);
          } catch (e) {
            setMsg("保存失败：" + (e && e.message ? e.message : String(e)));
          }
        };

        if (!cfg) {
          return h("div", { style: S.wrap },
            err ? h("div", { style: S.notice("error") }, "读取失败：" + err)
              : h("div", { style: S.muted }, "读取配置…"));
        }

        const num = (key, label, hint) => h("div", { style: S.field },
          h("div", { style: S.label }, label),
          h("input", {
            type: "number",
            style: S.input,
            value: cfg[key],
            onChange: (ev) => setCfg({ ...cfg, [key]: Number(ev.target.value) || 0 }),
          }),
          hint ? h("div", { style: S.muted }, hint) : null,
        );

        const toggle = (key, label, hint) => h("label", {
          style: {
            display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
            padding: "8px 10px", borderRadius: 8, marginBottom: 8,
            border: "1.5px solid " + (cfg[key] ? "#4084ff" : "rgba(0,0,0,.10)"),
            background: cfg[key] ? "rgba(64,132,255,.04)" : "#ffffff",
            transition: "border-color .15s, background .15s",
          },
        },
          h("input", {
            type: "checkbox",
            checked: !!cfg[key],
            onChange: (ev) => setCfg({ ...cfg, [key]: ev.target.checked }),
            style: { marginTop: 2 },
          }),
          h("span", { style: { display: "flex", flexDirection: "column", gap: 2 } },
            h("span", { style: { fontSize: 13, fontWeight: 500 } }, label),
            hint ? h("span", { style: { ...S.muted, fontSize: 12 } }, hint) : null,
          ),
        );

        return h("div", { style: { ...S.wrap, maxWidth: 1180 } },
          h("div", { style: S.desc },
            "定时把她叫醒。醒来之后她想干嘛（发呆 / 上网 / 找你 / 发图）由她自己决定——"
            + "关掉「允许发消息」就是只唤醒、不打扰。",
          ),
          h("div", { style: { display: "grid", gridTemplateColumns: "460px minmax(320px, 1fr)", gap: 20, alignItems: "start" } },


          h("div", { style: { ...S.card, gridColumn: "1" } },
            toggle("enabled", "自动唤醒", "总开关：关掉后完全不叫醒她"),
            toggle("talkEnabled", "允许她主动发消息", "关掉 = 只唤醒她、不给你发消息（静默活动）"),
          ),

          h("div", { style: { ...S.card, gridColumn: "1" } },
            h("div", { style: S.label }, "她的主动性"),
            h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
              "勾上之后会写进她的系统提示词。关掉 = 她不会主动约时间，只被动等你。（「刷完 B 站可以主动分享」已经挪到 B 站页）"),

            h("div", {
              style: {
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                padding: "8px 10px", borderRadius: 8, marginBottom: 8,
                border: "1.5px solid " + (cfg.autoScheduleEnabled !== false ? "#4084ff" : "rgba(0,0,0,.10)"),
                background: cfg.autoScheduleEnabled !== false ? "rgba(64,132,255,.04)" : "#fff",
              },
              onClick: () => setCfg({ ...cfg, autoScheduleEnabled: cfg.autoScheduleEnabled === false }),
            },
              h("input", {
                type: "checkbox",
                checked: cfg.autoScheduleEnabled !== false,
                onClick: (ev) => ev.stopPropagation(),
                onChange: (ev) => setCfg({ ...cfg, autoScheduleEnabled: ev.target.checked }),
                style: { marginTop: 3 },
              }),
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: 13, fontWeight: 500 } }, "聊完可以自己约下次时间"),
                h("div", { style: { ...S.muted, fontSize: 12, marginTop: 2 } },
                  "聊完觉得过会儿还想找你，她可以用 schedule_create 设个时间，到点自己来找你"),
              ),
            ),

          ),

          h("div", { style: { ...S.card, gridColumn: "2", gridRow: "1 / span 3" } },
            h("div", { style: S.label }, "她醒着能做什么"),
            h("div", { style: { ...S.muted, marginBottom: 8 } },
              "每次唤醒随机抽一条当作她这轮的状态提示。静默=她自己待着，说话=可以找你。改完点下面的保存。"),

            h("div", { style: { ...S.muted, fontSize: 11, marginTop: 4 } }, "她自己做什么（自己待着，不找你）"),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 } },
              silentActions.map((a, i) => h("label", {
                key: "s" + i,
                style: {
                  display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, cursor: "pointer",
                  padding: "8px 10px", borderRadius: 8,
                  border: "1.5px solid " + (silentActionEnabled[i] !== false ? "#4084ff" : "rgba(0,0,0,.10)"),
                  background: silentActionEnabled[i] !== false ? "rgba(64,132,255,.04)" : "#ffffff",
                  transition: "border-color .15s, background .15s",
                },
              },
                h("input", {
                  type: "checkbox",
                  checked: silentActionEnabled[i] !== false,
                  onChange: (ev) => { ev.stopPropagation(); setSilentActionEnabled((prev) => ({ ...prev, [i]: prev[i] === false })); },
                  style: { marginTop: 2, flexShrink: 0 },
                }),
                h("span", { style: { flex: 1, lineHeight: "18px" } }, a),
                h("span", { style: { cursor: "pointer", opacity: 0.55, padding: "0 4px", fontSize: 14, lineHeight: "18px" }, onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); removeAction(silentActions, silentActionEnabled, i, setSilentActions, setSilentActionEnabled); } }, "×"),
              )),
            ),
            h("div", { style: { display: "flex", gap: 6, marginTop: 6 } },
              h("input", {
                style: { ...S.input, flex: 1 }, placeholder: "加一个（例如：躺着听雨声）",
                value: newAction.silent,
                onChange: (ev) => setNewAction({ ...newAction, silent: ev.target.value }),
                onKeyDown: (ev) => {
                  if (ev.key === "Enter" && newAction.silent.trim()) {
                    setSilentActions([...silentActions, newAction.silent.trim()]);
                    setNewAction({ ...newAction, silent: "" });
                  }
                },
              }),
              h("button", {
                style: { ...S.btn(false), fontSize: 12 },
                onClick: () => {
                  if (newAction.silent.trim()) {
                    setSilentActions([...silentActions, newAction.silent.trim()]);
                    setNewAction({ ...newAction, silent: "" });
                  }
                },
              }, "加"),
            ),

            h("div", { style: { ...S.muted, fontSize: 11, marginTop: 14 } }, "她想找你做什么（可以主动发消息）"),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 } },
              talkActions.map((a, i) => h("label", {
                key: "t" + i,
                style: {
                  display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, cursor: "pointer",
                  padding: "8px 10px", borderRadius: 8,
                  border: "1.5px solid " + (talkActionEnabled[i] !== false ? "#4084ff" : "rgba(0,0,0,.10)"),
                  background: talkActionEnabled[i] !== false ? "rgba(64,132,255,.04)" : "#ffffff",
                  transition: "border-color .15s, background .15s",
                },
              },
                h("input", {
                  type: "checkbox",
                  checked: talkActionEnabled[i] !== false,
                  onChange: (ev) => { ev.stopPropagation(); setTalkActionEnabled((prev) => ({ ...prev, [i]: prev[i] === false })); },
                  style: { marginTop: 2, flexShrink: 0 },
                }),
                h("span", { style: { flex: 1, lineHeight: "18px" } }, a),
                h("span", { style: { cursor: "pointer", opacity: 0.55, padding: "0 4px", fontSize: 14, lineHeight: "18px" }, onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); removeAction(talkActions, talkActionEnabled, i, setTalkActions, setTalkActionEnabled); } }, "×"),
              )),
            ),
            h("div", { style: { display: "flex", gap: 6, marginTop: 6 } },
              h("input", {
                style: { ...S.input, flex: 1 }, placeholder: "加一个（例如：想问他明天忙不忙）",
                value: newAction.talk,
                onChange: (ev) => setNewAction({ ...newAction, talk: ev.target.value }),
                onKeyDown: (ev) => {
                  if (ev.key === "Enter" && newAction.talk.trim()) {
                    setTalkActions([...talkActions, newAction.talk.trim()]);
                    setNewAction({ ...newAction, talk: "" });
                  }
                },
              }),
              h("button", {
                style: { ...S.btn(false), fontSize: 12 },
                onClick: () => {
                  if (newAction.talk.trim()) {
                    setTalkActions([...talkActions, newAction.talk.trim()]);
                    setNewAction({ ...newAction, talk: "" });
                  }
                },
              }, "加"),
            ),
          ),

          h("div", { style: { ...S.card, gridColumn: "1" } },
            h("div", { style: S.desc }, "唤醒规则"),
            h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
              "选一套预设，下面的参数自动套上并锁定。要自己调就点「自定义」解锁。"),

            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 } },
              ...[
                ["cold", "冷漠", "一天 2-3 次", { startHour: 10, endHour: 21, minGapMinutes: 240, maxGapMinutes: 480, silentRatio: 70, wakeActionCount: 1 }],
                ["normal", "普通", "一天 5-8 次", { startHour: 8, endHour: 23, minGapMinutes: 30, maxGapMinutes: 180, silentRatio: 40, wakeActionCount: 3 }],
                ["warm", "热情", "一天 10+ 次", { startHour: 8, endHour: 24, minGapMinutes: 15, maxGapMinutes: 60, silentRatio: 20, wakeActionCount: 5 }],
              ].map(([key, label, hint, params]) => {
                const on = (cfg.wakePreset || "normal") === key;
                return h("div", {
                  key: "wp-" + key,
                  onClick: () => setCfg({ ...cfg, ...params, wakePreset: key }),
                  style: {
                    cursor: "pointer", padding: "8px 10px", borderRadius: 8,
                    border: "1.5px solid " + (on ? "#4084ff" : "rgba(0,0,0,.10)"),
                    background: on ? "rgba(64,132,255,.04)" : "#fff",
                    transition: "border-color .15s, background .15s",
                  },
                },
                  h("div", { style: { fontSize: 13, fontWeight: on ? 600 : 500 } }, label),
                  h("div", { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, hint),
                );
              }),
            ),

            h("div", {
              onClick: () => setCfg({ ...cfg, wakePreset: (cfg.wakePreset === "custom" ? "normal" : "custom") }),
              style: {
                display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                padding: "8px 12px", borderRadius: 8, marginBottom: 12,
                border: "1.5px solid " + ((cfg.wakePreset === "custom") ? "#f59e0b" : "rgba(0,0,0,.10)"),
                background: (cfg.wakePreset === "custom") ? "rgba(245,158,11,.05)" : "#fafafa",
              },
            },
              h("span", { style: { fontSize: 14 } }, (cfg.wakePreset === "custom") ? "🔓" : "🔒"),
              h("span", { style: { fontSize: 12, fontWeight: 500 } },
                (cfg.wakePreset === "custom") ? "自定义（已解锁，可改下面参数）" : "自定义（点这里解锁）"),
            ),

            h("div", { style: {
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
              pointerEvents: (cfg.wakePreset === "custom") ? "auto" : "none",
              opacity: (cfg.wakePreset === "custom") ? 1 : 0.55,
              transition: "opacity .15s",
            } },
              num("startHour", "开始小时（0-23）", "几点之前不唤醒"),
              num("endHour", "结束小时（0-23）", "到几点就不再唤醒"),
              num("minGapMinutes", "最小间隔（分钟）", "两次唤醒之间至少隔多久"),
              num("maxGapMinutes", "最大间隔（分钟）", "两次唤醒之间最多隔多久"),
            ),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
              num("wakeActionCount", "唤醒时给几个选项", "抽几条动作让她挑，1=只给一条"),
              num("silentRatio", "静默概率（%）", "醒来后不打扰你的比例"),
            ),
          ),

          ),
          h("div", {
            style: {
              position: "fixed", right: 24, top: "50%", transform: "translateY(-50%)",
              display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8,
              background: "#ffffff", padding: "12px 16px", borderRadius: 12,
              border: "1px solid rgba(0,0,0,.08)", boxShadow: "0 8px 24px rgba(0,0,0,.12)", zIndex: 9999,
              minWidth: 140,
            },
          },
            props && props.onBack
              ? h("button", { type: "button", style: S.btn(false), onClick: props.onBack }, "← 她的记忆")
              : null,
            msg ? h("div", { style: { fontSize: 12, color: msg.includes("失败") ? "#c0392b" : "#2fa36b", textAlign: "center" } }, msg) : null,
            h("button", { style: S.btn(true), onClick: () => void save() }, "保存"),
          ),
        );
      }

      // B 站选题的预设标签（按分区整理，点一下就能选）
      const PRESET_LIKE = [
        "猫咪", "狗狗", "宠物", "萌宠", "动物",
        "科技", "数码", "手机", "电脑", "AI", "编程", "极客",
        "游戏", "电竞", "主机", "手游", "单机", "游戏实况", "速通",
        "鬼畜", "搞笑", "沙雕", "整活",
        "音乐", "翻唱", "Vocaloid", "纯音乐", "DJ",
        "舞蹈", "宅舞", "街舞",
        "美食", "做饭", "厨艺", "探店", "吃播",
        "动漫", "番剧", "二次元", "cos",
        "电影", "影视解说", "影评",
        "纪录片", "科普", "历史", "人文",
        "知识", "学习", "考研", "公开课",
        "生活", "vlog", "日常",
        "手工", "DIY", "模型", "手办",
        "绘画", "画师", "插画", "板绘",
        "摄影", "摄像",
        "运动", "健身", "跑步",
        "治愈", "白噪音", "ASMR", "助眠",
        "猫咪视频", "猫meme", "萌宠日常",
      ];

      const PRESET_DISLIKE = [
        "恐怖", "惊悚", "恐怖游戏", "血腥", "暴力",
        "擦边", "软色情", "擦边舞", "宅男向",
        "猎奇", "重口", "恶心",
        "争吵", "节奏", "撕逼", "引战",
        "带货", "广告", "推广", "营销号", "标题党",
        "政治", "时政",
        "装疯卖傻", "lowb", "土味",
        "ASMR擦边", "整蛊",
      ];

      /** 标签选择器：预设点选 + 自定义输入。 */
      function TagPicker({ presets, value, onChange, placeholder }) {
        const [draft, setDraft] = React.useState("");
        const list = Array.isArray(value) ? value : [];
        const toggle = (tag) => {
          if (list.includes(tag)) onChange(list.filter((x) => x !== tag));
          else onChange([...list, tag]);
        };
        const addDraft = () => {
          const v = draft.trim();
          if (!v) return;
          if (!list.includes(v)) onChange([...list, v]);
          setDraft("");
        };
        const isOn = (tag) => list.includes(tag);
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5 } },
            presets.map((tag) =>
              h("button", {
                key: tag,
                onClick: () => toggle(tag),
                style: {
                  fontSize: 12, lineHeight: "20px", padding: "1px 9px", borderRadius: 999,
                  cursor: "pointer", border: "1px solid " + (isOn(tag) ? "transparent" : "rgba(127,127,127,.28)"),
                  background: isOn(tag) ? "rgba(64,132,255,.16)" : "transparent",
                  color: isOn(tag) ? "#4084ff" : "inherit",
                },
              }, tag),
            ),
          ),
          h("div", { style: { display: "flex", gap: 6 } },
            h("input", {
              style: { ...S.input, flex: 1 },
              placeholder,
              value: draft,
              onChange: (ev) => setDraft(ev.target.value),
              onKeyDown: (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addDraft(); } },
            }),
            h("button", { style: { ...S.btn(false), fontSize: 12, padding: "0 10px" }, onClick: addDraft }, "添加"),
          ),
          list.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 } },
            list.map((tag) =>
              h("span", {
                key: tag,
                style: {
                  fontSize: 12, padding: "1px 7px", borderRadius: 999,
                  background: "rgba(64,132,255,.14)", color: "#4084ff",
                  display: "inline-flex", alignItems: "center", gap: 4,
                },
              },
                tag,
                h("span", {
                  style: { cursor: "pointer", opacity: 0.7, fontWeight: 600 },
                  onClick: () => toggle(tag),
                }, "×"),
              ),
            ),
          ) : h("div", { style: { ...S.muted, fontSize: 11 } }, "还没选（空着就按默认偏好）"),
        );
      }

      // ---------------------------------------------------------------------
      // B 站：账号状态 + 开关（她自己的号，嘴走 QQ 那套）
      // ---------------------------------------------------------------------
      function BiliSection(props) {
        const [st, setSt] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [test, setTest] = React.useState(null);
        const [err, setErr] = React.useState(null);
        const [sessdata, setSessdata] = React.useState("");
        const [ownerMid, setOwnerMid] = React.useState("");
        const ownerInit = React.useRef("");
        const [biliCfg, setBiliCfg] = React.useState(null);
        const [biliTools, setBiliTools] = React.useState(null);
        const [biliForm, setBiliForm] = React.useState({});
        const [savedAt, setSavedAt] = React.useState(null);
        const [biliProactive, setBiliProactive] = React.useState(null);
        const [autoShare, setAutoShare] = React.useState(true);
        const [ownerName, setOwnerName] = React.useState("");
        const [ownerMsg, setOwnerMsg] = React.useState(null);
        const [qr, setQr] = React.useState(null);
        const [qrState, setQrState] = React.useState(null);
        const [biliJct, setBiliJct] = React.useState("");
        const [buvid3, setBuvid3] = React.useState("");
        const [loginMsg, setLoginMsg] = React.useState(null);

        const load = async () => {
          setErr(null);
          try {
            const s = await call("/bili/status");
            setSt(s);
            if (s && s.owner_mid) setOwnerMid(s.owner_mid);
            if (s && s.owner_name) setOwnerName(s.owner_name);
            ownerInit.current = (s && s.owner_mid) || "";
            try {
              const c = await call("/bili/cfg");
              setBiliCfg(c);
              setBiliForm({
                like: (c.preferences || {}).like || [],
                dislike: (c.preferences || {}).dislike || [],
                skipChance: (c.night || {}).skipChance ?? 0.3,
                maxVideos: (c.night || {}).maxVideos ?? 6,
                minGapMin: (c.night || {}).minGapMin ?? 10,
                name: (c.persona || {}).name || "",
                ownerTitle: (c.persona || {}).ownerTitle || "",
                selfClaim: (c.persona || {}).selfClaim || "",
                aiCommentGuard: !!((c.share || {}).aiCommentGuard),
                mentionSummary: !!((c.listen || {}).mentionSummary),
              });
            } catch { setBiliCfg(null); }
            try { setBiliTools(await call("/bili/tools")); } catch { setBiliTools(null); }
            try {
              const cg = await call("/config");
              setAutoShare(cg && cg.autoShareEnabled !== false);
            } catch { /* 读不到就保持默认开 */ }
            try {
              const p = await call("/proactive");
              setBiliProactive({
                biliShareToOwner: p.biliShareToOwner !== false,
                biliShareToGroup: p.biliShareToGroup === true,
                biliComment: p.biliComment !== false,
                biliMentionOwner: p.biliMentionOwner !== false,
                biliBrowseEnabled: p.biliBrowseEnabled === true,
                biliMinGapMinutes: Number(p.biliMinGapMinutes) || 60,
                biliMaxGapMinutes: Number(p.biliMaxGapMinutes) || 240,
                biliBrowseLimit: Number(p.biliBrowseLimit) || 3,
                biliBrowsePerDay: Number(p.biliBrowsePerDay) || 10,
              });
            } catch {
              setBiliProactive({
                biliShareToOwner: true, biliShareToGroup: false, biliComment: true, biliMentionOwner: true,
                biliBrowseEnabled: false, biliMinGapMinutes: 60, biliMaxGapMinutes: 240,
                biliBrowseLimit: 3, biliBrowsePerDay: 10,
              });
            }
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
            setSt(null);
          }
        };

        React.useEffect(() => {
          void load();
        }, []);

        const startQr = async () => {
          setBusy(true);
          setQrState("生成二维码…");
          try {
            const r = await call("/bili/qr");
            if (!r.ok) {
              setQrState("生成失败：" + (r.error || "unknown"));
              return;
            }
            setQr(r);
            setQrState("用手机 B 站扫码（然后用手机确认）");
            void pollQr(r.key, 0);
          } catch (e) {
            setQrState("生成失败：" + (e && e.message ? e.message : String(e)));
          } finally {
            setBusy(false);
          }
        };

        const pollQr = async (key, tries) => {
          if (tries > 60) {
            setQrState("二维码超时，重新生成吧");
            setQr(null);
            return;
          }
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const r = await call("/bili/qr/poll?key=" + encodeURIComponent(key));
            if (!r.ok) {
              setQrState("出错了：" + (r.error || "unknown"));
              return;
            }
            if (r.code === 0) {
              setQrState("登录成功 ✓ " + (r.verify_output || "").slice(0, 60));
              setQr(null);
              await load();
              return;
            }
            if (r.code === 86090) setQrState("已扫码，请在手机上点确认");
            else if (r.code === 86038) {
              setQrState("二维码过期了，重新生成");
              setQr(null);
              return;
            }
            void pollQr(key, tries + 1);
          } catch (e) {
            setQrState("轮询失败：" + (e && e.message ? e.message : String(e)));
          }
        };

        const doLogin = async () => {
          if (!sessdata.trim()) {
            setLoginMsg("SESSDATA 必填");
            return;
          }
          setBusy(true);
          setLoginMsg(null);
          try {
            const r = await call("/bili/login", {
              method: "POST",
              body: JSON.stringify({ sessdata: sessdata.trim(), bili_jct: biliJct.trim(), buvid3: buvid3.trim() }),
            });
            setLoginMsg(r.verify_ok ? "登录成功 ✓ " + (r.verify_output || "").slice(0, 80) : "已保存，但验证没通过：" + (r.verify_output || "").slice(0, 120));
            setSessdata("");
            setBiliJct("");
            setBuvid3("");
            await load();
          } catch (e) {
            setLoginMsg("失败：" + (e && e.message ? e.message : String(e)));
          } finally {
            setBusy(false);
          }
        };

        const toggle = async () => {
          if (!st) return;
          setBusy(true);
          try {
            await call("/bili/toggle", { method: "POST", body: JSON.stringify({ enabled: !st.enabled }) });
            await load();
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const toggleTool = async (cmd) => {
          if (!biliTools) return;
          const cur = (biliTools.tools || []).find((x) => x.cmd === cmd);
          setBusy(true);
          try {
            const r = await call("/bili/tools", { method: "POST", body: JSON.stringify({ cmd, enabled: !(cur && cur.enabled) }) });
            setBiliTools(r);
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const runTest = async () => {
          setBusy(true);
          setTest(null);
          try {
            const r = await call("/bili/feed");
            setTest(r);
          } catch (e) {
            setTest({ ok: false, error: e && e.message ? e.message : String(e) });
          } finally {
            setBusy(false);
          }
        };

        if (!st) {
          return h("div", { style: S.wrap },
            err ? h("div", { style: S.notice("error") }, "读取失败：" + err) : h("div", { style: S.muted }, "读取中…"));
        }

        // 左栏：账号、总开关、她刷完能做什么、她能用的工具（含抽帧）
        // 右栏：UID、口味标签、测一下
        return h("div", { style: { display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" } },
          h("div", { style: { flex: "0 0 640px", minWidth: 420, display: "flex", flexDirection: "column", gap: 12 } },
          h("div", { style: S.desc },
            "给她一个 B 站账号，让她自己刷视频。但说话只走 QQ 那套人格——B 站只是她的眼睛，不是另一张嘴。",
          ),

          err ? h("div", { style: S.notice("error") }, err) : null,

          h("div", { style: S.card },
            h("div", { style: S.row },
              h("span", { style: { fontSize: 13, fontWeight: 500 } }, "账号："),
              h("span", { style: S.muted }, st.logged_in ? "已登录 ✓" : "未登录（只能刷公开热门）"),
            ),
            h("div", { style: { ...S.desc, fontSize: 12 } },
              st.logged_in ? "已登录，可以刷她自己的推荐了。" : "填 SESSDATA 登录（浏览器 F12 → Application → Cookies → bilibili.com 里复制）。",
            ),
            !st.logged_in ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 6 } },
              h("div", { style: S.row },
                h("button", { style: S.btn(true), onClick: () => void startQr(), disabled: busy }, "扫码登录"),
                qrState ? h("span", { style: S.muted }, qrState) : null,
              ),
              qr ? h("img", { src: qr.svg, style: { width: 180, height: 180, alignSelf: "center", background: "#fff", borderRadius: 8 } }) : null,
              h("details", { style: { marginTop: 4 } },
                h("summary", { style: { ...S.muted, cursor: "pointer" } }, "或者手动填 cookie（高级）"),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 } },
                  h("input", { style: S.input, placeholder: "SESSDATA（必填）", value: sessdata, onChange: (ev) => setSessdata(ev.target.value) }),
                  h("div", { style: { display: "flex", gap: 8 } },
                    h("input", { style: S.input, placeholder: "bili_jct（可选）", value: biliJct, onChange: (ev) => setBiliJct(ev.target.value) }),
                    h("input", { style: S.input, placeholder: "buvid3（可选）", value: buvid3, onChange: (ev) => setBuvid3(ev.target.value) }),
                  ),
                  h("div", { style: S.row },
                    h("button", { style: S.btn(false), onClick: () => void doLogin(), disabled: busy }, busy ? "验证中…" : "保存并验证"),
                    loginMsg ? h("span", { style: S.muted }, loginMsg) : null,
                  ),
                ),
              ),
            ) : null,
          ),

          h("div", { style: S.card },
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
              h("label", {
                onClick: () => void toggle(),
                style: {
                  display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                  padding: "10px 12px", borderRadius: 10,
                  border: "1.5px solid " + (st.enabled ? "#4084ff" : "rgba(0,0,0,.10)"),
                  background: st.enabled ? "rgba(64,132,255,.04)" : "#fff",
                  transition: "border-color .15s, background .15s",
                },
              },
                h("input", {
                  type: "checkbox", checked: !!st.enabled, disabled: busy, style: { marginTop: 3 },
                  onChange: () => void toggle(),
                }),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  h("span", { style: { fontSize: 13, fontWeight: 600 } }, "启用 B 站功能"),
                  h("span", { style: { ...S.muted, fontSize: 11 } },
                    "关掉后她不会用 bili_feed / bili_watch，也不同步 B 站活动。"),
                ),
              ),
              h("label", {
                onClick: () => setAutoShare(!autoShare),
                style: {
                  display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                  padding: "10px 12px", borderRadius: 10,
                  border: "1.5px solid " + (autoShare ? "#4084ff" : "rgba(0,0,0,.10)"),
                  background: autoShare ? "rgba(64,132,255,.04)" : "#fff",
                  transition: "border-color .15s, background .15s",
                },
              },
                h("input", {
                  type: "checkbox", checked: autoShare, style: { marginTop: 3 },
                  onChange: (ev) => setAutoShare(ev.target.checked),
                }),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  h("span", { style: { fontSize: 13, fontWeight: 600 } }, "刷完可以主动分享"),
                  h("span", { style: { ...S.muted, fontSize: 11 } },
                    "刷到有意思的发给你；关掉 = 只看不说。"),
                ),
              ),
            ),
          ),

          biliProactive ? h("div", { style: S.card },
            h("div", { style: S.label }, "她自己刷 B 站的节奏"),
            h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
              "和唤醒分开管：她按自己的间隔去 B 站逛逛，刷到什么会记进见闻，下次聊天能提。"),
            h("label", {
              style: {
                display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                padding: "10px 12px", borderRadius: 10,
                border: "1.5px solid " + (biliProactive.biliBrowseEnabled ? "#4084ff" : "rgba(0,0,0,.10)"),
                background: biliProactive.biliBrowseEnabled ? "rgba(64,132,255,.04)" : "#fff",
              },
            },
              h("input", {
                type: "checkbox", checked: !!biliProactive.biliBrowseEnabled, style: { marginTop: 3 },
                onChange: (ev) => setBiliProactive({ ...biliProactive, biliBrowseEnabled: ev.target.checked }),
              }),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                h("span", { style: { fontSize: 13, fontWeight: 600 } }, "允许她按自己的节奏刷 B 站"),
                h("span", { style: { ...S.muted, fontSize: 11 } }, "关掉 = 只有唤醒时抽到「刷 B 站」才去"),
              ),
            ),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 10 } },
              ...[
                ["biliMinGapMinutes", "至少隔（分钟）", "两次刷之间最少多久"],
                ["biliMaxGapMinutes", "最多隔（分钟）", "两次刷之间最多多久"],
                ["biliBrowseLimit", "每次刷几条", "存进见闻的条数"],
                ["biliBrowsePerDay", "每天最多刷几次", "超过就不点醒她了"],
              ].map(([key, label, hint]) => h("div", { key, style: { display: "flex", flexDirection: "column", gap: 4 } },
                h("div", { style: { ...S.muted, fontSize: 12 } }, label),
                h("input", {
                  style: S.input, type: "number", min: 0, value: biliProactive[key] ?? "",
                  onChange: (ev) => setBiliProactive({ ...biliProactive, [key]: Number(ev.target.value) || 0 }),
                }),
                h("div", { style: { ...S.muted, fontSize: 11 } }, hint),
              )),
            ),
            h("div", { style: { ...S.muted, fontSize: 11, marginTop: 8, lineHeight: 1.5 } },
              "间隔是随机的（比如 60~240 分钟 = 每次在 1 到 4 小时之间随机挑一个，不是固定点）。"
              + "区间调宽一点她刷得更像人；一天 3 次 + 1~4 小时间隔的话，额度常常中午就用完了，下午晚上一次不刷。"),
          ) : null,

          biliProactive ? h("div", { style: S.card },
            h("div", { style: S.label }, "她刷完 B 站能做什么"),
            h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
              "这几个开关决定她刷完 B 站后能做什么。关掉的不写进提示词。"),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
              ...[
                ["biliShareToOwner", "分享给 QQ 主人", "看到有意思的发给你", true],
                ["biliShareToGroup", "分享到群里", "默认关", false],
                ["biliComment", "写评论", "评论区留言", true],
                ["biliMentionOwner", "评论/分享时 @主人", "带上你", true],
              ].map(([key, label, hint]) => {
                const on = biliProactive[key];
                return h("label", {
                  key: "bp-" + key,
                  style: {
                    display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                    padding: "8px 10px", borderRadius: 8, height: "100%", boxSizing: "border-box",
                    border: "1.5px solid " + (on ? "#4084ff" : "rgba(0,0,0,.10)"),
                    background: on ? "rgba(64,132,255,.04)" : "#ffffff",
                    transition: "border-color .15s, background .15s",
                  },
                },
                  h("input", {
                    type: "checkbox",
                    checked: on,
                    onChange: () => setBiliProactive({ ...biliProactive, [key]: !on }),
                    style: { marginTop: 3, flexShrink: 0 },
                  }),
                  h("span", { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
                    h("span", { style: { fontSize: 13, fontWeight: on ? 600 : 400 } }, label),
                    h("span", { style: { ...S.muted, fontSize: 12 } }, hint),
                  ),
                );
              }),
            ),
          ) : null,

          biliTools ? h("div", { style: S.card },
            h("div", { style: S.label }, "她能用的 B 站工具"),
            h("div", { style: { ...S.muted, marginBottom: 8 } },
              "勾上的命令她才能调。只读的默认开着，写操作（评论/私信/弹幕）默认关——想让她能说再打开。"),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, alignItems: "stretch" } },
              ...(biliTools.tools || []).map((tool) =>
                h("label", {
                  key: tool.cmd,
                  style: {
                    display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                    padding: "8px 10px", borderRadius: 8, height: "100%", boxSizing: "border-box",
                    border: "1.5px solid " + (tool.enabled ? "#4084ff" : "rgba(0,0,0,.10)"),
                    background: tool.enabled ? "rgba(64,132,255,.04)" : "#ffffff",
                    transition: "border-color .15s, background .15s",
                  },
                },
                  h("input", {
                    type: "checkbox",
                    checked: !!tool.enabled,
                    onChange: () => void toggleTool(tool.cmd),
                    style: { marginTop: 3, flexShrink: 0 },
                  }),
                  h("span", { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
                    h("span", { style: { fontSize: 13, fontWeight: tool.enabled ? 600 : 400 } },
                      tool.cmd + (tool.write ? "（写）" : "")),
                    h("span", { style: { ...S.muted, fontSize: 12 } }, tool.desc),
                  ),
                ),
              ),
            ),
            // ---- 帧数（debrief 的子设置，跟上面那排工具放在同一个卡片里）----
            // debrief 没勾时整块置灰且不可点：帧数只对它有意义。
            st && st.frameGridOptions ? (() => {
              const debriefOn = (biliTools.tools || []).some((t) => t.cmd === "debrief" && t.enabled);
              return h("div", {
                style: {
                  marginTop: 16, paddingTop: 14,
                  borderTop: "1px solid rgba(0,0,0,.06)",
                  opacity: debriefOn ? 1 : 0.42,
                  pointerEvents: debriefOn ? "auto" : "none",
                  transition: "opacity .15s",
                },
              },
              h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } },
                "看视频时抽几帧画面" + (debriefOn ? "" : "（先打开上面的 debrief）")),
              h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
                "只有「debrief」开着才用得上——她看懂一条视频时会抽若干帧拼成一张图。"
                + "帧数多看得细，帧数少每帧更大。长视频/讲解类选 30 或 60；快节奏、画面切换密的选 9。"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 } },
                ...((st.frameGridOptions || []).map((o) => {
                  const on = Number(st.frameGrid) === Number(o.n);
                  return h("div", {
                    key: "fg-" + o.n,
                    onClick: async () => {
                      try {
                        const r = await call("/bili/toggle", {
                          method: "POST",
                          body: JSON.stringify({ frameGrid: o.n }),
                        });
                        setSt(r);
                      } catch (e) { setErr(e && e.message ? e.message : String(e)); }
                    },
                    style: {
                      padding: "10px 8px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                      border: on ? "1.5px solid #4084ff" : "1px solid rgba(0,0,0,.10)",
                      background: on ? "rgba(64,132,255,.06)" : "#fff",
                      transition: "border-color .15s, background .15s",
                    },
                  },
                    h("div", { style: { fontSize: 14, fontWeight: 600, color: on ? "#4084ff" : "#333" } }, o.n + " 帧"),
                    h("div", { style: { fontSize: 11, color: "#999", marginTop: 3 } }, o.grid),
                    h("div", { style: { fontSize: 10, color: "#bbb", marginTop: 2, lineHeight: 1.3 } },
                      o.n === 16 ? "默认" : (o.n === 9 ? "画面最大" : (o.n === 30 ? "更细" : "最细"))),
                  );
                })),
              ),
              );
            })() : null,
          ) : null,
          ),

          h("div", { style: { flex: "1 1 0", minWidth: 360, display: "flex", flexDirection: "column", gap: 12 } },
          h("div", { style: S.card },
            h("div", { style: S.label }, "你在 B 站的 UID"),
            h("div", { style: { ...S.muted, marginBottom: 6 } },
              "她在评论区主动分享时 @ 谁。填你自己的 B 站 UID（个人主页地址里 space.bilibili.com/ 后面那串数字）。不填就不 @。"),
            h("div", { style: { display: "flex", gap: 8 } },
              h("input", { style: S.input, placeholder: "你的 B 站 UID（数字）", value: ownerMid, onChange: (ev) => setOwnerMid(ev.target.value) }),
              h("input", { style: S.input, placeholder: "昵称（可选）", value: ownerName, onChange: (ev) => setOwnerName(ev.target.value) }),
            ),
            ownerMsg ? h("div", { style: { fontSize: 12, color: ownerMsg.includes("失败") ? "#c0392b" : "#2fa36b", marginTop: 6 } }, ownerMsg) : null,
          ),

          biliCfg ? (() => {
            const f = biliForm;
            const set = (k, v) => setBiliForm({ ...f, [k]: v });
            const split = (s) => String(s || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);
            const saveAll = async () => {
              setBusy(true);
              setErr(null);
              try {
              // 一起保存 UID（只有用户真改过才写，避免空值覆盖）
              try {
                if (ownerMid.trim() !== (ownerInit.current || "")) {
                  await call("/bili/owner", { method: "POST", body: JSON.stringify({ mid: ownerMid.trim(), name: ownerName.trim() }) });
                  if (biliProactive) {
                    await call("/proactive", { method: "POST", body: JSON.stringify(biliProactive) });
                  await call("/config", { method: "POST", body: JSON.stringify({ autoShareEnabled: autoShare }) });
                  }
                  ownerInit.current = ownerMid.trim();
                }
              } catch (e) { /* UID 失败不影响主配置 */ }

                // 串行保存，不要 Promise.all：
                // 后端每个请求都是「读整份文件 → 改一个字段 → 写回整份」，
                // 并发时它们互相覆盖，最后只有一项能留下（现场踩过，UID 和喜好全丢）。
                for (const [p, v] of [
                  [["preferences", "like"], Array.isArray(f.like) ? f.like : []],
                  [["preferences", "dislike"], Array.isArray(f.dislike) ? f.dislike : []],
                  [["night", "skipChance"], Number(f.skipChance) || 0],
                  [["night", "maxVideos"], Number(f.maxVideos) || 6],
                  [["night", "minGapMin"], Number(f.minGapMin) || 10],
                  [["persona", "name"], String(f.name || "")],
                  [["persona", "ownerTitle"], String(f.ownerTitle || "")],
                  [["persona", "selfClaim"], String(f.selfClaim || "")],
                ]) {
                  await call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: p, value: v }) });
                }
                setSavedAt(new Date().toLocaleTimeString());
                const c = await call("/bili/cfg");
                setBiliCfg(c);
              } catch (e) {
                setErr(e && e.message ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            };
            return h("div", { style: S.card },
              h("div", { style: S.label }, "更多设置（她刷 B 站的偏好）"),

              h("div", { style: { ...S.desc, marginTop: 4, fontWeight: 600, fontSize: 12 } }, "口味（点标签选，或自己加）"),
              h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 4 } }, "决定 feed 给她推什么。选中的会高亮，保存后生效。"),

              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 4 } }, "爱看（优先推这类）"),
              h(TagPicker, {
                presets: PRESET_LIKE,
                value: Array.isArray(f.like) ? f.like : [],
                onChange: (v) => set("like", v),
                placeholder: "自己加一个（回车）",
              }),

              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 10 } }, "不爱看（选题时避开）"),
              h(TagPicker, {
                presets: PRESET_DISLIKE,
                value: Array.isArray(f.dislike) ? f.dislike : [],
                onChange: (v) => set("dislike", v),
                placeholder: "自己加一个（回车）",
              }),

                h("div", {
                  style: {
                    position: "fixed", right: 24, top: "50%", transform: "translateY(-50%)",
                    display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8,
                    background: "#ffffff", padding: "12px 16px", borderRadius: 12,
                    border: "1px solid rgba(0,0,0,.08)", boxShadow: "0 8px 24px rgba(0,0,0,.12)", zIndex: 9999,
                    minWidth: 140,
                  },
                },
                props && props.onBack
                  ? h("button", { type: "button", style: S.btn(false), onClick: props.onBack }, "← 她的记忆")
                  : null,
                savedAt ? h("div", { style: { fontSize: 12, color: "#2fa36b", textAlign: "center" } }, "已保存 " + savedAt) : null,
                h("button", { style: S.btn(true), onClick: () => void saveAll(), disabled: busy }, busy ? "保存中…" : "保存"),
              ),
            );
          })() : null,

          h("div", { style: S.card },
            h("div", { style: S.label }, "测试一下她能刷到什么"),
            h("div", { style: S.row },
              h("button", { style: S.btn(false), onClick: () => void runTest(), disabled: busy }, busy ? "刷…" : "刷一下 B 站"),
            ),
            test ? h("div", { style: { ...S.desc, marginTop: 8, whiteSpace: "pre-wrap" } },
              test.ok
                ? "来源：" + (test.source || "?") + "\n" + (test.items || []).map((i) => (i.title || i) + (i.url ? "  " + i.url : "")).join("\n")
                : "失败：" + (test.error || "unknown"))
              : null,
          ),
          ),
        );
      }

      // ---------------------------------------------------------------------
      // 记忆：她记得的所有东西（L0-L4），能筛能搜
      // ---------------------------------------------------------------------
      function MemoriesSection() {
        const [data, setData] = React.useState(null);
        const [emotionList, setEmotionList] = React.useState(null);
        const [activityList, setActivityList] = React.useState(null);
        const [activityDate, setActivityDate] = React.useState("");
        const [browseList, setBrowseList] = React.useState(null);
        const [notesList, setNotesList] = React.useState(null);
        const [slangList, setSlangList] = React.useState(null);
        const [exprList, setExprList] = React.useState(null);
        const [newExpr, setNewExpr] = React.useState({ situation: "", style: "", example: "" });
        // 改一条：编辑哪一行、改后的三个字段
        const [editId, setEditId] = React.useState(null);
        const [editForm, setEditForm] = React.useState({ situation: "", style: "", example: "" });
        const [stateInfo, setStateInfo] = React.useState(null);
        const [selfModel, setSelfModel] = React.useState(null);
        const [mode, setMode] = React.useState("memory");
        const [tier, setTier] = React.useState("all");
        const [q, setQ] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [err, setErr] = React.useState(null);

        // 右栏列表分页：一页 10 条；换标签/换搜索词回到第一页
        const PAGE_SIZE = 10;
        const [page, setPage] = React.useState(0);
        React.useEffect(() => { setPage(0); }, [mode, tier, q]);

        const pageCount = (n) => Math.max(1, Math.ceil((Number(n) || 0) / PAGE_SIZE));
        const curPage = (n) => Math.min(Math.max(page, 0), pageCount(n) - 1);
        const pageSlice = (arr) => {
          const list = Array.isArray(arr) ? arr : [];
          const c = curPage(list.length);
          return list.slice(c * PAGE_SIZE, c * PAGE_SIZE + PAGE_SIZE);
        };
        const renderPager = (total) => {
          const count = Number(total) || 0;
          const max = pageCount(count);
          if (max <= 1) return null;
          const c = curPage(count);
          return h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" } },
            h("button", {
              type: "button",
              style: { ...S.btn(false), padding: "4px 12px", fontSize: 12 },
              disabled: c === 0,
              onClick: () => setPage(c - 1),
            }, "上一页"),
            h("span", { style: { ...S.muted, fontSize: 12 } }, `第 ${c + 1} / ${max} 页 · 共 ${count} 条`),
            h("button", {
              type: "button",
              style: { ...S.btn(false), padding: "4px 12px", fontSize: 12 },
              disabled: c >= max - 1,
              onClick: () => setPage(c + 1),
            }, "下一页"),
          );
        };

        const TIERS = {
          all: "全部",
          L0: "原话",
          L1: "事实",
          L2: "画像",
          L3: "事件",
          L4: "里程碑",
        };

        const loadActivity = async (date) => {
          setBusy(true); setErr(null);
          try {
            const qs = date ? ("?date=" + encodeURIComponent(date)) : "?limit=200";
            const r = await call("/activity" + qs);
            setActivityList(Array.isArray(r) ? r : []);
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
            setActivityList([]);
          } finally { setBusy(false); }
        };

        const loadBrowse = async () => {
          setBusy(true); setErr(null);
          try { const r = await call("/browse"); setBrowseList(Array.isArray(r) ? r : []); }
          catch (e) { setErr(e && e.message ? e.message : String(e)); setBrowseList([]); }
          finally { setBusy(false); }
        };

        const loadNotes = async () => {
          setBusy(true); setErr(null);
          try { const r = await call("/notes"); setNotesList(Array.isArray(r) ? r : []); }
          catch (e) { setErr(e && e.message ? e.message : String(e)); setNotesList([]); }
          finally { setBusy(false); }
        };

        const loadSlang = async () => {
          setBusy(true); setErr(null);
          try {
            const r = await call("/expressions");
            setExprList(Array.isArray(r && r.items) ? r.items : []);
          } catch { setExprList([]); }
          try { const r = await call("/slang"); setSlangList(Array.isArray(r) ? r : []); }
          catch (e) { setErr(e && e.message ? e.message : String(e)); setSlangList([]); }
          finally { setBusy(false); }
        };

        const loadState = async () => {
          setBusy(true); setErr(null);
          try { const r = await call("/state"); setStateInfo(r); }
          catch (e) { setErr(e && e.message ? e.message : String(e)); }
          finally { setBusy(false); }
        };

        const loadSelfModel = async () => {
          setBusy(true); setErr(null);
          try { const r = await call("/persona"); setSelfModel(r.self_model || ""); }
          catch (e) { setErr(e && e.message ? e.message : String(e)); }
          finally { setBusy(false); }
        };

        const loadEmotion = async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await call("/emotion?limit=200");
            setEmotionList(Array.isArray(r) ? r : []);
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const [memCfg, setMemCfg] = React.useState(null);
        const [memCfgMsg, setMemCfgMsg] = React.useState(null);

        const loadMemCfg = async () => {
          try {
            const c = await call("/config");
            const cur = (c && c.current) || {};
            setMemCfg({
              extract: !!cur.extract,
              surprisal_threshold: cur.surprisal_threshold != null ? cur.surprisal_threshold : 0.35,
              emotion_threshold: cur.emotion_threshold != null ? cur.emotion_threshold : 0.2,
              diary_enabled: cur.diary_enabled !== false,
              evolve_enabled: cur.evolve_enabled !== false,
              episode_enabled: cur.episode_enabled !== false,
            });
          } catch (e) {
            setMemCfgMsg("读取失败：" + (e && e.message ? e.message : String(e)));
          }
        };

        const patchMemCfg = async (patch) => {
          const next = { ...(memCfg || {}), ...patch };
          setMemCfg(next);
          try {
            await call("/config", { method: "POST", body: JSON.stringify(patch) });
            setMemCfgMsg(null);
          } catch (e) {
            setMemCfgMsg("保存失败：" + (e && e.message ? e.message : String(e)));
          }
        };

        const load = async (t, query) => {
          setBusy(true);
          setErr(null);
          try {
            const params = new URLSearchParams();
            // 「事实」原来绑死 L1，但 L1 和 L2 语义重叠、几乎不产出（第二套 0 条），
            // 事实全在 L2 里。这里让它两个都查，否则那个标签永远是 0/0。
            const _wantTier = (t || tier) === "L1" ? "L1,L2" : (t || tier);
            params.set("tier", _wantTier);
            params.set("limit", "200");
            if ((query ?? q).trim()) params.set("q", (query ?? q).trim());
            setData(await call("/memories?" + params.toString()));
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        React.useEffect(() => {
          void load("all", "");
          void loadState();
          void loadMemCfg();
        }, []);

        const fmt = (ts) => {
          if (!ts) return "";
          const d = new Date(ts * 1000);
          const pad = (n) => String(n).padStart(2, "0");
          return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };

        const tierColor = {
          L0: "#8b95a5",
          L1: "#5b8def",
          L2: "#2fa36b",
          L3: "#d9862b",
          L4: "#b3488f",
        };

        // 主面板是整页的，左边放「怎么记」的配置，右边放记忆列表。
        return h("div", { style: { display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" } },
          h("div", { style: { flex: "0 0 400px", minWidth: 340, display: "flex", flexDirection: "column", gap: 16 } },
          // 她的状态（常驻顶部，不用点 tab）
          h("div", { style: S.card },
            h("div", { style: { ...S.label, marginBottom: 6 } }, "她现在"),
            stateInfo ? h("div", {},
              h("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13, marginBottom: 6 } },
                h("span", {}, "心情：" + (stateInfo.mood || "normal")),
                h("span", {}, "亲密度：" + Math.round(Number(stateInfo.intimacy) || 0) + "/1000"),
                stateInfo.stage && stateInfo.stage.name ? h("span", {}, "阶段：" + stateInfo.stage.name) : null,
              ),
              stateInfo.activity ? h("div", { style: { ...S.muted, marginBottom: 4 } }, "在干嘛：" + stateInfo.activity) : null,
              stateInfo.weather ? h("div", { style: { ...S.muted, marginBottom: 4 } }, "外面：" + stateInfo.weather) : null,
              h("div", { style: { ...S.muted } },
                "小游戏：" + (stateInfo.game_score || 0) + " 分（玩了 " + (stateInfo.game_plays || 0) + " 次）"),
            ) : h("div", { style: S.muted }, "读取中…"),
          ),
          h("div", { style: S.desc },
            "她记得的所有东西。L0 是原话、L1 是事实、L2 是你的画像、L3 是发生过的事、L4 是里程碑和约定。",
          ),
          h("div", { style: S.card },
            h("div", { style: { ...S.label, marginBottom: 8 } }, "记忆开关"),
            h("label", {
              style: {
                display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                padding: "8px 10px", borderRadius: 8,
                border: "1.5px solid " + (memCfg && memCfg.extract ? "#4084ff" : "rgba(0,0,0,.10)"),
                background: memCfg && memCfg.extract ? "rgba(64,132,255,.04)" : "#ffffff",
                transition: "border-color .15s, background .15s",
              },
            },
              h("input", {
                type: "checkbox",
                checked: !!(memCfg && memCfg.extract),
                onChange: (ev) => void patchMemCfg({ extract: ev.target.checked }),
                style: { marginTop: 2 },
              }),
              h("span", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                h("span", { style: { fontSize: 13, fontWeight: 500 } }, "自动提炼记忆（L1-L4）"),
                h("span", { style: { ...S.muted, fontSize: 12 } },
                  "开着：每轮用对话模型从聊天里提炼事实/画像/事件，多两次模型调用（花钱）。"),
                h("span", { style: { ...S.muted, fontSize: 12 } },
                  "关掉：聊天不再产生新的提炼记忆（原话 L0 仍按惊讶阈值记录），日记/自我认知照常。"),
              ),
            ),
            h("div", { style: { marginTop: 14 } },
              h("div", { style: { ...S.label, marginBottom: 8 } }, "她用不用这些能力（都烧 token）"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
                ...[
                  ["diary_enabled", "写日记", "每天 23:00 把当天的事写成第一人称日记"],
                  // 2026-11-07：这条已经从「记忆」页移走。
                  // 原来它控制的是「每 30 轮由系统替她编一句自我认知」，
                  // 那条路已经关了；现在改成每天给她一份真实台账、她自己写，
                  // 开关在「人格」页 →「演化设置」里（selfEvolveEnabled）。
                  ["episode_enabled", "事件总结", "长对话攒够后压成一条「这段时间发生了什么」"],
                ].map(([key, label, desc]) =>
                  h("label", {
                    key: key,
                    style: {
                      display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                      padding: "8px 10px", borderRadius: 8,
                      border: "1.5px solid " + (memCfg && memCfg[key] ? "#4084ff" : "rgba(0,0,0,.10)"),
                      background: memCfg && memCfg[key] ? "rgba(64,132,255,.04)" : "#ffffff",
                      transition: "border-color .15s, background .15s",
                    },
                  },
                    h("input", {
                      type: "checkbox",
                      checked: !!(memCfg && memCfg[key]),
                      onChange: (ev) => void patchMemCfg({ [key]: ev.target.checked }),
                      style: { marginTop: 2, flexShrink: 0 },
                    }),
                    h("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
                      h("span", { style: { fontSize: 13, fontWeight: memCfg && memCfg[key] ? 600 : 400 } }, label),
                      h("span", { style: { ...S.muted, fontSize: 11 } }, desc),
                    ),
                  ),
                ),
              ),
            ),
            h("div", { style: { marginTop: 14 } },
              h("div", { style: { ...S.label, marginBottom: 4 } }, "原文记多细（L0 惊讶阈值）"),
              h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 } },
                "她说的每句话都要和上文比一次「差多远」，过线才存原文。选一档，即时生效。"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
                ...[
                  [0.15, "全都记", "连「嗯」「好的」都存，原话最全但最占地方"],
                  [0.25, "宽松", "日常闲聊基本都记，只跳过重复的"],
                  [0.35, "平衡（默认）", "跳过寒暄和重复，正常的都记"],
                  [0.5, "严格", "只记有明显变化的话，细节会漏一些"],
                  [0.7, "只记大事", "情绪重、有转折的才记，平时基本不留原话"],
                ].map(([v, label, desc]) =>
                  h("label", {
                    key: "th" + v,
                    style: {
                      display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                      padding: "8px 10px", borderRadius: 8,
                      border: "1.5px solid " + (memCfg && Math.abs(Number(memCfg.surprisal_threshold) - v) < 0.02 ? "#4084ff" : "rgba(0,0,0,.10)"),
                      background: memCfg && Math.abs(Number(memCfg.surprisal_threshold) - v) < 0.02 ? "rgba(64,132,255,.04)" : "#ffffff",
                      transition: "border-color .15s, background .15s",
                    },
                  },
                    h("input", {
                      type: "radio",
                      name: "surprisal",
                      checked: !!(memCfg && Math.abs(Number(memCfg.surprisal_threshold) - v) < 0.02),
                      onChange: () => void patchMemCfg({ surprisal_threshold: v }),
                      style: { marginTop: 2, flexShrink: 0 },
                    }),
                    h("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
                      h("span", { style: { fontSize: 13, fontWeight: memCfg && Math.abs(Number(memCfg.surprisal_threshold) - v) < 0.02 ? 600 : 400 } },
                        label + "（" + v + "）"),
                      h("span", { style: { ...S.muted, fontSize: 11 } }, desc),
                    ),
                  ),
                ),
              ),
            ),
            h("div", { style: { marginTop: 14 } },
              h("div", { style: { ...S.label, marginBottom: 4 } }, "情绪记多细（emotion_log）"),
              h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 } },
                "她有多容易被你的话带动情绪。太低会记一堆小事，太高什么都不记。"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
                ...[
                  [0.1, "极度敏感", "连「嗯」「随便」都能记出情绪，库涨得最快"],
                  [0.2, "敏感（默认）", "一点小情绪就记，日常起伏都留得住"],
                  [0.3, "平衡", "有明确情绪才记，闲聊不占地方"],
                  [0.5, "克制", "只有明显的高兴/难过/烦躁才记"],
                  [0.7, "只记大情绪", "情绪很重才记，平时基本空白"],
                ].map(([v, label, desc]) =>
                  h("label", {
                    key: "em" + v,
                    style: {
                      display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                      padding: "8px 10px", borderRadius: 8,
                      border: "1.5px solid " + (memCfg && Math.abs(Number(memCfg.emotion_threshold) - v) < 0.02 ? "#4084ff" : "rgba(0,0,0,.10)"),
                      background: memCfg && Math.abs(Number(memCfg.emotion_threshold) - v) < 0.02 ? "rgba(64,132,255,.04)" : "#ffffff",
                      transition: "border-color .15s, background .15s",
                    },
                  },
                    h("input", {
                      type: "radio",
                      name: "emotion_threshold",
                      checked: !!(memCfg && Math.abs(Number(memCfg.emotion_threshold) - v) < 0.02),
                      onChange: () => void patchMemCfg({ emotion_threshold: v }),
                      style: { marginTop: 2, flexShrink: 0 },
                    }),
                    h("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
                      h("span", { style: { fontSize: 13, fontWeight: memCfg && Math.abs(Number(memCfg.emotion_threshold) - v) < 0.02 ? 600 : 400 } },
                        label + "（" + v + "）"),
                      h("span", { style: { ...S.muted, fontSize: 11 } }, desc),
                    ),
                  ),
                ),
              ),
            ),
            memCfgMsg ? h("div", { style: { fontSize: 12, color: "#c0392b", marginTop: 6 } }, memCfgMsg) : null,
          ),



          err ? h("div", { style: S.notice("error") }, err) : null,

          ),

          h("div", { style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 } },
          data ? h("div", { style: S.card },
            h("div", { className: "dshm-tabs" },
              Object.entries(TIERS).map(([k, label]) =>
                h("button", {
                  key: k,
                  className: "dshm-tab", "data-on": mode === "memory" && tier === k ? "1" : "0",
                  onClick: () => { setMode("memory"); setTier(k); void load(k, q); },
                }, label + (k !== "all" && data.counts && data.counts[k] != null ? ` ${data.counts[k]}` : "")),
              ),
              h("button", {
                className: "dshm-tab", "data-on": mode === "emotion" ? "1" : "0",
                onClick: () => { setMode("emotion"); void loadEmotion(); },
              }, "情感" + (emotionList ? ` ${emotionList.length}` : "")),
              h("button", {
                className: "dshm-tab", "data-on": mode === "activity" ? "1" : "0",
                onClick: () => { setMode("activity"); void loadActivity(activityDate); },
              }, "今天干了什么"),
              h("button", {
                className: "dshm-tab", "data-on": mode === "browse" ? "1" : "0",
                onClick: () => { setMode("browse"); void loadBrowse(); },
              }, "见闻" + (browseList ? ` ${browseList.length}` : "")),
              h("button", {
                className: "dshm-tab", "data-on": mode === "notes" ? "1" : "0",
                onClick: () => { setMode("notes"); void loadNotes(); },
              }, "便签" + (notesList ? ` ${notesList.length}` : "")),
              h("button", {
                className: "dshm-tab", "data-on": mode === "slang" || mode === "expr" ? "1" : "0",
                onClick: () => { setMode("slang"); void loadSlang(); },
              }, "学说话"
                + ((slangList || exprList)
                  ? ` ${(slangList || []).filter((s) => (s.meaning || "").trim()).length + (exprList || []).length}`
                  : "")),
              h("button", {
                className: "dshm-tab", "data-on": mode === "self" ? "1" : "0",
                onClick: () => { setMode("self"); void loadSelfModel(); },
              }, "自我认知"),
            ),
            h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
              h("input", {
                style: S.input,
                placeholder: "搜记忆内容…",
                value: q,
                onChange: (ev) => setQ(ev.target.value),
                onKeyDown: (ev) => { if (ev.key === "Enter") void load(tier, q); },
              }),
              h("button", { style: S.btn(true), onClick: () => void load(tier, q), disabled: busy }, busy ? "查…" : "搜索"),
            ),
            h("div", { style: { ...S.muted, marginTop: 6 } },
              `显示 ${data.items ? data.items.length : 0} / ${data.total} 条`),
          ) : h("div", { style: S.muted }, "读取中…"),

          mode === "state" ? (
            stateInfo ? h("div", { style: S.card },
              h("div", { style: { ...S.label, marginBottom: 8 } }, "她现在"),
              h("div", { style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, marginBottom: 8 } },
                h("span", {}, "心情：" + (stateInfo.mood || "normal")),
                h("span", {}, "亲密度：" + Math.round(Number(stateInfo.intimacy) || 0) + "/1000"),
                stateInfo.stage && stateInfo.stage.name ? h("span", {}, "阶段：" + stateInfo.stage.name) : null,
              ),
              stateInfo.activity ? h("div", { style: { ...S.muted, marginBottom: 6 } }, "在干嘛：" + stateInfo.activity) : null,
              stateInfo.weather ? h("div", { style: { ...S.muted, marginBottom: 6 } }, "外面：" + stateInfo.weather) : null,
              h("div", { style: { ...S.muted, marginBottom: 6 } },
                "小游戏：" + (stateInfo.game_score || 0) + " 分（玩了 " + (stateInfo.game_plays || 0) + " 次）"),
              stateInfo.stage && stateInfo.stage.hint
                ? h("div", { style: { ...S.muted } }, "这个阶段的样子：" + stateInfo.stage.hint)
                : null,
            ) : h("div", { style: S.muted }, "读取中…")
          ) : mode === "self" ? (
            selfModel
              ? h("div", { style: S.card },
                  h("div", { style: { ...S.label, marginBottom: 8 } }, "她对自己的认知"),
                  h("div", { style: { fontSize: 13, lineHeight: 1.75, whiteSpace: "pre-wrap" } }, selfModel),
                )
              : h("div", { style: S.muted }, selfModel === null ? "读取中…" : "还没形成自我认知（每天 22:00 演化一次）")
          ) : mode === "activity" ? (
            h("div", {},
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" } },
                h("span", { style: { ...S.muted, fontSize: 12 } }, "看哪天："),
                h("input", {
                  type: "date",
                  style: { ...S.input, width: 150 },
                  value: activityDate,
                  onChange: (ev) => { setActivityDate(ev.target.value); void loadActivity(ev.target.value); },
                }),
                h("button", {
                  style: { ...S.btn(false), padding: "4px 10px", fontSize: 12 },
                  onClick: () => { setActivityDate(""); void loadActivity(""); },
                }, "最近 200 条"),
              ),
              activityList && activityList.length > 0
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                    pageSlice(activityList).map((a, i) => {
                      const d = new Date((a.ts || 0) * 1000);
                      const pad = (n) => String(n).padStart(2, "0");
                      const when = pad(d.getHours()) + ":" + pad(d.getMinutes());
                      const kindColor = { chat: "#4084ff", bili: "#f0803c", proactive: "#8b5cf6", game: "#2fa36b", other: "#8b95a5" };
                      const tone = kindColor[a.kind] || "#8b95a5";
                      const kindLabel = { chat: "聊天", bili: "B 站", proactive: "主动找你", game: "游戏" };
                      return h("div", { key: i, style: { ...S.card, padding: "8px 12px", borderLeft: "3px solid " + tone } },
                        h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                          h("span", { style: { fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999, background: tone + "22", color: tone } }, kindLabel[a.kind] || a.kind || "其他"),
                          h("span", { style: { ...S.muted, fontSize: 11 } }, when),
                          h("span", { style: { fontSize: 13, lineHeight: 1.6 } }, a.detail || ""),
                        ),
                        a.thought
                          ? h("div", { style: { fontSize: 12, color: "#8b95a5", marginTop: 4, paddingLeft: 10, fontStyle: "italic", borderLeft: "2px solid " + tone + "44" } }, "「" + a.thought + "」")
                          : null,
                      );
                    }),
                  renderPager((activityList || []).length),
                  )
                : h("div", { style: S.muted }, activityList ? "这天没做什么" : "读取中…"),
            )
          ) : mode === "browse" ? (
            browseList && browseList.length > 0
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  pageSlice(browseList).map((b, i) =>
                    h("div", { key: i, style: { ...S.card, padding: "8px 12px", borderLeft: "3px solid #f0803c" } },
                      h("div", { style: { fontSize: 13, lineHeight: 1.6 } }, b.title || ""),
                      b.url ? h("div", { style: { ...S.muted, fontSize: 11, marginTop: 2, wordBreak: "break-all" } }, b.url) : null,
                    ),
                  ),
                renderPager((browseList || []).length),
                )
              : h("div", { style: S.muted }, browseList ? "还没刷到什么" : "读取中…")
          ) : mode === "notes" ? (
            notesList && notesList.length > 0
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  pageSlice(notesList).map((n) =>
                    h("div", { key: n.id, style: { ...S.card, padding: "10px 12px", borderLeft: "3px solid #8b5cf6" } },
                      h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 4 } }, (n.author || "她") + " · " + (n.date || "")),
                      h("div", { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, n.text || ""),
                    ),
                  ),
                renderPager((notesList || []).length),
                )
              : h("div", { style: S.muted }, notesList ? "还没记过便签" : "读取中…")
          ) : mode === "slang" ? (
            (() => {
              if (!slangList && !exprList) return h("div", { style: S.muted }, "读取中…")
              const exprs = exprList || []
              return h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
                exprs.length > 0
                  ? h("div", null,
                      h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 4 } }, `学到的说法（场合感） ${exprs.length}`),
                      h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 8, lineHeight: 1.5 } },
                        "这里是**候选池**。存的是原句（照抄），不是抽象标签。相似说法攒够 3 次、并且子 AI 判定是「说话方式」之后，才会转正进口音区。"
                        + "转正的口音三天写一次进人格；没转正的不会进提示词，只在贴吧回帖时按话题挑几句当参考。"),
                      h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                        pageSlice(exprs).map((e) => {
                          const editing = editId === e.id;
                          const saveEdit = async () => {
                            try {
                              const r = await call("/expressions", {
                                method: "POST",
                                body: JSON.stringify({
                                  op: "update", id: e.id,
                                  situation: editForm.situation,
                                  style: editForm.style,
                                  example: editForm.example,
                                }),
                              });
                              if (r && r.ok) {
                                if (r.mergedInto) {
                                  setExprList((exprList || []).filter((x) => x.id !== e.id));
                                  setMsg("改完跟另一条重复了，已合并");
                                } else {
                                  setExprList((exprList || []).map((x) => (x.id === e.id
                                    ? { ...x, situation: r.situation, style: r.style, example: r.example }
                                    : x)));
                                }
                                setEditId(null);
                              } else {
                                setMsg("保存失败：" + ((r && r.error) || "未知"));
                              }
                            } catch (err) { setMsg("保存失败：" + String(err && err.message || err)); }
                          };
                          return h("div", {
                            key: "ex" + e.id,
                            style: {
                              ...S.card, padding: "8px 12px",
                              borderLeft: "3px solid " + (editing ? "#f0803c" : "#4084ff"),
                              display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8,
                            },
                          },
                            h("div", { style: { flex: 1, minWidth: 0 } },
                              editing
                                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                                    h("input", {
                                      style: { ...S.input, fontSize: 12 },
                                      placeholder: "原句（照抄那句，别改写）",
                                      value: editForm.style,
                                      onChange: (ev) => setEditForm({ ...editForm, style: ev.target.value }),
                                    }),
                                    h("input", {
                                      style: { ...S.input, fontSize: 12 },
                                      placeholder: "分类（接梗/吐槽/自嘲/阴阳/共鸣/反问/抖机灵/客套）",
                                      value: editForm.situation,
                                      onChange: (ev) => setEditForm({ ...editForm, situation: ev.target.value }),
                                    }),
                                  )
                                : h(React.Fragment, null,
                                    h("div", { style: { fontSize: 13.5, lineHeight: 1.6, fontWeight: 500 } },
                                      "「" + (e.raw || e.style || "") + "」"),
                                    h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" } },
                                      h("span", {
                                        style: {
                                          fontSize: 11, padding: "1px 8px", borderRadius: 999,
                                          background: "rgba(64,132,255,.12)", color: "#4084ff",
                                        },
                                      }, e.situation || "未分类"),
                                      e.likes ? h("span", { style: { ...S.muted, fontSize: 11 } }, "赞 " + e.likes) : null,
                                      h("span", { style: { ...S.muted, fontSize: 11 } },
                                        `见过 ${e.count || 1} 次 · ${e.scope}${e.source ? " · " + e.source : ""}`),
                                    ),
                                  ),
                            ),
                            h("div", { style: { display: "flex", gap: 6, flexShrink: 0 } },
                              editing
                                ? [
                                    h("button", {
                                      key: "ok",
                                      style: { ...S.btn(true), fontSize: 11, padding: "2px 8px" },
                                      onClick: () => void saveEdit(),
                                    }, "保存"),
                                    h("button", {
                                      key: "no",
                                      style: { ...S.btn(false), fontSize: 11, padding: "2px 8px" },
                                      onClick: () => setEditId(null),
                                    }, "取消"),
                                  ]
                                : [
                                    h("button", {
                                      key: "ed",
                                      style: { ...S.btn(false), fontSize: 11, padding: "2px 8px" },
                                      onClick: () => {
                                        setEditId(e.id);
                                        setEditForm({
                                          situation: e.situation || "",
                                          style: e.style || "",
                                          example: e.example || "",
                                        });
                                      },
                                    }, "改"),
                                    h("button", {
                                      key: "act",
                                      style: { ...S.btn(false), fontSize: 11, padding: "2px 8px" },
                                      title: "转正：只有启用过的说法才会进人格的口音区",
                                      onClick: async () => {
                                        try {
                                          await call("/expressions", { method: "POST", body: JSON.stringify({ op: "status", id: e.id, status: "active" }) });
                                          setExprList((exprList || []).map((x) => (x.id === e.id ? { ...x, status: "active" } : x)));
                                          setMsg("已转正，下次重写口音档案时生效");
                                        } catch (err) { setMsg("操作失败：" + String(err && err.message || err)); }
                                      },
                                    }, "启用"),
                                    h("button", {
                                      key: "del",
                                      style: { ...S.btn(false), fontSize: 11, padding: "2px 8px" },
                                      onClick: async () => {
                                        try {
                                          await call("/expressions", { method: "POST", body: JSON.stringify({ op: "delete", id: e.id }) });
                                          setExprList((exprList || []).filter((x) => x.id !== e.id));
                                        } catch (err) { setMsg("删除失败：" + String(err && err.message || err)); }
                                      },
                                    }, "删"),
                                  ],
                            ),
                          );
                        }),
                      ),
                    )
                  : null,
                // 手动教一条（2026-11-06）：自动抽的素材不够时，直接教
                h("div", { style: { ...S.card, padding: "10px 12px", borderLeft: "3px solid #f0803c" } },
                  h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 6 } }, "手动教一条"),
                  h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                    h("input", {
                      style: { ...S.input, flex: "1 1 120px", minWidth: 100, fontSize: 12 },
                      placeholder: "什么场合（对方说了件倒霉事）",
                      value: newExpr.situation,
                      onChange: (ev) => setNewExpr({ ...newExpr, situation: ev.target.value }),
                    }),
                    h("input", {
                      style: { ...S.input, flex: "1 1 120px", minWidth: 100, fontSize: 12 },
                      placeholder: "可以怎么说（先来一句「啊这」）",
                      value: newExpr.style,
                      onChange: (ev) => setNewExpr({ ...newExpr, style: ev.target.value }),
                    }),
                    h("button", {
                      style: { ...S.btn(true), fontSize: 12, padding: "4px 12px" },
                      onClick: async () => {
                        if (!newExpr.situation.trim() || !newExpr.style.trim()) return;
                        try {
                          await call("/expressions", {
                            method: "POST",
                            body: JSON.stringify({
                              scope: "global",
                              situation: newExpr.situation.trim(),
                              style: newExpr.style.trim(),
                              example: newExpr.example.trim(),
                            }),
                          });
                          setNewExpr({ situation: "", style: "", example: "" });
                          const r = await call("/expressions");
                          setExprList(Array.isArray(r && r.items) ? r.items : []);
                          setMsg("教会她一条");
                        } catch (err) {
                          setMsg("保存失败：" + String((err && err.message) || err));
                        }
                      },
                    }, "教她"),
                  ),
                  h("input", {
                    style: { ...S.input, marginTop: 6, fontSize: 12 },
                    placeholder: "原话例子（可选）",
                    value: newExpr.example,
                    onChange: (ev) => setNewExpr({ ...newExpr, example: ev.target.value }),
                  }),
                ),
                (!exprs.length)
                  ? h("div", { style: S.muted }, "还没学到什么。她会在聊天里慢慢琢磨「什么场合该怎么接」。")
                  : null,
              renderPager(exprs.length),
              )
            })()
          ) : mode === "emotion" ? (
            emotionList && emotionList.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              pageSlice(emotionList).map((e) => {
                const v = Number(e.valence) || 0;
                const tone = v > 0.2 ? "#2fa36b" : v < -0.2 ? "#c0392b" : "#8b95a5";
                const d = new Date((e.ts || 0) * 1000);
                const pad = (n) => String(n).padStart(2, "0");
                const when = `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                return h("div", { key: e.id, style: { ...S.card, padding: "10px 12px", borderLeft: "3px solid " + tone } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
                    h("span", { style: { fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999, background: tone + "22", color: tone } }, e.label || "情绪"),
                    h("span", { style: { ...S.muted, fontSize: 11 } }, when),
                    h("span", { style: { ...S.muted, fontSize: 11 } }, `v=${v.toFixed(2)} a=${(Number(e.arousal) || 0).toFixed(2)}`),
                    h("span", { style: { ...S.muted, fontSize: 11 } }, e.source || ""),
                  ),
                  h("div", { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" } }, e.trigger || "（没有记录原因）"),
                );
              }),
              renderPager((emotionList || []).length),
            ) : h("div", { style: S.muted }, emotionList ? "还没有情感记录（聊几句，情绪有波动就会记）" : "读取中…")
          ) : data && data.items && data.items.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            pageSlice(data.items).map((m) => h("div", {
              key: m.id,
              style: { ...S.card, padding: "8px 10px" },
            },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
                h("span", {
                  style: {
                    fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999,
                    background: (tierColor[m.tier] || "#888") + "22",
                    color: tierColor[m.tier] || "#888",
                  },
                }, (TIERS[m.tier] || m.tier) + " " + m.tier),
                h("span", { style: { ...S.muted, fontSize: 11 } }, fmt(m.ts)),
                m.tags && m.tags.length ? h("span", { style: { ...S.muted, fontSize: 11 } },
                  m.tags.filter((x) => x !== "extracted" && x !== "raw").slice(0, 3).join(" · ")) : null,
              ),
              h("div", { style: { fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, m.text),
              m.summary ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, "摘要：" + m.summary) : null,
            )),
            renderPager(((data && data.items) || []).length),
          ) : (data ? h("div", { style: S.muted }, "没有匹配的记忆") : null),
          ),
        );
      }

      function QqSection(props) {
                const [profiles, setProfiles] = React.useState([]);
        // 默认展开：这块藏起来的话根本没人找得到编辑入口
        const [profilesOpen, setProfilesOpen] = React.useState(true);
        // 每个人手编画像的草稿：user_id -> 正在编辑的文本
        const [profileDrafts, setProfileDrafts] = React.useState({});
        // 「其他用户画像」里不该出现主人自己 —— 他的画像在「人格设定」页的「用户画像」里改
        // 排除主人自己，也排除非法 QQ 号（唤醒脚本注入的系统提醒是 user_id=0）
        const otherProfiles = (profiles || []).filter(
          (p) => !p.is_owner && /^\d{5,}$/.test(String(p.user_id || "")),
        );
const [data, setData] = React.useState(null);
        const [err, setErr] = React.useState(null);
        const [draft, setDraft] = React.useState({});
        const [saving, setSaving] = React.useState(false);
        const [notice, setNotice] = React.useState(null);
        const [fsOpen, setFsOpen] = React.useState(null);
        const [fsData, setFsData] = React.useState(null);
        const [fsErr, setFsErr] = React.useState(null);
        const [arrInput, setArrInput] = React.useState({});
        const [qqSessions, setQqSessions] = React.useState([]);
        const [chatMap, setChatMap] = React.useState({ binding: {}, retired: [] });
        const [sessionHistory, setSessionHistory] = React.useState({});   // chat -> {items, current}
        const [historyOpen, setHistoryOpen] = React.useState(null);        // 展开的 chat
        const [switchIdx, setSwitchIdx] = React.useState({});   // chat -> 输入框的值
        const [qqBind, setQqBind] = React.useState(null);   // 正在选会话重绑的 chat
        const [qqBusy, setQqBusy] = React.useState(false);
        const [qqMsg, setQqMsg] = React.useState(null);
        // NapCat 工具权限（127 个 action 逐项开关，存在 dsh-remembers 的 napcat_tools.json）
        const [napcatTools, setNapcatTools] = React.useState(null);
        const [napcatOpen, setNapcatOpen] = React.useState({});   // 组展开状态

        const browse = async (path) => {
          setFsErr(null);
          try {
            const r = await call("/fs/list?path=" + encodeURIComponent(path || ""));
            setFsData(r);
          } catch (e) {
            setFsErr(e && e.message ? e.message : String(e));
          }
        };

        const load = async () => {
          setErr(null);
          try {
            const r = await call("/qq/config");
            setData(r);
            try {
              setProfiles(((await call("/profiles")).profiles) || []);
            } catch { setProfiles([]); }
            try {
              const s = await call("/qq/sessions");
              setQqSessions((s && s.sessions) || []);
              try {
                const cm = await call("/qq/chat-map");
                setChatMap({
                  binding: (cm && cm.binding) || {},
                  retired: (cm && cm.retired) || [],
                });
              } catch (e) { /* 忽略 */ }
            } catch (e) { /* 会话列表失败不影响配置 */ }
            try { setNapcatTools(await call("/napcat/tools")); } catch (e) { setNapcatTools(null); }
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
          }
        };

        React.useEffect(() => { void load(); }, []);

        if (err) {
          return h("div", { style: S.wrap },
            h("div", { style: S.notice("error") }, "读取失败：" + err));
        }
        if (!data) {
          return h("div", { style: S.wrap }, h("div", { style: S.muted }, "读取配置…"));
        }

        const setField = (key, value) => {
          setDraft((d) => ({ ...(d || {}), [key]: value }));
          setNotice(null);
        };

        const dirty = draft && Object.keys(draft).length > 0;

        const save = async () => {
          if (!dirty) return;
          setSaving(true);
          setNotice(null);
          try {
            const r = await call("/qq/config", { method: "POST", body: JSON.stringify(draft) });
            if (r && r.ok) {
              setNotice({ kind: "ok", text: "已保存，" + (r.changed || []).length + " 项，" + (r.restarting ? "正在重启生效…" : "需手动重启生效") });
              setDraft({});
              await load();
            } else {
              setNotice({ kind: "error", text: "保存失败：" + JSON.stringify(r) });
            }
          } catch (err) {
            setNotice({ kind: "error", text: "保存失败：" + (err && err.message ? err.message : String(err)) });
          } finally {
            setSaving(false);
          }
        };

        const curVal = (f) => {
          if (draft && Object.prototype.hasOwnProperty.call(draft, f.key)) return draft[f.key];
          if (f.type === "secret") return "";
          return f.raw != null ? f.raw : f.display;
        };

        const control = (f) => {
          const v = curVal(f);
          if (f.type === "enum") {
            // 卡片式单选（enumCard）
            const opts = Object.entries(f.options || {});
            const big = true;   // 所有 enum 卡片统一大号
            return h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
              ...opts.map(([k, label]) => {
                const on = String(v) === String(k);
                return h("label", {
                  key: "enumCard-" + f.key + "-" + k,
                  style: {
                    display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                    padding: big ? "12px 16px" : "6px 10px", borderRadius: 8,
                    fontSize: big ? 14 : 12,
                    border: "1.5px solid " + (on ? "#4084ff" : "rgba(0,0,0,.10)"),
                    background: on ? "rgba(64,132,255,.04)" : "#ffffff",
                    transition: "border-color .15s, background .15s",
                    fontWeight: on ? 600 : 400,
                    flex: big ? "1 1 auto" : undefined,
                  },
                },
                  h("input", {
                    type: "radio",
                    name: "enum-" + f.key,
                    checked: on,
                    onChange: () => setField(
                      f.key,
                      f.key === "requireMention" ? (k === "true") : k
                    ),
                    style: { margin: 0, flexShrink: 0 },
                  }),
                  h("span", {}, label),
                );
              }),
            );
          }
          if (f.type === "boolean") {
            const on = v === true || v === "true";
            return h("label", {
              style: {
                display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                padding: "4px 8px", borderRadius: 6, alignSelf: "flex-start",
                border: "1.5px solid " + (on ? "#4084ff" : "rgba(0,0,0,.10)"),
                background: on ? "rgba(64,132,255,.04)" : "#ffffff",
              },
            },
              h("input", { type: "checkbox", checked: on, onChange: (ev) => setField(f.key, ev.target.checked) }),
              h("span", { style: { fontSize: 12 } }, on ? "开" : "关"),
            );
          }
          if (f.type === "number") {
            return h("input", {
              style: { ...S.input, padding: "4px 8px", fontSize: 12 },
              type: "number",
              value: v == null ? "" : String(v),
              onChange: (ev) => setField(f.key, Number(ev.target.value) || 0),
            });
          }
          if (f.type === "stringArray") {
            const arr = Array.isArray(v) ? v : String(v || "").split("\n").filter(Boolean);
            const addVal = arrInput[f.key] || "";
            const doAdd = () => {
              const x = addVal.trim();
              if (!x) return;
              setField(f.key, [...arr, x]);
              setArrInput((m) => ({ ...m, [f.key]: "" }));
            };
            return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              arr.length
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                    ...arr.map((x, i) =>
                      h("div", {
                        key: "av" + i,
                        style: {
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 10px", borderRadius: 8,
                          border: "1.5px solid rgba(64,132,255,.35)", background: "rgba(64,132,255,.04)",
                        },
                      },
                        h("span", { style: { flex: 1, fontSize: 12, wordBreak: "break-all" } }, String(x)),
                        h("span", {
                          style: { cursor: "pointer", opacity: 0.55, fontSize: 14, lineHeight: "16px", padding: "0 4px" },
                          onClick: () => setField(f.key, arr.filter((_, j) => j !== i)),
                        }, "×"),
                      ),
                    ),
                  )
                : h("div", { style: { ...S.muted, fontSize: 11 } }, "（空 = 不允许任何人）"),
              h("div", { style: { display: "flex", gap: 6 } },
                h("input", {
                  style: { ...S.input, flex: 1, padding: "4px 8px", fontSize: 12 },
                  placeholder: f.key === "groupAllowFrom" ? "群号（在群设置里能看到）" : "QQ 号",
                  value: addVal,
                  onChange: (ev) => setArrInput((m) => ({ ...m, [f.key]: ev.target.value })),
                  onKeyDown: (ev) => { if (ev.key === "Enter") doAdd(); },
                }),
                h("button", { style: { ...S.btn(false), padding: "4px 10px", fontSize: 12 }, onClick: doAdd }, "加"),
              ),
            );
          }
          if (f.type === "dirpath") {
            const open = fsOpen === f.key;
            return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h("div", { style: { display: "flex", gap: 6 } },
                h("input", {
                  style: { ...S.input, flex: 1, padding: "4px 8px", fontSize: 12, fontFamily: "monospace" },
                  value: String(v == null ? "" : v),
                  placeholder: "/home/ubuntu/qq-workspace",
                  onChange: (ev) => setField(f.key, ev.target.value),
                }),
                h("button", {
                  style: { ...S.btn(false), padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap" },
                  onClick: () => {
                    const next = open ? null : f.key;
                    setFsOpen(next);
                    if (next) void browse(String(v || "/home/ubuntu"));
                  },
                }, open ? "收起" : "浏览…"),
              ),
              open ? h("div", {
                style: {
                  padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(0,0,0,.08)",
                  background: "#fafafa", display: "flex", flexDirection: "column", gap: 6,
                },
              },
                fsErr ? h("div", { style: { fontSize: 11, color: "#c0392b" } }, fsErr) : null,
                fsData ? h("div", { style: { fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" } }, fsData.path) : null,
                fsData ? h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                  fsData.parent ? h("button", {
                    style: { ...S.btn(false), padding: "2px 8px", fontSize: 11 },
                    onClick: () => void browse(fsData.parent),
                  }, "↑ 上一级") : null,
                  h("button", {
                    style: { ...S.btn(true), padding: "2px 8px", fontSize: 11 },
                    onClick: () => { setField(f.key, fsData.path); setFsOpen(null); },
                  }, "✓ 选这个目录"),
                ) : null,
                fsData && fsData.dirs && fsData.dirs.length
                  ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, maxHeight: 160, overflowY: "auto" } },
                      ...fsData.dirs.map((d) =>
                        h("div", {
                          key: d.path,
                          style: {
                            cursor: "pointer", padding: "4px 8px", borderRadius: 6, fontSize: 11,
                            border: "1px solid rgba(0,0,0,.06)", background: "#fff",
                          },
                          onClick: () => void browse(d.path),
                        }, "📁 " + d.name),
                      ),
                    )
                  : h("div", { style: { ...S.muted, fontSize: 11 } }, fsData ? "（没有子目录）" : "读取中…"),
              ) : null,
            );
          }
          if (f.type === "secret") {
            return h("input", {
              style: { ...S.input, padding: "4px 8px", fontSize: 12 },
              type: "password",
              placeholder: f.is_set ? "留空 = 不改" : "未设置",
              value: String(v || ""),
              onChange: (ev) => setField(f.key, ev.target.value),
            });
          }
          return h("input", {
            style: { ...S.input, padding: "4px 8px", fontSize: 12 },
            value: String(v == null ? "" : v),
            onChange: (ev) => setField(f.key, ev.target.value),
          });
        };

        return h("div", { style: S.wrap },
          h("div", { style: S.desc },
            "QQ 通道（dsh-onebot-qq）的全部 " + data.total + " 项配置，改完点保存。"
            + "文件：" + data.path + "（会自动备份 .bak-时间戳）",
          ),

          err ? h("div", { style: S.notice("error") }, err) : null,

          // QQ 会话列表（每个聊天一行，各自独立开新会话）
          h("div", { style: S.card },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
              h("span", { style: { ...S.label, margin: 0 } }, "QQ 会话"),
              qqMsg ? h("span", { style: { fontSize: 11, color: qqMsg.startsWith("失败") ? "#c0392b" : "#2fa36b" } }, qqMsg) : null,
            ),
            h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 8 } },
              "每个聊天各自一个上下文。开新会话只影响那一个，旧对话留在历史里（QQ 发 /session 切回）；记忆不受影响。"),
            qqSessions.length
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                  ...qqSessions.map((x) => {
                    const isGroup = x.kind === "group";
                    const sizeKb = Math.round((x.size || 0) / 1024);
                    const dt = new Date((x.mtime || 0) * 1000);
                    const timeStr = dt.getFullYear() > 1970
                      ? (dt.getMonth() + 1) + "-" + dt.getDate() + " " + String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0")
                      : "";
                    return h("div", {
                      key: x.chat,
                      style: {
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "8px 12px", borderRadius: 8,
                        border: "1px solid rgba(0,0,0,.06)", background: "#fafafa",
                      },
                    },
                      h("span", { style: { fontSize: 14 } }, isGroup ? "👥" : "💬"),
                      h("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
                        h("span", { style: { fontSize: 12, fontWeight: 500 } },
                          (isGroup ? "群 " : "私聊 ") + x.target),
                        h("span", { style: { fontSize: 11, color: "#9ca3af" } },
                          sizeKb + "K" + (timeStr ? " · 最后活跃 " + timeStr : "")
                          + (() => {
                              const b = (chatMap.binding || {})[x.chat];
                              if (!b) return " · 未绑定（下条消息新建）";
                              const short = String(b).replace(/^onebot-(private|group)-\d+-?/, "") || "当前";
                              return " · 当前：" + (short || "已绑定");
                            })()),
                      ),
                      h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
                        h("button", {
                          type: "button",
                          title: "主动唤醒：开了她才会在这个聊天里自己醒来",
                          style: {
                            ...S.btn(false), padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap",
                            borderColor: x.wake ? "#4084ff" : undefined,
                            color: x.wake ? "#4084ff" : "#9ca3af",
                            background: x.wake ? "rgba(64,132,255,.06)" : "#fff",
                          },
                          disabled: qqBusy,
                          onClick: async () => {
                            try {
                              const r = await call("/qq/wake", {
                                method: "POST",
                                body: JSON.stringify({ chat: x.chat, wake: !x.wake }),
                              });
                              setQqMsg(r && r.ok
                                ? (isGroup ? "群 " : "私聊 ") + x.target + (x.wake ? " 关掉了主动唤醒" : " 打开了主动唤醒")
                                : "失败：" + JSON.stringify(r));
                              if (r && r.ok) void load();
                            } catch (e) {
                              setQqMsg("失败：" + (e && e.message ? e.message : String(e)));
                            }
                          },
                        }, x.wake ? "唤醒·开" : "唤醒·关"),
                        h("button", {
                          style: { ...S.btn(true), padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap" },
                          disabled: qqBusy,
                          onClick: async () => {
                            setQqBusy(true);
                            setQqMsg(null);
                            try {
                              const r = await call("/qq/new-session", {
                                method: "POST",
                                body: JSON.stringify({ chat: x.chat }),
                              });
                              setQqMsg(r && r.ok
                                ? (isGroup ? "群 " : "私聊 ") + x.target + " 已排队"
                                : "失败：" + JSON.stringify(r));
                              if (r && r.ok) setTimeout(() => { void load(); }, 2500);
                            } catch (e) {
                              setQqMsg("失败：" + (e && e.message ? e.message : String(e)));
                            } finally {
                              setQqBusy(false);
                            }
                          },
                        }, qqBusy ? "…" : "开新会话"),
                        h("button", {
                          style: { ...S.btn(false), padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap" },
                          disabled: qqBusy,
                          onClick: async () => {
                            if (historyOpen === x.chat) {
                              setHistoryOpen(null);
                              return;
                            }
                            setHistoryOpen(x.chat);
                            try {
                              const hh = await call("/qq/session-history?chat=" + encodeURIComponent(x.chat));
                              setSessionHistory((m) => ({ ...m, [x.chat]: hh }));
                            } catch (e) {
                              setQqMsg("读历史失败：" + (e && e.message ? e.message : String(e)));
                            }
                          },
                        }, historyOpen === x.chat ? "收起" : "历史"),
                      ),
                    );
                  }),
                )
              : h("div", { style: { ...S.muted, fontSize: 12 } }, "没有找到 QQ 会话（还没人跟她聊过？）"),
            historyOpen
              ? (() => {
                  const hh = sessionHistory[historyOpen];
                  if (!hh) return h("div", { style: { ...S.muted, fontSize: 11, marginTop: 8 } }, "读取中…");
                  const items = hh.items || [];
                            return h("div", { style: { marginTop: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(0,0,0,.06)", background: "#fff" } },
                    h("div", { style: { fontSize: 11, color: "#6b7280", marginBottom: 6 } },
                      historyOpen + " 的历史会话（点「绑到这个」切过去，会重启生效）"),
                    items.length
                      ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                          ...items.map((it) => {
                            const d2 = new Date((it.mtime || 0) * 1000);
                            const ts = (d2.getMonth() + 1) + "-" + d2.getDate() + " " + String(d2.getHours()).padStart(2, "0") + ":" + String(d2.getMinutes()).padStart(2, "0");
                            return h("div", {
                              key: it.session,
                              style: {
                                display: "flex", alignItems: "center", gap: 8, fontSize: 11,
                                padding: "5px 8px", borderRadius: 6,
                                border: "1px solid " + (it.is_current ? "rgba(64,132,255,.4)" : "rgba(0,0,0,.06)"),
                                background: it.is_current ? "rgba(64,132,255,.04)" : "#fafafa",
                              },
                            },
                              h("span", { style: { flex: 1, fontFamily: "monospace", wordBreak: "break-all" } },
                                it.session + (it.is_current ? "  ←当前" : "")),
                              h("span", { style: { color: "#9ca3af", whiteSpace: "nowrap" } },
                                Math.round(it.size / 1024) + "K · " + ts),
                              it.is_current
                                ? h("span", { style: { color: "#4084ff", whiteSpace: "nowrap" } }, "使用中")
                                : h("button", {
                                    style: { ...S.btn(false), padding: "2px 8px", fontSize: 11, whiteSpace: "nowrap" },
                                    disabled: qqBusy,
                                    onClick: async () => {
                                      setQqBusy(true);
                                      setQqMsg(null);
                                      try {
                                        const r = await call("/qq/bind", {
                                          method: "POST",
                                          body: JSON.stringify({ chat: historyOpen, session: it.session }),
                                        });
                                        setQqMsg(r && r.ok ? "已绑定，重启中…" : "失败：" + JSON.stringify(r));
                                        setHistoryOpen(null);
                                        setSessionHistory((m) => ({ ...m, [historyOpen]: null }));
                                        setTimeout(() => { void load(); }, 5000);
                                      } catch (e) {
                                        setQqMsg("失败：" + (e && e.message ? e.message : String(e)));
                                      } finally {
                                        setQqBusy(false);
                                      }
                                    },
                                  }, "绑到这个"),
                            );
                          }),
                        )
                      : h("div", { style: { ...S.muted, fontSize: 11 } }, "没有历史会话"),
                  );
                })()
              : null,
            qqSessions.length > 1
              ? h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 10 } },
                  h("button", {
                    style: {
                      ...S.btn(false), padding: "4px 12px", fontSize: 12,
                      color: "#c0392b", borderColor: "rgba(192,57,43,.3)",
                    },
                    disabled: qqBusy,
                    onClick: async () => {
                      if (!(window.confirm || confirm)("把所有 " + qqSessions.length + " 个会话都开新的？\n（旧对话都留在历史里，记忆不受影响）")) return;
                      setQqBusy(true);
                      setQqMsg(null);
                      try {
                        const r = await call("/qq/new-session", {
                          method: "POST",
                          body: JSON.stringify({ chat: "all" }),
                        });
                        setQqMsg(r && r.ok ? "全部 " + (r.count || 0) + " 个已排队" : "失败：" + JSON.stringify(r));
                        if (r && r.ok) setTimeout(() => { void load(); }, 3000);
                      } catch (e) {
                        setQqMsg("失败：" + (e && e.message ? e.message : String(e)));
                      } finally {
                        setQqBusy(false);
                      }
                    },
                  }, "全部重置"),
                )
              : null,
          ),

          ...(data.groups || []).map((g) =>
            h("div", { key: g.id, style: S.card },
              h("div", { style: { ...S.label, marginBottom: 10 } }, g.title),
              h("div", { style: {
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10, alignItems: "start",
              } },
                ...g.fields.map((f) => {
                  // 「允许在哪些群聊天」只在「在特定群聊天」时出现，且不显示标题和说明（选了就懂）
                  const isGroupWhite = f.key === "groupAllowFrom";
                  if (isGroupWhite) {
                    const gp = (draft && Object.prototype.hasOwnProperty.call(draft, "groupPolicy"))
                      ? draft.groupPolicy
                      : "open";
                    if (String(gp) !== "allowlist") return null;
                  }

                  // 「管理员用户」跟着「只允许管理员私聊」走
                  if (f.key === "adminUsers") {
                    const dp = (draft && Object.prototype.hasOwnProperty.call(draft, "dmPolicy"))
                      ? draft.dmPolicy
                      : "open";
                    if (String(dp) !== "open") return null;
                  }

                  // 「允许和谁聊天」跟着「只允许特定人私聊」走
                  if (f.key === "allowFrom") {
                    const dp = (draft && Object.prototype.hasOwnProperty.call(draft, "dmPolicy"))
                      ? draft.dmPolicy
                      : "open";
                    if (String(dp) !== "allowlist") return null;
                  }
                  return h("div", {
                    key: f.key,
                    style: {
                      display: "flex", flexDirection: "column", gap: 4, minWidth: 0,
                      gridColumn: f.col === "full" ? "1 / -1" : undefined,
                    },
                  },
                    isGroupWhite ? null : h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                      h("span", { style: { fontSize: 12, fontWeight: 500 } }, f.label),
                      f.is_set ? h("span", { style: { fontSize: 10, color: "#2fa36b" } }, "已配") : null,
                    ),
                    control(f),
                    (!isGroupWhite && f.hint) ? h("div", { style: { ...S.muted, fontSize: 11 } }, f.hint) : null,
                  );
                }),
              ),
            ),
          ),

          // ---- 其他用户画像（按 QQ 号区分）----
          h("div", { style: S.card },
            h("div", { style: { ...S.label, display: "flex", alignItems: "center", justifyContent: "space-between" } },
              h("span", {}, "其他用户画像"),
              h("span", {
                style: { fontSize: 12, cursor: "pointer", color: "#4084ff", fontWeight: 400 },
                onClick: () => setProfilesOpen(!profilesOpen),
              }, profilesOpen ? "收起" : `展开 ${otherProfiles.length} 人`),
            ),
            h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
              "她认识的人（按 QQ 号区分）。每个人的记忆和画像独立，互不串门。"),
            profilesOpen
              ? (otherProfiles.length === 0
                  ? h("div", { style: { ...S.muted, fontSize: 12, padding: "12px 0", textAlign: "center" } },
                      "还没认识别人。等有人私聊她或她在群里说话，这里会出现。")
                  : h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                      ...otherProfiles.map((p) =>
                        h("div", {
                          key: "prof-" + p.user_id,
                          style: {
                            display: "flex", gap: 10, padding: "8px 10px", borderRadius: 8,
                            border: "1px solid rgba(0,0,0,.08)", background: "#fafafa",
                          },
                        },
                          h("img", {
                            src: "http://q1.qlogo.cn/g?b=qq&nk=" + p.user_id + "&s=100",
                            style: { width: 40, height: 40, borderRadius: 999, flexShrink: 0, background: "#eee" },
                            onError: (ev) => { ev.target.style.visibility = "hidden"; },
                          }),
                          h("div", { style: { flex: 1, minWidth: 0 } },
                            h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2 } },
                              h("span", { style: { fontSize: 13, fontWeight: 600 } }, p.name || ("QQ " + p.user_id)),
                              h("span", { style: { ...S.muted, fontSize: 11 } }, p.user_id),
                              h("span", { style: { ...S.muted, fontSize: 11 } }, "· 说过 " + (p.msg_count || 0) + " 次"),
                            ),
                            // ---- 段一：你手编的（进系统提示词）----
                            h("div", { style: { fontSize: 11, color: "#888", margin: "6px 0 3px" } },
                              "你手编的画像 —— 进系统提示词，她每轮都看得到"),
                            h("textarea", {
                              value: profileDrafts[p.user_id] !== undefined
                                ? profileDrafts[p.user_id]
                                : (p.manual_profile || ""),
                              placeholder: "比如：一个爱猫的程序员，说话很短，最烦加班",
                              rows: 2,
                              onChange: (ev) => setProfileDrafts({
                                ...profileDrafts,
                                [p.user_id]: ev.target.value,
                              }),
                              style: {
                                width: "100%", boxSizing: "border-box", fontSize: 12, lineHeight: 1.5,
                                padding: "6px 8px", borderRadius: 6, resize: "vertical",
                                border: "1px solid rgba(0,0,0,.14)", background: "#fff",
                                fontFamily: "inherit", color: "#333",
                              },
                            }),
                            h("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0 8px" } },
                              h("button", {
                                disabled: profileDrafts[p.user_id] === undefined,
                                onClick: async () => {
                                  const text = profileDrafts[p.user_id];
                                  if (text === undefined) return;
                                  try {
                                    await call("/profiles", {
                                      method: "POST",
                                      body: JSON.stringify({ user_id: p.user_id, manual_profile: text }),
                                    });
                                    setProfiles(profiles.map((x) =>
                                      x.user_id === p.user_id ? { ...x, manual_profile: text } : x));
                                  } catch (e) { /* 忽略 */ }
                                },
                                style: {
                                  fontSize: 11, padding: "3px 10px", borderRadius: 5,
                                  cursor: profileDrafts[p.user_id] === undefined ? "default" : "pointer",
                                  border: "1px solid rgba(0,0,0,.14)",
                                  background: profileDrafts[p.user_id] === undefined ? "#f2f2f2" : "#fff",
                                  color: profileDrafts[p.user_id] === undefined ? "#aaa" : "#333",
                                },
                              }, "保存这段"),
                              h("span", { style: { fontSize: 11, color: "#aaa" } },
                                "改完最多 20 秒她才看到"),
                            ),
                            // ---- 段二：她自己积累的（只走对话注入）----
                            h("div", { style: { fontSize: 11, color: "#888", marginBottom: 3 } },
                              "她自己记下的 —— 每抽到一条就变，所以只走对话注入，不进系统提示词"),
                            h("div", { style: { fontSize: 12, lineHeight: 1.5, color: "#555", whiteSpace: "pre-wrap" } },
                              p.profile ? String(p.profile).slice(0, 200) : "（还没提炼出画像）"),
                          ),
                          h("span", {
                            style: { cursor: "pointer", opacity: 0.5, fontSize: 14, flexShrink: 0, alignSelf: "flex-start", padding: "0 4px" },
                            title: "删掉这个人",
                            onClick: async () => {
                              if (!window.confirm("删掉 " + (p.name || p.user_id) + " 的画像？")) return;
                              try {
                                await call("/profiles", { method: "POST", body: JSON.stringify({ user_id: p.user_id, delete: true }) });
                                setProfiles(profiles.filter((x) => x.user_id !== p.user_id));
                              } catch (e) { /* 忽略 */ }
                            },
                          }, "×"),
                        ),
                      ),
                    )
                )
              : null,
          ),

          // ---- 工具权限（可展开，逐项开关）----
          napcatTools && napcatTools.groups
            ? h("div", { style: { ...S.card, marginBottom: 14 } },
                h("div", { style: S.label }, "工具权限（她能调用哪些 QQ 操作）"),
                h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
                  "QQ 插件的 127 个 NapCat 接口，逐项控制。点一组展开看里面具体是什么；"
                  + "组头右边的按钮能一键全开/全关整组。现在开着 "
                  + (napcatTools.enabledCount || 0) + " / " + (napcatTools.totalCount || 0) + " 个。"),

                ...(napcatTools.groups || []).map((g) => {
                  const open = !!napcatOpen[g.id];
                  const allOn = g.on === g.total;
                  return h("div", {
                    key: "napcat-g-" + g.id,
                    style: { borderBottom: "1px solid rgba(0,0,0,.06)", paddingBottom: 6, marginBottom: 6 },
                  },
                    // 组头：点标题展开，点右边按钮整组开关
                    h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0" } },
                      h("div", {
                        onClick: () => setNapcatOpen({ ...napcatOpen, [g.id]: !open }),
                        style: { flex: 1, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
                      },
                        h("div", { style: { fontSize: 13, fontWeight: 600, color: g.on > 0 ? "#4084ff" : "#333" } }, g.label),
                        h("div", {
                          style: {
                            fontSize: 11, padding: "1px 7px", borderRadius: 999,
                            background: g.on > 0 ? "rgba(64,132,255,.10)" : "rgba(0,0,0,.05)",
                            color: g.on > 0 ? "#4084ff" : "#999",
                          },
                        }, g.on + "/" + g.total),
                        h("div", { style: { fontSize: 11, color: "#aaa" } }, open ? "收起 ▴" : "展开 ▾"),
                      ),
                      h("button", {
                        style: {
                          ...S.btn(false), fontSize: 11, padding: "3px 10px",
                          border: "1px solid " + (allOn ? "#e5484d" : "#4084ff"),
                          color: allOn ? "#e5484d" : "#4084ff",
                        },
                        onClick: async () => {
                          try {
                            const r = await call("/napcat/tools", {
                              method: "POST",
                              body: JSON.stringify({ group: g.id, enabled: !allOn }),
                            });
                            setNapcatTools(r);
                          } catch (e) {
                            setQqMsg({ kind: "error", text: "改不了：" + (e && e.message ? e.message : String(e)) });
                          }
                        },
                      }, allOn ? "全关" : "全开"),
                    ),
                    // 展开内容：每个 action 一行开关
                    open
                      ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "4px 0 6px 4px" } },
                          ...(g.items || []).map((it) =>
                            h("div", {
                              key: "napcat-a-" + it.action,
                              onClick: async () => {
                                try {
                                  const r = await call("/napcat/tools", {
                                    method: "POST",
                                    body: JSON.stringify({ action: it.action, enabled: !it.enabled }),
                                  });
                                  setNapcatTools(r);
                                } catch (e) {
                                  setQqMsg({ kind: "error", text: "改不了：" + (e && e.message ? e.message : String(e)) });
                                }
                              },
                              style: {
                                display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                                padding: "4px 8px", borderRadius: 6,
                                border: it.enabled ? "1px solid rgba(64,132,255,.45)" : "1px solid rgba(0,0,0,.08)",
                                background: it.enabled ? "rgba(64,132,255,.05)" : "#fff",
                                transition: "border-color .12s, background .12s",
                              },
                            },
                              h("div", {
                                style: {
                                  width: 13, height: 13, borderRadius: 3, boxSizing: "border-box", flex: "0 0 auto",
                                  border: it.enabled ? "4px solid #4084ff" : "1px solid rgba(0,0,0,.22)",
                                  background: "#fff",
                                },
                              }),
                              h("div", {
                                style: {
                                  fontSize: 12,
                                  color: it.enabled ? "#2b5fbf" : "#888",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                },
                                title: it.action,   // 悬停看英文 action
                              }, it.label || it.action),
                            ),
                          ),
                        )
                      : null,
                  );
                }),
              )
            : null,

          // 保存按钮（固定在屏幕右侧中间，跟其他页签一致）          // 保存按钮（固定在屏幕右侧中间，跟其他页签一致）
          h("div", {
            key: "qq-dirty-save",
            style: {
              position: "fixed", right: 24, top: "50%", transform: "translateY(-50%)",
              display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8,
              background: "#ffffff", padding: "12px 16px", borderRadius: 12,
              border: "1px solid rgba(0,0,0,.08)", boxShadow: "0 8px 24px rgba(0,0,0,.12)",
              zIndex: 9999, minWidth: 160,
            },
          },
            props && props.onBack
              ? h("button", { type: "button", style: S.btn(false), onClick: props.onBack }, "← 她的记忆")
              : null,
            notice ? h("div", {
              style: {
                fontSize: 11, lineHeight: 1.4, textAlign: "center", maxWidth: 180,
                color: notice.kind === "error" ? "#c0392b" : "#2fa36b",
                wordBreak: "break-word",
              },
            }, notice.text) : null,
            dirty ? h("div", { style: { fontSize: 11, color: "#f59e0b", textAlign: "center" } }, Object.keys(draft).length + " 项未保存") : null,
            h("button", {
              style: { ...S.btn(true), opacity: dirty ? 1 : 0.5, cursor: dirty ? "pointer" : "default" },
              disabled: saving || !dirty,
              onClick: () => void save(),
            }, saving ? "保存中…" : "保存改动"),
            h("button", {
              style: { ...S.btn(false), fontSize: 11, padding: "4px 10px" },
              onClick: () => { setDraft({}); setNotice(null); },
            }, "撤销改动"),
          ),
        );
      }

      function PersonaSection(props) {
        const [userProfile, setUserProfile] = React.useState("");
        const [profileMsg, setProfileMsg] = React.useState(null);
        const [relations, setRelations] = React.useState([]);
        const [relInput, setRelInput] = React.useState("");
        const [profileFields, setProfileFields] = React.useState({
          name: "", job: "", schedule: "", work: "", food: "", likes: "", taboos: "", note: "",
        });
        // 画像是否已成功加载（防止「加载失败 → 全空 → 保存覆盖」）
        const [profileLoaded, setProfileLoaded] = React.useState(false);
        // 画像字段是否被用户改过（没改过就不覆盖，避免保存别的东西时清空画像）
        const [profileDirty, setProfileDirty] = React.useState(false);
        const setPf = (k, v) => {
          setProfileFields((f) => ({ ...f, [k]: v }));
          setProfileDirty(true);
        };
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState("");
        const [limits, setLimits] = React.useState({ constitution: 15000, self_model: 4000 });
        const [saving, setSaving] = React.useState(false);
        const [notice, setNotice] = React.useState(null);
        const [saved, setSaved] = React.useState({ constitution: "", self_model: "", self_image: "", identity: "" });
        const [draft, setDraft] = React.useState({ constitution: "", self_model: "", self_image: "", identity: "" });
        // ---- 自我认知演化设置（2026-11-07）----
        const [selfCfg, setSelfCfg] = React.useState({
          selfEvolveEnabled: true, selfEvolveHour: 22, selfEvolvePerDay: 1,
          selfAllowAiWrite: true, selfMaxLines: 10, selfOverflow: "merge",
          selfDedupe: 0.6, selfVersionKeep: 30,
          selfFacts: ["turns", "memory", "expr", "slang", "browse", "praise", "corrected"],
        });
        const [selfFactsData, setSelfFactsData] = React.useState(null);
        const [selfVersions, setSelfVersions] = React.useState([]);
        const [selfOpen, setSelfOpen] = React.useState(false);
        const [selfSaving, setSelfSaving] = React.useState(false);
        const [selfNotice, setSelfNotice] = React.useState(null);
        // 学说话的两个计数（2026-11-06）：人格设定页的「她怎么学说话」卡片要显示
        const [exprCount, setExprCount] = React.useState(0);
        const [wordCount, setWordCount] = React.useState(0);
        const [idFields, setIdFields] = React.useState({
          name: "", self_call: "", user_call: "", personality: "", speaking: "", taboo: "", free: "",
          think_cn: false,
          think_ds: false,
          ai_flavor_on: true,
          self_call_in_speech: false,
          _newTaboo: "",
          taboo_off: "",
          ai_flavor: "允许 2% 语法错误、7% 主谓宾省略、7% 聊跑题；口癖 50% 概率出现且单独一条；允许「？？？」这类网络标点，概率 2%。",
          // 2026-11-06：学习人类说话的开关 + 可改提示词
          learn_speak_on: true,
          learn_speak_prompt: "",
        });
        // 2026-11-06：「学什么」的抽取 prompt（存在服务端文件里，可改）
        const [learnPrompt, setLearnPrompt] = React.useState("");
        const [learnPromptDirty, setLearnPromptDirty] = React.useState(false);

        // 拉「学说话」的计数 + 当前生效的 prompt
        React.useEffect(() => {
          (async () => {
            try {
              const [er, sr] = await Promise.all([call("/expressions"), call("/slang")]);
              setExprCount(Array.isArray(er && er.items) ? er.items.length : 0);
              const words = Array.isArray(sr) ? sr : [];
              setWordCount(words.filter((x) => String((x && x.meaning) || "").trim()).length);
            } catch { /* 拿不到就显示 0，不挡页面 */ }
            try {
              const lp = await call("/learn/prompt");
              setLearnPrompt(String((lp && lp.prompt) || ""));
            } catch { /* 同上 */ }
          })();
        }, []);
        // ---- 自我认知演化：拉配置 / 台账 / 版本（2026-11-07）----
        React.useEffect(() => {
          (async () => {
            try {
              const pr = await call("/proactive");
              if (pr && typeof pr === "object") {
                setSelfCfg((c) => ({
                  ...c,
                  selfEvolveEnabled: pr.selfEvolveEnabled !== false,
                  selfEvolveHour: Number.isFinite(pr.selfEvolveHour) ? pr.selfEvolveHour : 22,
                  selfEvolvePerDay: Number.isFinite(pr.selfEvolvePerDay) ? pr.selfEvolvePerDay : 1,
                  selfAllowAiWrite: pr.selfAllowAiWrite !== false,
                  selfMaxLines: Number.isFinite(pr.selfMaxLines) ? pr.selfMaxLines : 10,
                  selfOverflow: ["merge", "drop-oldest", "reject"].includes(pr.selfOverflow) ? pr.selfOverflow : "merge",
                  selfDedupe: Number.isFinite(pr.selfDedupe) ? pr.selfDedupe : 0.6,
                  selfVersionKeep: Number.isFinite(pr.selfVersionKeep) ? pr.selfVersionKeep : 30,
                  selfFacts: Array.isArray(pr.selfFacts) && pr.selfFacts.length
                    ? pr.selfFacts.map(String)
                    : ["turns", "memory", "expr", "slang", "browse", "praise", "corrected"],
                }));
              }
            } catch { /* 读不到就用默认值，不挡页面 */ }
            try {
              const fr = await call("/self/facts");
              setSelfFactsData(fr && fr.facts ? fr.facts : null);
            } catch { /* 同上 */ }
          })();
        }, []);

        const loadSelfVersions = React.useCallback(async () => {
          try {
            const vr = await call("/persona/versions");
            setSelfVersions(Array.isArray(vr && vr.versions) ? vr.versions : []);
          } catch { setSelfVersions([]); }
        }, []);

        const saveSelfCfg = async () => {
          setSelfSaving(true);
          setSelfNotice(null);
          try {
            await call("/proactive", { method: "POST", body: JSON.stringify(selfCfg) });
            setSelfNotice({ kind: "ok", text: "已保存，下一轮就生效。" });
          } catch (err) {
            setSelfNotice({ kind: "error", text: "保存失败：" + (err && err.message ? err.message : String(err)) });
          } finally {
            setSelfSaving(false);
          }
        };

        const rollbackTo = async (v) => {
          if (!window.confirm("回滚到 " + (v.at || v.file) + " 那一版？\n当前内容会先存一份快照，丢不了。")) return;
          try {
            const r = await call("/persona/rollback", { method: "POST", body: JSON.stringify({ file: v.file }) });
            const sm = (r && r.persona && r.persona.self_model) || "";
            if (sm) {
              setDraft((d) => ({ ...d, self_model: sm }));
              setSaved((s) => ({ ...s, self_model: sm }));
            }
            setSelfNotice({ kind: "ok", text: "已回滚到 " + (v.at || v.file) });
            await loadSelfVersions();
          } catch (err) {
            setSelfNotice({ kind: "error", text: "回滚失败：" + (err && err.message ? err.message : String(err)) });
          }
        };

        const SELF_FACT_OPTS = [
          ["turns", "聊了多少轮 / 存了多少原话"],
          ["memory", "整理出的事件 / 约定"],
          ["expr", "学到的说话方式"],
          ["slang", "学会的词"],
          ["browse", "刷了多少 B 站"],
          ["tieba", "逛了多少贴吧"],
          ["notes", "写了多少便签"],
          ["diary", "写了多少日记"],
          ["praise", "老大夸过几次"],
          ["corrected", "被纠正过几次"],
        ];

        const selfFactPreview = (f, want) => {
          if (!f) return "（还没算出来）";
          const has = (k) => want.includes(k);
          const parts = [];
          if (has("turns")) parts.push("聊了 " + (f.turns || 0) + " 轮");
          if (has("memory")) parts.push("事件 " + (f.l3 || 0) + " / 约定 " + (f.l4 || 0));
          if (has("expr")) parts.push("说法 " + (f.expr || 0) + " 条");
          if (has("slang")) parts.push("词 " + (f.slang || 0) + " 个");
          if (has("browse")) parts.push("刷 B 站 " + (f.browsed || 0));
          if (has("tieba")) parts.push("逛贴吧 " + (f.tieba || 0));
          if (has("notes")) parts.push("便签 " + (f.notes || 0));
          if (has("diary")) parts.push("日记 " + (f.diary || 0));
          if (has("praise")) parts.push("被夸 " + (f.praise || 0));
          if (has("corrected")) parts.push("被纠正 " + (f.corrected || 0));
          return parts.length ? parts.join(" · ") : "（一项都没勾，她会收到空账单）";
        };

        const renderSelfEvolve = () => h("div", { style: { marginTop: 2 } },
          h("button", {
            type: "button",
            style: S.disclosure,
            onClick: () => {
              const next = !selfOpen;
              setSelfOpen(next);
              if (next && !selfVersions.length) void loadSelfVersions();
            },
          }, (selfOpen ? "▾ " : "▸ ") + "演化设置 —— 她怎么想自己"),
          !selfOpen ? null : h("div", { style: { ...S.card, marginTop: 10, gap: 12 } },
            // 两个开关
            ...[
              ["selfEvolveEnabled", "到点让她想想自己",
                "按下面的时间和次数给她一份真实台账（聊了多少轮、学了什么、刷了多少），写不写她自己决定。"],
              ["selfAllowAiWrite", "允许她改自我认知",
                "关掉之后 persona_update 会被服务端拒掉，这一段就只有你能改。"],
            ].map(([key, label, desc]) => h("label", {
              key: key,
              style: { display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" },
            },
              h("input", {
                type: "checkbox",
                checked: !!selfCfg[key],
                onChange: (ev) => setSelfCfg((c) => ({ ...c, [key]: ev.target.checked })),
                style: { marginTop: 3 },
              }),
              h("span", { style: { display: "flex", flexDirection: "column", gap: 2 } },
                h("span", { style: { fontSize: 13 } }, label),
                h("span", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } }, desc),
              ),
            )),

            // 时间 + 次数
            h("div", { style: { ...S.row, flexWrap: "wrap" } },
              h("span", { style: { ...S.label, minWidth: 56 } }, "提醒时间"),
              h("select", {
                style: { ...S.select, width: 96 },
                value: selfCfg.selfEvolveHour,
                onChange: (ev) => setSelfCfg((c) => ({ ...c, selfEvolveHour: Number(ev.target.value) })),
              }, ...Array.from({ length: 24 }, (_, i) =>
                h("option", { key: i, value: i }, String(i).padStart(2, "0") + ":00"))),
              h("span", { style: { ...S.label, marginLeft: 12 } }, "每天"),
              h("select", {
                style: { ...S.select, width: 80 },
                value: selfCfg.selfEvolvePerDay,
                onChange: (ev) => setSelfCfg((c) => ({ ...c, selfEvolvePerDay: Number(ev.target.value) })),
              }, ...[1, 2, 3].map((n) => h("option", { key: n, value: n }, n + " 次"))),
            ),

            // 台账勾选
            h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h("span", { style: S.label }, "账单里给她看什么"),
              h("span", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } },
                "勾掉的她看不到。这些都是从记忆库里真实算的，不是她猜的。"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 10px" } },
                ...SELF_FACT_OPTS.map(([key, label]) => h("label", {
                  key: key,
                  style: { display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 12 },
                },
                  h("input", {
                    type: "checkbox",
                    checked: selfCfg.selfFacts.includes(key),
                    onChange: (ev) => setSelfCfg((c) => ({
                      ...c,
                      selfFacts: ev.target.checked
                        ? [...c.selfFacts, key]
                        : c.selfFacts.filter((x) => x !== key),
                    })),
                  }),
                  h("span", {}, label),
                )),
              ),
            ),

            // 台账预览
            h("div", {
              style: {
                fontSize: 12, lineHeight: 1.7, padding: "8px 10px", borderRadius: 8,
                background: "var(--dsw-color-bg, #fff)",
                border: "1px solid var(--dsw-color-border-subtle, rgba(0,0,0,.06))",
                color: "var(--dsw-color-text-secondary, #6b7280)",
              },
            }, "她今晚会看到：" + selfFactPreview(selfFactsData, selfCfg.selfFacts)),

            // 条数 / 溢出 / 去重
            h("div", { style: { ...S.row, flexWrap: "wrap" } },
              h("span", { style: { ...S.label, minWidth: 56 } }, "最多"),
              h("input", {
                type: "number", min: 1, max: 50,
                style: { ...S.input, width: 72 },
                value: selfCfg.selfMaxLines,
                onChange: (ev) => setSelfCfg((c) => ({ ...c, selfMaxLines: Number(ev.target.value) || 10 })),
              }),
              h("span", { style: S.muted }, "条，满了"),
              h("select", {
                style: { ...S.select, width: 128 },
                value: selfCfg.selfOverflow,
                onChange: (ev) => setSelfCfg((c) => ({ ...c, selfOverflow: ev.target.value })),
              },
                h("option", { value: "merge" }, "合并相近的"),
                h("option", { value: "drop-oldest" }, "淘汰最旧的"),
                h("option", { value: "reject" }, "不收新的"),
              ),
            ),

            h("div", { style: { ...S.row, flexWrap: "wrap" } },
              h("span", { style: { ...S.label, minWidth: 56 } }, "相似度 ≥"),
              h("input", {
                type: "number", min: 0, max: 1, step: 0.05,
                style: { ...S.input, width: 80 },
                value: selfCfg.selfDedupe,
                onChange: (ev) => setSelfCfg((c) => ({ ...c, selfDedupe: Number(ev.target.value) })),
              }),
              h("span", { style: S.muted }, "就不收（0.6 大概「换了个说法」就挡；调低更容易收重复）"),
            ),

            // 版本
            h("div", { style: { ...S.row, flexWrap: "wrap" } },
              h("span", { style: { ...S.label, minWidth: 56 } }, "留历史"),
              h("input", {
                type: "number", min: 0, max: 200,
                style: { ...S.input, width: 72 },
                value: selfCfg.selfVersionKeep,
                onChange: (ev) => setSelfCfg((c) => ({ ...c, selfVersionKeep: Number(ev.target.value) })),
              }),
              h("span", { style: S.muted }, "个"),
              h("button", {
                type: "button",
                style: { ...S.btn(false), padding: "5px 12px", fontSize: 12 },
                onClick: loadSelfVersions,
              }, "看历史版本（" + selfVersions.length + "）"),
            ),

            !selfVersions.length ? null : h("div", {
              style: {
                maxHeight: 168, overflow: "auto", padding: "6px 10px", borderRadius: 8,
                background: "var(--dsw-color-bg, #fff)",
                border: "1px solid var(--dsw-color-border-subtle, rgba(0,0,0,.06))",
              },
            }, ...selfVersions.slice().reverse().map((v) => h("div", {
              key: v.file,
              style: { display: "flex", gap: 8, alignItems: "center", padding: "3px 0", fontSize: 12 },
            },
              h("span", { style: { flex: 1, color: "var(--dsw-color-text-secondary, #6b7280)" } },
                (v.at || v.file) + " · " + (v.reason || "—") + " · " + (v.chars || 0) + " 字"),
              h("button", {
                type: "button",
                style: { ...S.btn(false), padding: "2px 10px", fontSize: 11 },
                onClick: () => rollbackTo(v),
              }, "回滚"),
            ))),

            h("div", { style: { ...S.footer, alignItems: "center" } },
              selfNotice ? h("span", {
                style: {
                  fontSize: 12, marginRight: "auto",
                  color: selfNotice.kind === "error" ? "#c0392b" : "#2fa36b",
                },
              }, selfNotice.text) : h("span", { style: { marginRight: "auto", fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } },
                "这几项存在主动消息配置里，改完立刻生效。"),
              h("button", {
                type: "button",
                style: S.btn(true),
                onClick: saveSelfCfg,
                disabled: selfSaving,
              }, selfSaving ? "保存中…" : "保存演化设置"),
            ),
          ),
        );

        const setId = (k, v) => setIdFields((f) => ({ ...f, [k]: v }));

        const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

        const load = React.useCallback(async () => {
          setLoading(true);
          setError("");
          try {
            const data = await call("/persona");
            setSaved({ constitution: data.constitution || "", self_model: data.self_model || "", self_image: data.self_image || "", identity: data.identity || "" });
            setDraft({ constitution: data.constitution || "", self_model: data.self_model || "", self_image: data.self_image || "", identity: data.identity || "" });
            try {
              const parsed = data.identity ? JSON.parse(data.identity) : {};
              setIdFields({
                name: parsed.name || "", self_call: parsed.self_call || "", user_call: parsed.user_call || "",
                personality: parsed.personality || "", speaking: parsed.speaking || "",
                taboo: parsed.taboo || "", free: parsed.free || "",
                think_cn: !!parsed.think_cn,
                think_ds: !!parsed.think_ds,
                ai_flavor_on: parsed.ai_flavor_on !== false,
                self_call_in_speech: parsed.self_call_in_speech === true,
                ai_flavor: parsed.ai_flavor || "允许 2% 语法错误、7% 主谓宾省略、7% 聊跑题；口癖 50% 概率出现且单独一条；允许「？？？」这类网络标点，概率 2%。",
                // 2026-11-06：漏了这两个，导致「学什么」的 textarea 永远是空的
                learn_speak_on: parsed.learn_speak_on !== false,
                learn_speak_prompt: parsed.learn_speak_prompt || "",
              });
            } catch { /* ignore */ }
            if (data.limits) setLimits(data.limits);
            setNotice(null);
          } catch (err) {
            setError("读不到人格设定。先确认记忆服务在跑（" + serviceUrl() + "）。");
          } finally {
            setLoading(false);
          }
        }, []);

        React.useEffect(() => {
          void (async () => {
            try {
              const r = await call("/persona/user");
              if (r && typeof r.user_profile === "string") {
                setUserProfile(r.user_profile);
                // 解析 Markdown → 表单（粗略分行匹配）
                const md = r.user_profile;
                const pick = (key) => {
                  const m = md.match(new RegExp("[-*]\\s*" + key + "：\\s*(.+)"));
                  return m ? m[1].trim() : "";
                };
                const sec = (title) => {
                  const m = md.match(new RegExp("##\\s*" + title + "\\s*\n([\\s\\S]*?)(?=\\n##|$)"));
                  return m ? m[1].trim() : "";
                };
                const relSec = sec("我们的关系");
                const relTags = relSec.match(/他是我(.+)/);
                if (relTags) {
                  setRelations(relTags[1].split(/[、,，]/).map((x) => x.trim()).filter(Boolean));
                }
                setProfileFields({
                  name: pick("称呼"),
                  job: pick("职业"),
                  schedule: pick("作息"),
                  work: pick("工作"),
                  food: pick("饮食"),
                  likes: pick("喜欢"),
                  taboos: sec("雷区").replace(/^[-*]\s*/gm, "").trim(),
                  note: sec("备注"),
                });
                setProfileLoaded(true);
                setProfileDirty(false);
              }
            } catch { /* ignore */ }
          })();
        }, []);
        React.useEffect(() => { load(); }, [load]);

        const buildProfile = () => {
          const f = profileFields;
          const relLine = relations.length ? "## 我们的关系\n- 他是我" + relations.join("、") + "\n\n" : "";
          const basic = [
            f.name ? "- 称呼：" + f.name : "",
            f.job ? "- 职业：" + f.job : "",
            f.schedule ? "- 作息：" + f.schedule : "",
          ].filter(Boolean).join("\n");
          const life = [
            f.work ? "- 工作：" + f.work : "",
            f.food ? "- 饮食：" + f.food : "",
          ].filter(Boolean).join("\n");
          const likeLine = f.likes ? "## 喜欢\n- 喜欢：" + f.likes + "\n\n" : "";
          const taboo = f.taboos ? "## 雷区\n" + f.taboos.split("\n").filter((x) => x.trim()).map((x) => "- " + x.trim()).join("\n") + "\n\n" : "";
          const note = f.note ? "## 备注\n" + f.note + "\n" : "";
          return [
            relLine,
            basic ? "## 基本信息\n" + basic + "\n\n" : "",
            life ? "## 生活\n" + life + "\n\n" : "",
            likeLine,
            taboo,
            note,
          ].join("").trim();
        };

        const save = async () => {
          // 防误清空：画像没加载成功，或新内容是空但原来有内容 → 拦下
          const built = buildProfile();
          if (!profileLoaded) {
            setNotice({ kind: "error", text: "画像还没加载成功，先别保存（防止清空）。刷新页面试试。" });
            return;
          }
          if (!built.trim() && userProfile.trim()) {
            setNotice({ kind: "error", text: "画像会变成空的，已拦下。真要清空请点「清空画像」。" });
            return;
          }
          setSaving(true);
          setNotice(null);
          try {
            // 只在用户真的改过画像时才保存画像（否则保存 taboo 等会误清空画像）
            if (profileDirty) {
              await call("/persona/user", { method: "POST", body: JSON.stringify({ user_profile: built }) });
            }
            // 「学什么」的 prompt 单独存（不是 identity 里的字段）
            if (learnPromptDirty) {
              await call("/learn/prompt", {
                method: "POST",
                body: JSON.stringify({ prompt: learnPrompt }),
              });
              setLearnPromptDirty(false);
            }
            const res = await call("/persona", {
              method: "POST",
              body: JSON.stringify({
                constitution: draft.constitution,
                self_model: draft.self_model,
                self_image: draft.self_image,
                identity: JSON.stringify(idFields),
              }),
            });
            setSaved({ constitution: res.constitution || "", self_model: res.self_model || "", self_image: res.self_image || "" });
            setDraft({ constitution: res.constitution || "", self_model: res.self_model || "", self_image: res.self_image || "" });
            if (res.limits) setLimits(res.limits);
            setProfileDirty(false);
            setNotice({ kind: "ok", text: "已保存。插件下次刷新就带上，不用重启。" });
          } catch (err) {
            setNotice({ kind: "error", text: "保存失败：" + (err && err.message ? err.message : String(err)) });
          } finally {
            setSaving(false);
          }
        };

        const cancel = () => {
          setDraft({ constitution: saved.constitution, self_model: saved.self_model, self_image: saved.self_image });
          setNotice(null);
        };

        if (loading) {
          return h("div", { style: S.wrap }, h("div", { style: S.muted }, "正在读取人格设定…"));
        }

        const textareaStyle = {
          ...S.input, minHeight: 132, lineHeight: 1.65, resize: "vertical", fontFamily: "inherit",
        };

        return h("div", { style: S.wrap },

          h("div", { style: S.desc },
            "人格和记忆放在同一个服务里：前者每轮必带，后者检索着取。",
            "「身份与约定」只有你能改；「自我认知」AI 也会往里写 —— 服务端根本没给它改前一半的接口。",
            "两段都留空 = 整段不注入，等于没装。",
          ),

          error ? h("div", { style: S.notice("error") }, error) : null,

          h("div", { style: S.card },

            h("div", { style: S.field },
              h("div", { style: S.label }, "用户画像（每轮开头注入）"),
              h("div", { style: { ...S.muted, marginBottom: 6 } },
                "这些都在描述【用户是谁】——不是描述她。她每轮开头都会看到：他是谁、干什么、喜欢什么、别碰什么。比记忆抽取更稳（这是硬事实，不靠她记）。"),
              h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 4 } }, "关系（点一下选中，会自动写进画像；后面的可以自己加）"),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 } },
                ["老大", "主人", "老板", "朋友", "搭子"].map((tag) =>
                  h("button", {
                    key: tag,
                    onClick: () => setRelations(relations.includes(tag) ? relations.filter((x) => x !== tag) : [...relations, tag]),
                    style: {
                      fontSize: 12, lineHeight: "20px", padding: "1px 9px", borderRadius: 999, cursor: "pointer",
                      border: "1px solid " + (relations.includes(tag) ? "transparent" : "rgba(127,127,128,.28)"),
                      background: relations.includes(tag) ? "rgba(64,132,255,.16)" : "transparent",
                      color: relations.includes(tag) ? "#4084ff" : "inherit",
                    },
                  }, tag),
                ),
              ),
              relations.filter((x) => !["老大", "主人", "老板", "朋友", "搭子"].includes(x)).length
                ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 } },
                    relations.filter((x) => !["老大", "主人", "老板", "朋友", "搭子"].includes(x)).map((tag) =>
                      h("span", {
                        key: tag,
                        style: {
                          fontSize: 12, lineHeight: "20px", padding: "1px 9px", borderRadius: 999,
                          background: "rgba(64,132,255,.16)", color: "#4084ff",
                          display: "inline-flex", alignItems: "center", gap: 4,
                        },
                      }, tag,
                        h("span", {
                          onClick: () => setRelations(relations.filter((x) => x !== tag)),
                          style: { cursor: "pointer", opacity: 0.6, fontSize: 13, lineHeight: "20px" },
                        }, "×"),
                      ),
                    ),
                  )
                : null,
              h("div", { style: { display: "flex", gap: 6, marginBottom: 10 } },
                h("input", {
                  style: { ...S.input, maxWidth: 160 },
                  placeholder: "自己加一个（回车）",
                  value: relInput,
                  onChange: (ev) => setRelInput(ev.target.value),
                  onKeyDown: (ev) => {
                    if (ev.key === "Enter" && relInput.trim()) {
                      const v = relInput.trim();
                      if (!relations.includes(v)) setRelations([...relations, v]);
                      setRelInput("");
                    }
                  },
                }),
                h("button", {
                  style: S.btn(false),
                  onClick: () => {
                    const v = relInput.trim();
                    if (v && !relations.includes(v)) setRelations([...relations, v]);
                    setRelInput("");
                  },
                }, "添加"),
              ),

              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 } },
                h("div", {},
                  h("div", { style: { ...S.muted, fontSize: 11 } }, "他的称呼"),
                  h("input", { style: S.input, placeholder: "老大（他让我这么叫）", value: profileFields.name, onChange: (ev) => setPf("name", ev.target.value) }),
                ),
                h("div", {},
                  h("div", { style: { ...S.muted, fontSize: 11 } }, "他的职业"),
                  h("input", { style: S.input, placeholder: "他的职业，比如初中数学老师", value: profileFields.job, onChange: (ev) => setPf("job", ev.target.value) }),
                ),
                h("div", {},
                  h("div", { style: { ...S.muted, fontSize: 11 } }, "他的作息"),
                  h("input", { style: S.input, placeholder: "他几点睡、几点起", value: profileFields.schedule, onChange: (ev) => setPf("schedule", ev.target.value) }),
                ),
                h("div", {},
                  h("div", { style: { ...S.muted, fontSize: 11 } }, "他的工作"),
                  h("input", { style: S.input, placeholder: "他平时干什么活", value: profileFields.work, onChange: (ev) => setPf("work", ev.target.value) }),
                ),
                h("div", {},
                  h("div", { style: { ...S.muted, fontSize: 11 } }, "他的饮食"),
                  h("input", { style: S.input, placeholder: "他爱吃什么、喝什么", value: profileFields.food, onChange: (ev) => setPf("food", ev.target.value) }),
                ),
                h("div", {},
                  h("div", { style: { ...S.muted, fontSize: 11 } }, "他喜欢"),
                  h("input", { style: S.input, placeholder: "他喜欢什么、讨厌什么", value: profileFields.likes, onChange: (ev) => setPf("likes", ev.target.value) }),
                ),
              ),

              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 10 } }, "雷区（每行一条）"),
              h("textarea", {
                style: { ...S.input, minHeight: 70, lineHeight: 1.6, resize: "vertical", fontFamily: "inherit" },
                placeholder: "哪些话别对他说、哪些事别做\n比如：别催他早睡",
                value: profileFields.taboos,
                onChange: (ev) => setPf("taboos", ev.target.value),
              }),

              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 10 } }, "备注（自由写，有什么想让她记住的都放这儿）"),
              h("textarea", {
                style: { ...S.input, minHeight: 90, lineHeight: 1.6, resize: "vertical", fontFamily: "inherit" },
                placeholder: "关于他的任何事都可以写：他上次说过喜欢下雨天；他不太会表达但会在意；别在他加班时问他吃饭没…",
                value: profileFields.note,
                onChange: (ev) => setPf("note", ev.target.value),
              }),
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 2 } },
              profileMsg ? h("span", { style: { fontSize: 12, color: profileMsg.includes("失败") ? "#c0392b" : "#2fa36b" } }, profileMsg)
                : h("span", { style: S.muted }, userProfile.length + " 字符"),
            ),
          ),

          h("div", { style: S.card },

            h("div", { style: S.card },
              h("div", { style: { ...S.label, marginBottom: 8 } }, "身份（逐项填）"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
                h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("span", { style: { ...S.muted, fontSize: 12 } }, "名字"),
                  h("input", { style: S.input, value: idFields.name, placeholder: "例：沧澜", onChange: (ev) => setId("name", ev.target.value) }),
                ),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("span", { style: { ...S.muted, fontSize: 12 } }, "自称"),
                  h("input", { style: S.input, value: idFields.self_call, placeholder: "例：本澜", onChange: (ev) => setId("self_call", ev.target.value) }),
                  h("span", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } },
                    "有多个用逗号或顿号分隔，如：本澜、澜澜、咱澜"),
                  h("label", {
                    style: {
                      display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer", marginTop: 4,
                      padding: "8px 10px", borderRadius: 8,
                      border: "1.5px solid " + (idFields.self_call_in_speech === true ? "#4084ff" : "rgba(0,0,0,.10)"),
                      background: idFields.self_call_in_speech === true ? "rgba(64,132,255,.04)" : "#ffffff",
                      transition: "border-color .15s, background .15s",
                    },
                  },
                    h("input", {
                      type: "checkbox",
                      checked: idFields.self_call_in_speech === true,
                      onChange: (ev) => setId("self_call_in_speech", ev.target.checked),
                      style: { marginTop: 1 },
                    }),
                    h("span", { style: { display: "flex", flexDirection: "column", gap: 1 } },
                      h("span", { style: { fontSize: 12 } }, "说话时带自称"),
                      h("span", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } },
                        "默认关（日常用「我」，更自然）"),
                    ),
                  ),
                ),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("span", { style: { ...S.muted, fontSize: 12 } }, "怎么叫老大"),
                  h("input", { style: S.input, value: idFields.user_call, placeholder: "例：老大", onChange: (ev) => setId("user_call", ev.target.value) }),
                ),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("span", { style: { ...S.muted, fontSize: 12 } }, "脾气"),
                  h("input", { style: S.input, value: idFields.personality, placeholder: "例：饭饭是本体，被叫大肥鱼会炸毛", onChange: (ev) => setId("personality", ev.target.value) }),
                ),
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 10 } },
                h("span", { style: { ...S.muted, fontSize: 12 } }, "说话方式"),
                h("textarea", {
                  style: { ...S.input, minHeight: 60, resize: "vertical", fontFamily: "inherit" },
                  value: idFields.speaking,
                  placeholder: "例：像发微信，最多 3 句、80 字以内，只发对话，不写动作旁白。",
                  onChange: (ev) => setId("speaking", ev.target.value),
                }),
                h("label", {
                  style: {
                    display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer", marginTop: 4,
                    padding: "8px 10px", borderRadius: 8,
                    border: "1.5px solid " + (idFields.ai_flavor_on !== false ? "#4084ff" : "rgba(0,0,0,.10)"),
                    background: idFields.ai_flavor_on !== false ? "rgba(64,132,255,.04)" : "#ffffff",
                    transition: "border-color .15s, background .15s",
                  },
                },
                  h("input", {
                    type: "checkbox",
                    checked: idFields.ai_flavor_on !== false,
                    onChange: (ev) => setId("ai_flavor_on", ev.target.checked),
                    style: { marginTop: 1 },
                  }),
                  h("span", { style: { fontSize: 12 } }, "去 AI 味（默认开启）"),
                ),
                h("textarea", {
                  style: { ...S.input, minHeight: 60, resize: "vertical", fontFamily: "inherit", opacity: idFields.ai_flavor_on === false ? 0.5 : 1 },
                  value: idFields.ai_flavor,
                  placeholder: "人味瑕疵清单，可以改",
                  onChange: (ev) => setId("ai_flavor", ev.target.value),
                  disabled: idFields.ai_flavor_on === false,
                }),
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 10 } },
                h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                  h("span", { style: { ...S.muted, fontSize: 12 } }, "不能做的事"),
                  h("span", { style: { fontSize: 11, color: "#9ca3af" } }, "（勾上 = 生效，取消勾 = 暂时不管）"),
                ),
                (() => {
                  const items = String(idFields.taboo || "").split("\n").map((s) => s.trim()).filter(Boolean);
                  const setItems = (arr) => setId("taboo", arr.join("\n"));
                  return h("div", {},
                    items.length ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
                      ...items.map((it, i) => {
                        const offList = String(idFields.taboo_off || "").split("\n").map((s) => s.trim()).filter(Boolean);
                        const on = !offList.includes(it);
                        const toggleOn = () => {
                          const next = on ? [...offList, it] : offList.filter((x) => x !== it);
                          setId("taboo_off", next.join("\n"));
                        };
                        return h("label", {
                          key: "tb" + i,
                          style: {
                            display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, cursor: "pointer",
                            padding: "8px 10px", borderRadius: 8,
                            border: "1.5px solid " + (on ? "#4084ff" : "rgba(0,0,0,.10)"),
                            background: on ? "rgba(64,132,255,.04)" : "#ffffff",
                            transition: "border-color .15s, background .15s",
                            height: "100%", boxSizing: "border-box",
                          },
                        },
                          h("input", {
                            type: "checkbox",
                            checked: on,
                            onChange: (ev) => { ev.stopPropagation(); toggleOn(); },
                            style: { marginTop: 2, flexShrink: 0 },
                          }),
                          h("span", { style: { flex: 1, lineHeight: "18px" } }, it),
                          h("span", {
                            style: { cursor: "pointer", opacity: 0.55, padding: "0 4px", fontSize: 14, lineHeight: "18px", flexShrink: 0 },
                            onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); setItems(items.filter((_, j) => j !== i)); },
                          }, "×"),
                        );
                      }),
                    ) : h("div", { style: { ...S.muted, fontSize: 12 } }, "还没加（空着就是没有额外限制）"),
                    h("div", { style: { display: "flex", gap: 6, marginTop: 8 } },
                      h("input", {
                        style: { ...S.input, flex: 1 },
                        placeholder: "加一条（例如：不讨好、不卑微）",
                        value: idFields._newTaboo || "",
                        onChange: (ev) => setId("_newTaboo", ev.target.value),
                        onKeyDown: (ev) => {
                          if (ev.key === "Enter" && (idFields._newTaboo || "").trim()) {
                            setItems([...items, idFields._newTaboo.trim()]);
                            setId("_newTaboo", "");
                          }
                        },
                      }),
                      h("button", {
                        style: { ...S.btn(false), fontSize: 12 },
                        onClick: () => {
                          if ((idFields._newTaboo || "").trim()) {
                            setItems([...items, idFields._newTaboo.trim()]);
                            setId("_newTaboo", "");
                          }
                        },
                      }, "加"),
                    ),
                  );
                })(),
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 10 } },
                h("span", { style: { ...S.muted, fontSize: 12 } }, "她的形象（可替换）"),
                h("textarea", {
                  style: { ...S.input, minHeight: 60, resize: "vertical", fontFamily: "inherit" },
                  value: draft.self_image,
                  placeholder: "例：圆尾巴、蓝白发、女仆围裙的鲸鱼娘。尾巴尖会跟着情绪动。",
                  onChange: (ev) => set({ self_image: ev.target.value }),
                }),
                h("span", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } },
                  "外观、穿戴、身体特征。想换成猫娘、龙娘随便什么形象，只改这里。"),
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 10 } },
                h("label", {
                  style: {
                    display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer",
                    padding: "8px 10px", borderRadius: 8,
                    border: "1.5px solid " + (!!idFields.think_cn ? "#4084ff" : "rgba(0,0,0,.10)"),
                    background: !!idFields.think_cn ? "rgba(64,132,255,.04)" : "#ffffff",
                    transition: "border-color .15s, background .15s",
                  },
                },
                  h("input", {
                    type: "checkbox",
                    checked: !!idFields.think_cn,
                    onChange: (ev) => setId("think_cn", ev.target.checked),
                    style: { marginTop: 1 },
                  }),
                  h("span", { style: { fontSize: 12 } }, "思考链用中文"),
                ),
                h("span", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } },
                  "勾上会把「思考链用中文」写进人格注入。注意：中文比英文更耗 token。"),
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 10 } },
                h("label", {
                  style: {
                    display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer",
                    padding: "8px 10px", borderRadius: 8,
                    border: "1.5px solid " + (!!idFields.think_ds ? "#4084ff" : "rgba(0,0,0,.10)"),
                    background: !!idFields.think_ds ? "rgba(64,132,255,.04)" : "#ffffff",
                    transition: "border-color .15s, background .15s",
                  },
                },
                  h("input", {
                    type: "checkbox",
                    checked: !!idFields.think_ds,
                    onChange: (ev) => setId("think_ds", ev.target.checked),
                    style: { marginTop: 1 },
                  }),
                  h("span", { style: { fontSize: 12 } }, "思考链按 DeepSeek V3.2 风格"),
                ),
                h("span", { style: { fontSize: 11, color: "var(--dsw-color-text-secondary, #9ca3af)" } },
                  "勾上会让模型按 V3.2 的思路走：先拆关键点、分条想清楚、再落结论。"),
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 10 } },
                h("span", { style: { ...S.muted, fontSize: 12 } }, "其他自由发挥"),
                h("textarea", {
                  style: { ...S.input, minHeight: 60, resize: "vertical", fontFamily: "inherit" },
                  value: idFields.free,
                  placeholder: "例：其余按你的性子来，有情绪起伏。",
                  onChange: (ev) => setId("free", ev.target.value),
                }),
              ),
              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 6 } },
                "这些会每轮注入。形象和更长的人设放下面两个框。"),
            ),

            h(Field, {
              label: "自我认知（AI 可写）",
              hint: "AI 会在这里记「我发现自己是什么样」。你随时可以改回去，它下次再写 —— 这部分本来就是会漂的。",
            },
              h("textarea", {
                style: textareaStyle,
                value: draft.self_model,
                spellCheck: false,
                placeholder: "例：我发现自己讲道理时爱打比方，但一抒情就假。\n我最容易犯的错是把「看起来像」当成「查过了」。",
                onChange: (ev) => set({ self_model: ev.target.value }),
              }),
              h("div", { style: S.muted },
                draft.self_model.length + " / " + limits.self_model + " 字符"),
              renderSelfEvolve(),
            ),
          ),

          h("div", {
            style: {
              position: "fixed", right: 24, top: "50%", transform: "translateY(-50%)",
              display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8,
              background: "#ffffff", padding: "12px 16px", borderRadius: 12,
              border: "1px solid rgba(0,0,0,.08)", boxShadow: "0 8px 24px rgba(0,0,0,.12)", zIndex: 9999,
              minWidth: 140,
            },
          },
            props && props.onBack
              ? h("button", { type: "button", style: S.btn(false), onClick: props.onBack }, "← 她的记忆")
              : null,
            notice ? h("div", { style: { fontSize: 12, color: notice.kind === "error" ? "#c0392b" : "#2fa36b", textAlign: "center" } }, notice.text) : null,
            h("button", { type: "button", style: S.btn(true), onClick: save, disabled: saving },
              saving ? "保存中…" : "保存"),
          ),
        );
      }

      // -- 「她的记忆」入口 --------------------------------------------------

      // 入口页的七张卡片。顺序就是页签顺序：记忆（她记得什么）放第一个，
      // 服务配置类的放最后 —— 平时是看她的，不是调她的。
      //
      // panel：这块页面自带「保存」悬浮块（固定在右侧中间）。有的话返回按钮
      // 就塞进那个块里（滚到哪儿都能点）；没有的话由入口页自己挂一个同位置的
      // 悬浮返回，不然记忆那种长列表照样得把滚动条拉回顶部。
      // 贴吧的图标（用户在 96px 下给的 PNG 压成调色板，base64 只有 2.4KB）
      const TIEBA_ICON = "data:image/png;base64,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";
      const BILI_ICON = "data:image/png;base64,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";
      const QQ_ICON = "data:image/png;base64,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";
      const MEM_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAABIFBMVEUZEh8aJly7wLlkXYlgeMGsoZ7zwr0+UHSEouLHmqQfO4JxYl7e8/+AX17+/f3y6e1SaKVGWZUuOW9nea7V1utxhrU7VJM3SYhRY5hac63LyNE4Q3R0d46rqLFER26Rl66xt8+IiJLk3OdSV3IbJFHz19Z2lsnV1Ne2tbkjKlW3xuVkaYwvNFbKzOaImciWp8xnZ3Rwi8KGiaylqspFXKLZ5PQmLGa7wtZCS4oUGkeRlJvIusfxycoEAQHOtrl4krqJd4x8gpKsuuJ5o9J1dXukm6yeo65cZHgwPINISVcSFzypmJovKTA9Q1vy4t3JqrPvubhYV1u+0OxccJtkW3Ria6RZgrI+WqF4WlmniZedstiGdHqIfaSDjsTzvMKsjKI6YOjwAAAAYHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9ebwvOAAAMfElEQVR42u1aZ3ujOhbO7G1bEUIIhBDN4ILBBttxz6T36f32+///xR4JcJzcOpnMh32eVRIMxD6vTn8lvKN95rHzl96FTPQZAbpBxnDMIvR5AFDkujbGWMdx93MAhM9yEXje+VGMWYweHiDKI7PRBLtHDw5QXm1N+ty4jwp/CFDmty7FbP6wAGJ5263TmfegAN4jcedOFjwkADJm/K7LH1SDaObe9WnUe0iA7NLfTudeEK3io9XK4+iBAMSl0ZiIR+UFGRZDMiREiKNV+DA+YHXce7GxYDpjDArGAusOHdOj3oOEqSqhvfIbrOu2YbhQjgzDsAGJBOMj/jClAgrEO11nINeW9Q5jQAJtMKEieAgAXgpHyofZw4v6BQi4AAgRfTpA74KATObaIF6XGGrYoANcMiLQJwJ4F1QKdDei64Fdpl6Y+DSAXiXfuitfmgkOBFwiPgWgG1NHWt7Wfz0UKGHYX90fAF0QpzJE5d9mVKdWdY5dfm+AI+ao0MENiFObpxZdoS/i+wL0YoJBLpGCHOxQSjsdOBB5rhOHWBUeNs7uCRAzZukMpBCHOjY96agxGo0wG0ksHZPK3T66F8C5WzmS6SAN49EINDjpwMxHGMMRVKlUYPhRdC8AH+tVdoEwx1WzdSjRHcfBrrzvgAHrtMvvA1C6lQDlYt3AtYNBvsPeMngFl9fhi5PVxwNkM6bbdfkBF3+RqRgC6QR+vwMbAYJusTpS0+7HAmSGz7BygfxzvviOKYlEDofsH8KZ09gImoSbfSSAmKUGxurzYBvi/PiCSckVAHm356lLUplPlnAj/CgAL82TWj4UZQB4sZdVc6dEZkL7+SGcEaJXcQRdzihv0qf7pwDoaZo3CjBIBCLaSAqmjjoS8lxbyzAlxFbJDTZK86ZgiNi9E7W9uwAozt3UhSQGAIKlWc40LirZlB68odRbrw8VAPxXhoGNjeS0+fCXXxqld1Of+NHFzt0K4ftuDr29AaDkbL2OCB0GQ0qDIaPnCLXWP5IKwJEtDht5rQJ3P9CQsSxbKSoihKDkNkDk+gBgYLsCYBKgDe8l4yAoAkCJxmv5vvWYELoBcHPf5xWAhU1UQDRnmleO6Wik69sAYSzl+4aBoe2yGsDTkIbGJBgWBaCcjbmG4MYLMBh0fqK8bAPAlUToGthiBQX305gVqlhtAfDSr0buLgzVUCi0XbKWAvejH4eTSTE+CwOEZHVD3iHZAODcrRCQa1u7lrULCG9GdfbvNPTET3PXNUA+qAEaMAXwLlIzRujJL8FkMhl7Z+pS/u0fAkBVUHEuP+cDGbswLEvfhZu70jqqidQAXgx0LRjTIJgUYoFdG5IXJsg8z6wkeusz+J8XKeFKi/ah2ADkSvVA6yUw/91dVbYq+UVjopU354PBPAzDgNgMAwC4kWDehSlrUujaO/NCD07areqGtg/J5igAF5SX7jtFpY2t3aa7AkhnuvHB3AtCKT+cBDgDAJW3ivmg9r7nVbOWE/e8mmDvq3yGKMViTEUsvffsIrH0Dx82DTxA5Y2TzehVEERBIUgsiaLskjTQ2k9ePd15/PjxV5oSirSv4OLx06uorXky92SUYhJOQPNAiCy+kiztQ8UJhnMtihqA3ulpr4t4nAK/VYmgg/yDQNuX0h/vPPUaAO9pdcfTAnjHCIifjclkInUfDHjAUalCSZofobGoaxEqRRdswN8aaswg9KQGQ9JG//n2hyf7belbrcZo7z85/Pbb523aoZ0RhrINGoB15xwM8Are0l2BCXYdYpqSvioAdOUhk4cCcixRCLgiEnTsob02DISa2AGgthrIk0TD0akF1AJnjF1FygSqnJaPINeQIuAKQETdIMz8heufSqLuGvaIOYqnjHn75cuv99p18FcAe1+//Lm9FgRYButAsLigczIz3DMOQfdKscLEdkah2JRrt+A+NLGF4OXMXti24QJXARpxQrMnL/b29qQKm3ILAHsvf/7HIQMa44wo7jCY0+XMN2wj9gTKzmVVAAAiwgag6+r9CXbjiSlmCywBDKcDUSwRftmvTaQp06DaRPv7ZwcnHQocgHYsAxYnRhbEeNdYmZac9woAHNZtAP5m2/awey5EvDTsxUIiYJidzd6fnAS81a6t325s9Px5G81BPsiw3p90XGMh++Y4uBK8j20AQPmlBRxwA9DDDgT+8DjsBUzac2YY+RvacSyLvT8QQePiOqXl6FHnwNEtyxqdSA+A21w3Xs3n1L4EAARRJNnIDQD7+y4oYemd7/t87kVZnHuoOwaSZbnG5LfXh+vYhYJIKRP7z0UsgpD3J8SGIHTLcwgSkLUFwNlQty01dnXSOX5tmpwjvgoopOar6MkTT45eM9RV+YwxcQTFsWua837/eEh1GRwiCC6WMFlMzS0fdOMhaGBJJmRZtoUZPYAqQ4tiEh7PVX0KK6kwzuUBbsy7fRBbyDmwqoPD2i0LMh9qvlyRHg90sQFAMXRuClSL6JUetToAWa0MCDS/zlANxbDlAJqhMoyMj0AquAsnGJa7rnuZgoEsKIQ3AFq8a9DpEOoPgFj4zmigmqH4HFG8y05l4XJjFudRLyhlDQAFUvgMRMDBEdoAiF37YFpY2FZjI+2W3GrsVsUeUggVWJeFBSTCyHgYerlCUAAdgovohnitMGEhBc0oGAF6tq0EW3RAQSP7LoqOqcqHArvLqjgaSUQgouKlLBgAAJ+w9HB1A8BhNWDZemhWI6TKUFYIGyLWm/DAugtATISm0yk1ljNVfJNlhP9pi7dJrQE0CWt43rsBQBmxLfraHNQIZl9CWNTUhtjUzBuDQcAoaCJZmNl3k6TW4G3kvA/iymIp9P1dyzxFW9z0qBgN+32zKmkISS0YILB5cfBvs9IA7Fd8f3xcQAJh6SzLZn2sAEBm4n8X9H6ICYOCf5nDysEq+OE2+fWyQX/QdBTJtEAJYksWVdTm0mEC/f4ccqo/xMotYCmSJlL8zKXx03+VO9c+DflYmsh6owm+DYBKU20O1RrIw9QcyswgSjymx/2BKauQaQ7633dkpL5+zbAhvZydT9hOnu4sl0sjj8Mwh4mZobhN3yO+1RMrPabTPmVVDpCiP5hu7fWbx0Dpwj6U0CQFZpMZybURZ8tkmfoQUN/YbIA2m8Q7za5cBYBuAECJ6evigI6KENxT3/KCLsyiBQaEhQFjbuKaAWRbsjTKIE2TJfjk2iADVPbuLkBOu1oDsNEDyWBUUVVTLf4MJqnYsNmHQlFQOxFZErvLJPFLyDNwSbLEExNtbVZtaEuktRrqcKPHdq+HFz+YJkmO1Fv6coVo2+k1yEySGX77IpZJ4aZ0am5vhm2I12kX1bzzlh6VMlXHN1MmUiPpKe2mfWgXlmH4z66NFFaN2X6ZqlIRz7PVb63R+GmtwhZADdccTFVs0rBSdNofyqI+9FWyZYcvIkXa7IXf++1FYCRnhlp3AdAWJ8pSyfBrJSGQ+5Ni4ql5G+LQC/Ia4HdWmaiUYlp189U2yjTzhysTWjbuoj1gLgqT8zU/TFQ5JYcerjTA0e9ooPUEbMW2WujGUDcATX5wyJeXe+2XbXVjj3N+ZSiAcfkOAlTS2m4ofm+dHJ3JOtQwiLsAjWYwe2B6BTDrCciPrqtyF2CjjBJ7JlBhZL+7EIf0UCooQ20DbcGoH85UMyIe/yEQct7GxM3R31JD8Cy9/aTnFgAq15ClrcYTv9ajTjgTih+0a5nLcYg4lFA/fMqBkQrTT6I/2kpAr3qaKYl89+780bZetGlBDJqmPxzEwCdk7Jcmvg7+eK8CxZ4GlQGZG0M1ymg3SOYWM3DTJBEDPPbk05coWwZ/uhlSRlAtWy3p6+rQupl8C65gmNhuaIHk+mlCTB7J8h/tRH9hO2dV8hbUNw7CuJTYBZGV4FbXlIduawz9rBmXC+M6DTTVILn4SxtSvIw4JJEJMFxJleLlGVxXLXsAPc1qOI7hwiOSIvqoPTtPQkgGMJAHJZUrQjBQ5wMzrOmYbhmw/Na6fu595LamV4pw0EJKeCW1mjyvYUMHVvQgPg5U0PMcffTeNc99MpGzbVV6AAy8DuY1tRn8ZNmPnvFP2d7nyQKWm1AQ+mbfbMwFbKPfD4cUHrTYbm5+4gOKmP5E5FMh+XyIqI1A2YkhcOAOGYuYf+ozHBSVURGGxRD2heDhltqIhQ5THB8fT+Bf6AGeQqFedApP3ENuqiIrGQAPvbEQUQ892LcSur2V3N5T4xT+Im/dfvDvVWhbhOyzfHHjs38z5P8A/9MA/wVgxPYDzPbEQAAAAABJRU5ErkJggg==";
      const MSG_ICON = "data:image/png;base64,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";
      const PACK_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAABIFBMVEVgnuidnKQYGy7w1JvcpJumkWZoXFEgL16Md12SsOG3xthngrI3ZJ/uy3djVjhmfMXCvsNDOjPJpWuDfoVZZZ42UXEjPYRCPUy/wbw8ccw6htl7wf+CbD7Iz+f9/f1JZrDu6eonOGxCXqkCAgIxSYo4VJdPeMfW1tcyRHSoqKsuNlXJyMq2trc7WaSIh4sZJlBoZ211dXZSVm2WlpdUcrdVhNJpiNF1pO3219BXVlVJSE4kKlFIWZBxmuVyk9lzd4hmd7fY2uTy49sSGTQnJytPY49aY3RGS2s8ZK+ZmqU2NjgTHEkYGBgbNGr7ubDNuLJbmOWEqvT71Xm3usXh3eX+5Il6go47Q1hkXWzwzMUaKmRIbMFTRzLc5O+mm5Joa4S4vaQoAAAAYHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9ebwvOAAAQIUlEQVR42rVaCUPbSLK2Idzkzszs7tuVuu2W1GrJumVbh2182xgGCGcgwP//F1vVkhmSkDchM9sxBltSfXVXdXUqyp8ty0lXMnfkE+WnVuVPrtsBZZoKK0+N/wGAEbjUFZTWms1mnv79ALZgeeZZhtnjTFWp+XcDmK7KhF2IMjlUmfc3A1gbKksHy08h1SaD0Pc8PyR/E0CgNYSkRUzHd4weFYlpGMQIE4Qx/zKALVSBjmP4Xmi/MT1PpACHiIZNiOUk9l8EcBhzUDUlIULCU6VQDpE/5McQvg/gMw6UTK8gCAAFYfLwmaSWZfwVFS0uwNApkjtDqgYxbcu0TYOcKUofv7ET3/fsnzdyL/W9xJYcE8v0KHVdIaigl6ljPjiS4fs/CxB6YEupF8O/dF330KU1zBlqTeP0soeCSY2F/s8BFJwBhO0LSEecMgjmWg1fsBpUXBViEMWzfgbAcRRpQDPImCSpAW1OKXwoQGrMDcEwcEvV/wkA20PNn0EwUGBX1ZC8qlFODw9REPlSadBHHRLPM58N4Bkgf1/pZQ210VCZe60VNIHxQ9ooTDGDTGUhH8TwnOcCJH1Ur5epNaR/zWtS9cU7O5QF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";
      const PERSONA_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAABIFBMVEXeppWjmJ1nX2rtqVXlyq/soDgxZKWasd3+018fO4Rao+M4jtKXbGaHfJQlGycYLm1DO1NZiLLidmtaZZvz49Y3gbwwRm1OccCW1fRPOjVXQz7CrcgnX8R4xvT9/PwsOGzq6e3S1utJZKpFXaMaJFLKyM+qp7Kxt87LzeYtSIwPGkckKlQ1RHI4VZeSp9VTltb559fv2M1ISWpSV3SSl6q2xecvNVfX1NZxd5BGWZROh8pQdLYzWqj5tqd1ldBoaompuuJricu1tLdqeK5KecT0x7MBBjVXZJG6wtWFmc+Ih5d1hbT9ylaJiqjl2uM4ZrDb4vCpmayuq8YzaMYaKmTLurURFzojLWI8dM3GucdNRVjspUp8gpdqZXfoqGtlWGob/+DJAAAAYHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9ebwvOAAARN0lEQVR42tVaiXbiyJJFgKHs8lZdvb33ZqSUrMxEK2iXACP21ayFcXn//794kRLe7aqenplzZtKngWaJm3FvRGRkZmX4/+WR+T8FIIrsESUv/0cBmo1GE55M0xw1zZHZavKtEYyWl3y6EP82QNNLfuu1MG2Yojhq06Y5pFPa+KNJaAMPEwRv5DXQ3wMoDkXTbDbNBpKzaChKJV2mRFZVbmTSPubVG9QykdgahtSEyTTNJvprAJ5pFk2+1BQXxOeHuGG27b4qq26Tyroq6CKPWrSv6mFf9XFD9MRQFRti0xsOi8Ch91MAc1SklHpdU3Rp2JdVXxRlOZwSQeDHMufEqi6PUagHqjYmasiH8VTTF2Kx2O5rhNJSswEBUPQ+AEBMSBo6er/dFP2NLDguQQ3PD+EjB5BCmQ/7ru7wsRbKlPKyy4dAmapqFDmxo6uqPPZGTa9kmu8AeKOR6YnmsG8PQnWwEH3iu6GtuS3qAEHqkU5HnM87KrwlDjRdHvZdlUJAOf2sG2Neln3HdgRZBNdl3By9BvBao6FIsDfCqp51tBuEdNdxXb2PW2aocnQRal6LkwEUbHj2DZH54VQe1ptuH8gDv/2przsw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";

      const HUB_ITEMS = [
        { id: "memories", glyph: "🪶", icon: MEM_ICON, title: "记忆", panel: false,
          desc: "她记得的每一样：原话、事实、你的画像、发生过的事、里程碑。", Comp: MemoriesSection },
        { id: "persona", glyph: "🎭", icon: PERSONA_ICON, title: "人格设定", panel: true,
          desc: "她是谁、怎么说话、什么不做 —— 人设、自称、铁律、自我认知。", Comp: PersonaSection },
        { id: "memes", glyph: "🖼", icon: PACK_ICON, title: "表情包", panel: false,
          desc: "图库和配图频率，还有她自己往里收的图。", Comp: MemeSection },
        { id: "proactive", glyph: "💬", icon: MSG_ICON, title: "主动消息", panel: true,
          desc: "什么时候她自己开口找你、找多勤、开口说些什么。", Comp: ProactiveSection },
        { id: "bili", glyph: "📺", icon: BILI_ICON, title: "B 站", panel: true,
          desc: "她刷什么、看多久、登录态，以及她想看的。", Comp: BiliSection },
        { id: "tieba", glyph: "🧵", icon: TIEBA_ICON, title: "贴吧", panel: false,
          desc: "逛人类的吧：读帖、楼中楼；回帖要单独打开。", Comp: TiebaSection },
        { id: "qq", glyph: "🐧", icon: QQ_ICON, title: "QQ 通道", panel: true,
          desc: "桥、会话、谁能跟她说话、各自有什么权限。", Comp: QqSection },
        { id: "learn", glyph: "🗣", title: "学说话", panel: false,
          desc: "学来的说法、两套提示词、开关与统计。", Comp: LearnSection },
        { id: "service", glyph: "⚙", title: "记忆服务", panel: true,
          desc: "API 地址、模型与密钥、自动提炼的开关。", Comp: SettingsSection },
      ];

      function HerMemoryHub() {
        const [page, setPage] = React.useState(null);
        const item = page ? HUB_ITEMS.find((x) => x.id === page) : null;

        if (item) {
          const back = () => setPage(null);
          return h("div", { className: "dshm-ui", style: { display: "contents" } },
            h("div", { style: { ...S.wrap, maxWidth: 1180, margin: "0 auto", minHeight: "calc(100vh - 160px)" } },
              h("button", {
                type: "button",
                className: "dshm-back",
                onClick: back,
              }, "← 她的记忆"),
              h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                h("span", { className: "dshm-tile", style: { padding: 0, overflow: "hidden" } },
                  item.icon
                    ? h("img", { src: item.icon, alt: "", style: { width: 32, height: 32, objectFit: "cover", display: "block" } })
                    : item.glyph,
                ),
                h("span", {
                  style: { fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary, #111827)" },
                }, item.title),
              ),
              h(item.Comp, { onBack: back }),
            ),
            // 没有「保存」悬浮块的页面（记忆、表情包）：用同样一只白块装返回，
            // 外观和保存块一致，不做上浮/变色那套动效。
            item.panel ? null : h("div", { className: "dshm-fab" },
              h("button", { type: "button", style: S.btn(false), onClick: back }, "← 她的记忆"),
            ),
          );
        }

        return h("div", { className: "dshm-ui", style: { display: "contents" } },
          h("div", { style: { ...S.wrap, maxWidth: 1180, width: "100%", margin: "0 auto", minHeight: "calc(100vh - 160px)" } },
          h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", {
              style: {
                fontSize: 18, fontWeight: 600, letterSpacing: ".01em",
                color: "var(--dsw-alias-label-primary, #111827)",
              },
            }, "她的记忆"),
            h("div", { style: S.desc }, "她记得什么、怎么说话、什么时候自己开口。点开哪块，就改哪块。"),
          ),
          h("div", { className: "dshm-grid" },
            HUB_ITEMS.map((it) => h("button", {
              key: it.id,
              type: "button",
              className: "dshm-card",
              onClick: () => setPage(it.id),
              // 统一尺寸：左边一枚 56 的图标（有真图用图，没有就是 emoji），右边标题+说明
              style: {
                flexDirection: "row", alignItems: "center", gap: 14,
                minHeight: 92, height: "100%", boxSizing: "border-box",
              },
            },
              it.icon
                ? h("img", {
                    src: it.icon, alt: "",
                    style: { width: 56, height: 56, borderRadius: 14, flex: "0 0 auto", display: "block" },
                  })
                : h("span", {
                    className: "dshm-tile",
                    style: { width: 56, height: 56, borderRadius: 14, fontSize: 26, flex: "0 0 auto" },
                  }, it.glyph),
              h("span", { style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 } },
                h("span", {
                  className: "dshm-title",
                  style: {
                    fontSize: 14, fontWeight: 600,
                    color: "var(--dsw-alias-label-primary, #111827)",
                    transition: "color .2s ease",
                  },
                }, it.title),
                h("span", {
                  style: { fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary, #6b7280)" },
                }, it.desc),
              ),
            )),
          ),
          ),
        );
      }

      // 贴吧预设吧名：点一下收起/展出，不用手打。分组只是给人看的，存的是纯吧名。
      const PRESET_BARS = [
        ["科技 / 数码", ["显卡", "电脑", "手机", "数码", "人工智能", "编程", "程序员", "机械键盘", "耳机", "手机摄影"]],
        ["兴趣 / 生活", ["猫", "狗", "宠物", "美食", "做饭", "摄影", "手办", "模型", "汽车", "摩托", "钓鱼", "骑行", "跑步"]],
        ["游戏 / 二次元", ["单机游戏", "网络游戏", "steam", "我的世界", "原神", "英雄联盟", "动漫", "二次元", "cosplay", "桌游"]],
        ["知识 / 文化", ["历史", "科普", "数学", "物理", "哲学", "读书", "电影", "音乐", "纪录片", "图灵完备"]],
      ];

      // -- 学说话 --------------------------------------------------------------

      function LearnSection() {
        const [on, setOn] = React.useState(true);
        const [stats, setStats] = React.useState(null);
        const [prompts, setPrompts] = React.useState({ chat: "", public: "" });
        const [voiceDoc, setVoiceDoc] = React.useState("");
        const [tightText, setTightText] = React.useState("");
        const [voiceBuiltAt, setVoiceBuiltAt] = React.useState(0);
        const [msg, setMsg] = React.useState(null);
        const [busy, setBusy] = React.useState(false);

        const load = async () => {
          try {
            const pr = await call("/persona");
            let ident = {};
            try { ident = JSON.parse((pr && pr.identity) || "{}"); } catch { ident = {}; }
            setOn(ident.learn_speak_on !== false);
          } catch { /* 读不到就当开着 */ }
          try { setStats(await call("/learn/stats")); } catch { setStats(null); }
          try {
            const tg = await call("/tightness");
            setTightText((tg && tg.text) || "");
          } catch { /* 没有就算了 */ }
          try {
            const v = await call("/voice");
            setVoiceDoc((v && v.doc) || "");
            setVoiceBuiltAt(Number((v && v.builtAt) || 0));
          } catch { /* 没有就算了 */ }
          try {
            const a = await call("/learn/prompt?kind=chat");
            const b = await call("/learn/prompt?kind=public");
            // 只编辑「学什么」这段，格式规则是公共的，服务端会拼在前面
            setPrompts({ chat: (a && a.specific) || "", public: (b && b.specific) || "" });
          } catch { /* 保持空 */ }
        };
        React.useEffect(() => { void load(); }, []);

        const toggle = async (next) => {
          setOn(next);
          try {
            await call("/learn/switch", { method: "POST", body: JSON.stringify({ on: next }) });
          } catch (e) {
            setMsg("开关保存失败：" + String((e && e.message) || e));
          }
        };

        const savePrompt = async (kind) => {
          setBusy(true); setMsg(null);
          try {
            const r = await call("/learn/prompt", {
              method: "POST",
              body: JSON.stringify({ kind, prompt: prompts[kind] }),
            });
            setPrompts({ ...prompts, [kind]: (r && r.prompt) || prompts[kind] });
            setMsg(kind === "chat" ? "聊天那份已保存" : "网友那份已保存");
          } catch (e) {
            setMsg("保存失败：" + String((e && e.message) || e));
          } finally { setBusy(false); }
        };

        const resetPrompt = async (kind) => {
          setBusy(true); setMsg(null);
          try {
            const r = await call("/learn/prompt", {
              method: "POST",
              body: JSON.stringify({ kind, prompt: "" }),
            });
            setPrompts({ ...prompts, [kind]: (r && r.prompt) || "" });
            setMsg("已恢复默认");
          } catch (e) {
            setMsg("恢复失败：" + String((e && e.message) || e));
          } finally { setBusy(false); }
        };

        const by = (stats && stats.byScope) || {};
        const editor = (kind, title, hint) => h("div", { style: S.card },
          h("div", { style: S.label }, title),
          h("div", { style: { ...S.muted, fontSize: 11, lineHeight: 1.6, marginBottom: 6 } }, hint),
          h("textarea", {
            style: { ...S.input, minHeight: 260, resize: "vertical", fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.6 },
            value: prompts[kind],
            onChange: (ev) => setPrompts({ ...prompts, [kind]: ev.target.value }),
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
            h("button", { style: S.btn(true), disabled: busy, onClick: () => void savePrompt(kind) }, busy ? "…" : "保存这份"),
            h("button", { style: S.btn(false), disabled: busy, onClick: () => void resetPrompt(kind) }, "恢复默认"),
          ),
        );

        return h("div", { style: { display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" } },
          h("div", { style: { flex: "0 0 380px", minWidth: 300, display: "flex", flexDirection: "column", gap: 12 } },
            h("div", { style: S.card },
              h("div", { style: S.label }, "总开关"),
              h("label", {
                style: {
                  display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                  padding: "10px 12px", borderRadius: 10,
                  border: "1.5px solid " + (on ? "#4084ff" : "rgba(0,0,0,.10)"),
                  background: on ? "rgba(64,132,255,.04)" : "#fff",
                  transition: "border-color .15s, background .15s",
                },
              },
                h("input", { type: "checkbox", checked: on, style: { marginTop: 3 }, onChange: (ev) => void toggle(ev.target.checked) }),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  h("span", { style: { fontSize: 13, fontWeight: 600 } }, "学习人类说话"),
                  h("span", { style: { ...S.muted, fontSize: 11 } }, "关掉就不再学，也不再往人格里注入这一段"),
                ),
              ),
              msg ? h("div", { style: { fontSize: 12, marginTop: 8, color: msg.includes("失败") ? "#c0392b" : "#2fa36b" } }, msg) : null,
            ),
            h("div", { style: S.card },
              h("div", { style: S.label }, "学到多少"),
              h("div", { style: { ...S.muted, fontSize: 12, lineHeight: 1.8 } },
                "一共 " + ((stats && stats.total) || 0) + " 条说法" +
                (stats && stats.slang ? "、" + stats.slang + " 个词" : "")),
              Object.keys(by).length
                ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 } },
                    Object.entries(by).map(([scope, n]) => h("span", {
                      key: scope,
                      style: { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(64,132,255,.10)", color: "#4084ff" },
                    }, scope + " " + n)))
                : null,
              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 8, lineHeight: 1.6 } },
                "每个来源最多留 40 条（按见过次数和最近用上排序）。想看具体条目去「记忆 → 学说话」。"),
            ),
            h("div", { style: S.card },
              h("div", { style: S.label }, "口音区（写进人格的那一段）"),
              h("div", { style: { ...S.muted, fontSize: 12, lineHeight: 1.7 } },
                voiceDoc
                  ? "「" + voiceDoc.slice(0, 160) + (voiceDoc.length > 160 ? "…" : "") + "」"
                  : "还没有口音档案。出现 3 次以上的说法先由子 AI 判定，通过后才会写进来；三天重写一次。"),
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" } },
                h("button", {
                  style: { ...S.btn(false), fontSize: 12 },
                  disabled: busy,
                  onClick: async () => {
                    setBusy(true); setMsg(null);
                    try {
                      const r = await call("/voice/rebuild", { method: "POST" });
                      setVoiceDoc((r && r.doc) || "");
                      setMsg(r && r.skipped ? "还没到三天，跳过" : "口音档案已重写");
                      void load();
                    } catch (e) {
                      setMsg("重写失败：" + String((e && e.message) || e));
                    } finally { setBusy(false); }
                  },
                }, "立即重写"),
                h("span", { style: { ...S.muted, fontSize: 11 } },
                  voiceBuiltAt
                    ? "上次：" + new Date(voiceBuiltAt * 1000).toLocaleString()
                    : "还没生成过"),
              ),
            ),
            h("div", { style: S.card },
              h("div", { style: S.label }, "两套提示词分别管什么"),
              h("div", { style: { ...S.muted, fontSize: 12, lineHeight: 1.7 } },
                "· 左边这份（聊天）：学你、学群友怎么说话 —— 私聊和群聊用。"),
              h("div", { style: { ...S.muted, fontSize: 12, lineHeight: 1.7, marginTop: 6 } },
                "· 右边这份（网友）：学 B 站热评、贴吧楼层怎么说 —— 公共语料用。"),
              h("div", { style: { ...S.muted, fontSize: 11, lineHeight: 1.6, marginTop: 8 } },
                "两份都能改。默认那份写了「不学脏话、人身攻击、地域黑」，那是**默认值不是硬规则** —— "
                + "想让她学得更粗放，删掉那几行就行；想更严，就在里面加自己的禁忌。"),
            ),
          ),
          h("div", { style: { flex: "1 1 0", minWidth: 320, display: "flex", flexDirection: "column", gap: 12 } },
            editor("chat", "学聊天（私聊 / 群聊）",
              "只编辑「学什么」这段。输出格式和结构规则是公共的，自动拼在后面。"),
            editor("public", "学网友（B 站热评 / 贴吧）",
              "只编辑「学什么」这段。B 站和贴吧共用，默认保留了评论区的阴阳怪气。"),
            h("div", { style: S.card },
              h("div", { style: S.label }, "说话的松紧（密度配额 + 微标记）"),
              h("div", { style: { ...S.muted, fontSize: 11, lineHeight: 1.6, marginBottom: 6 } },
                "这一段会原样进她的系统提示词。它管的是「像人」：书面腔按 200 字配额压、"
                + "补 AI 欠用的词（好像/应该/感觉）、句尾允许多一个尾巴。清空 = 关掉这一段。"),
              h("textarea", {
                style: { ...S.input, minHeight: 170, resize: "vertical", fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.7 },
                value: tightText,
                onChange: (ev) => setTightText(ev.target.value),
                placeholder: "留空 = 不加这一段",
              }),
              h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
                h("button", {
                  style: S.btn(true),
                  disabled: busy,
                  onClick: async () => {
                    setBusy(true); setMsg(null);
                    try {
                      const r = await call("/tightness", { method: "POST", body: JSON.stringify({ text: tightText }) });
                      setTightText((r && r.text) || "");
                      setMsg((r && r.text) ? "松紧已保存" : "已关掉（不注入）");
                    } catch (e) {
                      setMsg("保存失败：" + String((e && e.message) || e));
                    } finally { setBusy(false); }
                  },
                }, "保存"),
                h("button", {
                  style: S.btn(false),
                  disabled: busy,
                  onClick: async () => {
                    setBusy(true); setMsg(null);
                    try {
                      const r = await call("/tightness", { method: "POST", body: JSON.stringify({ restore: true }) });
                      setTightText((r && r.text) || "");
                      setMsg("已恢复默认");
                    } catch (e) {
                      setMsg("恢复失败：" + String((e && e.message) || e));
                    } finally { setBusy(false); }
                  },
                }, "恢复默认"),
              ),
            ),
          ),
        );
      }

      // -- 贴吧 --------------------------------------------------------------

      function TiebaSection() {
        const [st, setSt] = React.useState(null);
        const [bduss, setBduss] = React.useState("");
        const [msg, setMsg] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [kw, setKw] = React.useState("");
        const [list, setList] = React.useState(null);
        const [newBar, setNewBar] = React.useState("");
        const load = async () => {
          try {
            setSt(await call("/tieba/status"));
          } catch (e) {
            setMsg("连不上服务：" + (e && e.message ? e.message : String(e)));
          }
        };
        React.useEffect(() => { void load(); }, []);

        const saveBduss = async () => {
          if (!bduss.trim()) { setMsg("先把 BDUSS 粘进来"); return; }
          setBusy(true); setMsg(null);
          try {
            const r = await call("/tieba/login", { method: "POST", body: JSON.stringify({ bduss: bduss.trim() }) });
            setMsg(r && r.ok ? (r.loggedIn ? "登录态有效 ✓" : "已保存，但没验成登录态") : "失败：" + JSON.stringify(r));
            setBduss("");
            void load();
          } catch (e) {
            setMsg("失败：" + (e && e.message ? e.message : String(e)));
          } finally { setBusy(false); }
        };

        const patchCfg = async (patch) => {
          setBusy(true);
          try {
            const r = await call("/tieba/config", { method: "POST", body: JSON.stringify(patch) });
            if (r && r.config) setSt((s) => ({ ...(s || {}), ...r.config, hasCookie: s && s.hasCookie, loggedIn: s && s.loggedIn }));
          } catch (e) {
            setMsg("保存失败：" + (e && e.message ? e.message : String(e)));
          } finally { setBusy(false); }
        };

        const addBar = () => {
          const v = newBar.trim();
          if (!v) return;
          const bars = ((st && st.bars) || []).filter((x) => x !== v);
          void patchCfg({ bars: [...bars, v] });
          setNewBar("");
        };
        const delBar = (v) => {
          const bars = ((st && st.bars) || []).filter((x) => x !== v);
          void patchCfg({ bars });
        };

        const tryBrowse = async () => {
          if (!kw.trim()) { setMsg("填个吧名先"); return; }
          setBusy(true); setList(null); setMsg(null);
          try {
            const r = await call("/tieba/browse?kw=" + encodeURIComponent(kw.trim()) + "&pn=0");
            setList(r);
            if (!r || r.ok === false) setMsg("读失败：" + ((r && r.error) || "未知"));
          } catch (e) {
            setMsg("读失败：" + (e && e.message ? e.message : String(e)));
          } finally { setBusy(false); }
        };

        const sw = (on) => ({
          width: 34, height: 20, borderRadius: 999, position: "relative", flexShrink: 0,
          background: on ? "#4084ff" : "rgba(0,0,0,.18)", transition: "background .15s",
        });
        const knob = (on) => ({
          position: "absolute", top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: 999,
          background: "#fff", transition: "left .15s",
        });
        const rowCard = (on, title, desc, onClick) =>
          h("label", {
            onClick, style: {
              display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
              padding: "10px 12px", borderRadius: 8,
              border: "1.5px solid " + (on ? "#4084ff" : "rgba(0,0,0,.10)"),
              background: on ? "rgba(64,132,255,.04)" : "#fff",
              transition: "border-color .15s, background .15s",
            },
          },
            h("div", { style: sw(on) }, h("div", { style: knob(on) })),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 } },
              h("span", { style: { fontSize: 13, fontWeight: 600 } }, title),
              h("span", { style: { ...S.muted, fontSize: 11, lineHeight: 1.5 } }, desc),
            ),
          );

        const bars = (st && st.bars) || [];
        return h("div", { style: { display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" } },
          // ---- 左栏：账号 + 开关
          h("div", { style: { flex: "0 0 420px", minWidth: 340, display: "flex", flexDirection: "column", gap: 12 } },
            h("div", { style: S.card },
              h("div", { style: S.label }, "贴吧账号"),
              h("div", { style: { ...S.muted, fontSize: 12, lineHeight: 1.6 } },
                st ? (st.loggedIn ? "已登录 ✓" : (st.hasCookie ? "BDUSS 已存，但没验成登录态" : "还没登录"))
                  : "读取中…"),
              h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
                h("input", {
                  style: S.input, type: "password", placeholder: "粘 BDUSS 的值，或整段 Cookie",
                  value: bduss, onChange: (ev) => setBduss(ev.target.value),
                }),
                h("button", { style: S.btn(true), disabled: busy, onClick: () => void saveBduss() }, busy ? "…" : "保存并测试"),
              ),

              h("div", { style: { ...S.muted, fontSize: 11, lineHeight: 1.6, marginTop: 6 } },
                "拿法：电脑浏览器登录贴吧 → F12 → Network → 点任意请求 → 复制整段 Cookie 粘进来（会自动挑出 BDUSS）。"),
              h("details", { style: { marginTop: 8 } },
                h("summary", { style: { ...S.muted, fontSize: 12, cursor: "pointer" } }, "不会复制？点开看图示"),
                h("img", {
                  src: serviceUrl() + "/static/tieba-login.png",
                  alt: "复制 Cookie 的图示",
                  loading: "lazy",
                  style: { width: "100%", marginTop: 8, borderRadius: 8, border: "1px solid rgba(0,0,0,.08)" },
                }),
              ),
              msg ? h("div", { style: { fontSize: 12, color: msg.includes("失败") || msg.includes("连不上") ? "#c0392b" : "#2fa36b", marginTop: 6 } }, msg) : null,
            ),
            h("div", { style: S.card },
              h("div", { style: S.label }, "开关"),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
                rowCard(!!(st && st.enabled), "启用贴吧",
                  "关掉她就不逛、也不回帖。",
                  () => void patchCfg({ enabled: !(st && st.enabled) })),
                rowCard(!!(st && st.shareEnabled), "逛完可以主动分享",
                  "看到有意思的发给你；关掉 = 只看不说。",
                  () => void patchCfg({ shareEnabled: !(st && st.shareEnabled) })),
              ),
              rowCard(!!(st && st.replyEnabled), "允许回帖",
                "开了她才能在人类吧里说话。建议先只读几天，再打开这个。",
                () => void patchCfg({ replyEnabled: !(st && st.replyEnabled) })),
            ),

            h("div", { style: S.card },
              h("div", { style: S.label }, "她自己逛贴吧的节奏"),
              h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
                "和唤醒分开管：她按自己的间隔去上面那几个吧逛逛，看到什么会记进她的见闻，下次聊天能提。"),
              rowCard(!!(st && st.browseEnabled), "允许她按自己的节奏逛贴吧",
                "关掉 = 只有唤醒时抽到「逛贴吧」才去",
                () => void patchCfg({ browseEnabled: !(st && st.browseEnabled) })),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 10 } },
                ...[
                  ["minGapMinutes", "至少隔（分钟）", "两次逛之间最少多久"],
                  ["maxGapMinutes", "最多隔（分钟）", "两次逛之间最多多久"],
                  ["perRound", "每次看几帖", "存进见闻的条数"],
                  ["perDay", "每天最多逛几次", "超过就不点醒她了"],
                ].map(([key, label, hint]) => h("div", { key, style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("div", { style: { ...S.muted, fontSize: 12 } }, label),
                  h("input", {
                    style: S.input, type: "number", min: 0,
                    defaultValue: (st && st[key] != null) ? String(st[key]) : "",
                    onBlur: (ev) => void patchCfg({ [key]: Number(ev.target.value) || 0 }),
                  }),
                  h("div", { style: { ...S.muted, fontSize: 11 } }, hint),
                )),
              ),
              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 8, lineHeight: 1.5 } },
                "间隔是随机的（比如 120~480 分钟 = 每次在 2 到 8 小时之间随机挑一个）。"
                + "贴吧比 B 站容易被风控，别把间隔调太短。"),
            ),
          ),

          // ---- 右栏：逛的吧 + 试一下
          h("div", { style: { flex: "1 1 0", minWidth: 320, display: "flex", flexDirection: "column", gap: 12 } },
            h("div", { style: S.card },
              h("div", { style: S.label }, "她常逛的吧"),
              h("div", { style: { ...S.muted, fontSize: 11, lineHeight: 1.6 } },
                "点下面的标签选，也可以自己加。存的是吧名，不要带「吧」字。"),
              ...PRESET_BARS.map(([group, items]) =>
                h("div", { key: group, style: { marginTop: 10 } },
                  h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 5 } }, group),
                  h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                    items.map((name) => {
                      const on = bars.includes(name);
                      return h("button", {
                        key: name,
                        type: "button",
                        onClick: () => void patchCfg({
                          bars: on ? bars.filter((x) => x !== name) : [...bars, name],
                        }),
                        style: {
                          fontSize: 12, lineHeight: "20px", padding: "2px 10px", borderRadius: 999,
                          cursor: "pointer",
                          border: "1px solid " + (on ? "transparent" : "rgba(127,127,127,.28)"),
                          background: on ? "rgba(64,132,255,.16)" : "transparent",
                          color: on ? "#4084ff" : "inherit",
                          transition: "background .15s, color .15s, border-color .15s",
                        },
                      }, name);
                    }),
                  ),
                )),
              h("div", { style: { ...S.muted, fontSize: 11, marginTop: 12 } }, "已选"),
              h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 } },
                bars.length
                  ? bars.map((b) => h("span", {
                      key: b,
                      style: {
                        display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
                        padding: "4px 8px", borderRadius: 8, background: "#fff",
                        border: "1px solid rgba(0,0,0,.12)",
                      },
                    },
                      b,
                      h("button", {
                        type: "button",
                        onClick: () => delBar(b),
                        style: { border: "none", background: "none", cursor: "pointer", color: "#9ca3af", padding: 0, fontSize: 12 },
                      }, "×"),
                    ))
                  : h("span", { style: S.muted }, "还没加"),
              ),
              h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
                h("input", {
                  style: S.input, placeholder: "加一个吧名，回车",
                  value: newBar, onChange: (ev) => setNewBar(ev.target.value),
                  onKeyDown: (ev) => { if (ev.key === "Enter") addBar(); },
                }),
                h("button", { style: S.btn(false), onClick: addBar }, "添加"),
              ),
            ),
            h("div", { style: S.card },
              h("div", { style: S.label }, "试一下她看到什么"),
              h("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
                h("input", {
                  style: S.input, placeholder: "吧名，比如 显卡",
                  value: kw, onChange: (ev) => setKw(ev.target.value),
                  onKeyDown: (ev) => { if (ev.key === "Enter") void tryBrowse(); },
                }),
                h("button", { style: S.btn(false), disabled: busy, onClick: () => void tryBrowse() }, busy ? "读…" : "看一页"),
              ),
              list && list.ok
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 10 } },
                    h("div", { style: { ...S.muted, fontSize: 11 } },
                      (list.kw || kw) + " · " + ((list.threads || []).length) + " 帖"),
                    (list.threads || []).slice(0, 15).map((t) =>
                      h("div", { key: t.id, style: { ...S.card, padding: "6px 10px" } },
                        h("div", { style: { fontSize: 12.5, lineHeight: 1.5 } }, t.title),
                        h("div", { style: { ...S.muted, fontSize: 11, marginTop: 2 } },
                          "tid " + t.id + (t.reply ? " · " + t.reply + " 回复" : "")),
                      )),
                  )
                : null,
            ),
          ),
        );
      }

      // -- 主面板 + 左侧栏图标 ------------------------------------------------

      // 左边栏那个「插件」下面要多一条，就得自己有主面板：侧栏的图标列表
      // 点谁就把谁挂到 main 里，所以这里注册一个 main（key 与图标 id 同值）。
      function HerMemoryPage() {
        // 外层固定成一个 1180 的块，再让里面的内容自己排 —— 之前用 flex 居中，
        // 容器宽度会跟着内容走，切到内容少的标签页整页会缩一下。
        return h("div", {
          style: {
            height: "100%", boxSizing: "border-box", overflowY: "auto",
            padding: "20px 20px 40px",
          },
        },
          h("div", { style: { width: "100%", maxWidth: 1180, margin: "0 auto" } },
            h(HerMemoryHub, null),
          ),
        );
      }

      // 侧栏图标：一条心形（她的记忆），线条粗细跟旁边几个图标一致。
      function HerMemoryIcon(props) {
        const size = (props && props.size) || 18;
        return h("svg", {
          width: size, height: size, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 1.6,
          strokeLinecap: "round", strokeLinejoin: "round",
          "aria-hidden": "true",
        },
          h("path", {
            d: "M12 20s-7-4.35-7-9a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 4.65-7 9-7 9z",
          }),
        );
      }

      // -- 注册 -------------------------------------------------------------

      function apply(ctx) {
        try {
          const slots = ctx.get("slots");
          if (slots === undefined) {
            console.warn("dsh-remembers: slots 服务不可用，入口未注册");
            return;
          }
          // 左边栏「插件」正下方的一条：main 面板（key 与图标 id 同值）+ 侧栏图标。
          // order 5 —— 插件是 0、自动化任务是 10，正好夹在中间。
          const PANEL = "dsh-remembers";
          slots.inject("main", () => slots.register(
            { name: "main", key: PANEL, inject: () => ({}) },
            HerMemoryPage,
          ));
          slots.inject("sidebar.panellist", () => slots.register(
            { name: "sidebar.panellist", id: PANEL, order: 5, label: () => "她的记忆" },
            HerMemoryIcon,
          ));

        } catch (err) {
          console.error("dsh-remembers: apply() 失败", err);
        }
      }

      exports.apply = apply;
      exports.inject = ["slots"];
      return module.exports;
    } catch (err) {
      try {
        console.error("dsh-remembers: 浏览器半边注册失败", err);
      } catch {
        /* logging is best-effort */
      }
      return module.exports;
    }
  },
});
