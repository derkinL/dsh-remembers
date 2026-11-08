# dsh-onebot-qq 本地补丁

`dsh-onebot-qq` 是 QQ 通道的宿主插件。下面这些改动**不在上游**，升级插件会被覆盖，
所以把打好的文件存在这里；升级后照下面覆盖回去再重启即可。

| 文件 | 对应上游路径 | 改了什么 |
|---|---|---|
| `onebot-outbound.js` | `lib/outbound.js` | **分句不再断在引号里**（`splitSentences` 改成逐字扫描 + 括号栈，右引号开头的碎片贴回上一段） |
| `onebot-registry.js` | `lib/registry.js` | **不许自动开新会话**（只有用户发 `/new` 才允许新 id；黑名单就地解禁；resume 失败重试而不是退役换新） |
| `onebot-split-test.mjs` | 只用于验证 | 5 组用例，跑 `node onebot-split-test.mjs` 检查分句 |

## 怎么用

```bash
# 1. 找到实际安装路径（两套 profile 都指向同一个 patched 目录时只改一处）
ls -l ~/.dsh/profiles/web/node_modules/dsh-onebot-qq
ls -l ~/dsh2/profiles/qq2/node_modules/dsh-onebot-qq

# 2. 备份后覆盖
cp ~/.dsh/profiles/web/node_modules/dsh-onebot-qq/lib/outbound.js{,.bak}
cp ~/.dsh/profiles/web/node_modules/dsh-onebot-qq/lib/registry.js{,.bak}
cp onebot-outbound.js ~/.dsh/profiles/web/node_modules/dsh-onebot-qq/lib/outbound.js
cp onebot-registry.js ~/.dsh/profiles/web/node_modules/dsh-onebot-qq/lib/registry.js

# 3. 语法检查 + 重启
node --check ~/.dsh/profiles/web/node_modules/dsh-onebot-qq/lib/registry.js
systemctl restart dsh-web dsh-web2
```

> 分句补丁里的 `export { splitSentences }` 只是为了让 `onebot-split-test.mjs` 能 import，
> 运行时无副作用；上游升级后如果这个 export 冲突，删掉那行即可。

## 两个补丁各自防的是什么

**分句**：上游按 `。！？` 一刀切，`弹幕还在问「不是单身安澜？」` 会被切成两条，
第二条只剩一个 `」` —— QQ 里就是"断句断在引号中间"。

**会话**：上游在三处会自己换新 session id（黑名单、resume 失败、create 冲突），
结果 QQ 私聊隔几天就多一个"未命名"窗口。现在只有 `resetChat()`（用户 `/new`）
会给 `freshRequested` 打标记，其他路径一律沿用同一个 id。
