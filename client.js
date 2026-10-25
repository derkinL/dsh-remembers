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

      const S = {
        wrap: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 },
        desc: { fontSize: 13, lineHeight: 1.6, color: "var(--dsw-color-text-secondary, #6b7280)" },
        card: {
          border: "1px solid var(--dsw-color-border-subtle, rgba(0,0,0,.08))",
          borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 14,
          background: "var(--dsw-color-bg-subtle, #fafafa)",
        },
        field: { display: "flex", flexDirection: "column", gap: 6 },
        label: { fontSize: 13, fontWeight: 500, color: "var(--dsw-color-text-primary, #111827)" },
        input: {
          width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13,
          borderRadius: 8, border: "1px solid var(--dsw-color-border, rgba(0,0,0,.14))",
          background: "var(--dsw-color-bg, #fff)", color: "var(--dsw-color-text-primary, #111827)",
          outline: "none", fontFamily: "inherit",
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

      function SettingsSection() {
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
      // 鲸鱼日记本：她现在在干嘛 / 心情 / 记得什么
      // ---------------------------------------------------------------------
      function DiarySection() {
        const [st, setSt] = React.useState(null);
        const [viewHour, setViewHour] = React.useState(null);
        const [diaries, setDiaries] = React.useState([]);
        const [activities, setActivities] = React.useState([]);
        const [diaryDate, setDiaryDate] = React.useState("");
        const [persona, setPersona] = React.useState(null);
        const [memories, setMemories] = React.useState([]);
        const [taskList, setTaskList] = React.useState([]);
        const [noteList, setNoteList] = React.useState([]);
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState(null);

        const load = async () => {
          setLoading(true);
          setError(null);
          try {
            const s = await call("/state" + (viewHour === null ? "" : "?hour=" + viewHour));
            const p = await call("/persona");
            let m = [];
            try {
              m = await call("/profile");
            } catch {
              m = [];
            }
            let ds = [];
            try {
              ds = await call("/diary");
            } catch {
              ds = [];
            }
            setDiaries(Array.isArray(ds) ? ds : []);
            let acts = [];
            try {
              acts = await call("/activity");
            } catch {
              acts = [];
            }
            setActivities(Array.isArray(acts) ? acts : [])
            try { setTaskList(await call("/tasks") || []); } catch { setTaskList([]); }
            try { setNoteList(await call("/notes") || []); } catch { setNoteList([]); }
            setSt(s);
            setPersona(p);
            setMemories(Array.isArray(m) ? m : []);
          } catch (err) {
            setError(err && err.message ? err.message : String(err));
          } finally {
            setLoading(false);
          }
        };

        React.useEffect(() => {
          void load();
        }, [viewHour]);

        if (loading && !st) {
          return h("div", { style: S.wrap }, h("div", { style: S.muted }, "正在读鲸鱼日记本…"));
        }

        const MOOD = { happy: "开心", tired: "累", annoyed: "烦", bored: "无聊", normal: "平常" };
        const mood = st ? (MOOD[st.mood] || "平常") : "?";
        const intimacy = st ? Math.round(Number(st.intimacy) || 0) : 0;
        const stage = st && st.stage ? st.stage.name : "?";
        const stageHint = st && st.stage ? st.stage.hint : "";
        const activity = st && st.activity ? st.activity : "发呆";
        const weather = st && st.weather ? st.weather : "不知道";
        const gameScore = st ? Number(st.game_score) || 0 : 0;
        const gamePlays = st ? Number(st.game_plays) || 0 : 0;

        return h("div", { style: S.wrap },

          h("div", { style: S.desc },
            "她现在在干嘛、心情怎么样、还记得什么——实时从记忆服务读。",
          ),

          h("div", { style: S.row },
            h("button", { style: S.btn(false), onClick: () => void load() }, "刷新"),
            h("span", { style: S.muted }, "看看她几点：" ),
            h("select", {
              style: { ...S.select, width: 120 },
              value: viewHour === null ? "" : String(viewHour),
              onChange: (ev) => {
                const v = ev.target.value;
                setViewHour(v === "" ? null : Number(v));
              },
            },
              h("option", { value: "" }, "现在"),
              Array.from({ length: 24 }).map((_, hr) =>
                h("option", { key: hr, value: String(hr) }, (hr < 10 ? "0" + hr : hr) + ":00")),
            ),
            st ? h("span", { style: S.muted }, "最后互动：" + (st.last_interaction ? new Date(st.last_interaction * 1000).toLocaleString() : "还没聊过")) : null,
          ),

          error ? h("div", { style: S.notice("error") }, "读取失败：" + error) : null,

          h("div", { style: S.card },
            h("div", { style: S.label }, "她现在"),
            h("div", { style: { display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13 } },
              h("span", null, "心情：" + mood),
              h("span", null, "亲密度：" + intimacy + "/1000"),
              h("span", null, "阶段：" + stage),
            ),
            h("div", { style: S.muted }, "在干嘛：" + activity),
            h("div", { style: S.muted }, "外面：" + weather),
            h("div", { style: S.muted }, "小游戏：《像素鲸鱼吃豆子》" + gameScore + " 分（玩了 " + gamePlays + " 次）"),
            stageHint ? h("div", { style: S.muted }, "这个阶段的样子：" + stageHint) : null,
          ),

          h("div", { style: S.card },
            h("div", { style: S.label }, "她对自己的认知"),
            h("div", { style: S.desc },
              persona && persona.self_model ? persona.self_model : "还没有——聊够 30 轮她会开始写。"),
          ),

          h("div", { style: S.card },
            h("div", { style: S.label }, "今天的时间线（她真的做了什么）"),
            activities.length === 0
              ? h("div", { style: S.muted }, "还没有记录——聊一句或等她主动找你。")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  activities.slice(0, 30).map((a, i) => h("div", { key: i, style: S.muted },
                    new Date(a.ts * 1000).toLocaleTimeString() + " · " + (a.kind === "chat" ? "聊天" : a.kind === "game" ? "玩游戏" : a.kind === "proactive" ? "主动找你" : a.kind === "bili" ? "B 站" : a.kind === "habit" ? "习惯" : a.kind) + " · " + String(a.detail || "").slice(0, 60)))),
          ),

          h("div", { style: S.card },
            h("div", { style: S.label }, "她给老大派的任务"),
            taskList.length === 0
              ? h("div", { style: S.muted }, "还没有任务——她说派的时候会出现在这里。")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  taskList.slice(0, 10).map((tk) => h("div", { key: tk.id, style: S.row },
                    h("span", { style: { fontSize: 13 } }, (tk.done ? "✓ " : "○ ") + tk.text),
                    h("span", { style: S.muted }, "(" + tk.points + " 分)"),
                  ))),
          ),

          h("div", { style: S.card },
            h("div", { style: S.label }, "共享便签"),
            noteList.length === 0
              ? h("div", { style: S.muted }, "还没有便签。")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  noteList.slice(0, 10).map((nt) => h("div", { key: nt.id, style: S.muted },
                    nt.date + " · " + (nt.author || "某人") + "：" + nt.text))),
          ),


          h("div", { style: S.card },
            h("div", { style: S.row },
              h("div", { style: S.label }, "日记本（按天，每天一篇）"),
              diaries.length > 0
                ? h("select", {
                    style: { ...S.select, width: 160, marginLeft: "auto" },
                    value: diaryDate,
                    onChange: (ev) => setDiaryDate(ev.target.value),
                  },
                    h("option", { value: "" }, "全部"),
                    diaries.map((d) => h("option", { key: d.date, value: d.date }, d.date)))
                : null,
            ),
            diaries.length === 0
              ? h("div", { style: S.muted }, "还没有日记——每天 23:00 她会写一篇。")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 12, marginTop: 8 } },
                  diaries.filter((d) => !diaryDate || d.date === diaryDate).map((d, i) => h("div", { key: i },
                    h("div", { style: { fontSize: 12, color: "var(--dsw-color-text-secondary, #6b7280)", marginBottom: 4 } }, d.date),
                    h("div", { style: S.desc }, d.text)))),
          ),

          h("div", { style: S.card },
            h("div", { style: S.label }, "她记得的事（最近 12 条）"),
            memories.length === 0
              ? h("div", { style: S.muted }, "还没有记忆——先聊几句。")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  memories.slice(0, 12).map((m, i) => h("div", { key: i, style: S.muted },
                    "[" + (m.tier || "?") + "] " + String(m.text || m.summary || "").slice(0, 90)))),
          ),

        );
      }

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
          return h("div", { style: S.wrap },
            h("div", { style: S.desc },
              "她的表情包库，按图库分。点一个图库进去看里面的图。",
            ),
            h("div", { style: { display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" } },
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
            h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 } },
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
                    border: "1px solid var(--dsw-color-border-subtle, rgba(0,0,0,.08))",
                    borderRadius: 12, overflow: "hidden", cursor: "pointer",
                    background: "var(--dsw-color-bg, #fff)",
                    display: "flex", flexDirection: "row", alignItems: "center", gap: 12, padding: 12,
                    transition: "transform .12s ease, box-shadow .12s ease",
                  },
                },
                  h("div", {
                    style: {
                      flex: "none", width: 96, height: 96, borderRadius: 10,
                      backgroundColor: "var(--dsw-color-bg-secondary, #f3f4f6)",
                      backgroundImage: pk.cover
                        ? "url(" + serviceUrl() + "/memes/file/" + encodeURIComponent(pk.cover) + ")"
                        : "none",
                      backgroundSize: "cover",
                      backgroundPosition: "center 28%",
                      backgroundRepeat: "no-repeat",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 22,
                      color: "var(--dsw-color-text-secondary, #9ca3af)",
                    },
                  }, pk.cover ? null : (pk.pack === "all" ? "🗂️" : "🐟")),
                  h("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
                    h("div", { style: { fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, pk.name),
                    h("div", { style: { fontSize: 12, color: "var(--dsw-color-text-secondary, #6b7280)" } }, pk.count + " 张"),
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
          );
        }

        const PACKS_DEF = [
          { id: "dafeiyu", name: "大肥鱼" },
          { id: "user", name: "用户表情包" },
          { id: "found", name: "大肥鱼叼回来的" },
        ];
        const packCount = (id) => {
          const hit = packs.find((p) => p.pack === id);
          return hit ? hit.count : 0;
        };

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
      function ProactiveSection() {
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
            padding: "10px 12px", borderRadius: 8, marginBottom: 8,
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

        return h("div", { style: S.wrap },
          h("div", { style: S.desc },
            "定时把她叫醒。醒来之后她想干嘛（发呆 / 上网 / 找你 / 发图）由她自己决定——"
            + "关掉「允许发消息」就是只唤醒、不打扰。",
          ),


          h("div", { style: S.card },
            toggle("enabled", "自动唤醒", "总开关：关掉后完全不叫醒她"),
            toggle("talkEnabled", "允许她主动发消息", "关掉 = 只唤醒她、不给你发消息（静默活动）"),
          ),

          h("div", { style: S.card },
            h("div", { style: S.label }, "她的主动性"),
            h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
              "勾上之后会写进她的系统提示词。关掉 = 她不会主动约时间、也不会主动分享，只被动等你。"),

            h("div", {
              style: {
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                padding: "10px 12px", borderRadius: 8, marginBottom: 8,
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

            h("div", {
              style: {
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                padding: "10px 12px", borderRadius: 8,
                border: "1.5px solid " + (cfg.autoShareEnabled !== false ? "#4084ff" : "rgba(0,0,0,.10)"),
                background: cfg.autoShareEnabled !== false ? "rgba(64,132,255,.04)" : "#fff",
              },
              onClick: () => setCfg({ ...cfg, autoShareEnabled: cfg.autoShareEnabled === false }),
            },
              h("input", {
                type: "checkbox",
                checked: cfg.autoShareEnabled !== false,
                onClick: (ev) => ev.stopPropagation(),
                onChange: (ev) => setCfg({ ...cfg, autoShareEnabled: ev.target.checked }),
                style: { marginTop: 3 },
              }),
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: 13, fontWeight: 500 } }, "刷完 B 站可以主动分享"),
                h("div", { style: { ...S.muted, fontSize: 12, marginTop: 2 } },
                  "刷到有意思的，她会把链接和两句感想发给你"),
              ),
            ),
          ),

          h("div", { style: S.card },
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

          h("div", { style: S.card },
            h("div", { style: S.label }, "B 站（她自己刷视频的节奏）"),
            h("div", { style: { ...S.muted, marginBottom: 8 } },
              "和唤醒分开管：她按自己的间隔去 B 站逛逛，刷到什么会记进见闻，下次聊天能提。"),
            toggle("biliBrowseEnabled", "允许她按自己的节奏刷 B 站", "关掉 = 只有唤醒时抽到「刷 B 站」才去"),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 8 } },
              num("biliMinGapMinutes", "至少隔（分钟）", "两次刷之间最少多久"),
              num("biliMaxGapMinutes", "最多隔（分钟）", "两次刷之间最多多久"),
              num("biliBrowseLimit", "每次刷几条", "存进见闻的条数"),
              num("biliBrowsePerDay", "每天最多刷几次", "超过就不点醒她了"),
            ),
          ),

          h("div", { style: S.card },
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
                    cursor: "pointer", padding: "10px 12px", borderRadius: 8,
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

          h("div", {
            style: {
              position: "fixed", right: 24, top: "50%", transform: "translateY(-50%)",
              display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8,
              background: "#ffffff", padding: "12px 16px", borderRadius: 12,
              border: "1px solid rgba(0,0,0,.08)", boxShadow: "0 8px 24px rgba(0,0,0,.12)", zIndex: 9999,
              minWidth: 140,
            },
          },
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
      function BiliSection() {
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
              const p = await call("/proactive");
              setBiliProactive({
                biliShareToOwner: p.biliShareToOwner !== false,
                biliShareToGroup: p.biliShareToGroup === true,
                biliComment: p.biliComment !== false,
                biliMentionOwner: p.biliMentionOwner !== false,
              });
            } catch { setBiliProactive({ biliShareToOwner: true, biliShareToGroup: false, biliComment: true, biliMentionOwner: true }); }
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

        const saveCfg = async (path, value) => {
          try {
            await call("/bili/cfg", { method: "POST", body: JSON.stringify({ path, value }) });
            const c = await call("/bili/cfg");
            setBiliCfg(c);
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
          }
        };

        const saveOwner = async () => {
          setBusy(true);
          setOwnerMsg(null);
          try {
            await call("/bili/owner", { method: "POST", body: JSON.stringify({ mid: ownerMid.trim(), name: ownerName.trim() }) });
            setOwnerMsg("已保存 ✓" + (ownerMid.trim() ? "（@ " + ownerMid.trim() + "）" : "（不 @）"));
            await load();
          } catch (e) {
            setOwnerMsg("保存失败：" + (e && e.message ? e.message : String(e)));
          } finally {
            setBusy(false);
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

        const toggleMouth = async (key) => {
          if (!st) return;
          setBusy(true);
          try {
            const cur = st[key];
            await call("/bili/toggle", { method: "POST", body: JSON.stringify({ key, value: !cur }) });
            await load();
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

        return h("div", { style: S.wrap },
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

          h("label", { style: {
            display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
            padding: "14px 16px", borderRadius: 12,
            border: "1.5px solid " + (st.enabled ? "#4084ff" : "rgba(0,0,0,.10)"),
            background: st.enabled ? "rgba(64,132,255,.04)" : "#ffffff",
            transition: "border-color .15s, background .15s",
          } },
            h("input", { type: "checkbox", checked: !!st.enabled, onChange: () => void toggle(), disabled: busy, style: { marginTop: 3 } }),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              h("span", { style: { fontSize: 13, fontWeight: 600 } }, "启用 B 站功能"),
              h("span", { style: { ...S.muted, fontSize: 12 } },
                "关掉后她不会用 bili_feed / bili_watch，也不会同步 B 站活动。"),
            ),
          ),

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
                    padding: "10px 12px", borderRadius: 8, height: "100%", boxSizing: "border-box",
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
                    padding: "10px 12px", borderRadius: 8, height: "100%", boxSizing: "border-box",
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
          ) : null,

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
                  }
                  ownerInit.current = ownerMid.trim();
                }
              } catch (e) { /* UID 失败不影响主配置 */ }

                await Promise.all([
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["preferences", "like"], value: Array.isArray(f.like) ? f.like : [] }) }),
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["preferences", "dislike"], value: Array.isArray(f.dislike) ? f.dislike : [] }) }),
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["night", "skipChance"], value: Number(f.skipChance) || 0 }) }),
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["night", "maxVideos"], value: Number(f.maxVideos) || 6 }) }),
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["night", "minGapMin"], value: Number(f.minGapMin) || 10 }) }),
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["persona", "name"], value: String(f.name || "") }) }),
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["persona", "ownerTitle"], value: String(f.ownerTitle || "") }) }),
                  call("/bili/cfg", { method: "POST", body: JSON.stringify({ path: ["persona", "selfClaim"], value: String(f.selfClaim || "") }) }),
                ]);
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
        const [tasksList, setTasksList] = React.useState(null);
        const [stateInfo, setStateInfo] = React.useState(null);
        const [selfModel, setSelfModel] = React.useState(null);
        const [mode, setMode] = React.useState("memory");
        const [tier, setTier] = React.useState("all");
        const [q, setQ] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [err, setErr] = React.useState(null);

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
          try { const r = await call("/slang"); setSlangList(Array.isArray(r) ? r : []); }
          catch (e) { setErr(e && e.message ? e.message : String(e)); setSlangList([]); }
          finally { setBusy(false); }
        };

        const loadTasks = async () => {
          setBusy(true); setErr(null);
          try { const r = await call("/tasks"); setTasksList(Array.isArray(r) ? r : []); }
          catch (e) { setErr(e && e.message ? e.message : String(e)); setTasksList([]); }
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
            params.set("tier", t || tier);
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

        return h("div", { style: S.wrap },
          h("div", { style: S.desc },
            "她记得的所有东西。L0 是原话、L1 是事实、L2 是你的画像、L3 是发生过的事、L4 是里程碑和约定。",
          ),
          h("div", { style: S.card },
            h("div", { style: { ...S.label, marginBottom: 8 } }, "记忆开关"),
            h("label", {
              style: {
                display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                padding: "10px 12px", borderRadius: 8,
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
                  ["evolve_enabled", "演化自我认知", "每 30 轮悟一句「我发现自己……」"],
                  ["episode_enabled", "事件总结", "长对话攒够后压成一条「这段时间发生了什么」"],
                ].map(([key, label, desc]) =>
                  h("label", {
                    key: key,
                    style: {
                      display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                      padding: "10px 12px", borderRadius: 8,
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
                      padding: "10px 12px", borderRadius: 8,
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
                      padding: "10px 12px", borderRadius: 8,
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

          data ? h("div", { style: S.card },
            h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", minHeight: 66, alignContent: "flex-start" } },
              Object.entries(TIERS).map(([k, label]) =>
                h("button", {
                  key: k,
                  style: { ...S.btn(mode === "memory" && tier === k), padding: "4px 10px", fontSize: 12 },
                  onClick: () => { setMode("memory"); setTier(k); void load(k, q); },
                }, label + (k !== "all" && data.counts && data.counts[k] != null ? ` ${data.counts[k]}` : "")),
              ),
              h("button", {
                style: { ...S.btn(mode === "emotion"), padding: "4px 10px", fontSize: 12 },
                onClick: () => { setMode("emotion"); void loadEmotion(); },
              }, "情感" + (emotionList ? ` ${emotionList.length}` : "")),
              h("button", {
                style: { ...S.btn(mode === "activity"), padding: "4px 10px", fontSize: 12 },
                onClick: () => { setMode("activity"); void loadActivity(activityDate); },
              }, "今天干了什么"),
              h("button", {
                style: { ...S.btn(mode === "browse"), padding: "4px 10px", fontSize: 12 },
                onClick: () => { setMode("browse"); void loadBrowse(); },
              }, "见闻" + (browseList ? ` ${browseList.length}` : "")),
              h("button", {
                style: { ...S.btn(mode === "notes"), padding: "4px 10px", fontSize: 12 },
                onClick: () => { setMode("notes"); void loadNotes(); },
              }, "便签" + (notesList ? ` ${notesList.length}` : "")),
              h("button", {
                style: { ...S.btn(mode === "slang"), padding: "4px 10px", fontSize: 12 },
                onClick: () => { setMode("slang"); void loadSlang(); },
              }, "学会的词" + (slangList ? ` ${slangList.length}` : "")),
              h("button", {
                style: { ...S.btn(mode === "tasks"), padding: "4px 10px", fontSize: 12 },
                onClick: () => { setMode("tasks"); void loadTasks(); },
              }, "互相派的活" + (tasksList ? ` ${tasksList.length}` : "")),

              h("button", {
                style: { ...S.btn(mode === "self"), padding: "4px 10px", fontSize: 12 },
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
                    activityList.map((a, i) => {
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
                  )
                : h("div", { style: S.muted }, activityList ? "这天没做什么" : "读取中…"),
            )
          ) : mode === "browse" ? (
            browseList && browseList.length > 0
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  browseList.map((b, i) =>
                    h("div", { key: i, style: { ...S.card, padding: "8px 12px", borderLeft: "3px solid #f0803c" } },
                      h("div", { style: { fontSize: 13, lineHeight: 1.6 } }, b.title || ""),
                      b.url ? h("div", { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, b.url) : null,
                    ),
                  ),
                )
              : h("div", { style: S.muted }, browseList ? "还没刷到什么" : "读取中…")
          ) : mode === "notes" ? (
            notesList && notesList.length > 0
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  notesList.map((n) =>
                    h("div", { key: n.id, style: { ...S.card, padding: "10px 12px", borderLeft: "3px solid #8b5cf6" } },
                      h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 4 } }, (n.author || "她") + " · " + (n.date || "")),
                      h("div", { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" } }, n.text || ""),
                    ),
                  ),
                )
              : h("div", { style: S.muted }, notesList ? "还没记过便签" : "读取中…")
          ) : mode === "slang" ? (
            slangList && slangList.length > 0
              ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
                  slangList.map((s, i) =>
                    h("span", {
                      key: i,
                      style: { fontSize: 12, padding: "2px 10px", borderRadius: 999, border: "1px solid rgba(127,127,127,.25)", background: "rgba(64,132,255,.08)" },
                    }, (s.phrase || s.word || "") + " ×" + (s.count || 0)),
                  ),
                )
              : h("div", { style: S.muted }, slangList ? "还没学会什么词" : "读取中…")
          ) : mode === "tasks" ? (
            tasksList && tasksList.length > 0
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  tasksList.map((k) =>
                    h("div", { key: k.id, style: { ...S.card, padding: "8px 12px", borderLeft: "3px solid " + (k.done ? "#2fa36b" : "#f0803c"), opacity: k.done ? 0.7 : 1 } },
                      h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                        h("span", { style: { fontSize: 11, fontWeight: 600, color: k.done ? "#2fa36b" : "#f0803c" } }, k.done ? "✓ 已完成" : "待办"),
                        h("span", { style: { fontSize: 13, lineHeight: 1.6, flex: 1 } }, k.text || ""),
                        h("span", { style: { ...S.muted, fontSize: 11 } }, "+" + (k.points || 0) + " 分"),
                      ),
                    ),
                  ),
                )
              : h("div", { style: S.muted }, tasksList ? "还没有互相派的活" : "读取中…")
          ) : mode === "emotion" ? (
            emotionList && emotionList.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              emotionList.map((e) => {
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
            ) : h("div", { style: S.muted }, emotionList ? "还没有情感记录（聊几句，情绪有波动就会记）" : "读取中…")
          ) : data && data.items && data.items.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            data.items.map((m) => h("div", {
              key: m.id,
              style: { ...S.card, padding: "10px 12px" },
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
              h("div", { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, m.text),
              m.summary ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, "摘要：" + m.summary) : null,
            )),
          ) : (data ? h("div", { style: S.muted }, "没有匹配的记忆") : null),
        );
      }

      function QqSection() {
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
                  const renderHistoryPanel = true;
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

          // 保存按钮（固定在屏幕右侧中间，跟其他页签一致）
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

      function PersonaSection() {
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
        const [idFields, setIdFields] = React.useState({
          name: "", self_call: "", user_call: "", personality: "", speaking: "", taboo: "", free: "",
          think_cn: false,
          think_ds: false,
          ai_flavor_on: true,
          self_call_in_speech: false,
          _newTaboo: "",
          taboo_off: "",
          ai_flavor: "允许 2% 语法错误、7% 主谓宾省略、7% 聊跑题；口癖 50% 概率出现且单独一条；允许「？？？」这类网络标点，概率 2%。",
        });
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
            notice ? h("div", { style: { fontSize: 12, color: notice.kind === "error" ? "#c0392b" : "#2fa36b", textAlign: "center" } }, notice.text) : null,
            h("button", { type: "button", style: S.btn(true), onClick: save, disabled: saving },
              saving ? "保存中…" : "保存"),
          ),
        );
      }

      // -- 注册 -------------------------------------------------------------

      function apply(ctx) {
        try {
          const slots = ctx.get("slots");
          if (slots === undefined) {
            console.warn("dsh-remembers: slots 服务不可用，设置页未注册");
            return;
          }
          slots.inject("settings.section", () => slots.register(
            {
              name: "settings.section",
              id: "dsh-remembers",
              order: 32,
              label: () => "记忆服务 API 设置",
            },
            SettingsSection,
          ));
          slots.inject("settings.section", () => slots.register(
            {
              name: "settings.section",
              id: "dsh-remembers-persona",
              order: 33,
              label: () => "人格设定",
            },
            PersonaSection,
          ));
          slots.inject("settings.section", () => slots.register(
            {
              name: "settings.section",
              id: "dsh-remembers-memes",
              order: 35,
              label: () => "表情包",
            },
            MemeSection,
          ));
          slots.inject("settings.section", () => slots.register(
            {
              name: "settings.section",
              id: "dsh-remembers-proactive",
              order: 36,
              label: () => "主动消息",
            },
            ProactiveSection,
          ));
          slots.inject("settings.section", () => slots.register(
            {
              name: "settings.section",
              id: "dsh-remembers-qq",
              order: 365,
              label: () => "QQ 通道",
            },
            QqSection,
          ));
          slots.inject("settings.section", () => slots.register(
            {
              name: "settings.section",
              id: "dsh-remembers-bili",
              order: 37,
              label: () => "B 站",
            },
            BiliSection,
          ));
          slots.inject("settings.section", () => slots.register(
            {
              name: "settings.section",
              id: "dsh-remembers-memories",
              order: 38,
              label: () => "记忆",
            },
            MemoriesSection,
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
