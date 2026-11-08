# 功能：设置（记忆服务 / 模型 / 开关）

设置页的「记忆服务」卡片，管的是**服务端**这一半：LLM、embedding、抽取开关、阈值。

## 界面

```
服务地址  [http://127.0.0.1:8080]

┌ 对话模型 ──────────────┐   ┌ 向量模型 ──────────────┐
│ 提供商 [DeepSeek ▾]    │   │ 提供商 [阿里云百炼 ▾]  │
│ API 密钥 [        ]    │   │ API 密钥 [        ]    │
│ Base URL [        ]    │   │ Base URL [        ]    │
│ 常用模型 [deepseek-chat▾]│  │ 常用模型 [text-embedding-v3 ▾]│
│ 模型名   [        ]    │   │ 模型名   [        ]    │
└────────────────────────┘   └────────────────────────┘
抽取开关 / 惊讶度阈值 / 情绪阈值 / 日记 / 演化 / episode
```

12 家厂商预设（DeepSeek、百炼、智谱、Kimi、火山方舟、千帆、混元、硅基流动、MiniMax、OpenAI、OpenRouter、自定义），每家带 logo、OpenAI 兼容端点、常用模型下拉。模型名可手改，不锁死。

## 保存与生效

- `GET /config` 返回**脱敏**后的 key（`sk-ab…1234`）+ `*_key_set`，页面不会拿到明文。
- 保存时把带 `…` 的值原样回传 → 服务端跳过，不会把真 key 洗成掩码。
- `POST /config` 原子写 `data/config.json`（权限 600），然后**热重建** LLM/Embedder/Extractor/Gate，不用重启。

## 文件树

```
index.mjs                     # 只读 config（endpoint 等），不含服务端密钥
client.js                     # 「记忆服务」面板：厂商下拉、模型下拉、logo、阈值
service/server.py             # GET|POST /config；_load_config/_save_config/_rebuild
service/llm.py                # OpenAI 兼容 chat + JSON 容错解析
service/embedding.py          # embeddings（批次上限、失败对半拆）
service/data/config.json      # 实际配置（含密钥，600）
service/.env / .env.win       # 环境变量兜底（服务启动时读）
```

## 优先级

`data/config.json` > 环境变量（含 `.env`）> 内置默认。

`service/.env`（Linux）和 `service/.env.win`（Windows）都是 `KEY=VALUE`，安装脚本生成；**服务启动时会读**（1.2.0 起）。

## 已知边界

- key 只在服务端；插件侧永远拿不到，也不需要。
- `CMEM_AUTH_TOKEN` 不配时服务只应绑 `127.0.0.1`；绑公网必须配 token（服务会校验 `X-Auth-Token`）。
- 换 embedding 模型后旧向量不再可比：要么手动 `POST /reindex`，要么清掉 `vec` 重来。
