// kmd-conditioned-server —— 用真实 pose 约束生成过渡动画的 shim。
//
// 直接 include kimodo.cpp 的内部头文件，link 静态库 kimodo.lib 调用
// sample_motion_from_noise_conditioned：前 N 帧来自 prev 段尾部，后 N 帧来自 next 段头部，
// 中间靠 denoiser 自由生成 → 首帧严格对齐 prev 末帧，尾帧严格对齐 next 首帧。
//
// 协议：每行一个请求，TAB 分隔。
//
//   CONDITIONED\tSTEPS\tSEED\tOUTPUT_DIR\t
//     PREV_ROOT.f32\tPREV_ROT.f32\t
//     NEXT_ROOT.f32\tNEXT_ROT.f32\t
//     TRANSITION_FRAMES\tTOTAL_FRAMES\tPROMPT.txt
//
// 响应：OK\tFRAMES\tJOINTS      或     ERR\tmessage
//
// 生成后还会做一次纯几何后处理（见 postprocess_decoded）：抑制单帧孤立尖峰、
// 把高频甩动的关节压向低频参考轨迹、把根位移匀到整段，并让首尾各 K 帧向锚点姿态
// 平滑靠拢。扩散采样只拿到单帧锚点时，倒数第 2 帧与锚点可差上百十度，不处理就是
// 舞台上的末帧瞬移（实测手臂/头/脚末帧位移 130~200cm，处理后降到 30cm 以内）。

#include "denoiser.hpp"
#include "ggml_weights.hpp"
#include "llm_text_encoder.hpp"
#include "motion_decode.hpp"
#include "skeleton.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <random>
#include <sstream>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace fs = std::filesystem;
namespace kimodo { inline constexpr unsigned embedding_width = 4096; }

namespace {

// ===== 数学辅助：旋转（行优先 3x3）、四元数、cont6 =====

/** 行优先的 3x3 旋转矩阵（v[0..2] = 第一行）。 */
struct mat { float v[9]; };

/** 矩阵乘法：r = a * b。用于 FK 中父子关节的旋转级联。 */
mat mat_mul(const mat &a, const mat &b) {
    mat r{};
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            for (int k = 0; k < 3; ++k)
                r.v[i*3+j] += a.v[i*3+k] * b.v[k*3+j];
    return r;
}
/** 转置矩阵（FK 中把父关节的 global 旋转转到局部坐标系用）。 */
mat mat_trans(const mat &a) {
    mat r{};
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            r.v[i*3+j] = a.v[j*3+i];
    return r;
}
/** 把向量 x 按矩阵 m 旋转到目标坐标系：o = m * x。 */
void mat_rotate(const mat &m, const std::array<float, 3> &x, float *o) {
    for (int i = 0; i < 3; ++i) o[i] = m.v[i*3] * x[0] + m.v[i*3+1] * x[1] + m.v[i*3+2] * x[2];
}

/**
 * 四元数 (x,y,z,w) → 行优先 3x3 旋转矩阵。
 * 注意 Kimodo 的 local_rotations_xyzw.f32 用的是 xyzw 顺序（非 wxyz）。
 */
mat quat_to_mat(const float q[4]) {
    const float x = q[0], y = q[1], z = q[2], w = q[3];
    const float xx = x*x, yy = y*y, zz = z*z;
    const float xy = x*y, xz = x*z, yz = y*z;
    const float wx = w*x, wy = w*y, wz = w*z;
    mat m{};
    m.v[0]=1-2*(yy+zz); m.v[1]=2*(xy-wz);     m.v[2]=2*(xz+wy);
    m.v[3]=2*(xy+wz);   m.v[4]=1-2*(xx+zz);   m.v[5]=2*(yz-wx);
    m.v[6]=2*(xz-wy);   m.v[7]=2*(yz+wx);     m.v[8]=1-2*(xx+yy);
    return m;
}

/**
 * 把 3x3 旋转矩阵压缩成 cont6 表示（前两列共 6 个浮点数）。
 * cont6 是 Kimodo motion_rep 里关节旋转的编码方式（比四元数更适合 diffusion）。
 * 只取前两列，第三列可由前两列叉积重建（旋转矩阵正交）。
 */
void fill_cont6_from_mat(float *dst, const mat &m) {
    dst[0] = m.v[0]; dst[1] = m.v[3]; dst[2] = m.v[6];   // 第一列（v[0,3,6]）
    dst[3] = m.v[1]; dst[4] = m.v[4]; dst[5] = m.v[7];   // 第二列（v[1,4,7]）
}

/**
 * 归一化用的缩放因子：sqrt(std^2 + 1e-5)。
 * 加 1e-5 防止 std 为 0 时除零（Kimodo stats 里有极小方差的维度）。
 */
float scale_sqrt(float v) { return std::sqrt(v * v + 1e-5f); }

/** 两个四元数(xyzw)之间的旋转夹角（弧度），已处理 q/-q 双覆盖。 */
float quat_angle(const float *a, const float *b) {
    float d = std::fabs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]);
    d = std::min(1.f, d);
    return 2.f * std::acos(d);
}

/** 四元数归一化（原地）；退化输入回退到单位四元数。 */
void quat_normalize(float *q) {
    const float len = std::sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
    if (len <= 1e-8f) { q[0] = q[1] = q[2] = 0.f; q[3] = 1.f; return; }
    for (int i = 0; i < 4; ++i) q[i] /= len;
}

/** 四元数 → 旋转向量（axis*angle，弧度）：取最短弧，w<0 时整体取反。 */
void quat_log(float *axis, const float *q) {
    float x = q[0], y = q[1], z = q[2], w = q[3];
    if (w < 0.f) { x = -x; y = -y; z = -z; w = -w; }
    const float n = std::sqrt(x*x + y*y + z*z);
    if (n < 1e-8f) { axis[0] = axis[1] = axis[2] = 0.f; return; }
    const float angle = 2.f * std::atan2(n, w);
    const float k = angle / n;
    axis[0] = x * k; axis[1] = y * k; axis[2] = z * k;
}

/** 旋转向量（axis*angle）→ 单位四元数。 */
void quat_exp(float *q, const float *axis) {
    const float angle = std::sqrt(axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]);
    if (angle < 1e-8f) { q[0] = q[1] = q[2] = 0.f; q[3] = 1.f; return; }
    const float s = std::sin(angle * 0.5f) / angle;
    q[0] = axis[0] * s; q[1] = axis[1] * s; q[2] = axis[2] * s;
    q[3] = std::cos(angle * 0.5f);
}

/** 球面插值 dst = slerp(a, b, t)，t ∈ [0,1]；自动走短弧（处理 q/-q 双覆盖）。 */
void quat_slerp(float *dst, const float *a, const float *b, float t) {
    float d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
    float sign = 1.f;
    if (d < 0.f) { d = -d; sign = -1.f; }
    if (d > 0.9995f) {                      // 夹角近似 0：线性插值后归一化
        for (int i = 0; i < 4; ++i) dst[i] = a[i] + t * (sign * b[i] - a[i]);
        quat_normalize(dst);
        return;
    }
    const float theta = std::acos(d);
    const float s = std::sin(theta);
    const float wa = std::sin((1.f - t) * theta) / s;
    const float wb = std::sin(t * theta) / s * sign;
    for (int i = 0; i < 4; ++i) dst[i] = wa * a[i] + wb * b[i];
}

