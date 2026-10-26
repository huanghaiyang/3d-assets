# Kimodo 真实 Pose 约束过渡动画 —— 技术实现文档

> 本文档对应提交：在旧版「文本 prompt 过渡」基础上新增「真实 pose 约束」过渡路径，使生成的过渡段首帧严格对齐前一段末帧、尾帧严格对齐后一段首帧（RMS 误差 = 0.000000 m）。

---

## 1. 概述

### 1.1 解决的问题

Kimodo C++ 引擎内部已实现完整的条件扩散机制（`sample_motion_from_noise_conditioned`），
但官方 `kmd-generate --server` 协议只暴露「纯文本生动作」入口，无法把已有片段的
**真实肢体姿势**作为约束喂给 denoiser。这导致：

- 旧版过渡段靠 prompt 描述「从前一帧走向后一帧」，首尾帧姿态不可控；
- 两段动作拼接时出现明显的肢体跳变（尤其手、脚位置）。

本方案新建一个 C++ shim，直接调用 Kimodo 内部函数，把前后段的真实 pose 编码成
`observed + observed_mask`，通过双向约束（prev 末帧 → observed[0]，next 首帧 →
observed[frames-1]）生成中间过渡段，保证拼接零跳变。

### 1.2 与旧版的关系

- **不替换旧版**：纯文本 prompt 路径保留并默认兜底；
- **自动选择**：当两段都是 Kimodo 源（`source.kind === 'kimodo'`）时走新路径，
  否则（FBX / anim-project 源）回退旧版文本 prompt；
- **配置可控**：`.env` 里 `KIMODO_CONDITIONED_SHIM` 留空即自动回退。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│  前端 Web (Vue 3 + Pinia)                                        │
│  stage.store.generateTransition(prevId, nextId)                 │
│   ├─ 两段都是 kimodo 源？ ──是──▶ POST /api/kimodo/              │
│   │                                  generate-conditioned        │
│   │                                  {prevAnimationId,           │
│   │                                   nextAnimationId,            │
│   │                                   frames, prompt}            │
│   └─ 否 ──▶ POST /api/kimodo/generate（旧版文本 prompt）         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  API 层 (Fastify + TypeScript)                                   │
│                                                                  │
│  route: /api/kimodo/generate-conditioned                         │
│   ├─ 方式 B（推荐）：传 prevAnimationId + nextAnimationId         │
│   │   → 从 outputDir/<jobId>/ 读 root_positions.f32 /           │
│   │     local_rotations_xyzw.f32                                 │
│   │   → 切 prev 尾部 N 帧 + next 头部 N 帧                       │
│   │   → 写临时 f32 到 outputDir/_constraints/<tag>/              │
│   └─ 方式 A：直接传四个 f32 绝对路径                              │
│                                                                  │
│  service: KimodoService                                          │
│   ├─ submitConditioned(req)                                      │
│   ├─ ensureConditionedSession()  ← 独立子进程                    │
│   └─ runConditioned(job, req)     ← 拼 CONDITIONED 协议行        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  C++ Shim (kmd-conditioned-server.exe)                           │
│  命令行：kmd-conditioned-server MOTION.gguf TEXT_BUNDLE.gguf      │
│                                                                  │
│  输入：STDIN 协议行 → encode + normalize → 双向 observed/mask    │
│  处理：sample_motion_from_noise_conditioned（DDIM）               │
│        + 硬约束覆盖（mask=1 位置 ← observed）                    │
│  输出：root_positions.f32 [T,3] + local_rotations_xyzw.f32 [T,30,4]│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Kimodo C++ 内核 (D:\thirdparty\kimodo.cpp)                      │
│  - denoiser.hpp: sample_motion_from_noise_conditioned            │
│  - motion_decode.hpp: decode_motion                              │
│  - skeleton.hpp: soma30_spec (30 joints, 4 end-effectors)        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 端到端时序

