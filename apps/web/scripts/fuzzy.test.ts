import { fuzzyMatch, highlightSegments } from '../src/utils/fuzzy.js';

const NAMES = [
  'Climbing Up Wall.fbx',
  'Dodging Right.fbx',
  'Standard Walk.fbx',
  'Walking Turn 180.fbx',
  'Unarmed Run Forward.fbx',
  'Fast Run.fbx',
  'Jumping.fbx',
  'Male Sitting Pose.fbx',
  'Laying Nodding.fbx',
  'Great Sword Idle.fbx',
];

let failures = 0;

function rank(query: string): { name: string; score: number }[] {
  return NAMES.map((name) => ({ name, result: fuzzyMatch(name, query) }))
    .filter((item) => item.result)
    .map((item) => ({ name: item.name, score: Math.round(item.result!.score) }))
    .sort((a, b) => b.score - a.score);
}

/** 期望目标出现在前 topN 名（模糊搜索里多个同样合理的命中可接受） */
function expectTop(query: string, expected: string, label: string, topN = 1): void {
  const ranked = rank(query);
  const names = ranked.slice(0, topN).map((item) => item.name);
  const ok = names.includes(expected);
  if (!ok) failures += 1;
  const shown = ranked.slice(0, 3).map((item) => `${item.name}(${item.score})`).join('  ');
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${query}" -> ${shown}${ok ? '' : `   期望前${topN}含 ${expected}`}   [${label}]`);
}

function expectMiss(query: string, label: string): void {
  const hits = rank(query);
  const ok = hits.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${query}" 应无结果，实际 ${hits.length} 个   [${label}]`);
}

console.log('=== 精确 / 子串 ===');
expectTop('Standard Walk', 'Standard Walk.fbx', '完整名称');
expectTop('walk', 'Standard Walk.fbx', '两个 walk 动画都命中，允许并列', 2);
expectTop('walk', 'Walking Turn 180.fbx', '同上', 2);
expectTop('run', 'Fast Run.fbx', 'run 的两个命中都在前列', 2);
expectTop('run', 'Unarmed Run Forward.fbx', '同上', 2);

console.log('\n=== 缩写 / 跳字符（模糊）===');
expectTop('cuw', 'Climbing Up Wall.fbx', '首字母缩写');
expectTop('climbwall', 'Climbing Up Wall.fbx', '跨词跳字符');
expectTop('wlktrn', 'Walking Turn 180.fbx', '缩写带跳字符');
expectTop('stdwalk', 'Standard Walk.fbx', '缩写+连续');
expectTop('gsi', 'Great Sword Idle.fbx', '三词首字母');
expectTop('dgr', 'Dodging Right.fbx', '两词首字母');
expectTop('msp', 'Male Sitting Pose.fbx', '三词首字母');

console.log('\n=== 多关键词（空格分隔，需全部命中）===');
expectTop('unarmed forward', 'Unarmed Run Forward.fbx', '两词都在同一名称里');
expectTop('turn 180', 'Walking Turn 180.fbx', '含数字');
expectTop('fast run', 'Fast Run.fbx', '两词相邻');

console.log('\n=== 不命中 ===');
expectMiss('zzzz', '无匹配字符');
expectMiss('nope nope', '多词均不命中');

console.log('\n=== 前缀优先于同名散落匹配 ===');
const ranked = rank('jump');
console.log('  "jump" ->', ranked.map((item) => item.name).join('  '));
if (ranked[0]?.name !== 'Jumping.fbx') {
  failures += 1;
  console.log('FAIL  前缀命中应排第一');
} else {
  console.log('PASS  Jumping.fbx 排第一');
}

console.log('\n=== 高亮片段 ===');
for (const [text, query] of [
  ['Standard Walk.fbx', 'swalk'],
  ['Climbing Up Wall.fbx', 'cuw'],
]) {
  const result = fuzzyMatch(text, query)!;
  const segments = highlightSegments(text, result.indices);
  console.log(`  "${query}" -> ${segments.map((s) => (s.hit ? `[${s.text}]` : s.text)).join('')}`);
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