std::vector<float> read_f32(const fs::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("cannot open " + path.string());
    in.seekg(0, std::ios::end);
    auto size = in.tellg();
    in.seekg(0, std::ios::beg);
    if (size < 0) throw std::runtime_error("seek failed: " + path.string());
    std::vector<float> out(static_cast<size_t>(size / sizeof(float)));
    if (size > 0) in.read(reinterpret_cast<char *>(out.data()), size);
    return out;
}

void write_f32(const fs::path &path, std::span<const float> data) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) throw std::runtime_error("cannot write " + path.string());
    out.write(reinterpret_cast<const char *>(data.data()), data.size() * sizeof(float));
}

/**
 * 调试用：设置了环境变量 KIMODO_DUMP_DIR 时，把某个中间阶段的旋转落盘。
 * 用来逐阶段比对「帧间突跳」是在采样、尖峰抑制还是边界缓动里引入的。
 */
void debug_dump(const std::vector<float> &rot, const char *name) {
    const char *dir = std::getenv("KIMODO_DUMP_DIR");
    if (!dir || !*dir) return;
    std::error_code ec;
    fs::create_directories(dir, ec);
    write_f32(fs::path(dir) / name, rot);
}

// encode_motion + normalize：把 SOMA decoded f32 → normalized motion_rep
//
// 这是 shim 的核心 encode 步骤：把「root 位置 + 局部四元数」的 decoded 表示
// 转换成 Kimodo 模型训练时用的 motion_rep 表示，再按 GGUF 里的 stats 归一化。
// 是 motion_decode.cpp::decode_motion 的**逆过程**。
//
// motion_rep 布局（SOMA 30 关节，motion_dim() = 9 + 12*30 = 369）：
//   [0..4]   global_root  = [0, root.y, 0, cos(h), sin(h)]
//                       root.x/z 拆到 body[0]/body[2]，global_root 里这两维置 0
//   [5..7]   body[0..2]   = [root.x, root.y, root.z]
//   [8..97]  body[3..92]  = FK 关节位置（30 × 3），以 root 为原点
//   [98..277] body[93..272]= global cont6（30 × 6，global 旋转矩阵前两列）
//   [278..368] 余量填 0
//
// decode_motion 里还原 root 的公式：
//   root.x = denorm(global_root[0]) + denorm(body[0])
//   root.y = denorm(body[1])
//   root.z = denorm(global_root[2]) + denorm(body[2])
//
// 参数：
//   weights     - 动作模型权重（含 stats.mean/std）
//   s           - skeleton_spec（关节数、父子关系、骨骼偏移、hips）
//   root_pos    - [T, 3] 根节点位置
//   local_xyzw  - [T, J, 4] 局部旋转四元数（xyzw 顺序）
// 返回：
//   normalized motion_rep [T, D]，可直接作为 denoiser 的 observed
std::expected<std::vector<float>, std::string> encode_and_normalize(
    const kimodo::detail::ggml_motion_weights &weights,
    const kimodo::detail::skeleton_spec &s,
    std::span<const float> root_pos,
    std::span<const float> local_xyzw)
{
    const size_t J = s.joints();
    const size_t D = weights.motion_dim();
    if (root_pos.size() % 3 != 0) return std::unexpected("root_pos size not T*3");
    const size_t T = root_pos.size() / 3;
    if (local_xyzw.size() != T * J * 4) return std::unexpected("local_xyzw size mismatch");

    // 从 GGUF 读取全局统计量（训练集算出来的 mean/std，不是按序列的）
    const auto gm = weights.f32_values("stats.global_root.mean");
    const auto gs = weights.f32_values("stats.global_root.std");
    const auto bm = weights.f32_values("stats.body.mean");
    const auto bs = weights.f32_values("stats.body.std");
    if (!gm || !gs || !bm || !bs) return std::unexpected("motion GGUF lacks stats");
    const size_t body = D - 5;

    // 先构造 denorm 空间的 motion_rep，最后统一 normalize
    std::vector<float> denorm(T * D, 0.f);
    for (size_t t = 0; t < T; ++t) {
        const float *root = root_pos.data() + t * 3;
        const float *lx = local_xyzw.data() + t * J * 4;

        // ---- 正向运动学 FK：local quat → global 旋转矩阵 ----
        std::vector<mat> local(J), global(J);
        for (size_t j = 0; j < J; ++j) local[j] = quat_to_mat(lx + j * 4);
        for (size_t j = 0; j < J; ++j) {
            const int parent = s.parents[j];
            // 根关节 parent<0：global 旋转 = local 旋转
            global[j] = parent < 0 ? local[j]
                                  : mat_mul(global[static_cast<size_t>(parent)], local[j]);
        }

        // ---- FK：global 旋转 + 骨骼偏移 → 关节全局位置 ----
        std::vector<std::array<float, 3>> posed(J);
        for (size_t j = 0; j < J; ++j) {
            const int parent = s.parents[j];
            if (parent < 0) {
                posed[j] = {root[0], root[1], root[2]};   // 根关节位置 = root
            } else {
                std::array<float, 3> offset{};
                // 子关节的骨骼偏移需要按父关节的 global 旋转旋转
                mat_rotate(global[static_cast<size_t>(parent)], s.offsets[j], offset.data());
                for (int k = 0; k < 3; ++k)
                    posed[j][k] = posed[static_cast<size_t>(parent)][k] + offset[k];
            }
        }

        // ---- heading：用左右髋关节的 FK 位置差反算人物朝向 ----
        // 这与 Kimodo 官方 motion_rep 编码一致（decode 时再用 heading 还原）
        const size_t right = s.hips[0], left = s.hips[1];
        const float heading = std::atan2(posed[right][2] - posed[left][2],
                                         -(posed[right][0] - posed[left][0]));

        float *dst = denorm.data() + t * D;
        // global_root：root.x/z 留 0（拆到 body[0/2]），保留 root.y 和朝向
        dst[0] = 0.f; dst[1] = root[1]; dst[2] = 0.f;
        dst[3] = std::cos(heading); dst[4] = std::sin(heading);
        // body 前 3 维：完整 root 位置
        dst[5] = root[0]; dst[6] = root[1]; dst[7] = root[2];

        // FK 关节位置（以 root 为原点：减 global_root[0]=0, global_root[2]=0）
        for (size_t j = 0; j < J; ++j) {
            dst[5 + j * 3 + 0] = posed[j][0] - dst[0];
            dst[5 + j * 3 + 1] = posed[j][1];
            dst[5 + j * 3 + 2] = posed[j][2] - dst[2];
        }
        // global cont6：global 旋转矩阵前两列
        for (size_t j = 0; j < J; ++j)
            fill_cont6_from_mat(dst + 5 + 3 * J + j * 6, global[j]);
    }

    // ---- normalize：(x - mean) / sqrt(std^2 + 1e-5) ----
    std::vector<float> out(T * D);
    for (size_t t = 0; t < T; ++t) {
        const float *in = denorm.data() + t * D;
        float *dst = out.data() + t * D;
        for (size_t i = 0; i < 5; ++i) dst[i] = (in[i] - (*gm)[i]) / scale_sqrt((*gs)[i]);
        for (size_t i = 0; i < body; ++i) dst[5 + i] = (in[5 + i] - (*bm)[i]) / scale_sqrt((*bs)[i]);
    }
    return out;
}

