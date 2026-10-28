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

**多帧锚点窗口（正序填充）**：
- prev 尾部 N 帧**正序**填 `observed[0..N)`：`observed[0..N)` = prev 倒数第 N..末帧，
  即 `observed[N-1]` = prev **末帧**
- next 头部 N 帧**正序**填 `observed[frames-N..frames)`：`observed[frames-N]` = next **首帧**

这样生成段首帧窗口就是 prev 真实的「最后 N 帧」、尾帧窗口是 next 真实的「最前 N 帧」，
模型能看到真实的进出速度与朝向。早期只 pin 单帧时采用反转填充（让末帧/首帧落在窗口边界），
多帧窗口下不需要反转——交付时前端会裁掉这 2N 帧窗口（见 4.4）。

**mask 策略**（比官方更严：窗口帧**整行**锁定）：

```cpp
// 窗口内每一帧的所有维度都置 1
std::fill(mask.data() + t * D, mask.data() + (t + 1) * D, 1.f);
```

为什么必须整行锁：`decode_motion` **只用 cont6 还原全局旋转**（root 也来自
`global_root + body[0/2]`），body 里的 FK 位置根本不参与解码。
官方 `prepare_sequence_transition` 只锁 `[0, rotation_begin)` + 末端关节 cont6，
在双向硬切场景下实测末帧 Hips 与 next 首帧相差 **168°**（整条手臂翻掉的观感）。
改成整行锁后同 seed 复跑，首尾姿态差降到 **0.0°**、根位置误差 0.000cm。
中间帧 mask 全 0，仍由 denoiser 自由生成。

**自由段根位移引导**：

只 pin 首尾时，denoiser 会让角色原地做手势：60 帧里根只走 0.36m，
舞台再补 2m 位移就成了「滑步」。因此给中间**自由帧**铺一条 smoothstep 根轨迹
（锚点窗口内的行由真实姿态整行锁定，不能再写）：

```cpp
static constexpr size_t kRootHorizDims[] = {0, 2, 5, 7};  // global_root x/z + body 根 x/z
static constexpr size_t kRootYDims[]    = {1, 6};         // global_root y + body 根 y
const size_t anchor_begin = tail_n;                      // 第一个自由帧
const size_t anchor_end   = total_frames - head_n;       // 尾窗口首帧
const size_t start_idx = tail_n > 0 ? tail_n - 1 : 0;    // prev 末帧（可见段起点）
const size_t end_idx   = head_n > 0 ? anchor_end : total_frames - 1;
const float span = float(end_idx) - float(start_idx);
for (size_t t = anchor_begin; t < anchor_end && span > 0.5f; ++t) {
    const float x = (float(t) - float(start_idx)) / span;
    const float w = x * x * (3.f - 2.f * x);
    for (size_t d : kRootHorizDims) { row[d] = a[d] + (b[d] - a[d]) * w; row_mask[d] = 1.f; }
    // 根高只在可见段两端锁定（另一端 prev 末帧已在锚点窗口里整行锁住）
    if (t == start_idx || t + 1 == end_idx)
        for (size_t d : kRootYDims) { row[d] = a[d] + (b[d] - a[d]) * w; row_mask[d] = 1.f; }
}
```

三个必须踩过的坑：

1. **`global_root[0]/[2]` 也必须锁**。`decode_motion` 的根位置是
   `root.x = global_root[0] + body[0]`、`root.z = global_root[2] + body[2]`，
   而 encode 把这两个平移分量写成 0 并塞进 body。只锁 `{1,5,6,7}` 时模型在
   `global_root[0]/[2]` 上自由漂移，实测末帧累计 -1.14m，解码后根位置与引导曲线
   差出这么多 → 首段倒退、末帧突跳。
2. **根高 y 不能逐帧锁死**。逐帧锁 `{1,6}` 会抹掉走路时髋部的上下起伏，
   实测双脚全程悬空 5~10cm、贴地帧只剩 6/8，看着像滑行。
   只锁首尾后根高恢复 0.922~1.026m。
3. **端点取 prev 末帧 / next 首帧本身**（而不是 observed 首尾行），
   这样 `transition_frames=0`（不做姿态锚点）时也能锁住整段跨越距离。

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

#### 4.1.6 解码后处理 `postprocess_decoded`

