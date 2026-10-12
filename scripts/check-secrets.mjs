#!/usr/bin/env node
/**
 * 敏感信息自查：确认仓库里**会被提交的内容**不含后端运行数据与密钥。
 *
 *   npm run check:secrets
 *
 * 与 .githooks/pre-commit 互补：
 *   - 钩子只看本次暂存的内容（提交瞬间拦截）
 *   - 这个脚本按 .gitignore 过滤整个工作区（提交前 / CI 整体核对）
 *
 * 语义：本地必需的 .env、data/ 只要被正确忽略就不算问题；
 * 一旦有人把它们从 .gitignore 里删掉，这里会立刻报错。
 * 不依赖第三方库，也不调用子进程（避免受限环境下的管道限制）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 允许入库的模板文件 */
const ALLOWED = new Set(['.env.example']);

/** 真实密钥形如 sk-<48 位>；占位符 sk-xxxxxxxxxxxxxxxx 只有 16 位，不会误报 */
const SECRET_PATTERNS = [
  { name: 'Hunyuan/OpenAI 风格 API Key', re: /sk-[A-Za-z0-9]{24,}/ },
  { name: '腾讯云 SecretId', re: /AKID[A-Za-z0-9]{20,}/ },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const TEXT_EXT = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.vue', '.json', '.md', '.txt',
  '.yml', '.yaml', '.html', '.css', '.sh', '.gitignore', '.gitattributes', '',
]);

// ===== 极简 .gitignore 匹配（只支持本仓库用到的语法）=====

function globToRegex(glob) {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const ch = glob[index];
    if (ch === '*') {
      if (glob[index + 1] === '*') {
        out += '.*';
        index += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

function makeMatcher(pattern) {
  const clean = pattern.replace(/\/+$/, '');
  if (!clean) return null;
  const anchored = clean.includes('/');
  const body = globToRegex(clean);
  // 有 / 的模式从仓库根匹配，其余匹配任意层级的同名项；末尾允许继续跟子路径
  const source = anchored ? `^${body}(/.*)?$` : `(^|/)${body}(/.*)?$`;
  return new RegExp(source);
}

async function loadIgnoreMatchers() {
  const raw = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8').catch(() => '');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(makeMatcher)
    .filter(Boolean);
}

// ===== 扫描 =====

const matchers = await loadIgnoreMatchers();
const ignored = [];   // 命中忽略规则的敏感文件（正常）
const leaks = [];     // 会被提交的敏感内容（错误）
let scannedFiles = 0;

function relativeOf(full) {
  return path.relative(repoRoot, full).split(path.sep).join('/');
}

function isIgnored(rel) {
  return matchers.some((re) => re.test(rel));
}

function mask(value) {
  return value.length <= 14 ? `${value.slice(0, 4)}****` : `${value.slice(0, 6)}****${value.slice(-4)}`;
}

function isSensitivePath(name, rel) {
  if (ALLOWED.has(name)) return null;
  if (name === '.env' || name.startsWith('.env.')) return '环境变量文件（可能含真实密钥）';
  if (rel.startsWith('data/') || rel.includes('/data/')) return '运行期数据目录（任务/素材/上传输入）';
  if (/\.(pem|key|p12|pfx)$/i.test(name)) return '证书或私钥文件';
  return null;
}

async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = relativeOf(full);
    if (entry.name === '.git') continue;

    if (entry.isDirectory()) {
      if (isIgnored(`${rel}/`) || isIgnored(rel)) {
        ignored.push({ rel: `${rel}/`, detail: '目录已被 .gitignore 忽略' });
        continue;
      }
      await walk(full);
      continue;
    }
    if (!entry.isFile()) continue;

    const sensitive = isSensitivePath(entry.name, rel);
    if (sensitive) {
      (isIgnored(rel) ? ignored : leaks).push({ rel, detail: sensitive });
      continue;
    }

    if (isIgnored(rel)) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > 4 * 1024 * 1024) continue;

    scannedFiles += 1;
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    for (const { name, re } of SECRET_PATTERNS) {
      const match = re.exec(text);
      if (match) leaks.push({ rel, detail: `${name}（已打码：${mask(match[0])}）` });
    }
  }
}

await walk(repoRoot);

console.log(`已扫描 ${scannedFiles} 个会被提交的文本文件`);
if (ignored.length > 0) {
  console.log(`\n以下敏感路径已被 .gitignore 忽略，不会入库（正常）：`);
  const seen = new Set();
  for (const item of ignored) {
    if (seen.has(item.rel)) continue;
    seen.add(item.rel);
    console.log(`  ✓ ${item.rel}  ::  ${item.detail}`);
  }
}

if (leaks.length === 0) {
  console.log('\n✅ 会被提交的内容里未发现后端运行数据或密钥');
  process.exit(0);
}

console.log(`\n❌ 发现 ${leaks.length} 处会被提交的敏感内容：`);
for (const item of leaks) console.log(`  - ${item.rel}  ::  ${item.detail}`);
process.exit(1);