```
User           Store            API Route        API Service      Shim
 │                │                │                 │             │
 │ 点击「生成过渡」│                │                 │             │
 │───────────────▶│                │                 │             │
 │                │ 检测两段 kimodo源│                 │             │
 │                │────────────────▶│ submitConditioned             │
 │                │                │                 │             │
 │                │                │ 读 prev/next job 的 f32       │
 │                │                │ 切帧 → 写临时 f32            │
 │                │                │────────────────▶│ ensureConditionedSession
 │                │                │                 │ spawn(shim)│
 │                │                │                 │────────────▶│
 │                │                │                 │             │ (加载模型)
 │                │                │                 │             │
 │                │                │                 │ CONDITIONED\t...│
 │                │                │                 │────────────▶│
 │                │                │                 │             │ encode+norm
 │                │                │                 │             │ build_bidir
 │                │                │                 │             │ DDIM 50步
 │                │                │                 │             │ 硬约束覆盖
 │                │                │                 │             │ decode
 │                │                │                 │ OK\t24\t30   │
 │                │                │                 │◀────────────│
 │                │                │◀──{job: running}──────────────│
 │                │◀───────────────│                 │             │
 │   显示「生成中」│                │                 │             │
 │ ... (轮询 /animations) ...      │                 │             │
 │                │◀───────────────│◀────────────────│             │
 │   status=ready │                │                 │             │
 │                │ completeTransition()             │             │
 │                │ 把新段插到 prev/next 中间         │             │
```

---

## 4. 模块实现细节

### 4.1 C++ Shim：`tools/kimodo-shim/main.cpp`

