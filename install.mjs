#!/usr/bin/env node
/**
 * 把本仓库装进一个 DSH profile（跨平台）。
 *
 *   node install.mjs [--profile web] [--dsh-home ~/.dsh] [--check]
 *
 * 两条路，优先走第一条：
 *   1. `dsh plugin --profile <p> add file:<本目录>` —— 官方入口，会写进 profile 的
 *      dependencies，插件页有行、有启停开关；
 *   2. 兜底：把运行时文件拷进 profile/node_modules/dsh-remembers，并在
 *      profile/package.json 里登记 `file:` 依赖 + bundles 条目。
 *
 * 只装插件，不碰 Python 服务：服务由 install.sh / install.ps1 负责。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT = path.dirname(fileURLToPath(import.meta.url));
const NAME = "dsh-remembers";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const profile = arg("--profile", process.env.DSH_PROFILE || "web");
const dshHome = arg("--dsh-home", process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
const profileDir = path.join(dshHome, "profiles", profile);
const checkOnly = process.argv.includes("--check");

const say = (m) => console.log(`[install] ${m}`);
const warn = (m) => console.log(`[warn] ${m}`);
const die = (m) => {
  console.error(`[error] ${m}`);
  process.exit(1);
};

// ---------------------------------------------------------------- 环境校验
say(`插件目录: ${KIT}`);
say(`profile:   ${profileDir}`);

for (const f of ["index.mjs", "client.js", "cordis.patch.yml", "package.json"]) {
  if (!fs.existsSync(path.join(KIT, f))) die(`仓库不完整，缺 ${f}`);
}
if (!fs.existsSync(profileDir)) {
  die(
    `找不到 profile 目录: ${profileDir}\n` +
      `  先跑一次 dsh --profile ${profile} 让它初始化；或者用 --profile 指定已存在的 profile。`,
  );
}

const pkg = JSON.parse(fs.readFileSync(path.join(KIT, "package.json"), "utf8"));
say(`版本:      ${pkg.version}`);

if (checkOnly) process.exit(0);

// ---------------------------------------------------------------- 首选：dsh plugin add
function tryOfficialAdd() {
  const cmd = `dsh plugin --profile ${profile} add "file:${KIT}"`;
  try {
    say(`尝试官方安装：${cmd}`);
    execSync(`dsh --version`, { stdio: "pipe" });
  } catch {
    warn("PATH 里没有 dsh 命令，走手工登记");
    return false;
  }
  try {
    execSync(cmd, { stdio: "inherit" });
    const dest = path.join(profileDir, "node_modules", NAME);
    if (!fs.existsSync(dest)) {
      warn("dsh plugin add 返回成功，但 node_modules 里没有这个包 —— 继续用兜底方式");
      return false;
    }
    say(`已通过 dsh plugin add 装好: ${dest}`);
    return true;
  } catch (error) {
    warn(`dsh plugin add 失败: ${error.message.split("\n")[0]}`);
    return false;
  }
}

// ---------------------------------------------------------------- 兜底：拷贝 + 登记
const SKIP_DIRS = new Set(["node_modules", ".git", "data", "__pycache__", ".venv", ".venv-win", "tests", "ops"]);
const SKIP_FILES = new Set([".env", ".env.win", "seeds.imported"]);

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(path.join(src, entry.name), path.join(dest, entry.name));
    } else if (!SKIP_FILES.has(entry.name)) {
      fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
    }
  }
}

function manualInstall() {
  const dest = path.join(profileDir, "node_modules", NAME);
  say(`拷贝运行时文件 → ${dest}`);
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(KIT, dest);

  const pkgPath = path.join(profileDir, "package.json");
  const raw = fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, "");
  const profilePkg = JSON.parse(raw);
  profilePkg.dependencies = profilePkg.dependencies || {};
  // file: 用正斜杠：Windows 的反斜杠在 package.json 里会被当成转义。
  profilePkg.dependencies[NAME] = `file:${KIT.replace(/\\/g, "/")}`;
  profilePkg.dsh = profilePkg.dsh || {};
  profilePkg.dsh.profile = profilePkg.dsh.profile || {};
  const bundles = Array.isArray(profilePkg.dsh.profile.bundles) ? profilePkg.dsh.profile.bundles : [];
  if (!bundles.includes(NAME)) bundles.push(NAME);
  profilePkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(pkgPath, JSON.stringify(profilePkg, null, 2) + "\n");
  say(`已登记到 ${pkgPath}（dependencies + dsh.profile.bundles）`);
  return dest;
}

if (!tryOfficialAdd()) manualInstall();

console.log(`
装好了。插件本身已登记到 profile「${profile}」。

还要做的：
  1. 起记忆服务：  bash install.sh --no-plugin        （Linux）
                   powershell -File install.ps1 -NoPlugin   （Windows）
     或者手动：     cd service && python server.py
  2. 在服务设置页填 LLM key（或 service/.env 里写 CMEM_LLM_KEY）
  3. 重启 DSH，左边栏「插件」下面会出现「她的记忆」
`);
