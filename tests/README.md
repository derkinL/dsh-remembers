# 测试

不需要网络，不需要记忆服务在跑。

```bash
bash run_all_tests.sh        # Linux / macOS / WSL / Git Bash
.\run_all_tests.ps1          # Windows PowerShell
```

两个入口做的事一样：依次跑 `tests/python/*.py` 和 `tests/node/*.mjs`，日志落在 `_tmp/test-logs/`。

## 覆盖什么

| 套件 | 覆盖 |
|---|---|
| `python/test_json_parse.py` | LLM 返回的各种畸形 JSON 能不能解析 |
| `python/test_core.py` | 分词、BM25、向量融合、衰减、诚实出口、persona/episode |
| `python/test_gating.py` | 惊讶度门控（纯文本）+ ADD/UPDATE/DELETE/NONE + **LLM 挂了必须返回 degraded** |
| `python/test_transfer.py` | A 库 → JSONL → B 库，内容一字不差 |
| `python/test_slang.py` | 旧口头禅表的收录门槛 / 计数 / 转正（历史表，仍保留） |
| `python/test_seeds.py` | 默认语料导入：`last_hit` 必须是数字（否则 `/learn/stats` 500）、幂等、老库修复 |
| `python/test_selfline.py` | 她自己的发言（口音来源）：写入/计数/排序 + 口音样本优先级 |
| `node/test_plugin.mjs` | `apply()` 注册了 1 个 systemPrompt 段、4 个钩子、21 个工具 |
| `node/test_client.mjs` | `client.js` 的模块协议、入口页 9 张卡、9 个二级页、返回按钮位置 |
| `node/tone.test.mjs` | `tone_fix` 的每条规则 + 不该动的（代码块/表格/数字结尾） |

## 两个注意

- **`test_plugin.mjs` 在普通 checkout 里会跳过工具断言**：工具注册要 `@deepseek-ai/dsh-tools`，仓库自带的 `node_modules` 只有 `dsh-llm` 的测试替身。装进真实 profile 后才会真的建工具。
- **测试临时目录都在仓库内**（`tests/python/_*_tmp/`），不用系统 temp：某些沙箱会禁止在系统 temp 里建 sqlite 文件，报 `unable to open database file`，很难看出是权限问题。
