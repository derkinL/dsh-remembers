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

      const DEFAULT_SERVICE_URL = "http://127.0.0.1:8080";
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
          return window.localStorage.getItem(URL_KEY) || DEFAULT_SERVICE_URL;
        } catch {
          return DEFAULT_SERVICE_URL;
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
                "记忆服务默认跑在 127.0.0.1:8080；它没起来时这块会一直转圈。"),
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
            const l = await call("/memes?limit=50");
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
        const [msg, setMsg] = React.useState(null);
        const [err, setErr] = React.useState(null);

        const load = async () => {
          setErr(null);
          try {
            const c = await call("/proactive");
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
            await call("/proactive", { method: "POST", body: JSON.stringify(cfg) });
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
            h("div", { style: S.desc }, "唤醒规则"),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
              num("startHour", "开始小时（0-23）", "几点之前不唤醒"),
              num("endHour", "结束小时（0-23）", "到几点就不再唤醒"),
              num("minGapMinutes", "最小间隔（分钟）", "两次唤醒之间至少隔多久"),
              num("maxGapMinutes", "最大间隔（分钟）", "两次唤醒之间最多隔多久"),
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

      // ---------------------------------------------------------------------
      // B 站：账号状态 + 开关（她自己的号，嘴走 QQ 那套）
      // ---------------------------------------------------------------------
      function BiliSection() {
        const [st, setSt] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [test, setTest] = React.useState(null);
        const [err, setErr] = React.useState(null);

        const load = async () => {
          setErr(null);
          try {
            setSt(await call("/bili/status"));
          } catch (e) {
            setErr(e && e.message ? e.message : String(e));
            setSt(null);
          }
        };

        React.useEffect(() => {
          void load();
        }, []);

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
            h("div", { style: { ...S.desc, fontSize: 12 } }, st.login_hint),
            h("div", { style: S.row },
              h("button", { style: S.btn(false), onClick: () => window.open("/dsh-bili/", "_blank") }, "打开 B 站设置页（登录）"),
            ),
          ),

          h("div", { style: S.card },
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
              h("input", { type: "checkbox", checked: !!st.enabled, onChange: () => void toggle(), disabled: busy }),
              h("span", { style: { fontSize: 13, fontWeight: 500 } }, "启用 B 站功能"),
            ),
            h("div", { style: { ...S.muted, marginLeft: 24 } },
              "关掉后她不会用 bili_feed / bili_watch，也不会同步 B 站活动。"),
          ),

          h("div", { style: S.card },
            h("div", { style: S.label }, "她在 B 站说什么（嘴）"),
            h("div", { style: { ...S.muted, marginBottom: 6 } },
              "下面这些开着，她就会在 B 站那边自己说话；关掉就只有 QQ 这套嘴。"),
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
              h("input", { type: "checkbox", checked: !!st.share, onChange: () => void toggleMouth("share") }),
              h("span", { style: { fontSize: 13 } }, "主动分享（刷到好视频在评论区 @ 你）"),
            ),
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
              h("input", { type: "checkbox", checked: !!st.comment, onChange: () => void toggleMouth("comment") }),
              h("span", { style: { fontSize: 13 } }, "回复 B 站评论"),
            ),
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
              h("input", { type: "checkbox", checked: !!st.dm, onChange: () => void toggleMouth("dm") }),
              h("span", { style: { fontSize: 13 } }, "回复 B 站私信"),
            ),
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
              h("input", { type: "checkbox", checked: !!st.diaryPush, onChange: () => void toggleMouth("diaryPush") }),
              h("span", { style: { fontSize: 13 } }, "推送她的 B 站日记"),
            ),
          ),

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

      function PersonaSection() {
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
