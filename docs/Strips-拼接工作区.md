# 拼接工作区（Strips）设计

## 背景

动画工作区负责单条动画的编辑，舞台工作区负责把多条动画按时间顺次编排。两者都无法表达
「上半身做 A、下半身做 B，再叠一层头部动作」这类**按身体部位分层混合**的需求。

第 4 个工作区「拼接」用 Strips 时间轴表达：

> 每个 Strip = 一段动画来源 + 一组身体部位 + 一个时间范围 + 一个混合权重，
> 多个 Strip 在时间轴上互相叠加，逐骨骼按权重混合，最终烘焙成一段新的动画数据。

## 范围（v2）

- 基础模型：从动画库（Mixamo FBX）里选一个作为骨架与蒙皮载体；默认以 0.5 透明度显示。
- 动画来源：FBX 内嵌片段 / 已保存的动画项目 / Kimodo 生成动作；每个来源行右侧有「+」。
- 身体部位：固定 5 个互不重叠部位 `head / torso / leftArm / rightArm / legs`。
  - **同一部位最多被一个源动画占用**，跨动画重复占用会被拦下并提示「部位冲突」。
  - 同一条 Strip 可以**多选**部位。
  - 最多 5 个源动画（= 5 个部位）；达到上限后再加会提示。
- 视觉反馈：
  - 已添加部位不透明（alpha = 1）且染成该 Strip 的颜色；未添加部位保持 0.5 半透明。
  - 悬停 / 选中部位时对应模型区域外发光（`aGlow` + `onBeforeCompile` 注入自发光）。
  - 视口按钮栏提供「仅显示已添加部位」与「显示骨骼」开关。
  - 地面绘制下肢（髋部）运动轨迹。
- 时间轴：固定 5 条部位 lane，**宽度铺满整个底部工作栏**；
  总时长默认取所有源动画里最长的一段，可拖拽整体（`start`）、拖左右边缘裁剪（`start`/`trimStart`/`duration`）。
- 保存与再次编辑：烘焙结果与其编排一起保存（项目的 `composition` 字段），
  在动画工作区单独归入「拼接动画」分类；卡片上的「编辑拼接」入口可再次打开修改，保存即更新同一项目。
- 未保存提示：有未保存修改时，离开拼接工作区会确认；关闭/刷新浏览器由 `beforeunload` 兜底。

不在本次范围：跨模型骨架重定向、独立导出 FBX 文件。

## 数据模型

```ts
type BodyPart = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'legs';

interface StripDef {
  id: string;
  name: string;
  source: SegmentSource;   // fbx-clip | kimodo | anim-project（与舞台共用）
  parts: BodyPart[];       // 多选
  start: number;           // 时间轴起点（秒）
  trimStart: number;       // 片段内裁剪起点（秒）
  duration: number;        // 时间轴上的时长（秒）
  weight: number;          // 0–1
  muted: boolean;
  color?: string;          // 与时间轴 / 模型染色一致
}

interface StripsComposition {
  version: 1;
  basePath: string;
  baseName: string;
  tracks: StripDef[];
  duration: number;        // 默认总长（最长源动画）
  savedName: string;
}
```

`StripsComposition` 随项目一起存到 `PUT /api/anim/projects/:id`；
后端只要读到非空 `composition` 就派生 `kind = 'strips'`，并用 `composition.tracks.length` 给出
`stripCount`，供动画工作区分类与卡片摘要。

## 身体部位划分

按 `cleanBoneLabel(bone.name)`（去掉 `mixamorig` 前缀）分组，5 个部位互不重叠：

| 部位 | 骨骼 |
| --- | --- |
| head（头颈） | `Neck` / `Head` / `HeadTop_End` / `Eye` / `Jaw` |
| torso（躯干） | `Spine` / `Spine1` / `Spine2` / `Spine3` / `Spine4` |
| leftArm（左臂） | `LeftShoulder` / `LeftArm` / `LeftForeArm` / `LeftHand` / 左手各指 |
| rightArm（右臂） | 同上右侧 |
| legs（下肢） | `Hips` / `LeftUpLeg` / `LeftLeg` / `LeftFoot` / `LeftToeBase` / 右腿 / 右脚 |

