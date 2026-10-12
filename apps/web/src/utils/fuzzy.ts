/**
 * 轻量模糊匹配：用于动画列表搜索。
 *
 * 支持三种输入：
 *   - 连续子串：`walk` 直接命中 `Standard Walk.fbx`（得分最高）
 *   - 缩写 / 跳字符：`cuw` 命中 `Climbing Up Wall.fbx`（按顺序取字符）
 *   - 多关键词：`mixamo walk` 会分别匹配文件夹标签与文件名，空格分隔，全部命中才算匹配
 *
 * 打分考虑：是否连续、是否落在词首/驼峰边界、匹配位置是否靠前、是否命中更短的名称。
 */

const SEPARATORS = new Set([' ', '_', '-', '.', '/', '\\', '(', ')', '[', ']', ':', ',', '+', '#', '@']);

export interface FuzzyMatch {
  /** 越大越相关 */
  score: number;
  /** 命中的字符下标（升序），用于高亮 */
  indices: number[];
}

/** 单个关键词匹配一个字符串 */
export function matchToken(text: string, rawToken: string): FuzzyMatch | null {
  const token = rawToken.toLowerCase();
  if (!token) return { score: 0, indices: [] };
  const lower = text.toLowerCase();

  // 1) 连续子串：优先级最高
  const direct = lower.indexOf(token);
  if (direct >= 0) {
    let score = 1000 - direct * 2;
    if (isBoundary(text, direct)) score += 120;
    // 命中位置越靠前、名称越短越好
    score -= Math.min(text.length, 60);
    return { score, indices: range(direct, token.length) };
  }

  // 2) 子序列：按下标顺序逐字命中
  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let lastIndex = -2;
  let firstIndex = -1;

  for (let index = 0; index < lower.length && cursor < token.length; index += 1) {
    if (lower[index] !== token[cursor]) continue;
    if (firstIndex < 0) firstIndex = index;
    if (index === lastIndex + 1) {
      score += 18; // 连续命中
    } else {
      const gap = index - lastIndex - 1;
      score += 2 - Math.min(gap, 6); // 跳得越远扣得越多
    }
    if (isBoundary(text, index)) score += 12;
    indices.push(index);
    lastIndex = index;
    cursor += 1;
  }

  if (cursor < token.length) return null;

  score -= Math.min(firstIndex, 30); // 起始位置越靠前越好
  score -= Math.min(text.length, 60);
  return { score, indices };
}

/** 多关键词匹配；返回合并后的命中下标 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, indices: [] };

  let score = 0;
  const hits = new Set<number>();
  for (const token of tokens) {
    const result = matchToken(text, token);
    if (!result) return null;
    score += result.score;
    for (const index of result.indices) hits.add(index);
  }
  return { score, indices: [...hits].sort((a, b) => a - b) };
}

/** 把文本按命中位置切成片段，供界面高亮 */
export function highlightSegments(text: string, indices: readonly number[]): { text: string; hit: boolean }[] {
  if (indices.length === 0) return [{ text, hit: false }];
  const set = new Set(indices);
  const segments: { text: string; hit: boolean }[] = [];
  let buffer = '';
  let bufferHit = set.has(0);

  for (let index = 0; index < text.length; index += 1) {
    const hit = set.has(index);
    if (hit !== bufferHit && buffer.length > 0) {
      segments.push({ text: buffer, hit: bufferHit });
      buffer = '';
    }
    bufferHit = hit;
    buffer += text[index];
  }
  if (buffer.length > 0) segments.push({ text: buffer, hit: bufferHit });
  return segments;
}

function isBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = text[index - 1]!;
  if (SEPARATORS.has(prev)) return true;
  const current = text[index]!;
  // 驼峰边界：aB
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(current);
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}