后处理分两档，由 `anchor_frames`（= 协议里的 TRANS_FRAMES）决定：

- **单帧锚点（N ≤ 1）**：denoiser 退化最严重——末帧前一帧与锚点可差 60~170°，
  手臂/头/脚大幅高频甩动。步骤 1~6 全开。
- **多帧锚点窗口（N ≥ 2，舞台现用 N=8）**：模型已经看到真实的进出速度/朝向，
  步骤 3/4/5/6 这些「针对单帧信息不足」的强改反而会破坏模型自身的过渡动作，
  因此只保留 1、2 和新增的 5b，且所有循环都跳过首尾各 N 帧锚点窗口。

| 步骤 | 做法 | 生效条件 | 作用 |
|------|------|---------|------|
| 1 单帧尖峰 | 与前后帧 slerp 中点的夹角 > 25° 时，替换为中点 | 全程 | 去掉孤立单帧跳变 |
| 2 抖动关节阻尼 | 肢体 12 遍 binomial（阈值 25°→50°）；躯干链 36 遍（阈值 10°→20°） | 全程 | 髋/腿权重 0 不动，手臂走低频；脊柱不出现跨帧甩动 |
| 3 根朝向归位 | 根关节偏航换成 prev 末帧 → next 首帧的 smoothstep 曲线 | 仅单帧 | 拆掉模型自己转的一圈（实测 0°→131°→6°） |
| 4 躯干收拢 | 脊柱链（j1..j6）世界朝向按 `TORSO_DAMP=0.85` 拉回锚点插值 | 仅单帧 | 去掉模型自己甩出的胸口偏航/俯仰/侧倾（残余 9~15°） |
| 5 根位移摊平 | 末帧 anchor 与末帧前一帧的差值按 smoothstep 摊到整段 | 仅单帧 | 消除末帧瞬移 |
| 5b 锚点边界收拢 | 自由段两端各 `ANCHOR_EASE_FRAMES=8` 帧向相邻锚点 smoothstep 收拢 | 仅多帧 | 消除 mask 边界处模型无连续性保证造成的单帧硬跳变 |
| 6 边界窗口混合 | 首尾各 K=10 帧整段走 `slerp(窗口基准帧, 锚点, s)` | 仅单帧 | 把整段旋转摊到 10 帧，且保证路径唯一 |

**步骤 5b 为什么必须做（多帧锚点后的新问题）**：

多帧窗口能显著抑制自转（同一约束下 hips 偏航从 -5°→111° 收敛到 -13°→28°），
但扩散模型对 mask 边界**外侧的姿态没有连续性保证**：实测 44 帧 / N=8 时，
最后一个自由帧与 next 首帧（窗口第 0 帧）相差 150~164°，舞台上就是过渡段末尾瞬移。
提高采样步数反而更差（50 步比 10 步更严重），说明不是收敛问题。

做法：只处理自由段最靠近锚点的 8 帧，权重 smoothstep 从紧贴锚点的 1 衰减到内侧的 0，
锚点窗口与中间段都不动：

```cpp
const size_t free_len = frames - 2 * anchor;
const size_t ease = std::min({ANCHOR_EASE_FRAMES, anchor, free_len / 2});
for (size_t i = 0; i < ease; ++i) {
    const float x = float(ease - i) / float(ease);
    const float w = x * x * (3.f - 2.f * x);       // i=0 权重 1，i=ease-1 权重≈0
    const size_t head_t = anchor + i;               // 头部自由段
    const size_t tail_t = frames - anchor - 1 - i;  // 尾部自由段
    for (size_t j = 0; j < J; ++j) {
        quat_slerp(q_at(rot, head_t, j), q_at(rot, head_t, j), head_anchor + j * 4, w);
        quat_slerp(q_at(rot, tail_t, j), q_at(rot, tail_t, j), tail_anchor + j * 4, w);
    }
}
```


**步骤 4 为什么必须做（真正看得见的扭动）**：

一阶帧间转角与二阶 jerk 都已达标后，舞台上看仍然是「走路时上身拧一下、右肩抬高」。
把躯干世界朝向逐帧拆成 yaw/pitch/roll 后才定位到：两端锚点本身只差 6~14°，
而 denoiser 在段中让脊柱自己甩出去：