顶点级染色：`buildPaints` 读取每个蒙皮顶点的 `skinIndex / skinWeight` 主导骨骼，
映射到部位后写入顶点色（RGBA）与 `aGlow`；材质开启 `vertexColors` + `transparent`，逐顶点控制透明度。

## 混合算法

对任意时刻 `t`，先筛出「未静音、权重 > 0、`start ≤ t < start + duration`」的 Strip，
每条 Strip 用独立骨架克隆 + 独立 `AnimationMixer` 求值到 `trimStart + (t - start)`。

然后逐骨骼计算：

1. 取覆盖该骨骼（`coversBone(strip.parts, bone)`）的候选 Strip 权重 `w_i`，总权重 `Total = Σ w_i`。
2. 归一化：`scale = Total > 1 ? 1 / Total : 1`；剩余权重 `restW = max(0, 1 - Total)` 留给静置姿态。
3. 四元数：从静置姿态开始，按 `w_i * scale` 依次做增量 slerp。
4. 位置：仅髋部参与，按 `restW` 与各候选权重加权平均；其它骨骼固定写静置位置（避免骨架长度差拉扯）。
5. 缩放：始终使用静置缩放。

权重语义：单条 Strip 权重 0.5 → 结果介于静置与动画之间；多条权重和超过 1 → 自动按比例归一。

## 时间轴

- 5 条 lane 固定对应 5 个部位；一条 Strip 会出现在它占用的所有 lane 上，颜色一致。
- 每秒像素 = `(可用宽度 - 部位标签列宽) / 总时长`，因此默认铺满底部工作栏。
- 总时长 `duration = max(span, 所有 Strip 的结束时间)`，其中 `span = max(源动画时长)`；
  头部展示「总长 = span」。
- 空 lane 显示「空闲部位 / 已叠加」，便于快速判断哪些部位还能加入新动画。

## 烘焙输出

`bakeStrips` 以 `fps = 30` 逐帧写入目标骨架，再读回骨骼局部变换，生成：

- `skeleton.joints[]`：全部骨骼（`name` / `label` / `parent` / `depth` / `rest`）。
- `clips[0].tracks[]`：被 Strip 覆盖的骨骼各一条 `quaternion` 轨；髋部另加 `position` 轨。
- `timeline`：`clipCount = 1`、`fps = 30`、`interval = 1/30`。

`AnimationData` 经 `clipsFromAnimationData(data, boneNameMap)` 还原成 `AnimationClip` 用于预览，
与舞台/新建动画走同一条转换路径。

## 保存 / 新建 / 再次编辑

- 保存名默认 `动画自由拼-年-月-日-时-分-秒`。
- 首次保存生成项目 id；之后保存复用同一 id（更新），实现多次修改。
- 「新建」清空时间轴、保留基础模型，重置项目关联与默认名。
- 动画工作区按 `kind` 分类：普通「新建动画」与「拼接动画」；拼接卡片提供「编辑拼接」入口，
  点击后 `openComposition(id)` 恢复编排（若页面尚未挂载则暂存，挂载后应用）。
- 有未保存修改（`dirty`）时：离开拼接页签弹确认框；`beforeunload` 提示浏览器关闭。

## 数据流与调用时序

### 首次进入拼接工作区

```
TopBar 点击「拼接」
  → App.vue changePage('strips')
  → StripsPage 挂载
      → StripsViewport 挂载：new StripsPlayer(container)
      → store.attachPlayer(player)            // 接线三个回调
      → store.bootstrap()
          → loadCatalog()                     // 4 个接口并行，单项失败兜底
          → selectBase(files[0].path)
              → player.loadBase(path)
                  → FbxActor 安装模型 / filterShadowBones / captureRestPose
                  → buildPaints() / buildTrajectory() / buildSkeletonLines()
              → basePath 写入 store，saveName = defaultSaveName()
```

### 添加一个来源（+ 号）