// 双向 observed / observed_mask 构建：
// - 边界帧（prev 尾部 / next 头部）**整行**约束：global_root + FK 位置 + 全部关节 cont6
//   必须整行约束，因为 decode_motion 只用 cont6 还原旋转、不看 FK 位置；
//   官方 prepare_sequence_transition 只锁 end_effector 的 rotation，在双向硬切场景
//   会导致末帧 Hips 与 next 首帧差上百十度（实测 168°）
// - next 侧边界帧的根水平位置也一并锁定（曾试过放开，denoiser 会原地摆臂、
//   净位移趋近 0，舞台拉伸反而放大抖动，故撤回）
// - 中间帧 mask 全 0，denoiser 自由生成
// - prev 尾部 → observed 首段；next 头部 → observed 尾段
//
// 输入：
//   prev_norm - prev 段（已 normalize 的 motion_rep），取其尾部 tail_n 帧
//   next_norm - next 段（已 normalize 的 motion_rep），取其头部 head_n 帧
//   total_frames - 生成段总帧数
// 返回：
//   {observed, mask}，形状 [total_frames, D]
//   observed 是 normalized 空间的参考帧（denoiser 的约束目标）
//   mask 是 0/1 矩阵，1 表示该维度被约束
std::pair<std::vector<float>, std::vector<float>> build_bidirectional(
    [[maybe_unused]] const kimodo::detail::skeleton_spec &s,
    size_t total_frames, size_t D,
    std::span<const float> prev_norm, size_t tail_n,
    std::span<const float> next_norm, size_t head_n)
{
    tail_n = std::min(tail_n, prev_norm.size() / D);
    head_n = std::min(head_n, next_norm.size() / D);

    std::vector<float> observed(total_frames * D, 0.f);
    std::vector<float> mask(total_frames * D, 0.f);

    // 给边界帧 t 填 mask：整行置 1。
    // decode_motion 只用 cont6 还原全局旋转（root 也来自 global_root + body[0/2]），
    // body 里的 FK 位置完全不参与解码 → 只锁位置不锁旋转等于没锁姿态。
    // 因此边界帧的每一个 cont6 都必须观测，首尾才能精确还原 prev 末帧 / next 首帧。
    // observed 里超出 cont6 的余量维度也一并锁定（decode 不使用，无害）。
    auto fill_frame_mask = [&](size_t t) {
        float *row_mask = mask.data() + t * D;
        std::fill(row_mask, row_mask + D, 1.f);
    };

    // ===== prev 尾部：正序填入 observed[0..tail_n) =====
    // observed[t] = prev 倒数第 tail_n 帧 + t，因此 observed[tail_n-1] = prev 末帧。
    // 必须正序：反转填会把 prev 的尾部倒放，tail_n>1 时舞台上看就是倒带。
    // 这一段是模型的「进入速度/朝向」上下文；交付时前端会把 tail_n 帧从 trimStart
    // 剪掉（stage.ts completeTransition），所以不会真的在舞台上重播 prev。
    if (tail_n > 0) {
        const auto tail_begin = prev_norm.end() - static_cast<std::ptrdiff_t>(tail_n * D);
        for (size_t t = 0; t < tail_n; ++t) {
            const auto src = tail_begin + static_cast<std::ptrdiff_t>(t * D);
            std::copy(src, src + static_cast<std::ptrdiff_t>(D),
                      observed.begin() + static_cast<std::ptrdiff_t>(t * D));
            fill_frame_mask(t);
        }
    }
    // ===== next 头部：正序填入 observed[frames-head_n..frames) =====
    // observed[frames-head_n] = next 首帧，observed[frames-1] = next 倒数第 head_n 帧。
    // 交付时尾部 head_n 帧同样被剪掉，可见段的末帧正好是 next 首帧。
    if (head_n > 0) {
        const size_t dst_frame = total_frames - head_n;
        for (size_t t = 0; t < head_n; ++t) {
            const auto src = next_norm.begin() + static_cast<std::ptrdiff_t>(t * D);
            std::copy(src, src + static_cast<std::ptrdiff_t>(D),
                      observed.begin() + static_cast<std::ptrdiff_t>((dst_frame + t) * D));
            fill_frame_mask(dst_frame + t);
        }
    }
    // ===== 中间帧的根位移引导 =====
    // 只 pin 首尾两帧时 denoiser 会让角色原地做手势：实测 60 帧里根只走了 0.36m、
    // 双脚踝全程只抬 0~9cm（并排同步平移），舞台上再补 2m 位移就成了「滑步 + 扭动」。
    // 这里给中间帧铺一条 smoothstep 根轨迹（端点值直接取自已锁定的边界帧，
    // 归一化是逐维仿射，所以在归一化空间插值等价于在原空间插值），
    // 只锁根位置这几个维度，姿态完全不引导，交由模型自己生成。
    if (total_frames > 2 && !prev_norm.empty() && !next_norm.empty()) {
        // 0/2 也必须锁：decode_motion 的 root.x = global_root[0] + body[0]、
        // root.z = global_root[2] + body[2]，encode 把这两个平移分量写成 0 并拆到 body。
        // 只锁 body 时，模型在 global_root[0]/[2] 上自由漂移（实测末帧累计 -1.14m），
        // 解码后根位置就与引导曲线差出这么多——首段还会倒退、末帧突跳。
        // 高度 y 只锚首尾：逐帧锁死根高会抹掉走路时髋部的上下起伏，
        // 实测双脚全程悬空 5~10cm、贴地帧只剩 6/8，看着像滑行不像走。
        // 3/4 是 global_root 的 cos/sin(heading)。实测逐帧锁它几乎不改变结果
        // （hips 前向仍从 -5° 漂到 100°）：decode 的姿态完全由各关节 cont6 决定，
        // heading 这两维不参与姿态还原，锁它只是给 denoiser 一个无效信号。
        static constexpr size_t kRootHorizDims[] = {0, 2, 5, 7};   // global_root x/z + body 根 x/z
        static constexpr size_t kRootYDims[] = {1, 6};             // global_root y + body 根 y
        // 端点取自 prev 末帧 / next 首帧本身（而不是 observed 的首尾行），
        // 这样即使 transition_frames=0（不做姿态锚点）也能锁住整段跨越距离。
        const float *a = prev_norm.data() + (prev_norm.size() / D - 1) * D;  // prev 末帧
        const float *b = next_norm.data();                                  // next 首帧
        // 锚点窗口内的整行（含 root）已经由真实姿态锁定，不能再写插值引导，
        // 否则同一行里「姿态来自 prev/next、root 来自插值」会互相冲突。
        // 自由段 = [anchor_begin, anchor_end)，引导端点就是两侧锚点的边界帧。
        const size_t anchor_begin = tail_n;
        const size_t anchor_end = total_frames - std::min(head_n, total_frames);
        const size_t start_idx = tail_n > 0 ? tail_n - 1 : 0;
        const size_t end_idx = head_n > 0 ? anchor_end : total_frames - 1;
        const float span = static_cast<float>(end_idx) - static_cast<float>(start_idx);
        for (size_t t = anchor_begin; t < anchor_end && span > 0.5f; ++t) {
            const float x = (static_cast<float>(t) - static_cast<float>(start_idx)) / span;
            const float w = x * x * (3.f - 2.f * x);
            float *row = observed.data() + t * D;
            float *row_mask = mask.data() + t * D;
            // 水平位置逐帧引导：保证整段跨越距离与路径形状，且不会来回漂
            for (size_t d : kRootHorizDims) {
                row[d] = a[d] + (b[d] - a[d]) * w;
                row_mask[d] = 1.f;
            }
            // 根高只在首尾锁定（对齐前段末帧 / 后段首帧），中间交给模型自己起伏
            if (t == start_idx || t + 1 == end_idx) {
                for (size_t d : kRootYDims) {
                    row[d] = a[d] + (b[d] - a[d]) * w;
                    row_mask[d] = 1.f;
                }
            }
        }
    }
    return {observed, mask};
}