| 关节 | 生成段中的世界朝向摆动（相对首帧） | 锚点 wp→wn |
|------|------------------------------------|------------|
| Chest (j3) | 偏航 -9→52、俯仰 -63→40、侧倾 -84→0 | 10.8° |
| Head (j6) | 偏航 -104→4 | 5.5° |

这 80~100° 的摆动完全不是过渡必需，属于模型自甩。做法是只动脊柱链的世界朝向：

```cpp
base   = slerp(w_prev末帧[j], w_next首帧[j], smoothstep(t / (T-1)));
target = slerp(w[t][j], base, TORSO_DAMP);      // 0.85：收掉 85% 的偏离
local  = conj(w[t][parent]) * target;           // 父世界已更新，正序重算局部量
```

髋（j0）不动 → 腿与踏步完全不受影响；手臂挂在胸下 → 跟着躯干一起收；
首尾两帧本来就是锚点，s=0/1 处收拢是恒等变换，不会破坏边界对齐。

收拢比例实测：0.65 时残余偏离仍有 32~36°（肩线仍明显歪），0.85 时降到
9~15°（Chest yaw ≤9°、pitch ±11°、roll ≤13°），二阶 jerk 仍为 0 帧 >20。

**步骤 6 为什么不能用逐帧 slerp（关键踩坑）**：

最初的写法是 `slerp(生成帧 t, 锚点, w_t)`。当生成姿态与锚点相差接近 180°
（模型在无姿态约束时会把尾部拧反，实测 LeftHand 与锚点差 163~179°）时，
每帧到锚点的大圆方向由叉积决定，相邻帧一旦跨过对跖点方向就翻转：
实测帧 54 `dot(q, anchor) = +0.151`、帧 55 `dot = -0.0006`，
缓动本身反而造出 **124°~140°** 的帧间突跳（逐阶段 dump 定位：
`pp_stage2_smooth` 0 帧 >40°，`pp_final` 3 帧 >40°，突跳是缓动引入的）。

中间还试过「固定修正量」`q * exp(w · log(conj(base) * anchor))`：
抖动降到 1 帧，但 hips 偏航在帧 56/57/58 变成 22.5°/25.6°/27.8°，帧 59 突跳回 -5.8°。
原因是仿射修正只叠加局部偏移，不会把「已经拧反的原始帧」拉回锚点，不收敛。

最终改为**固定测地线窗口混合**：整段窗口内所有帧都在「窗口基准帧 → 锚点」
这同一条测地线上取值，路径唯一、s 连续则结果必然连续，且 s=1 时严格等于锚点：

```cpp
const size_t K = std::min(EASE_FRAMES, (frames - 1) / 2);   // 两端窗口不重叠
auto ease_weight = [&](size_t k) {                          // k=0 锚点帧, k=K 接缝
    const float x = float(K - k) / float(K);
    return x * x * (3.f - 2.f * x);                          // smoothstep，接缝导数为 0
};
// 首段基准 = 第 K 帧；尾段基准 = 倒数第 K+1 帧
for (size_t k = 0; k <= K; ++k)
    for (size_t j = 0; j < J; ++j)
        quat_slerp(q_at(k, j), base + j * 4, anchor_rot + j * 4, ease_weight(k));
```

同 seed 实测（60 帧 / 50 步）：

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 尾帧 vs next 首帧 | 176.1° | **0.0°** |
| 末帧根位移 | 204.2 cm | 7.1 cm |
| 手/头/脚世界空间最大帧间位移 | 137~174 cm | 7~34 cm |
| 帧均角峰值 | 69.3° | 8.4° |

扭动量化的最终验收（舞台 `53839238088a87` 同一约束、同一 seed、`transition_frames=1`）：

