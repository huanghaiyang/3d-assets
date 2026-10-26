# 拼接工作区（Strips）设计

## 背景

动画工作区负责单条动画的编辑，舞台工作区负责把多条动画按时间顺次编排。两者都无法表达
「上半身做 A、下半身做 B，再叠一层头部动作」这类**按身体部位分层混合**的需求。

新增第 4 个工作区「拼接」，用 Strips 时间轴表达：

> 每个 Strip = 一段动画来源 + 一个身体部位掩码 + 一个时间范围 + 一个混合权重，
> 多个 Strip 在时间轴上互相叠加，逐骨骼按权重混合，最终烘焙（bake）成一段新的动画数据。

烘焙结果复用「新建动画」的持久化通道（`PUT /api/anim/projects/:id`），
因此生成的新动画会直接出现在动画工作区的「新建动画」列表里。

## 范围

- 基础模型：从动画库（Mixamo FBX）里选一个作为骨架与蒙皮载体；切换模型会清空烘焙结果。
- 动画来源：FBX 内嵌片段 / 已保存的「新建动画」项目 / Kimodo 生成动作，统一转换成 `THREE.AnimationClip`
  并重绑定到基础模型的骨骼名。
- 身体部位：`full / upper / lower / head / leftArm / rightArm / leftLeg / rightLeg`。
- 时间轴：每个 Strip 一行，可拖动整体（改 `start`）、拖左右边缘（改 `start` + `trimStart` / `duration`）。
- 混合：逐骨骼四元数按权重 slerp，髋部位置按权重加权平均；未被任何 Strip 覆盖的骨骼保持静置姿态。
- 烘焙：以 30fps 逐帧求值，导出 `fbx-animation-data`（joints + tracks），并立即用同一份数据
  反向还原成 `AnimationClip` 做「烘焙预览」，保证保存结果与预览一致。
- 保存：作为新的「新建动画」项目保存，`basePath` 指向当前基础模型。

不在本次范围：Strips 编排本身的持久化（刷新后清空）、跨模型骨架重定向、独立导出 FBX 文件。

## 数据模型

```ts
type BodyPart = 'full' | 'upper' | 'lower' | 'head'
  | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

interface StripDef {
  id: string;
  name: string;
  source: SegmentSource;   // fbx-clip | kimodo | anim-project（与舞台共用）
  part: BodyPart;
  start: number;           // 时间轴起点（秒）
  trimStart: number;       // 片段内裁剪起点（秒）
  duration: number;        // 时间轴上的时长（秒）
  weight: number;          // 0–1
  muted: boolean;
  color?: string;
}
```

## 身体部位掩码

按 `cleanBoneLabel(bone.name)`（去掉 `mixamorig` 前缀）分组：

| 分组 | 骨骼 |
| --- | --- |
| hips | `Hips` |
| spine | `Spine` / `Spine1` / `Spine2` … |
| head | `Neck` / `Head` / `HeadTop_End` / `Eye` / `Jaw` |
| leftArm | `LeftShoulder` / `LeftArm` / `LeftForeArm` / `LeftHand` / 左手各指 |
| rightArm | 同上右侧 |
| leftLeg | `LeftUpLeg` / `LeftLeg` / `LeftFoot` / `LeftToeBase` |
| rightLeg | 同上右侧 |

掩码覆盖关系：

- `full`：全部骨骼（含髋部）
- `upper`：spine + head + 双臂（不含髋部）
- `lower`：hips + 双腿
- `head`：neck/head
- `leftArm` / `rightArm` / `leftLeg` / `rightLeg`：对应单肢

## 混合算法

对任意时刻 `t`，先筛出「未静音、权重 > 0、`start ≤ t < start + duration`」的 Strip，
每条 Strip 用独立骨架克隆 + 独立 `AnimationMixer` 求值到 `trimStart + (t - start)`。

然后逐骨骼计算：

1. 取覆盖该骨骼的候选 Strip 权重 `w_i`，总权重 `Total = Σ w_i`。
2. 归一化：`scale = Total > 1 ? 1 / Total : 1`；剩余权重 `restW = max(0, 1 - Total)` 留给静置姿态。
3. 四元数：从静置姿态开始，按 `w_i * scale` 依次做增量 slerp。
4. 位置：仅髋部参与，按 `restW` 与各候选权重加权平均；其它骨骼固定写静置位置（避免不同模型骨架长度差拉扯）。
5. 缩放：始终使用静置缩放。

权重语义：单条 Strip 权重 0.5 → 结果介于静置与动画之间；多条权重和超过 1 → 自动按比例归一。

## 烘焙输出

`bakeStrips` 以 `fps = 30` 逐帧写入目标骨架，再读回骨骼局部变换，生成：

- `skeleton.joints[]`：全部骨骼（`name` / `label` / `parent` / `depth` / `rest`）。
- `clips[0].tracks[]`：
  - 每根被 Strip 覆盖的骨骼一条 `quaternion` 轨（`times` / `values` 必填）；
  - 髋部一条 `position` 轨。
- `timeline`：`clipCount = 1`、`fps = 30`、`interval = 1/30`。

`AnimationData` 经 `clipsFromAnimationData(data, boneNameMap)` 还原成 `AnimationClip` 用于预览，
与舞台/新建动画走同一条转换路径，避免两套实现漂移。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `apps/web/src/viewer/strips/StripTypes.ts` | Strip / BodyPart 类型与工具 |
| `apps/web/src/viewer/strips/StripParts.ts` | 骨骼 → 身体部位分类、掩码覆盖判断 |
| `apps/web/src/viewer/strips/StripBlend.ts` | 逐骨骼权重混合、烘焙为 `AnimationData` |
| `apps/web/src/viewer/strips/StripsPlayer.ts` | 基础模型加载、来源片段转换、实时混合预览、烘焙预览、播放控制 |
| `apps/web/src/stores/strips.ts` | 素材目录、Strip CRUD、时间/播放状态、烘焙、保存为新动画 |
| `apps/web/src/components/strips/StripsPage.vue` | 页面骨架（左来源库 / 中视口与时间轴 / 右检查器） |
| `apps/web/src/components/strips/StripsViewport.vue` | three.js 视口与播放条 |
| `apps/web/src/components/strips/StripTimeline.vue` | 多行 Strips 时间轴（拖动 / 裁剪 / 定位） |
| `apps/web/src/components/strips/StripInspector.vue` | 选中 Strip 属性、烘焙与保存面板 |
| `apps/web/src/App.vue` / `TopBar.vue` | 第 4 个页签「拼接」 |

复用：`viewer/stage/FbxActor.ts`（加载 / 归一化 / 骨骼收集）、`clipFromAnimationData.ts`（JSON → Clip）、
`api/animation.ts`（封面 / 项目读写）、`api/kimodo.ts`（动作导入）。

## 验证

1. `npx vue-tsc --noEmit`（apps/web）。
2. 选基础模型 → 添加「上半身」Strip 与「下半身」Strip，两者时间重叠 → 视口应同时表现两段动作。
3. 调整权重 / 时间范围，视口实时变化。
4. 点「烘焙」→ 自动切到烘焙预览，动作与实时混合一致。
5. 保存为新动画 → 动画工作区「新建动画」列表出现该条目，可正常播放。