// ===== 解码后处理：抑制单帧尖峰 + 抖动关节压向低频轨迹 + 边界缓动 =====
//
// 背景：mask 修正后首尾帧已精确对齐（实测 0.0°），但 denoiser 只拿到「单帧锚点」
// 时，未被约束的自由度会退化：
//   - 倒数第 2 帧与末帧（= next 首帧）可差 60~170°，表现为最后一帧的瞬移；
//   - 手臂（LeftArm/RightArm/Hand）等未被提示词约束的关节出现大幅高频甩动，
//     帧间转角可达 130~170°，且每隔 4 帧净转 170° 左右，属于纯抖动；
//   - 中间帧偶发单帧孤立尖峰。
// 这些都与 FBX→f32 通路无关，是扩散采样在稀疏约束下的固有产物，
// 因此在 decode 之后做一次纯几何后处理（不改变首尾帧本身）：
//   1) 单帧尖峰：某帧四元数与「前后帧中点」夹角超过 SPIKE_ANGLE 时，
//      用前后帧的 slerp 中点替换（真实快速动作沿弧线走，不会偏离中点）。
//   2) 抖动关节阻尼：反复 binomial 平滑得到低频参考轨迹，再按关节的
//      「帧间最大转角」把该关节向参考轨迹混合——髋、腿等本来就平滑的关节
//      权重为 0 保持原样，手臂这类高频甩动的关节完全走低频轨迹。
//      躯干链路（髋/脊柱/颈/头）用更低的阈值和更狠的平滑：它们不该有
//      30°/帧以上的快速转动，而扩散采样偶尔会把整条脊柱在几帧内甩出去。
//   3) 根朝向归位：denoiser 会让整具身体在中段自转（实测 Hips 偏航 0°→131°→6°，
//      而锚点前后只差 11°），把根关节偏航换成 prev 末帧 → next 首帧的 smoothstep 曲线。
//   4) 躯干收拢：脊柱链（Spine1..Head）的世界朝向按 TORSO_DAMP 拉回
//      「prev 末帧 → next 首帧」的 smoothstep 插值。稀疏约束下模型会在段中把
//      上半身甩出去（肩 — 胸 — 颈同时偏转），视觉上就是走路时上身拧一下，
//      而这段摆动并非过渡所必需（两端锚点本身只差 ~20°）。
//      髋与腿不动，手臂挂在胸下跟着一起收。
//   5) 根位移摊平：末帧 anchor 与末帧前一帧的差值按 smoothstep 摊到整段，
//      避免 2m 位移全挤在最后一帧（否则舞台上是末帧瞬移或末段冲刺）。
//   6) 边界缓动：首/尾各 K 帧按 smoothstep 权重向锚点姿态靠拢，
//      把原本挤在末帧的整段旋转摊到 K 帧上；权重两端导数为 0，
//      与未处理序列衔接也不产生新的折角。

/** 单帧尖峰判定阈值：四元数与其前后帧中点夹角超过该值即视为孤立尖峰。 */
constexpr float SPIKE_ANGLE = 25.f * 3.14159265f / 180.f;

/** 肢体低频参考轨迹的 binomial 平滑迭代次数（σ≈2.4 帧）。 */
constexpr unsigned SMOOTH_PASSES = 12;

/** 躯干低频参考轨迹的 binomial 平滑迭代次数（σ≈4.2 帧）。 */
constexpr unsigned TORSO_SMOOTH_PASSES = 36;

/** 前 10 个关节是髋/脊柱/颈/头的慢速链路，抖动阈值要比四肢低得多。 */
constexpr size_t TORSO_JOINT_COUNT = 10;

/** 抖动评分分界（帧间最大转角，度）：低于 LO 原样保留，高于 HI 完全走低频轨迹。 */
constexpr float ERRATIC_LO_DEG = 25.f;
constexpr float ERRATIC_HI_DEG = 50.f;
constexpr float TORSO_LO_DEG = 10.f;
constexpr float TORSO_HI_DEG = 20.f;

/** 边界缓动帧数：首尾各 K 帧向锚点靠拢。 */
constexpr size_t EASE_FRAMES = 10;

/**
 * 多帧锚点专用：自由段两端各用多少帧向相邻锚点姿态收拢。
 *
 * 扩散模型对 mask 边界外的姿态没有连续性保证。实测 8 帧锚点时，
 * 末个自由帧与 next 首帧可差 160°，舞台上看是过渡段最后一帧瞬移；
 * 8 帧（≈0.27s）缓动能把这段差异摊成连续转向，且不碰锚点本身。
 */
constexpr size_t ANCHOR_EASE_FRAMES = 8;

/** 读环境变量里的浮点数；未设置或解析失败时返回 fallback。 */
float env_float(const char *name, float fallback) {
    const char *raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0') return fallback;
    char *end = nullptr;
    const float value = std::strtof(raw, &end);
    return (end != raw && std::isfinite(value)) ? value : fallback;
}

/**
 * 躯干世界朝向向「锚点插值」收拢的比例。
 *
 * 扩散采样在稀疏约束下会把上半身在段中甩出去（实测胸口偏航 0°→52°→0°、
 * 俯仰 0°→-63°→+40°，而两端锚点本身只差 6~14°），舞台上看就是走路时上身拧一下。
 * 0.85 表示把 85% 的偏离量收掉、保留 15% 的生成运动：实测残余偏离仍有
 * 14~15°（0.65 时是 32~36°），既不会把上身焊死，也不会让肩线明显歪掉。
 * 调参时用 KIMODO_TORSO_DAMP 覆盖（0 = 完全交给模型）。
 */
const float TORSO_DAMP = env_float("KIMODO_TORSO_DAMP", 0.85f);