| 指标 | 旧数据（旧后处理） | 新数据 |
|------|-------------------|--------|
| 帧间转角 >40° 的帧数 | 4 | **0** |
| 最陡帧 | #59 LFoot 179° / RFoot 173° / Hips 171°（整具身体末帧瞬移） | #18 j16 21°（正常摆臂） |
| 二阶 jerk 最大值 | 180°/帧（6 帧 >25） | 9.1°/帧（0 帧 >25） |
| 根路径 | 0→2.174 但末帧回跳 | 0→2.174，单调，路径 2.17m |
| 首帧 vs prev 末帧 | — | 0.04° |
| 末帧 vs next 首帧 | — | 0.03° |
| Hips 偏航全程 | 0°→131°→6°（自转一圈） | 5°→11°→-5° |
| Chest 偏航 / 俯仰 / 侧倾 | -9→52 / -63→40 / -84→0 | **-1→9 / -7→11 / -13→0** |
| Head 偏航 | -104→4 | **-12→4** |
| 躯干相对锚点插值的最大残余 | 92° | **9~15°** |
| 重定向后 Spine2 yaw / pitch / roll | -11.9→55.7 / -67.7→36 / -79→2.1 | **-4.2→7.0 / -12.3→5.2 / -9.5→2.1** |
| 重定向后 Head 偏航 | -107.5→2.2 | **-13.7→2.2** |
| 左脚贴地帧数 | 6/60（全程悬空 5~10cm） | 29/60 |

> `transition_frames=0`（不做姿态锚点、只靠窗口混合）实测最陡 40~45°、
> 双脚基本全程悬空；`transition_frames=1` 反而更稳（模型拿到边界姿势后
> 中间生成更连贯）。因此产品保持默认 `1` 即可，无需改前端/服务层参数。

#### 4.1.7 输出

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

**多帧锚点窗口（N = `ANCHOR_FRAMES` = 8）**。两条生成路径（新建 / 重新生成）共用：

```ts
// Kimodo 源：API 切原始 f32；FBX / 新建动画：浏览器采样真实姿态窗口
const prevAnimId = prev.source.kind === 'kimodo' ? prev.source.animationId : undefined;
const nextAnimId = next.source.kind === 'kimodo' ? next.source.animationId : undefined;
const bothKimodo = !!prevAnimId && !!nextAnimId;
const sampledPoses = bothKimodo
  ? null
  : {
      prev: player?.sampleSegmentBoundarySoma(prev.actorId, prevId, 'end', ANCHOR_FRAMES) ?? null,
      next: player?.sampleSegmentBoundarySoma(next.actorId, nextId, 'start', ANCHOR_FRAMES) ?? null,
    };
...
transitionFrames: ANCHOR_FRAMES,   // 首尾各 8 帧真实姿态
frames,                            // visibleFrames + 2 * (ANCHOR_FRAMES - 1)
```

- `sampleSegmentBoundarySoma(..., 'end', N)` 取 prev **裁剪窗口末尾 N 帧**（正序），
  `'start'` 取 next **裁剪窗口开头 N 帧**；上传格式 `{ root: N*3, rot: N*30*4 }` base64
  （`somaPosesToBase64`，见 `somaRetarget.ts`）。
- **帧数补偿**：`visibleFrames = clamp(round(duration*30/2)*2, 24, 96)`，
  `frames = visibleFrames + 2*(ANCHOR_FRAMES-1)`。否则交付裁剪会把可见时长吃掉
  （0.8s 的短过渡只剩 0.33s）。
- **交付裁剪**：`transitionTrim(frames)` → `trimStart=(N-1)/30`、`trimEnd=(frames-N)/30`，
  可见段恰好从 prev 末帧（窗口最后一个）到 next 首帧（尾窗口第一个），
  重播窗口被裁掉。之后 `cursor = start + segmentLength(segment)` 顺延后续段。
- **重新生成同样支持 FBX**：旧版要求前后两段都是 Kimodo；现在 FBX/新建动画走
  浏览器采样窗口（与新建一致），因此「FBX → 过渡 → FBX」可以直接重新生成。
- `stretchRootMotion` 改为按 `trimStart/trimEnd` 取样计算 clip 位移，
  保证裁剪后可见段的位移仍等于舞台两段站位差。

---

## 5. 关键技术决策与踩坑记录