```
左栏点「+」 → store.addStrip(source)
  ├─ 校验：有基础模型 / 未超 5 条 / 来源未重复 / 有空闲部位
  ├─ 新建 StripDef（duration 先占位 1s，autoDuration 标记）
  ├─ invalidateBake() + markDirty()
  └─ player.setStrips(strips)
       ├─ signature 变化 → 逐条 loadClip(source) → bindClipToBones()
       │    → SkeletonUtils.clone(基础模型) → 独立 AnimationMixer
       ├─ 失败分支 emitClip({status:'error', message})
       └─ 成功 emitClip({status:'ready', duration})
            → store.onClipState 记录时长、写 clipDurations
            → span 变化 → watch → player.setSpan(span)  // 时间轴总长
            → autoDuration 命中 → strip.duration = 片段时长 - trimStart
```

### 编辑与烘焙保存

```
改部位 / 裁剪 / 权重 / 静音
  → updateStrip / setStripParts → invalidateBake + markDirty + player.setStrips
（signature 未变：只 refreshPaint / refreshGlow / updateTrajectory，不重建 mixer）

点「烘焙」
  → store.bake() → player.bake(30)
      → bakeStrips(entries, base.bones, rest, liveDuration, 30)
      → clipsFromAnimationData → AnimationClip
  → baked = {data, clip}；bakedMode = true；player.setBakedClip(clip)

点「保存」
  → store.saveBaked()
      → animationApi.saveProject({ id, name, data, composition: compositionSnapshot() })
      → dirty = false；loadCatalog() + useAnimationStore().loadProjects()
```

## 状态机

`dirty` / `bakedMode` 共同决定用户看到的状态与离开提示：

| 状态 | 条件 | 预览内容 | 离开提示 | 可保存 |
| --- | --- | --- | --- | --- |
| idle | 无 Strip | 半透明 T 字模型 | 否 | 否 |
| editing | 有 Strip 且 `baked == null` | 实时逐骨骼混合 | 是（dirty） | 否（需先烘焙） |
| baked | `baked != null && bakedMode` | 烘焙片段 | 是（dirty） | 是 |
| live-preview | `baked != null && !bakedMode` | 实时混合（用于对比） | 是（dirty） | 是 |
| saved | 保存成功 `dirty = false` | 保持当前预览模式 | 否 | 是（更新同 id） |

状态转移：

```
idle ──addStrip──▶ editing ──bake──▶ baked ──save──▶ saved
  ▲                  ▲                  │
  │                  └──invalidateBake──┘   （任何编辑都会让烘焙失效）
  └──────────newComposition──────────────┘
```

要点：

- `invalidateBake()` 是唯一让 `baked` 失效的入口，且只在存在烘焙结果时才动作。
- `markDirty()` 是唯一置位 `dirty` 的入口；`saveBaked` 成功是唯一清零处（`newComposition` /
  `applyComposition` 的复位也会清零）。
- `resetState()` 只清编排数据，不清基础模型与视觉开关，保证「新建」后仍能立刻添加来源。

## `composition` 协议字段

随项目保存（与烘焙后的 `data` 并列），后端读取时由 `normalizeComposition` 兜底。

| 字段 | 类型 | 必填 | 取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `version` | `number` | 否 | 目前固定 `1` | 协议版本；非数字时后端补 `1`，只做容错不做迁移 |
| `basePath` | `string` | 否 | 非空 | 基础模型存储路径；重新打开时先加载它；非字符串补空串 |
| `baseName` | `string` | 否 | — | 模型展示名，仅用于 UI 与元信息 |
| `tracks` | `StripDef[]` | 是 | 数组，前端最多写 5 条 | 轨道列表；不是数组时整份 `composition` 作废为 `null` |
| `tracks[].id` | `string` | 是 | 非空 | 本地生成，重开时沿用（用于 diff / 选中） |
| `tracks[].source` | `SegmentSource` | 是 | 三种 kind | 来源描述，与舞台片段同构 |
| `tracks[].parts` | `BodyPart[]` | 是 | 1–5 个合法 id | 多选；前端 normalizeTrack 过滤非法值，空则按索引补一个 |
| `tracks[].start` | `number` | 是 | `>= 0` | 时间轴起点（秒） |
| `tracks[].trimStart` | `number` | 是 | `>= 0` | 源片段内裁剪起点（秒） |
| `tracks[].duration` | `number` | 是 | 0.2–60 | 时间轴上的时长（秒） |
| `tracks[].weight` | `number` | 是 | 0–1 | 混合权重；总权重大于 1 时归一 |
| `tracks[].muted` | `boolean` | 是 | — | 静音后不参与混合也不染色 |
| `tracks[].color` | `string?` | 否 | `#rrggbb` | 缺省按索引从调色板取 |
| `duration` | `number` | 否 | `>= 0` | 时间轴默认总长（最长源动画）；非数字补 0 |
| `savedName` | `string` | 否 | — | 仅由前端写入、用于本地回填输入框；后端 `compositionOf` 不保留该字段，重开时以项目 `name` 为准 |

