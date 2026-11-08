# dsh-remembers

> **She remembers. When she can't, she says so.**

A persona + long-term-memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built for companion-style chat rather than coding assistance.

```
you: hey
her: [remembers that 2am call three months ago] … still thinking about that night.
```

Not "retrieved a relevant document" — "she remembers what you told her".

- **DSH plugin (Node)**: persona section on every turn, relevance-based memory recall, 21 tools, a "Her memory" sidebar entry with 9 panels.
- **Memory service (Python + SQLite, separate process)**: layered memory, LLM extraction, hybrid BM25 + vector retrieval, built-in scheduler.

## Features

Layered memory (L0 raw → L1 facts → L2 profile → L3 episodes → L4 milestones) · persona injection · speak-like-a-human corpus (1020 seeded lines + learned phrases, accent profile rebuilt every 3 days) · memes · proactive wake-ups · Tieba reading/replying · Bilibili browsing · QQ bridge · model settings with 12 providers · rule-based tone clean-up.

Feature-by-feature docs (with per-feature file trees): [`docs/features/`](docs/features/).

## Requirements

Node.js ≥ 22.19 · Python ≥ 3.10 · DSH 0.2.x

## Install

```powershell
# Windows
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers
.\install.ps1 -Profile desktop
```

```bash
# Linux / VPS
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers
bash install.sh
sudo bash service/deploy/deploy-native.sh   # optional: systemd
```

Then put an LLM key in `service/.env` (`CMEM_LLM_KEY=...`) or in **Her memory → Memory service** after restarting DSH.

Full guides: [Windows](docs/deploy/windows.md) · [Linux/VPS](docs/deploy/linux.md) · [Docker](docs/deploy/docker.md)

## What works out of the box

Memory, persona, the phrase corpus, memes and settings work after install + an LLM key.
Proactive messages need a QQ bridge; Tieba needs a Cookie; Bilibili needs an external `bili-cli` and two hard-coded paths edited (see [compatibility](docs/compatibility.md)).

## Docs

[Architecture](docs/architecture.md) · [Compatibility](docs/compatibility.md) · [Audit (2026-11)](docs/audit.md) · [Tests](tests/README.md)

## Tests

```bash
bash run_all_tests.sh    # or .\run_all_tests.ps1
```

8 suites: 5 Python (retrieval, gating, transfer, parsing, thresholds) + 3 Node (host registration, 9 UI panels, tone rules).

## License

MIT. Seeded corpus from [dsh-fish-tone-flavor](https://github.com/MX3a48c5/dsh-fish-tone) (MIT); Tieba CLI based on [dsh-tieba-dive](https://github.com/Topkill/tiebaskill) (see `tools/tieba/LICENSE-tieba-dive`).