| # | 问题 | 现象 | 根因 | 解决 |
|---|------|------|------|------|
| 1 | 二次 normalize | 输出 root 严重偏离 | 误以为 `sample_motion_from_noise_conditioned` 返回 denorm 空间，又做了一次 normalize | 该函数返回 normalized 空间，直接传给 `decode_motion`（它内部 denorm） |
| 2 | mask 过度约束 | denoiser 生成僵硬、动作不自然 | 对所有关节 rotation 全约束（369 维里 274 维 mask=1） | 对齐官方：只约束 global_root + FK 位置 + 末端关节 rotation，中间骨架交给 denoiser |
| 3 | 单帧锚点时帧序错位 | 生成首帧等于 prev 倒数第 N 帧（不是末帧） | observed 正序填 prev 尾部，导致 observed[0] = prev 倒数第 N 帧 | 当时用反转填充；**改用多帧窗口后取消反转**（窗口整体就是 prev 真实尾帧序列，正序填充，交付时再裁掉） |
| 4 | 对齐残差 ~5cm | 首尾帧与 prev/next 有几厘米偏差 | denoiser 融合是平滑逼近，DDIM step 不会硬收敛 | 采样后在 normalized 空间把 mask=1 位置直接替换为 observed 值 |
| 5 | API 切帧空 Buffer | 首帧/尾帧不对齐，差 3.8 米 | `slice(-1, 0)` 时 `frameEnd=0` 被当成正数索引 | `frameEnd=0` 特判为 "到文件末尾"（totalFrames） |
| 6 | motion stats 非零均值 | 最初担心 root.x=0 的 encode 会偏 | GGUF stats 里 `global_root.mean[0] ≈ 0.004` | 实测往返验证（encode→denorm→decode）RMS=0，数学正确 |
| 7 | 官方 mask 在双向场景下不锁姿态 | 舞台过渡末帧整条手臂翻掉，Hips 与 next 首帧差 168° | 官方只锁末端关节 cont6，而 `decode_motion` 只用 cont6 还原旋转 → 中间关节姿态完全自由 | **边界窗口帧**整行锁（不是全序列锁，自由帧仍全 0，不会回到第 2 条的僵硬） |
| 8 | 末帧瞬移 + 肢体抖动 | 舞台上最后一帧跳一大截、手臂/头高频甩动 | 扩散采样只收到单帧锚点时，未约束自由度退化；倒数第 2 帧与锚点差 60~170° | decode 后做 `postprocess_decoded`（尖峰抑制 / 抖动关节阻尼 / 根位移摊平 / 边界缓动） |
| 9 | 脊柱「鞭打」5 帧 | j1~j4 同时以 30~38°/帧 甩动，一阶平滑只压掉一半（权重 w=0.02） | 躯干链本不该有 30°/帧的转动；12 遍 binomial 的 σ 只有 2.4 帧，压不住 5 帧的整链爆发 | 后处理步骤 2 给躯干链单独用 36 遍（σ≈4.2 帧）+ 阈值 10°→20° |
| 10 | 看得见的「扭动」（指标全绿仍不合格） | 帧间转角、jerk 都达标，但舞台上明显「走路时上身拧一下、右肩抬高」 | denoiser 在稀疏约束下让脊柱在段中自甩 80~100°（Chest 偏航 -9→52、俯仰 -63→40、侧倾 -84→0），而两端锚点只差 6~14°，这段摆动并非过渡必需 | 后处理步骤 4：脊柱链世界朝向按 `TORSO_DAMP=0.85` 收拢到锚点 smoothstep 插值；残余偏离从 92° 降到 9~15° |
| 11 | 段中自转（hips 转 111°） | 单帧锚点时模型在过渡段中间自己转身，舞台上像「原地打转再接上」 | 单帧约束只说明「从哪个方向开始」，中间朝向无参照 | **多帧锚点窗口（N=8）**：模型看到真实进出速度与朝向；同约束实测 hips 偏航从 -5°→111° 收敛到 -13°→28° |
| 12 | 多帧锚点后的 mask 边界硬跳 | 最后一个自由帧与尾窗口首帧相差 150~164°（44 帧 / N=8），舞台末尾瞬移；采样步数 50 比 10 更差 | 扩散模型只保证窗内帧，窗外的连续性没有任何约束；不是步数不足 | 后处理步骤 5b：自由段两端各 8 帧向相邻锚点 smoothstep 收拢；实测帧间 >40° 从 11 处降到 0，最大 30.4° |
| 13 | 交付裁剪吃时长 | 裁掉 2N 帧窗口后，0.8s 的短过渡只剩 0.33s | 生成帧数直接等于可见帧数 | 生成帧数 = 可见帧数 + 2*(N-1)，并让 `transitionTrim` 与裁剪窗口严格对应 |
| 14 | 旧 API 进程里的死 shim 会话 | 改完 exe 后所有生成任务 0.5s 内报「conditioned shim 无响应」 | 常驻 session 的子进程被外部杀掉后，旧 API 进程内的会话状态未复位 | 重启 API；错误信息现在会带上 `shim 退出 code=` 与 stderr 末尾，便于定位 |

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
| PREV_ROOT | path | prev 姿态窗口 root f32 ([N,3]，取文件末尾 N 帧) |
| PREV_ROT | path | prev 姿态窗口 rot f32 ([N,30,4]，取文件末尾 N 帧) |
| NEXT_ROOT | path | next 姿态窗口 root f32 ([N,3]，取文件开头 N 帧) |
| NEXT_ROT | path | next 姿态窗口 rot f32 ([N,30,4]，取文件开头 N 帧) |
| TRANS_FRAMES | uint | 首尾各取的真实姿态窗口帧数（舞台用 8；≤1 时退回单帧锚点后处理） |
| TOTAL_FRAMES | uint | 生成总帧数（含两端各 TRANS_FRAMES 帧窗口，前端交付时裁掉） |
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
  frames: 74, transitionFrames: 8, steps: 50, prompt: '...' }

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
| 74 帧 / 50 step（热会话，8 帧锚点） | ~60 s |