> 说明：后端只校验外层结构（`tracks` 必须是数组），`tracks` 元素内部字段原样透传、不截断；
> 「最多 5 条」由前端 store 的 `MAX_STRIP_TRACKS` 与 5 个部位约束保证。

后端派生字段（读取时计算，不落盘为用户可写字段）：

| 字段 | 来源 | 用途 |
| --- | --- | --- |
| `kind` | `composition` 非空即 `'strips'`，否则 `'clip'` | 动画工作区分组（需求 15） |
| `stripCount` | `composition.tracks.length ?? 0` | 卡片副标题「N 个源动画」 |

## 边界与失败路径

| 场景 | 触发条件 | 表现 | 恢复方式 |
| --- | --- | --- | --- |
| 无基础模型 | 未选择模型就点「+」 | toast「请先选择基础模型」 | 先在左栏选模型 |
| 超过 5 个源动画 | 已有 5 条轨道再点「+」 | toast 提示上限（需求 11） | 删除一条或取消部位 |
| 无空闲部位 | 5 个部位全被占用 | toast「5 个身体部位都已被占用」 | 取消某条 Strip 的部位 |
| 来源重复 | 同一来源再点「+」 | toast 提示去检查器勾选更多部位 | 多选部位而不是新建轨道 |
| 部位冲突 | 某部位已被其他 Strip 占用 | 不写入，红色「部位冲突：XX（已被…使用）」 | 先取消占用者的该部位 |
| 部位全取消 | 检查器取消最后一个部位 | 不写入，提示「至少保留一个身体部位」 | 保留至少一个 |
| 来源片段缺失 | FBX 内找不到该 clipName | 该 Strip 标记 error，不参与混合 | 换来源或重新导入 |
| 骨架不匹配 | `bindClipToBones` 全部轨道绑不上 | 该 Strip 标记 error「骨架不匹配」 | 换基础模型 |
| 模型加载失败 | 网络 / 文件损坏 | toast「模型加载失败：…」，保留旧模型 | 重试或换模型 |
| 烘焙为空 | 无有效 Strip 或被静音过滤 | `bake()` 返回 null，toast「没有可烘焙的内容」 | 至少一条生效 Strip |
| 烘焙无关键帧 | 生成片段为空 | toast「烘焙结果没有可用的关键帧」 | 检查来源与模型 |
| 未烘焙就保存 | `baked == null` | toast「请先烘焙再保存」 | 先烘焙 |
| 名称为空 | 保存名为空 | toast「请输入动画名称」 | 输入名称 |
| 保存失败 | API 4xx/5xx / 网络错误 | toast 具体原因，`dirty` 保留 | 重试 |
| 打开编排失败 | 项目无 composition 或读取失败 | toast「这个动画没有可编辑的拼接编排」 | 从拼接区新建 |
| 切换模型 | 已有编排时换基础模型 | 旧烘焙作废，来源重新绑定 | 骨架不匹配的来源会报 error |

## 调试与验证清单

类型检查：

```powershell
cd apps/web; npx vue-tsc --noEmit
cd apps/api; npx tsc --noEmit
```

浏览器（dev server 5173 / api 8788）：