constexpr float DEG = 3.14159265f / 180.f;

/** 球面加权平均：dst = normalize(w0*a + w1*b + w2*c)，符号对齐到 b。 */
void quat_blend3(float *dst, const float *a, float wa, const float *b, float wb, const float *c, float wc) {
    const float da = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3] < 0.f ? -1.f : 1.f;
    const float dc = c[0]*b[0] + c[1]*b[1] + c[2]*b[2] + c[3]*b[3] < 0.f ? -1.f : 1.f;
    for (int i = 0; i < 4; ++i) dst[i] = wa * da * a[i] + wb * b[i] + wc * dc * c[i];
    quat_normalize(dst);
}

/** 四元数乘：dst = a * b。允许 dst 与 a/b 之一别名。 */
void quat_mul(float *dst, const float *a, const float *b) {
    const float r[4] = {
        a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
        a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
        a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
        a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
    };
    for (int i = 0; i < 4; ++i) dst[i] = r[i];
}

/** 四元数(xyzw)绕 Y 轴的偏航角（弧度）。 */
float yaw_of(const float *q) {
    return std::atan2(2.f * (q[3]*q[1] + q[0]*q[2]), 1.f - 2.f * (q[1]*q[1] + q[2]*q[2]));
}

/** 绕 Y 轴 yaw 弧度的单位四元数。 */
void yaw_quat(float *q, float yaw) {
    q[0] = 0.f; q[1] = std::sin(yaw * 0.5f); q[2] = 0.f; q[3] = std::cos(yaw * 0.5f);
}

/**
 * 对 decode 结果做原地后处理。
 * 参数：
 *   rot_xyzw    - [frames, J, 4] 局部旋转（xyzw），就地修改
 *   root_pos    - [frames, 3] 根位置，就地修改
 *   prev_rot    - prev 段原始 decoded f32，末帧作为生成段首帧的姿态锚点
 *   next_rot    - next 段原始 decoded f32，首帧作为生成段尾帧的姿态锚点
 *   next_root   - next 段（已按 rootDelta 平移）的根位置，首帧作为终点锚点
 *   anchor_frames - 首尾各多少帧已被真实姿态锁定（transition_frames）
 * 单帧锚点时首帧与尾帧不做缓动，仍严格等于锚点；
 * 多帧锚点时只处理中间自由段，锚点窗口原样保留。
 */
