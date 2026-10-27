/**
 * 拼接（Strips）工作区的纯数据类型与最小工具函数。
 *
 * 模块定位：
 *  - 只放「数据结构 + 无副作用的小函数」，不依赖 Three.js / Vue / 网络，
 *    这样 store（状态）、StripsPlayer（渲染）与组件层可以共享同一套类型而不产生循环依赖。
 *  - 一个「拼接动画」= 1 个基础模型（T 字骨架） + N 条 Strip；每条 Strip 是某个源动画
 *    在时间轴上的一段，并声明它占用哪些身体部位。
 *
 * 数据流（简述）：
 *  StripDef[]（store 里的 strips） → StripsPlayer.setStrips → StripBlend.applyStrips 逐帧混合
 *  → 逐帧采样后由 bakeStrips 写成 AnimationData（落库） + AnimationClip（预览）。
 *  同时 store 会把 StripDef[] 打包成 StripsComposition 一起保存，供之后再次打开编辑。
 */
import type { SegmentSource } from '@/viewer/stage/StageTypes';

/** Strip 的动画来源与舞台片段共用同一套描述 */
export type StripSource = SegmentSource;

/**
 * 身体部位：拼接区固定 5 个互不重叠的部位槽位。
 *
 * 每个部位同一时刻只能由一个源动画占用（跨源动画冲突校验的依据），
 * 也正因为只有 5 个部位，一个拼接最多只能来自 5 个源动画。
 *
 * 这 5 个部位在骨骼层面的映射见 StripParts.partOfBone；在顶点层面通过
 * 「顶点权重最大的那根骨骼」反查部位，从而给蒙皮网格染色。
 */
export type BodyPart = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'legs';

/**
 * 部位的权威顺序（顺序即 UI 中的展示顺序 / 时间轴 lane 顺序）。
 * 所有「按部位排序、取第一个空闲部位」的逻辑都以本数组为准，不要另建字面量数组。
 */
export const BODY_PART_IDS: BodyPart[] = ['head', 'torso', 'leftArm', 'rightArm', 'legs'];

/**
 * 一条 Strip = 一个源动画在时间轴上的一段，可同时占用多个部位。
 *
 * 时间语义：
 *  - `start` / `duration` 是「时间轴坐标系」的秒数（时间轴总长见 StripsComposition.duration）；
 *  - `trimStart` 是「源片段坐标系」的裁剪起点秒数；
 *  - 实际取源片段的时刻由 stripClipTime() 计算：trimStart + (time - start)，并夹在源片段时长内。
 */
export interface StripDef {
  /** 稳定唯一 id，形如 strip-<时间戳 base36>-<随机 5 位>；前端本地生成，服务端不解析 */
  id: string;
  /** 展示名，默认取来源名称（sourceLabel），用户可在检查器里改 */
  name: string;
  source: StripSource;
  /** 该源动画占用的身体部位（同一动画可多选；跨 Strip 不允许重复，store 层校验） */
  parts: BodyPart[];
  /** 时间轴起点（秒），>= 0 */
  start: number;
  /** 片段内裁剪起点（秒），>= 0；不改变 duration，只改变取帧的偏移 */
  trimStart: number;
  /** 时间轴上的时长（秒），限制在 [MIN_STRIP_DURATION, MAX_STRIP_DURATION]，见 stores/strips.ts */
  duration: number;
  /** 混合权重 0–1；多条叠加时总和超过 1 会自动归一，不足 1 的剩余部分留给静置姿态 */
  weight: number;
  /** 静音：既不参与混合，也不会被染色（外观回到「未添加」的半透明态） */
  muted: boolean;
  /** 标识色（#rrggbb）；身体部位染色与时间轴共用。缺省时由 resolveSegmentColor(索引) 生成 */
  color?: string;
}

/**
 * 存进新建动画项目的拼接编排（用于之后反复打开修改）。
 *
 * 这份快照与烘焙出的 AnimationData 一起保存：
 *  - data 负责「播放 / 导出」，是不可逆的逐帧结果；
 *  - composition 负责「再次编辑」，保留轨道、部位、裁剪等原始参数。
 * 因此修改生成算法后，旧项目的 composition 仍可无损还原。
 */
export interface StripsComposition {
  /** 协议版本，目前固定为 1；后端 normalizeComposition 会在缺失时补齐 */
  version: 1;
  /** 基础模型（T 字 FBX）的存储路径；重新打开时需要先加载它 */
  basePath: string;
  /** 基础模型展示名（仅用于 UI / 元信息，加载以 basePath 为准） */
  baseName: string;
  /** 轨道列表，最多 5 条（受 5 个身体部位约束） */
  tracks: StripDef[];
  /** 时间轴默认总时长（取源动画里最长的一段；保存时用于还原标尺） */
  duration: number;
  /** 上次保存时使用的名称，供再次打开时回填输入框 */
  savedName: string;
}

/** Strip 在时间轴上的结束时刻（秒），即 start + duration */
export function stripEnd(strip: StripDef): number {
  return strip.start + strip.duration;
}

/**
 * 计算某条 Strip 在时间轴时刻 time 应取源片段的哪一帧（秒）。
 *
 * @param strip 轨道定义；其 trimStart / start / duration 见上方字段注释
 * @param time  时间轴时刻（秒），可以小于 start（会得到 trimStart 之前的负值并被夹到 0）
 * @param clipDuration 源片段的真实时长（秒）；当来源尚未加载完成时调用方不应传 0 以外的猜测值
 * @returns 源片段内的取帧时刻，范围 [0, clipDuration - 1e-4]。
 *         上界保留 1e-4 的余量，避免恰好取到片段末尾时 Three.js 回绕到第一帧造成闪烁。
 */
export function stripClipTime(strip: StripDef, time: number, clipDuration: number): number {
  const local = strip.trimStart + (time - strip.start);
  const max = Math.max(0, clipDuration - 1e-4);
  return Math.min(Math.max(local, 0), max);
}

/**
 * 生成 Strip 的本地唯一 id。
 * 使用「时间戳 + 随机串」而非自增序号：多条轨道可能在不同时间、不同会话里创建，
 * 自增序号在重新打开旧编排时容易与新轨道冲突。
 */
export function createStripId(): string {
  return `strip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