1. 进入拼接页 → 模型以 0.5 半透明显示；左栏三种来源都渲染出「+」。
2. 加第 1 个来源 → 对应部位变不透明并染成时间轴同色；左栏该行高亮。
3. 同一 Strip 勾选更多部位 → 其它部位同步染色；悬停部位项 → 模型外发光（颜色 = Strip 色）。
4. 让两条 Strip 勾选同一部位 → 红色冲突提示，界面状态不变。
5. 加满 5 条后仍能点「+」→ 提示上限；删除一条后可继续添加。
6. 时间轴 5 条 lane 铺满底部；总长 = 最长来源；拖动整体与左右裁剪都改变 `start/trimStart/duration`。
7. 打开「仅显示已添加部位」→ 未分配部位消失；「显示骨骼」→ 骨骼线常显；地面出现下肢轨迹。
8. 烘焙 → 切 baked/live 对比画面一致；保存 → 动画工作区出现「拼接动画」卡片。
9. 卡片「编辑拼接」→ 回到拼接页并完整恢复编排（含基础模型、部位、裁剪）；保存后仍是同一 id。
10. 改动后点其它页签 → 出现离开确认；选择留下可继续编辑；关闭浏览器触发 `beforeunload`。

常见问题定位：

- 模型全灰不染色：检查 `basePaints` 是否成功（蒙皮网格需同时有 `skinIndex` / `skinWeight`）。
- 只有部分骨骼动：来源片段与基础模型骨骼名不匹配，`bindClipToBones` 丢弃了这些轨道。
- 时间轴总长不更新：`clipDurations` 只在来源 `ready` 时写入，检查该 Strip 是否 error。
- 切换页面回来编排丢失：确认使用的是同一 store 实例（未刷新页面）且 `attachPlayer` 走的是恢复分支。
- 烘焙结果与预览不一致：确认烘焙后又做了编辑（应触发 `invalidateBake`）。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `apps/web/src/viewer/strips/StripTypes.ts` | Strip / BodyPart / StripsComposition 类型与工具 |
| `apps/web/src/viewer/strips/StripParts.ts` | 骨骼 → 5 部位分类、部位覆盖判断 |
| `apps/web/src/viewer/strips/StripBlend.ts` | 逐骨骼权重混合、烘焙为 `AnimationData` |
| `apps/web/src/viewer/strips/StripsPlayer.ts` | 基础模型加载、实时混合、顶点染色/外发光、骨骼线、轨迹、烘焙预览 |
| `apps/web/src/stores/strips.ts` | 素材目录、Strip CRUD、部位冲突校验、时间轴总长、烘焙、保存/新建/打开编排、未保存状态 |
| `apps/web/src/components/strips/StripsPage.vue` | 页面骨架（左来源库 / 中视口 / 右检查器 / 底部整行时间轴） |
| `apps/web/src/components/strips/StripsViewport.vue` | three.js 视口与播放条（含仅显示已添加部位、显示骨骼） |
| `apps/web/src/components/strips/StripTimeline.vue` | 5 条部位 lane、铺满底部、拖动 / 裁剪 / 定位 |
| `apps/web/src/components/strips/StripInspector.vue` | 部位多选、冲突提示、悬停高亮、烘焙与保存、新建 |
| `apps/web/src/components/animation/AnimationGrid.vue` | 「拼接动画」分类与「编辑拼接」入口 |
| `apps/api/src/services/animProjects.ts` | `composition` 存取与 `kind/stripCount` 派生 |
| `apps/web/src/App.vue` / `TopBar.vue` | 第 4 个页签「拼接」与离开确认 |

复用：`viewer/stage/FbxActor.ts`（加载 / 归一化 / 骨骼收集）、`clipFromAnimationData.ts`（JSON → Clip）、
`api/animation.ts`（封面 / 项目读写）、`api/kimodo.ts`（动作导入）。

## 验证

1. `npx vue-tsc --noEmit`（apps/web）与 `npx tsc --noEmit`（apps/api）。
2. 添加 5 个不同源动画 → 第 6 个提示「最多从 5 个源动画拼接」；左侧已添加行高亮。
3. 同一 Strip 多选部位 → 模型对应区域不透明并染成该 Strip 颜色；悬停部位按钮时外发光。
4. 跨动画重复占用同一部位 → 红色「部位冲突」提示且不写入。
5. 时间轴 5 条 lane 铺满底部；总长 = 最长源动画；拖动 / 裁剪生效。
6. 切换「仅显示已添加部位」与「显示骨骼」；地面出现下肢轨迹。
7. 烘焙 → 保存 → 动画工作区「拼接动画」出现条目；点「编辑拼接」回到拼接并恢复编排。
8. 修改后切换页签出现离开确认；关闭浏览器触发 `beforeunload`。