void postprocess_decoded(
    std::vector<float> &rot_xyzw, std::vector<float> &root_pos, size_t frames, size_t J,
    std::span<const float> prev_rot, std::span<const float> next_rot,
    std::span<const float> next_root, const int *parents, size_t anchor_frames)
{
    if (frames < 3 || J == 0 || rot_xyzw.size() != frames * J * 4) return;
    // 实验开关：KIMODO_PP=0 时完全跳过几何后处理，输出即模型原始结果。
    // 首尾帧本来就由 decode 精确复现约束，跳过后也不会有边界跳变。
    if (const char *pp = std::getenv("KIMODO_PP"); pp != nullptr && std::strcmp(pp, "0") == 0) return;
    // 锚点窗口：首尾各 anchor_frames 帧已被真实姿态锁定，几何后处理只动中间自由段。
    // 单帧锚点时 anchor_frames==1，下面 3/4/5/6 步的补偿仍然生效；
    // 多帧窗口时模型能直接看到真实的进出速度/朝向，不再需要那些针对单帧锚点的强改。
    const size_t anchor = std::min({anchor_frames, frames / 2,
                                    prev_rot.size() / (J * 4), next_rot.size() / (J * 4)});
    const bool single_anchor = anchor <= 1;
    auto q_at = [&](std::vector<float> &v, size_t t, size_t j) { return v.data() + (t * J + j) * 4; };
    auto q_at_c = [&](const std::vector<float> &v, size_t t, size_t j) {
        return v.data() + (t * J + j) * 4;
    };

    // ---- 1) 单帧孤立尖峰抑制 ----
    // 从副本读邻帧：否则改完 t 再判 t+1 会连锁触发，把整段动作抹平
    {
        const std::vector<float> src = rot_xyzw;
        for (size_t t = std::max<size_t>(1, anchor); t < frames - anchor && t + 1 < frames; ++t) {
            for (size_t j = 0; j < J; ++j) {
                const float *a = q_at_c(src, t - 1, j);
                const float *b = q_at_c(src, t, j);
                const float *c = q_at_c(src, t + 1, j);
                float mid[4];
                quat_slerp(mid, a, c, 0.5f);
                if (quat_angle(b, mid) <= SPIKE_ANGLE) continue;
                quat_slerp(q_at(rot_xyzw, t, j), a, c, 0.5f);
            }
        }
    }
    debug_dump(rot_xyzw, "pp_stage1_spike.f32");

    // ---- 2) 抖动关节压向低频轨迹 ----
    // 反复 3 抽头 binomial 平滑，首尾锚点窗口不动（端点用 clamping 边缘），
    // 得到一条只保留慢变化的参考轨迹；高频甩动会被叠乘压到很低。
    {
        // src 是上一遍的结果，dst 原地写；每遍都要先整段拷贝，避免连锁读到半成品
        auto binomial_pass = [&](std::vector<float> &buf) {
            const std::vector<float> src = buf;
            for (size_t t = std::max<size_t>(1, anchor); t < frames - anchor && t + 1 < frames; ++t) {
                for (size_t j = 0; j < J; ++j)
                    quat_blend3(q_at(buf, t, j), q_at_c(src, t - 1, j), 0.25f,
                                q_at_c(src, t, j), 0.5f, q_at_c(src, t + 1, j), 0.25f);
            }
        };

        std::vector<float> low = rot_xyzw;
        for (unsigned pass = 0; pass < SMOOTH_PASSES; ++pass) binomial_pass(low);
        // 躯干要更狠的平滑：实测扩散采样会在 4~5 帧里把整条脊柱甩出 30~38°/帧
        // （肩 — 胸 — 颈同时反向），这种「鞭打」用 12 遍平滑只压掉一半，
        // 舞台上看就是上半身抽一下。躯干链路本身不该这么快，直接用到 36 遍。
        std::vector<float> low_torso = low;
        for (unsigned pass = SMOOTH_PASSES; pass < TORSO_SMOOTH_PASSES; ++pass) binomial_pass(low_torso);

        // 按原始序列的帧间最大转角决定每个关节的混合权重
        for (size_t j = 0; j < J; ++j) {
            float max_step = 0.f;
            for (size_t t = 1; t < frames; ++t)
                max_step = std::max(max_step, quat_angle(q_at(rot_xyzw, t - 1, j), q_at(rot_xyzw, t, j)));
            const float deg = max_step / DEG;
            const bool torso = j < TORSO_JOINT_COUNT;
            const float lo = torso ? TORSO_LO_DEG : ERRATIC_LO_DEG;
            const float hi = torso ? TORSO_HI_DEG : ERRATIC_HI_DEG;
            if (deg <= lo) continue;
            float w = std::min(1.f, (deg - lo) / (hi - lo));
            w = w * w * (3.f - 2.f * w);
            const std::vector<float> &ref = torso ? low_torso : low;
            for (size_t t = std::max<size_t>(1, anchor); t + 1 < frames - anchor; ++t)
                quat_slerp(q_at(rot_xyzw, t, j), q_at(rot_xyzw, t, j), q_at_c(ref, t, j), w);
        }
    }
    debug_dump(rot_xyzw, "pp_stage2_smooth.f32");

    // ---- 3) 根朝向（yaw）归位 ----
    // 双向只 pin 两帧时，denoiser 会让整具身体在中段自转（实测 Hips 偏航 0°→131°→6°），
    // 而锚点前后只差 11°，属于模型自己转了一圈，舞台上看就是原地扭动。
    // 这里把根关节的偏航换成「prev 末帧 → next 首帧」的 smoothstep 曲线，
    // 拆掉原 yaw 后剩下的俯仰/侧倾原样保留，整具身体跟着根一起转向、姿态本身不变。
    // 多帧锚点窗口下不再需要：模型已经拿到真实的进出朝向，中间交给它自己发挥。
    if (single_anchor) {
        const size_t prev_frames = prev_rot.size() / (J * 4);
        const size_t next_frames = next_rot.size() / (J * 4);
        if (prev_frames > 0 && next_frames > 0) {
            const float yaw0 = yaw_of(prev_rot.data() + (prev_frames - 1) * J * 4);
            float delta = yaw_of(next_rot.data()) - yaw0;
            // 取最近的等价角，避免走 360° 的另一边
            while (delta > 3.14159265f) delta -= 6.28318531f;
            while (delta < -3.14159265f) delta += 6.28318531f;
            for (size_t t = 1; t + 1 < frames; ++t) {
                const float x = static_cast<float>(t) / static_cast<float>(frames - 1);
                const float target = yaw0 + delta * (x * x * (3.f - 2.f * x));
                float *q = q_at(rot_xyzw, t, 0);
                float qy[4];
                yaw_quat(qy, yaw_of(q));
                float inv[4] = {-qy[0], -qy[1], -qy[2], qy[3]};   // 单位四元数共轭即逆
                float res[4];
                quat_mul(res, inv, q);
                float qt[4];
                yaw_quat(qt, target);
                quat_mul(q, qt, res);
                quat_normalize(q);
            }
        }
    }

    // ---- 4) 躯干世界朝向向锚点插值收拢 ----
    // 稀疏约束下 denoiser 会在段中把上半身甩出去（实测胸口偏航 0°→52°→0°、
    // 俯仰 0°→-63°→+40°，而两端锚点本身只差 ~20°），舞台上看就是走路时上身拧一下。
    // 这里只动脊柱链（Spine1..Head）：把每个关节的世界朝向沿最短弧拉回
    // 「prev 末帧 → next 首帧的 smoothstep 插值」TORSO_DAMP 的比例。
    // 髋不动，腿挂在髋下 → 站姿与踏步完全不受影响；手臂挂在胸上，跟着躯干一起收拢。
    // 多帧锚点窗口下跳过：这段收拢本身就是对「单帧锚点信息不足」的补偿。
    if (single_anchor && parents != nullptr) {
        const size_t prev_frames = prev_rot.size() / (J * 4);
        const size_t next_frames = next_rot.size() / (J * 4);
        if (prev_frames > 0 && next_frames > 0 && J > TORSO_JOINT_COUNT) {
            std::vector<std::array<float, 4>> w(J), wp(J), wn(J);
            // 局部旋转链式累乘（SOMA 的父索引恒小于子索引，正序即可）
            auto build_world = [&](const float *rows, size_t t, std::vector<std::array<float, 4>> &dst) {
                for (size_t j = 0; j < J; ++j) {
                    const float *l = rows + (t * J + j) * 4;
                    const int p = parents[j];
                    if (p < 0) {
                        for (int k = 0; k < 4; ++k) dst[j][k] = l[k];
                    } else {
                        quat_mul(dst[j].data(), dst[static_cast<size_t>(p)].data(), l);
                    }
                    quat_normalize(dst[j].data());
                }
            };
            build_world(prev_rot.data(), prev_frames - 1, wp);
            build_world(next_rot.data(), 0, wn);

            for (size_t t = 1; t + 1 < frames; ++t) {
                build_world(rot_xyzw.data(), t, w);
                const float x = static_cast<float>(t) / static_cast<float>(frames - 1);
                const float s = x * x * (3.f - 2.f * x);
                // 从髋的子节点开始逐级往下：父的世界改过，子的局部量要按新父世界重算
                for (size_t j = 1; j < J && j < TORSO_JOINT_COUNT; ++j) {
                    float base[4], target[4], local[4], inv[4];
                    quat_slerp(base, wp[j].data(), wn[j].data(), s);
                    quat_slerp(target, w[j].data(), base, TORSO_DAMP);
                    quat_normalize(target);
                    const int p = parents[j];
                    const float *pw = w[static_cast<size_t>(p)].data();
                    inv[0] = -pw[0]; inv[1] = -pw[1]; inv[2] = -pw[2]; inv[3] = pw[3];
                    quat_mul(local, inv, target);
                    quat_normalize(local);
                    for (int k = 0; k < 4; ++k) {
                        q_at(rot_xyzw, t, j)[k] = local[k];
                        w[j][k] = target[k];
                    }
                }
            }
        }
    }

    // ---- 5) 根位移摊平 ----
    // 末帧必须等于 next 首帧（mask 已保证），但 denoiser 常把 2m 位移全丢给末帧、
    // 前面几十帧几乎不动 → 最后一帧的瞬移。这里把「末帧之前的剩余位移」按 smoothstep
    // 摊到整段：两端导数为 0，起步和到达都不产生速度突变；首帧与末帧保持不动。
    // 多帧窗口里 root 逐帧由真实段落与中间引导锁定，produced 的位移分布已连续，不再摊平。
    if (single_anchor && frames >= 4 && next_root.size() >= 3) {
        const float *anchor = next_root.data();
        float *last = root_pos.data() + (frames - 2) * 3;       // 末帧之前的最后一帧
        float delta[3];
        for (int i = 0; i < 3; ++i) delta[i] = anchor[i] - last[i];
        const float span = static_cast<float>(frames - 3);
        for (size_t t = 1; t + 1 < frames; ++t) {
            const float x = static_cast<float>(t - 1) / span;
            const float w = x * x * (3.f - 2.f * x);
            float *r = root_pos.data() + t * 3;
            for (int i = 0; i < 3; ++i) r[i] += delta[i] * w;
        }
    }

    // ---- 5b) 多帧锚点：自由段两端向相邻锚点收拢 ----
    // 扩散模型对 mask 边界外的姿态没有连续性保证：实测末个自由帧与 next 首帧可差
    // 160°，舞台上就是过渡段最后一帧瞬移。只处理自由段最靠近锚点的 8 帧，
    // 权重 smoothstep 从紧贴锚点的 1 衰减到内侧的 0；锚点窗口与中间段都不动。
    if (!single_anchor) {
        const size_t prev_frames = prev_rot.size() / (J * 4);
        const size_t next_frames = next_rot.size() / (J * 4);
        const size_t free_len = frames - 2 * anchor;
        const size_t ease = std::min({ANCHOR_EASE_FRAMES, anchor, free_len / 2});
        if (ease > 0 && prev_frames > 0 && next_frames > 0) {
            const float *head_anchor = prev_rot.data() + (prev_frames - 1) * J * 4;  // prev 末帧
            const float *tail_anchor = next_rot.data();                              // next 首帧
            for (size_t i = 0; i < ease; ++i) {
                // i=0 是紧贴锚点的自由帧（权重 1），i=ease-1 是缓动窗口内侧（权重≈0）
                const float x = static_cast<float>(ease - i) / static_cast<float>(ease);
                const float w = x * x * (3.f - 2.f * x);
                const size_t head_t = anchor + i;
                const size_t tail_t = frames - anchor - 1 - i;
                for (size_t j = 0; j < J; ++j) {
                    quat_slerp(q_at(rot_xyzw, head_t, j), q_at(rot_xyzw, head_t, j),
                               head_anchor + j * 4, w);
                    quat_slerp(q_at(rot_xyzw, tail_t, j), q_at(rot_xyzw, tail_t, j),
                               tail_anchor + j * 4, w);
                }
            }
        }
    }

    // ---- 6) 首尾各 K 帧向锚点姿态缓动 ----
    debug_dump(rot_xyzw, "pp_stage4_preEase.f32");
    // 多帧锚点窗口已把真实进出姿态钉进首尾各 N 帧，这段单帧锚点的补偿直接跳过
    if (!single_anchor) {
        debug_dump(rot_xyzw, "pp_final.f32");
        return;
    }
    // K 不超过半段，避免两端窗口重叠互相拉扯
    const size_t K = std::min(EASE_FRAMES, (frames - 1) / 2);
    if (K == 0) return;

    // 缓动权重：k=0 是锚点那一帧（s=1，严格等于锚点），k=K 是窗口内侧第一帧（s=0，
    // 与未缓动区域无缝衔接）。smoothstep 保证接缝处变化率为 0。
    auto ease_weight = [&](size_t k) {
        const float x = static_cast<float>(K - k) / static_cast<float>(K);
        return x * x * (3.f - 2.f * x);
    };

    /**
     * 窗口混合：整段窗口内所有帧都在「窗口基准帧 → 锚点」这一条固定测地线上取值，
     * P(s) = slerp(基准帧, 锚点, s)，s 按 smoothstep 从 0 到 1。
     *
     * 为什么不用逐帧 slerp(生成帧, 锚点, w)：模型在无姿态约束时会把尾部拧反
     * （实测 LeftHand / Head 子关节与锚点差 165~179°），此时每一帧到锚点的大圆
     * 方向由叉积决定，相邻帧一旦跨过对跖点方向就翻转——缓动本身反而造出
     * 124°~140° 的帧间突跳。固定基准帧后路径唯一，s 连续则结果必然连续，
     * 且 s=1 时严格等于锚点。
     */
    auto apply_window_blend = [&](size_t frame, float s, const float *base_src, const float *anchor_rot) {
        for (size_t j = 0; j < J; ++j) {
            float *q = q_at(rot_xyzw, frame, j);
            quat_slerp(q, base_src + j * 4, anchor_rot + j * 4, s);
            quat_normalize(q);
        }
    };

    // 首段：基准帧 = 生成段第 K 帧，锚点 = prev 末帧
    const size_t prev_frames = prev_rot.size() / (J * 4);
    if (prev_frames > 0) {
        const float *anchor_rot = prev_rot.data() + (prev_frames - 1) * J * 4;
        const std::vector<float> base(rot_xyzw.begin() + static_cast<std::ptrdiff_t>(K * J * 4),
                                      rot_xyzw.begin() + static_cast<std::ptrdiff_t>((K + 1) * J * 4));
        for (size_t k = 0; k <= K; ++k)
            apply_window_blend(k, ease_weight(k), base.data(), anchor_rot);
    }

    // 尾段：基准帧 = 生成段倒数第 K+1 帧，锚点 = next 首帧
    const size_t next_frames = next_rot.size() / (J * 4);
    if (next_frames > 0) {
        const float *anchor_rot = next_rot.data();
        const std::vector<float> base(
            rot_xyzw.begin() + static_cast<std::ptrdiff_t>((frames - 1 - K) * J * 4),
            rot_xyzw.begin() + static_cast<std::ptrdiff_t>((frames - K) * J * 4));
        for (size_t k = 0; k <= K; ++k)
            apply_window_blend(frames - 1 - k, ease_weight(k), base.data(), anchor_rot);
    }
    debug_dump(rot_xyzw, "pp_final.f32");
}

