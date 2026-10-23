"""解析器单元验证：用真实踩到的 LLM 输出形态。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from llm import _extract_json  # noqa: E402

cases = [
    ("JSON + 解释 + 重复围栏块",
     '[{"fact_index":0,"op":"ADD"}]\n\n```json\n[{"fact_index":0,"op":"ADD"}]\n```', "list"),
    ("JSON + 中间插话 + 围栏",
     '[{"op":"ADD"}]\n\nWait — target_id should be null.```json\n[{"op":"ADD"}]\n', "list"),
    ("纯 JSON + 后面跟说明",
     '[{"op":"NONE"}]\n\n**说明**：两条已有记忆无关。', "list"),
    ("只有围栏",
     '```json\n[{"op":"UPDATE","target_id":3}]\n```', "list"),
    ("对象而不是数组",
     '{"op":"DELETE","target_id":7}', "dict"),
    ("完全不是 JSON",
     "抱歉，我无法处理这个请求。", None),
]

passed_count = 0
for name, raw, expect in cases:
    got = _extract_json(raw)
    kind = type(got).__name__ if got is not None else None
    ok = (kind == expect) if expect else (got is None)
    passed_count += ok
    print(f"  {'✓' if ok else '✗'} {name:<24} → {kind}")

print(f"\n  {passed_count}/{len(cases)} 通过")
assert passed_count == len(cases), "解析器还有问题"
print("  ✅ 真实踩到的所有形态都能解析")