### 7.4 多帧锚点窗口实测（N=8，当前实现）

**A. 44 帧 / 可见 30 帧 / dz=0.8m / steps=50 / method C**

| 指标 | 加入步骤 5b 前 | 加入 5b 后 |
|------|----------------|------------|
| 首/尾锚点最大误差 | 0.037° / 0.040° | 0.044° / 0.051° |
| 帧间 >40° 次数 | 11（j15=164°、j6=150°） | **0** |
| 全局最大帧间转角 | 164° @ t36 | **36.8° @ t14**（自由段内正常动作） |
| hips 偏航范围 | -63.4..0.3° | -19.1..0.3° |
| 可见段首帧→尾帧根位移 | 0.800 m | 0.800 m |

边界连续性：`t7→t8 = 0.0°`、`t35→t36 = 0.0°`，之后逐帧 2~9° 平滑过渡到自由段。

**B. 真实舞台重生成（74 帧 / 可见 60 帧 / dz=2.171m / FBX 采样窗口 / steps=50）**

job `5c5700d51ec36b`（prev `Angry Point.fbx` 尾 8 帧、next `180 Turn W_ Briefcase (2).fbx` 头 8 帧）：

| 指标 | 值 |
|------|----|
| 首/尾锚点最大误差 | 0.037° / 0.040° |
| 全局最大帧间转角 | 30.4° @ t12 (j13) |
| >20° / >40° / >90° 次数 | 6 / 0 / 0 |
| hips 偏航范围 | -5.2..15.3°（无自转） |
| 可见段根位移 | 2.171 m（与舞台两段站位差完全一致） |
| 逐帧根位移峰值 | 0.055 m / 帧（≈1.66 m/s） |
| 边界 | t7→t8 = 0.0°，t65→t66 = 0.0° |

结论：多帧锚点解决「中途自转」，5b 解决「mask 边界末帧瞬移」，中间段仍由模型生成
（最大转角出现在自由段内，且远低于阈值）。

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
| `apps/web/src/stores/stage.ts` | `generateTransition` / `regenerateTransition` 路径选择、帧数补偿与 `transitionTrim` |
| `apps/web/src/viewer/stage/StagePlayer.ts` | `sampleSegmentBoundarySoma`（多帧窗口采样）、`stretchRootMotion`（按裁剪窗口取样） |
| `apps/web/src/viewer/stage/somaRetarget.ts` | `somaPosesToBase64`（多帧 payload） |
| `apps/web/src/components/stage/SequenceEditor.vue` | 过渡段「重新生成」入口与提示文案 |
| `.env` | `KIMODO_CONDITIONED_SHIM` |

---

## 10. 后续可扩展点

1. **约束权重可配**：当前 `constraint_weight=2`、`text_weight=2` 固定。可作为
   请求参数暴露，允许用户在「严格对齐」与「自由风格」间权衡。
2. **过渡 prompt 语义化**：目前由前端按位移/转向拼一句英文描述，可让用户手写。
3. **Best-of-N 自动打分**：同约束多 seed 采样，用帧间转角 / 锚点误差 / hips 偏航
   打分取最优，进一步压低偶发的 30~40°/帧峰值。
