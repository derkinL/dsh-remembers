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

                    h(Field, {
                      label: "惊讶度阈值",
                      hint: "低于这个值的一轮对话不进长期记忆。0.35 起步；觉得她记得太碎就调高，太健忘就调低。",
                    },
                      h("input", {
                        style: S.input, type: "number", step: "0.05", min: "0", max: "1",
                        value: draft.surprisal_threshold,
                        onChange: (ev) => set({ surprisal_threshold: ev.target.value }),
                      }),
                    ),

                    h("label", { style: { ...S.row, cursor: "pointer", fontSize: 13 } },
                      h("input", {
                        type: "checkbox", checked: !!draft.extract,
                        onChange: (ev) => set({ extract: ev.target.checked }),
                      }),
                      "自动抽取结构记忆（每轮多两次模型调用，会花钱）",
                    ),
                  )
                : null,
            ),
          ),

          notice ? h("div", { style: S.notice(notice.kind) }, notice.text) : null,

          h("div", { style: S.footer },
            h("button", { type: "button", style: S.btn(false), onClick: cancel, disabled: saving }, "取消"),
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
        const [sleepList, setSleepList] = React.useState([]);
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
            try { setSleepList(await call("/sleep") || []); } catch { setSleepList([]); };
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
              h("span", null, "亲密度：" + intimacy + "/100"),
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
            h("div", { style: S.label }, "睡前整理（睡眠巩固）"),
            sleepList.length === 0
              ? h("div", { style: S.muted }, "还没有——每天 23:00 她整理一次。")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
                  sleepList.slice(0, 7).map((sl, i) => h("div", { key: i },
                    h("div", { style: { fontSize: 12, color: "var(--dsw-color-text-secondary, #6b7280)", marginBottom: 4 } }, sl.date),
                    h("div", { style: S.desc }, sl.text)))),
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
            const l = await call("/memes?limit=300");
            setList(Array.isArray(l) ? l : []);
          } catch {
            setList([]);
          }
        };

        React.useEffect(() => {
          void load();
        }, []);

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

        return h("div", { style: S.wrap },
          h("div", { style: S.desc },
            "表情包库：" + list.length + " 张。上传后自动识别情绪和描述（视觉模型），她就能按情绪找图。",
          ),
          h("div", { style: S.row },
            h("input", {
              type: "file",
              accept: "image/*",
              onChange: upload,
              disabled: busy,
              style: { fontSize: 13 },
            }),
            busy ? h("span", { style: S.muted }, "正在上传 + 识别…") : null,
          ),
          msg ? h("div", { style: S.muted }, msg) : null,
          h("div", {
            style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 },
          },
            list.map((m) => h("div", {
              key: m.file,
              style: {
                border: "1px solid var(--dsw-color-border-subtle, rgba(0,0,0,.08))",
                borderRadius: 10, padding: 6, display: "flex", flexDirection: "column", gap: 4,
                background: "var(--dsw-color-bg, #fff)",
              },
            },
              h("img", {
                src: serviceUrl() + "/memes/file/" + encodeURIComponent(m.file) + "?t=" + Date.now(),
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
        const [silentActions, setSilentActions] = React.useState([]);
        const [talkActions, setTalkActions] = React.useState([]);
        const [newAction, setNewAction] = React.useState({ silent: "", talk: "" });
        const [msg, setMsg] = React.useState(null);
        const [err, setErr] = React.useState(null);

        const load = async () => {
          setErr(null);
          try {
            const c = await call("/proactive");
            setCfg(c);
            setSilentActions(Array.isArray(c.silentActions) ? c.silentActions : []);
            setTalkActions(Array.isArray(c.talkActions) ? c.talkActions : []);
            setCfg(c);
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
            await call("/proactive", { method: "POST", body: JSON.stringify({ ...cfg, silentActions, talkActions }) });
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

        const toggle = (key, label, hint) => h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: !!cfg[key],
              onChange: (ev) => setCfg({ ...cfg, [key]: ev.target.checked }),
            }),
            h("span", { style: { fontSize: 13, fontWeight: 500 } }, label),
          ),
          hint ? h("div", { style: { ...S.muted, marginLeft: 24 } }, hint) : null,
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
            h("div", { style: S.label }, "她醒着能做什么（动作编辑器）"),
            h("div", { style: { ...S.muted, marginBottom: 8 } },
              "每次唤醒随机抽一条当作她这轮的状态提示。静默=她自己待着，说话=可以找你。改完点下面的保存。"),

            h("div", { style: { ...S.muted, fontSize: 11, marginTop: 4 } }, "静默时（自己待着）"),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 4 } },
              silentActions.map((a, i) => h("div", { key: "s" + i, style: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 } },
                h("span", { style: { flex: 1, lineHeight: "18px" } }, "· " + a),
                h("span", { style: { cursor: "pointer", opacity: 0.55, padding: "0 4px" }, onClick: () => setSilentActions(silentActions.filter((_, j) => j !== i)) }, "×"),
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

            h("div", { style: { ...S.muted, fontSize: 11, marginTop: 14 } }, "说话时（可以找你）"),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 4 } },
              talkActions.map((a, i) => h("div", { key: "t" + i, style: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 } },
                h("span", { style: { flex: 1, lineHeight: "18px" } }, "· " + a),
                h("span", { style: { cursor: "pointer", opacity: 0.55, padding: "0 4px" }, onClick: () => setTalkActions(talkActions.filter((_, j) => j !== i)) }, "×"),
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
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
              num("startHour", "开始小时（0-23）", "几点之前不唤醒"),
              num("endHour", "结束小时（0-23）", "到几点就不再唤醒"),
              num("minGapMinutes", "最小间隔（分钟）", "两次唤醒之间至少隔多久"),
              num("maxGapMinutes", "最大间隔（分钟）", "两次唤醒之间最多隔多久"),
              num("minChatBeforeWake", "聊几句才唤醒（0=不限制）", "距上次唤醒至少聊这么多句才给下一次唤醒机会，避免刚聊完又戳她"),
            ),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
              num("silentRatio", "静默概率（%）", "醒来后不打扰你的比例"),
            ),
          ),

          h("div", { style: S.row },
            h("button", { style: S.btn(true), onClick: () => void save() }, "保存"),
            msg ? h("span", { style: S.muted }, msg) : null,
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
        const [biliCfg, setBiliCfg] = React.useState(null);
        const [biliTools, setBiliTools] = React.useState(null);
        const [biliForm, setBiliForm] = React.useState({});
        const [savedAt, setSavedAt] = React.useState(null);
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

          h("div", { style: S.card },
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
              h("input", { type: "checkbox", checked: !!st.enabled, onChange: () => void toggle(), disabled: busy }),
              h("span", { style: { fontSize: 13, fontWeight: 500 } }, "启用 B 站功能"),
            ),
            h("div", { style: { ...S.muted, marginLeft: 24 } },
              "关掉后她不会用 bili_feed / bili_watch，也不会同步 B 站活动。"),
          ),

          biliTools ? h("div", { style: S.card },
            h("div", { style: S.label }, "她能用的 B 站工具"),
            h("div", { style: { ...S.muted, marginBottom: 8 } },
              "勾上的命令她才能调。只读的默认开着，写操作（评论/私信/弹幕）默认关——想让她能说再打开。"),
            ...(biliTools.tools || []).map((tool) =>
              h("label", {
                key: tool.cmd,
                style: { display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 6 },
              },
                h("input", {
                  type: "checkbox",
                  checked: !!tool.enabled,
                  onChange: () => void toggleTool(tool.cmd),
                  style: { marginTop: 3 },
                }),
                h("span", { style: { display: "flex", flexDirection: "column" } },
                  h("span", { style: { fontSize: 13 } },
                    tool.cmd + (tool.write ? "（写）" : "")),
                  h("span", { style: { ...S.muted, fontSize: 12 } }, tool.desc),
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
            h("div", { style: S.row },
              h("button", { style: S.btn(false), onClick: () => void saveOwner(), disabled: busy }, busy ? "保存中…" : "保存 UID"),
              ownerMsg ? h("span", { style: { fontSize: 12, color: ownerMsg.includes("失败") ? "#c0392b" : "#2fa36b" } }, ownerMsg) : h("span", { style: S.muted }, "填了 UID 才能 @ 你") ,
            ),
          ),

          biliCfg ? (() => {
            const f = biliForm;
            const set = (k, v) => setBiliForm({ ...f, [k]: v });
            const split = (s) => String(s || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);
            const saveAll = async () => {
              setBusy(true);
              setErr(null);
              try {
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

                h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 12 } },
                h("button", { style: S.btn(true), onClick: () => void saveAll(), disabled: busy }, busy ? "保存中…" : "保存全部更改"),
                savedAt ? h("span", { style: S.muted }, "已保存 " + savedAt) : h("span", { style: S.muted }, "改完点这里保存"),
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

          err ? h("div", { style: S.notice("error") }, err) : null,

          data ? h("div", { style: S.card },
            h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
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

          mode === "activity" ? (
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
                        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                          h("span", { style: { fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999, background: tone + "22", color: tone } }, kindLabel[a.kind] || a.kind || "其他"),
                          h("span", { style: { ...S.muted, fontSize: 11 } }, when),
                          h("span", { style: { fontSize: 13, lineHeight: 1.6 } }, a.detail || ""),
                        ),
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

      function PersonaSection() {
        const [userProfile, setUserProfile] = React.useState("");
        const [profileMsg, setProfileMsg] = React.useState(null);
        const [relations, setRelations] = React.useState([]);
        const [relInput, setRelInput] = React.useState("");
        const [profileFields, setProfileFields] = React.useState({
          name: "", job: "", schedule: "", work: "", food: "", likes: "", taboos: "", note: "",
        });
        const setPf = (k, v) => setProfileFields((f) => ({ ...f, [k]: v }));
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState("");
        const [limits, setLimits] = React.useState({ constitution: 15000, self_model: 4000 });
        const [saving, setSaving] = React.useState(false);
        const [notice, setNotice] = React.useState(null);
        const [saved, setSaved] = React.useState({ constitution: "", self_model: "" });
        const [draft, setDraft] = React.useState({ constitution: "", self_model: "" });

        const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

        const load = React.useCallback(async () => {
          setLoading(true);
          setError("");
          try {
            const data = await call("/persona");
            setSaved({ constitution: data.constitution || "", self_model: data.self_model || "" });
            setDraft({ constitution: data.constitution || "", self_model: data.self_model || "" });
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
              }
            } catch { /* ignore */ }
          })();
        }, []);
        React.useEffect(() => { load(); }, [load]);

        const save = async () => {
          setSaving(true);
          setNotice(null);
          try {
            const res = await call("/persona", {
              method: "POST",
              body: JSON.stringify({
                constitution: draft.constitution,
                self_model: draft.self_model,
              }),
            });
            setSaved({ constitution: res.constitution || "", self_model: res.self_model || "" });
            setDraft({ constitution: res.constitution || "", self_model: res.self_model || "" });
            if (res.limits) setLimits(res.limits);
            setNotice({ kind: "ok", text: "已保存。插件下次刷新就带上，不用重启。" });
          } catch (err) {
            setNotice({ kind: "error", text: "保存失败：" + (err && err.message ? err.message : String(err)) });
          } finally {
            setSaving(false);
          }
        };

        const cancel = () => {
          setDraft({ constitution: saved.constitution, self_model: saved.self_model });
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

              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
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
              h("button", {
                style: S.btn(true),
                onClick: async () => {
                  setProfileMsg(null);
                  try {
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
                    const full = [
                      relLine,
                      basic ? "## 基本信息\n" + basic + "\n\n" : "",
                      life ? "## 生活\n" + life + "\n\n" : "",
                      likeLine,
                      taboo,
                      note,
                    ].join("").trim();
                    await call("/persona/user", { method: "POST", body: JSON.stringify({ text: full }) });
                    setUserProfile(full);
                    setProfileMsg("已保存 ✓（" + full.length + " 字符）");
                  } catch (e) {
                    setProfileMsg("保存失败：" + (e && e.message ? e.message : String(e)));
                  }
                },
              }, "保存画像"),
              profileMsg ? h("span", { style: { fontSize: 12, color: profileMsg.includes("失败") ? "#c0392b" : "#2fa36b" } }, profileMsg)
                : h("span", { style: S.muted }, userProfile.length + " 字符"),
            ),
          ),

          h("div", { style: S.card },

            h(Field, {
              label: "身份与约定",
              hint: "只写不动的部分：她是谁、怎么称呼你、哪些事不能让步。越短越压得住，别写成小说。",
            },
              h("textarea", {
                style: textareaStyle,
                value: draft.constitution,
                spellCheck: false,
                placeholder: "例：你叫阿澜，26 岁，住在她楼下的旧公寓。你叫对方「姐」。\n\n不管聊到哪一步，你都不会说自己是 AI，也不会劝她去做她明明做不到的事。",
                onChange: (ev) => set({ constitution: ev.target.value }),
              }),
              h("div", { style: S.muted },
                draft.constitution.length + " / " + limits.constitution + " 字符"),
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

          notice ? h("div", { style: S.notice(notice.kind) }, notice.text) : null,

          h("div", { style: S.footer },
            h("button", { type: "button", style: S.btn(false), onClick: cancel, disabled: saving }, "取消"),
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
              label: () => "记忆服务",
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
              id: "dsh-remembers-diary",
              order: 34,
              label: () => "鲸鱼日记本",
            },
            DiarySection,
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