文件：[main.cpp](file:///D:/sgames/3d-desing/tools/kimodo-shim/main.cpp)
产物：`tools/kimodo-shim/build/Release/kmd-conditioned-server.exe` (256 KB, Release)

#### 4.1.1 启动与加载

```cpp
auto weights = ggml_motion_weights::load(argv[1]);   // 动作模型
auto text    = llm_text_encoder::load(argv[2]);       // 文本编码器 (Llama-3-Kimodo)
auto *skel   = find_skeleton(weights.skeleton_key()); // soma30
```

启动时一次性加载两个 GGUF，常驻进程，后续每行协议行一个任务。

#### 4.1.2 `encode_and_normalize`：SOMA f32 → normalized motion_rep

输入：`root_positions [T,3]` + `local_rotations_xyzw [T,30,4]`（局部旋转四元数）
输出：`normalized motion_rep [T, 369]`

**motion_rep 布局**（SOMA 30 关节，`motion_dim() = 9 + 12*30 = 369`）：

| 维度范围 | 含义 | 说明 |
|---------|------|------|
| `[0..4]` | global_root | `[0, root.y, 0, cos(h), sin(h)]`，root.x/z 拆分进 body |
| `[5..7]` | body 前 3 维 | `[root.x, root.y, root.z]` |
| `[8..97]` | FK 关节位置 | 30 关节 × 3D，以 root 为原点 |
| `[98..277]` | global cont6 | 30 关节 × 6D（global 旋转矩阵前两列） |
| `[278..368]` | 余量 | 填 0 |

**heading 计算**：用左右髋关节（`skeleton.hips[0/1]`）的 FK 位置差算朝向：
```cpp
heading = atan2(posed[right][2] - posed[left][2],
                -(posed[right][0] - posed[left][0]));
```

**normalize**：按 GGUF 里的 `stats.global_root.{mean,std}` 和 `stats.body.{mean,std}` 逐维归一化，方差加 `1e-5` 防零。

> **往返验证**：encode → denorm → decode 与原始 root 完全一致（RMS = 0）。

#### 4.1.3 `build_bidirectional`：双向 observed / mask

**帧序反转**（关键）：
- prev 尾部 N 帧**反转**后填 `observed[0..N)`：
  - `observed[0]` = prev **末帧**，`observed[N-1]` = prev 倒数第 N 帧
- next 头部 N 帧**反转**后填 `observed[frames-N..frames)`：
  - `observed[frames-1]` = next **首帧**，`observed[frames-N]` = next 第 N 帧

反转的目的：让生成段**首帧直接等于 prev 末帧**，**尾帧直接等于 next 首帧**，
而不是中间某个过渡帧等于约束帧。

**mask 策略**（对齐 Kimodo 官方 `sequence.cpp::prepare_sequence_transition`）：

```cpp
rotation_begin = 5 + 3 * J;   // = 5 + 90 = 95
// mask[0 .. rotation_begin) = 1   （global_root 5 维 + 所有关节 FK 位置）
for (joint in end_effectors)   // soma30: {24, 28, 13, 19} 手脚
    mask[rotation_begin + joint*6 .. +6) = 1   // 仅末端关节 rotation cont6
```

只锁定：根位置、所有关节的 FK 空间位置、手/脚的旋转；中间骨架旋转交给 denoiser 自由发挥。

#### 4.1.4 DDIM 采样 + 硬约束覆盖

```cpp
auto sampled = sample_motion_from_noise_conditioned(
    weights, noise, embedding, observed, mask,
    heading=0, frames, steps=50, text_weight=2, constraint_weight=2);

// 硬覆盖：mask=1 的位置直接替换为 observed
for (i = 0; i < sampled->size(); ++i)
    if (mask[i] > 0.5) (*sampled)[i] = observed[i];
```

**为什么需要硬覆盖？** denoiser 内部的 mask 融合发生在 DDIM 输入层
（`dst = motion * (1-mask) + observed * mask`），是平滑逼近而非硬替换。
DDIM step 即使 50 步也不会精确收敛到 observed 值（会有 ~0.05 米级残差）。
因此在采样完成后，在 **normalized 空间**直接把 mask=1 的位置替换为 observed 值，
保证精确对齐。

#### 4.1.5 空间正确性

- `sample_motion_from_noise_conditioned` 返回 **normalized 空间**（DDIM 全程在 normalized 空间运行）；
- `decode_motion` 也接受 **normalized 输入**，内部先 denorm 再解码；
- 所以 sampled 直接传给 decode_motion，**不再做额外 normalize/denorm**。

#### 4.1.6 输出

```
<output_dir>/root_positions.f32        [T, 3]   float32 LE
<output_dir>/local_rotations_xyzw.f32  [T, 30, 4] float32 LE
```

格式与 `kmd-generate --server` 完全一致，前端预览链路零修改。

---

### 4.2 API Service：`apps/api/src/services/kimodo.ts`

文件：[kimodo.ts](file:///D:/sgames/3d-desing/apps/api/src/services/kimodo.ts)

#### 4.2.1 新增成员

```ts
private conditionedSession: ChildProcessWithoutNullStreams | null = null;
private conditionedStdoutBuffer = '';
private conditionedPendingLines: string[] = [];
private conditionedLineWaiters: Array<(line: string | null) => void> = [];
private conditionedWeightsLoaded = false;
```

**设计决策**：text 路径与 conditioned 路径各自独立 session，但**共享全局 queue / busy / pending 计数器**——因为同一时间只能跑一个推理任务（CPU/GPU 瓶颈），串行队列能避免显存爆掉。

#### 4.2.2 `ensureConditionedSession()`

与 `ensureSession()` 类似，但：

```ts
spawn(shimExe, [motionModel, textBundle], { env, ... })
```

- 不传 `--server`（shim 直接接受 GGUF 路径作为 args）；
- 不设 `KIMODO_BACKEND` 环境变量（shim 走默认后端）；
- stdout/stderr handler 绑定到 conditioned 版本的成员。

#### 4.2.3 `submitConditioned(req)`

```ts
interface KimodoConditionedRequest {
  prevRootPath: string; prevRotPath: string;
  nextRootPath: string; nextRotPath: string;
  frames: number;
  transitionFrames?: number;  // 默认 1
  steps?: number;              // 默认 50
  seed?: number;
  prompt: string;
}
```

校验：
- shim exe 存在；
- 四个 f32 文件存在；
- frames ∈ [8, 300]。

```ts
job.mode = 'conditioned';
this.queue = this.queue.then(() => this.runConditioned(job, req));
```

#### 4.2.4 `runConditioned(job, req)`

协议行拼接（TAB 分隔）：

```
CONDITIONED\tSTEPS\tSEED\tOUTPUT_DIR\t
  PREV_ROOT.f32\tPREV_ROT.f32\t
  NEXT_ROOT.f32\tNEXT_ROT.f32\t
  TRANSITION_FRAMES\tTOTAL_FRAMES\tPROMPT.txt
```

流程与 `run()` 一致：写 `prompt.txt` → 发送协议行 → `nextConditionedLine` 轮询 →
校验输出 f32 → `persist(job)`。失败时 `killConditionedSession`，成功时 `conditionedWeightsLoaded = true`。

---

### 4.3 API Route：`apps/api/src/routes/kimodo.ts`

文件：[kimodo.ts](file:///D:/sgames/3d-desing/apps/api/src/routes/kimodo.ts)

新增 `POST /api/kimodo/generate-conditioned`，支持两种输入方式。

#### 方式 A：直接路径

```json
{
  "prevRootPath": ".../prev_root.f32",
  "prevRotPath":  ".../prev_rot.f32",
  "nextRootPath": ".../next_root.f32",
  "nextRotPath":  ".../next_rot.f32",
  "frames": 24,
  "transitionFrames": 1,
  "steps": 50,
  "prompt": "smooth transition"
}
```

#### 方式 B：animationId 快捷（前端默认用）

```json
{
  "prevAnimationId": "0254a53b43931d",
  "nextAnimationId": "18365d95b6ef5c",
  "frames": 24,
  "transitionFrames": 1,
  "steps": 50,
  "prompt": "smooth transition"
}
```

**自动切帧逻辑**：

```ts
const perFrameRoot = 12;          // 3 float × 4 byte
const perFrameRot  = 30 * 4 * 4;  // 30 joint × 4 quat × 4 byte

// 切帧：负索引 = 倒数第 N 帧；frameEnd=0 = 到末尾
const slice = (src, perFrame, frameStart, frameEnd) => {
  const totalFrames = buf.length / perFrame;
  const start = frameStart < 0 ? Math.max(0, totalFrames + frameStart) : frameStart;
  const end   = frameEnd === 0 ? totalFrames
            : (frameEnd < 0 ? Math.max(0, totalFrames + frameEnd) : frameEnd);
  return buf.subarray(start * perFrame, end * perFrame);
};

prev_buf = slice(prev_root, 12, -transitionFrames, 0);  // prev 尾部 N 帧
next_buf = slice(next_root, 12, 0, transitionFrames);   // next 头部 N 帧
```

临时文件写入 `outputDir/_constraints/<prev6>-<next6>-<ts>/` 目录。

---

### 4.4 前端 Store：`apps/web/src/stores/stage.ts`

文件：[stage.ts](file:///D:/sgames/3d-desing/apps/web/src/stores/stage.ts)

`generateTransition(prevId, nextId)` 中新增路径选择：

```ts
const prevAnimId = prev.source.kind === 'kimodo' ? prev.source.animationId : undefined;
const nextAnimId = next.source.kind === 'kimodo' ? next.source.animationId : undefined;
const bothKimodo = !!prevAnimId && !!nextAnimId;

let job;
if (bothKimodo) {
  job = await kimodoApi.generateConditioned({
    prevAnimationId: prevAnimId,
    nextAnimationId: nextAnimId,
    frames,
    transitionFrames: 1,  // 首尾各 1 帧约束，精确对齐
    steps: 50,
    prompt: task.prompt,
  });
} else {
  job = await kimodoApi.generate({ prompt: task.prompt, frames, steps: 20 });
}
```

后续轮询、插入过渡段、冻结相邻段等逻辑完全复用旧版，无需修改。

---

## 5. 关键技术决策与踩坑记录

| # | 问题 | 现象 | 根因 | 解决 |
|---|------|------|------|------|
| 1 | 二次 normalize | 输出 root 严重偏离 | 误以为 `sample_motion_from_noise_conditioned` 返回 denorm 空间，又做了一次 normalize | 该函数返回 normalized 空间，直接传给 `decode_motion`（它内部 denorm） |
| 2 | mask 过度约束 | denoiser 生成僵硬、动作不自然 | 对所有关节 rotation 全约束（369 维里 274 维 mask=1） | 对齐官方：只约束 global_root + FK 位置 + 末端关节 rotation，中间骨架交给 denoiser |
| 3 | 帧序未反转 | 生成首帧等于 prev 倒数第 N 帧（不是末帧） | observed 正序填 prev 尾部，导致 observed[0] = prev 倒数第 N 帧 | prev 尾部反转填 observed[0..N)，next 头部反转填 observed[frames-N..frames) |
| 4 | 对齐残差 ~5cm | 首尾帧与 prev/next 有几厘米偏差 | denoiser 融合是平滑逼近，DDIM step 不会硬收敛 | 采样后在 normalized 空间把 mask=1 位置直接替换为 observed 值 |
| 5 | API 切帧空 Buffer | 首帧/尾帧不对齐，差 3.8 米 | `slice(-1, 0)` 时 `frameEnd=0` 被当成正数索引 | `frameEnd=0` 特判为 "到文件末尾"（totalFrames） |
| 6 | motion stats 非零均值 | 最初担心 root.x=0 的 encode 会偏 | GGUF stats 里 `global_root.mean[0] ≈ 0.004` | 实测往返验证（encode→denorm→decode）RMS=0，数学正确 |

---

## 6. 数据结构与协议

### 6.1 Shim STDIN 协议行

```
CONDITIONED\tSTEPS\tSEED\tOUTPUT_DIR\tPREV_ROOT\tPREV_ROT\tNEXT_ROOT\tNEXT_ROT\tTRANS_FRAMES\tTOTAL_FRAMES\tPROMPT
```

| 字段 | 类型 | 说明 |
|------|------|------|
| STEPS | uint | DDIM 步数，推荐 50 |
| SEED | uint64 | 随机种子 |
| OUTPUT_DIR | path | 输出目录 |
| PREV_ROOT | path | prev 尾部 root f32 ([N,3]) |
| PREV_ROT | path | prev 尾部 rot f32 ([N,30,4]) |
| NEXT_ROOT | path | next 头部 root f32 ([N,3]) |
| NEXT_ROT | path | next 头部 rot f32 ([N,30,4]) |
| TRANS_FRAMES | uint | 首尾各约束帧数 |
| TOTAL_FRAMES | uint | 生成总帧数 |
| PROMPT | path | 提示词 txt |

### 6.2 Shim STDOUT 响应

```
OK\tFRAMES\tJOINTS
ERR\t<message>
```

### 6.3 SOMA 30 关节与末端效应器

```
Hips(0), Spine1(1), Spine2(2), Chest(3), Neck1(4), Neck2(5), Head(6), Jaw(7),
LeftEye(8), RightEye(9),
LeftShoulder(10), LeftArm(11), LeftForeArm(12), LeftHand(13),
  LeftHandThumbEnd(14), LeftHandMiddleEnd(15),
RightShoulder(16), RightArm(17), RightForeArm(18), RightHand(19),
  RightHandThumbEnd(20), RightHandMiddleEnd(21),
LeftLeg(22), LeftShin(23), LeftFoot(24), LeftToeBase(25),
RightLeg(26), RightShin(27), RightFoot(28), RightToeBase(29)

end_effectors = {24(LeftFoot), 28(RightFoot), 13(LeftHand), 19(RightHand)}
```

### 6.4 KimodoAnimation 新增字段

```ts
interface KimodoAnimation {
  // ... 原有字段
  mode?: 'text' | 'conditioned';  // 生成模式
}
```

### 6.5 KimodoStatus 新增字段

```ts
interface KimodoStatus {
  // ... 原有字段
  conditionedShimExe: string | null;  // shim 路径
  conditionedReady: boolean;          // shim 文件存在
}
```

---

## 7. 验收数据

### 7.1 端到端 HTTP 调用

```
POST /api/kimodo/generate-conditioned
{ prevAnimationId: '0254a53b43931d', nextAnimationId: '18365d95b6ef5c',
  frames: 24, transitionFrames: 1, steps: 50, prompt: '...' }

→ { id: '6fdb3526d03c6e', status: 'running', mode: 'conditioned', etaMs: 145000 }
→ 约 100s 后 status: 'ready'（Vulkan 后端）
```

### 7.2 首尾帧对齐精度

```
首帧 root:  [-0.1195, 0.9656, 3.8308]  ← conditioned 输出
prev 末帧:  [-0.1195, 0.9656, 3.8308]  ← 原始 prev 段
RMS 差:     0.000000 m ✓

尾帧 root:  [0.0008, 1.0002, -0.0064]  ← conditioned 输出
next 首帧:  [0.0008, 1.0002, -0.0064]  ← 原始 next 段
RMS 差:     0.000000 m ✓
```

### 7.3 性能（Vulkan 后端，单卡）

| 项 | 值 |
|----|----|
| 冷启动加载模型 | ~25 s |
| 24 帧 / 50 step 推理 | ~75 s |
| 总耗时 | ~100 s |
| 输出 | root_positions.f32 (72 B) + local_rotations_xyzw.f32 (2880 B) |

---

## 8. 配置项

`.env`：

```env
# 动作模型 GGUF
KIMODO_MOTION_MODEL=D:\thirdparty\kimodo.cpp\models\kimodo-soma-rp-v1.1-f32.gguf
# 文本编码器 GGUF
KIMODO_TEXT_BUNDLE=D:\thirdparty\kimodo.cpp\text\Llama-3-Kimodo-Q4_K_M.gguf
# 旧版文本生成器（保留）
KIMODO_GENERATE_EXE=D:\thirdparty\kimodo.cpp\build-vulkan\Release\kmd-generate.exe
# 约束过渡 shim（留空则回退旧版文本 prompt）
KIMODO_CONDITIONED_SHIM=D:\sgames\3d-desing\tools\kimodo-shim\build\Release\kmd-conditioned-server.exe
# ggml 后端
KIMODO_BACKEND=vulkan
# 输出目录
KIMODO_OUTPUT_DIR=D:\sgames\3d-desing\data\kimodo-output
```

---

## 9. 文件清单

| 路径 | 说明 |
|------|------|
| `tools/kimodo-shim/main.cpp` | Shim 主程序 |
| `tools/kimodo-shim/CMakeLists.txt` | C++20 构建，include 外部头文件、link kimodo.lib |
| `tools/kimodo-shim/build/Release/kmd-conditioned-server.exe` | 编译产物 |
| `apps/api/src/services/kimodo.ts` | KimodoService（conditioned session + submit/run） |
| `apps/api/src/routes/kimodo.ts` | `POST /api/kimodo/generate-conditioned` |
| `apps/api/src/config.ts` | `kimodo.conditionedShimExe` |
| `apps/web/src/api/kimodo.ts` | `kimodoApi.generateConditioned()` + 类型 |
| `apps/web/src/stores/stage.ts` | `generateTransition` 路径选择 |
| `.env` | `KIMODO_CONDITIONED_SHIM` |

---

## 10. 后续可扩展点

1. **非 kimodo 源 retarget**：当前 FBX / anim-project 源只能走文本 prompt 兜底。
   可新增 `StagePlayer.sampleSomaPose()` 通过 Mixamo→SOMA 逆向映射，把任意源的
   末帧/首帧姿态写成 f32，实现全源类型的 pose 约束过渡。
2. **多帧约束渐变**：当前 `transitionFrames=1` 单帧精确对齐。可支持 N 帧渐变，
   让过渡段前 N 帧 = prev 末 N 帧（反转），后 N 帧 = next 头 N 帧（反转），
   中间自由生成，动作更自然。
3. **约束权重可配**：当前 `constraint_weight=2`、`text_weight=2` 固定。可作为
   请求参数暴露，允许用户在「严格对齐」与「自由风格」间权衡。