std::vector<std::string> split_fields(const std::string &line) {
    std::vector<std::string> fields;
    std::string field;
    std::istringstream input(line);
    while (std::getline(input, field, '\t')) fields.push_back(field);
    return fields;
}
std::string err_text(std::string message) {
    for (char &c : message) if (c == '\n' || c == '\r' || c == '\t') c = ' ';
    return message;
}

} // namespace

int main(int argc, char **argv) try {
    // 启动参数：kmd-conditioned-server MOTION.gguf TEXT_BUNDLE.gguf
    // 常驻进程，启动时一次性加载模型权重和文本编码器，后续每行一个请求
    if (argc < 3) {
        std::cerr << "usage: kmd-conditioned-server MOTION.gguf TEXT_BUNDLE\n";
        return 2;
    }

    // 加载动作模型（含 skeleton 定义、stats.mean/std、网络权重）
    auto weights_res = kimodo::detail::ggml_motion_weights::load(argv[1]);
    if (!weights_res) { std::cerr << "ERR\t" << err_text(weights_res.error()) << '\n'; return 1; }
    auto &weights = *weights_res.value();

    // 加载 Llama-3-Kimodo 文本编码器（生成 4096 维 prompt embedding）
    auto text_res = kimodo::detail::llm_text_encoder::load(argv[2]);
    if (!text_res) { std::cerr << "ERR\t" << err_text(text_res.error()) << '\n'; return 1; }
    auto &text = *text_res.value();

    // 根据模型内置的 skeleton_key 查关节定义（soma30）
    const auto *skeleton = kimodo::detail::find_skeleton(weights.skeleton_key());
    if (!skeleton) { std::cerr << "ERR\tunsupported skeleton: " << weights.skeleton_key() << '\n'; return 1; }
    const size_t D = weights.motion_dim();  // = 369 (soma30)

    std::string line;
    // 逐行处理请求，每行是一个 CONDITIONED 任务
    while (std::getline(std::cin, line)) {
        try {
            // ---- 解析协议行 ----
            // CONDITIONED\tSTEPS\tSEED\tOUTPUT_DIR\tPREV_ROOT\tPREV_ROT\tNEXT_ROOT\tNEXT_ROT\tTRANS_FRAMES\tTOTAL_FRAMES\tPROMPT
            const auto fields = split_fields(line);
            if (fields.size() != 11 || fields[0] != "CONDITIONED") {
                std::cout << "ERR\tinvalid request fields\n" << std::flush;
                continue;
            }
            const unsigned steps = static_cast<unsigned>(std::stoul(fields[1]));
            const std::uint64_t seed = static_cast<std::uint64_t>(std::stoull(fields[2]));
            const fs::path output_dir = fields[3];
            const fs::path prev_root = fields[4];
            const fs::path prev_rot = fields[5];
            const fs::path next_root = fields[6];
            const fs::path next_rot = fields[7];
            const unsigned transition_frames = static_cast<unsigned>(std::stoul(fields[8]));
            const unsigned frames = static_cast<unsigned>(std::stoul(fields[9]));
            const fs::path prompt_path = fields[10];

            if (frames <= 2) { std::cout << "ERR\ttotal_frames must be > 2\n" << std::flush; continue; }

            // 1) 读 prev/next 的 decoded f32（root_positions [T,3] + local_xyzw [T,30,4]），
            //    encode 成 motion_rep 并 normalize。
            //    prev 取尾部 transition_frames 帧，next 取头部 transition_frames 帧。
            const auto prev_root_data = read_f32(prev_root);
            const auto prev_rot_data = read_f32(prev_rot);
            const auto next_root_data = read_f32(next_root);
            const auto next_rot_data = read_f32(next_rot);

            const auto prev_enc = encode_and_normalize(weights, *skeleton, prev_root_data, prev_rot_data);
            if (!prev_enc) { std::cout << "ERR\t" << err_text(prev_enc.error()) << '\n' << std::flush; continue; }
            const auto next_enc = encode_and_normalize(weights, *skeleton, next_root_data, next_rot_data);
            if (!next_enc) { std::cout << "ERR\t" << err_text(next_enc.error()) << '\n' << std::flush; continue; }

            // 2) 构建双向 observed / mask：
            //    observed[0..T)           = prev 尾部 T 帧（observed[T-1] = prev 末帧）
            //    observed[frames-T..frames)= next 头部 T 帧（observed[frames-T] = next 首帧）
            //    中间帧只锁 root 引导，姿态完全交给 denoiser 自由生成
            //    T=1 即旧行为；T>1 时是一段真实的进出速度/朝向窗口。
            const auto [observed, mask] = build_bidirectional(
                *skeleton, frames, D,
                *prev_enc, transition_frames,
                *next_enc, transition_frames);

            // 3) 文本 embedding：提示词 → 4096 维向量，指导 denoiser 的中间过渡风格
            std::ifstream prompt_file(prompt_path);
            std::string prompt{std::istreambuf_iterator<char>(prompt_file), {}};
            if (!prompt_file && prompt.empty()) {
                std::cout << "ERR\tcannot read prompt\n" << std::flush; continue;
            }
            auto embedding_res = text.encode(prompt);
            if (!embedding_res) { std::cout << "ERR\t" << err_text(embedding_res.error()) << '\n' << std::flush; continue; }

            // 4) 初始噪声：DDIM 从高斯噪声开始，由 seed 控制可复现
            std::mt19937_64 rng(seed);
            std::normal_distribution<float> normal(0.f, 1.f);
            std::vector<float> noise(static_cast<size_t>(frames) * D);
            for (float &v : noise) v = normal(rng);

            // 5) 条件扩散采样
            //   - text_weight=2.0：文本引导强度（与 Kimodo 官方默认一致）
            //   - constraint_weight=2.0：约束引导强度
            //   - heading=0：双向约束下 heading 不重要，全局旋转已由 FK 位置约束
            const float text_cfg = env_float("KIMODO_TEXT_CFG", 2.f);
            const float constraint_cfg = env_float("KIMODO_CONSTRAINT_CFG", 2.f);
            auto sampled = kimodo::detail::sample_motion_from_noise_conditioned(
                weights, noise, *embedding_res, observed, mask,
                0.f, frames, steps, text_cfg, constraint_cfg);
            if (!sampled) { std::cout << "ERR\t" << err_text(sampled.error()) << '\n' << std::flush; continue; }

            // ===== 硬约束覆盖：mask=1 的位置直接填 observed 值 =====
            // 原因：denoiser 内部的 mask 融合（dst = motion*(1-mask) + observed*mask）
            //       发生在 DDIM 输入层，是平滑逼近而非硬替换。
            //       即使 50 步 DDIM，约束位置也会有 ~5cm 残差，达不到"首尾精确对齐"。
            //       所以在 normalized 空间里直接把 mask=1 的位置替换成 observed 值。
            for (size_t i = 0; i < sampled->size(); ++i) {
                if (mask[i] > 0.5f) (*sampled)[i] = observed[i];
            }

            // 6) 空间确认：
            //    sample_motion_from_noise_conditioned 返回 **normalized 空间**
            //    （DDIM 全程在 normalized 空间运行，见 denoiser.hpp 注释）。
            //    decode_motion 也接受 **normalized 输入**，内部先 denorm 再解码。
            //    所以 sampled 直接传给 decode_motion，**不再做额外 normalize/denorm**。
            const auto gm = weights.f32_values("stats.global_root.mean");
            const auto gs = weights.f32_values("stats.global_root.std");
            const auto bm = weights.f32_values("stats.body.mean");
            const auto bs = weights.f32_values("stats.body.std");
            if (!gm || !gs || !bm || !bs) { std::cout << "ERR\tGGUF stats missing\n" << std::flush; continue; }

            // 7) decode：normalized motion_rep → root_positions [T,3] + local_xyzw [T,30,4]
            auto decoded = kimodo::detail::decode_motion(
                *sampled, frames, *skeleton, *gm, *gs, *bm, *bs);
            if (!decoded) { std::cout << "ERR\t" << err_text(decoded.error()) << '\n' << std::flush; continue; }

            // 8) 后处理：单帧锚点(transition_frames=1)保留原有的根朝向归位/躯干收拢/
            //    根位移摊平/边界缓动；多帧锚点窗口只做尖峰抑制与抖动阻尼，
            //    锚点窗口与中间段之间的衔接完全交给模型和真实姿态。
            debug_dump(decoded->local_xyzw, "pp_stage0_raw.f32");
            postprocess_decoded(
                decoded->local_xyzw, decoded->root_positions, frames, skeleton->joints(),
                prev_rot_data, next_rot_data, next_root_data, skeleton->parents.data(),
                transition_frames);

            // 写出到 output_dir，格式与 kmd-generate --server 完全一致
            fs::create_directories(output_dir);
            write_f32(output_dir / "root_positions.f32", decoded->root_positions);
            write_f32(output_dir / "local_rotations_xyzw.f32", decoded->local_xyzw);

            // 响应：OK\tFRAMES\tJOINTS
            std::cout << "OK\t" << frames << '\t' << skeleton->joints() << '\n' << std::flush;
        } catch (const std::exception &e) {
            // 单任务失败不影响常驻进程，输出 ERR 后继续处理下一个请求
            std::cout << "ERR\t" << err_text(e.what()) << '\n' << std::flush;
        }
    }
    return 0;
} catch (const std::exception &e) {
    std::cerr << "ERR\t" << err_text(e.what()) << '\n';
    return 1;
}
