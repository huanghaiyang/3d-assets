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

#include "denoiser.hpp"
#include "ggml_weights.hpp"
#include "llm_text_encoder.hpp"
#include "motion_decode.hpp"
#include "skeleton.hpp"

#include <cstdint>
#include <cstdio>
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

// 双向 observed / observed_mask 构建，对齐 Kimodo 官方 sequence.cpp prepare_sequence_transition：
// - global_root 前 5 维 + 所有关节 FK 位置（rotation_begin 之前）全约束
// - rotation 只约束 end_effectors（中间骨架旋转交给 denoiser 自己决定）
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
    const kimodo::detail::skeleton_spec &s,
    size_t total_frames, size_t D,
    std::span<const float> prev_norm, size_t tail_n,
    std::span<const float> next_norm, size_t head_n)
{
    tail_n = std::min(tail_n, prev_norm.size() / D);
    head_n = std::min(head_n, next_norm.size() / D);
    const size_t J = s.joints();
    const size_t rotation_begin = 5 + 3 * J;  // global_root(5) + FK 位置(3*J)

    std::vector<float> observed(total_frames * D, 0.f);
    std::vector<float> mask(total_frames * D, 0.f);

    // 给第 t 帧填官方格式的 mask：
    //   [0, rotation_begin)        → 1（global_root + FK 位置全约束）
    //   end_effectors 的 cont6    → 1（手脚旋转锁定）
    //   中间骨架 rotation          → 0（让 denoiser 自由发挥）
    auto fill_frame_mask = [&](size_t t) {
        float *row_mask = mask.data() + t * D;
        std::fill(row_mask, row_mask + rotation_begin, 1.f);
        for (unsigned joint : s.end_effectors) {
            float *first = row_mask + rotation_begin + joint * 6;
            std::fill(first, first + 6, 1.f);
        }
    };

    // ===== prev 尾部：**反转**填入 observed[0..tail_n) =====
    // observed[0] = prev 末帧，observed[tail_n-1] = prev 倒数第 tail_n 帧
    // 反转目的：让生成段首帧直接 = prev 末帧，而不是 = prev 倒数第 tail_n 帧。
    // （若正序填，observed[0] 会是 prev 倒数第 tail_n 帧，导致首帧不对齐）
    if (tail_n > 0) {
        const auto tail_begin = prev_norm.end() - static_cast<std::ptrdiff_t>(tail_n * D);
        for (size_t t = 0; t < tail_n; ++t) {
            const auto src = tail_begin + static_cast<std::ptrdiff_t>((tail_n - 1 - t) * D);
            std::copy(src, src + static_cast<std::ptrdiff_t>(D),
                      observed.begin() + static_cast<std::ptrdiff_t>(t * D));
            fill_frame_mask(t);
        }
    }
    // ===== next 头部：**反转**填入 observed[frames-head_n..frames) =====
    // observed[frames-1] = next 首帧，observed[frames-head_n] = next 第 head_n 帧
    // 反转目的：让生成段尾帧直接 = next 首帧。
    if (head_n > 0) {
        const size_t dst_frame = total_frames - head_n;
        for (size_t t = 0; t < head_n; ++t) {
            const auto src = next_norm.begin() + static_cast<std::ptrdiff_t>((head_n - 1 - t) * D);
            std::copy(src, src + static_cast<std::ptrdiff_t>(D),
                      observed.begin() + static_cast<std::ptrdiff_t>((dst_frame + t) * D));
            fill_frame_mask(dst_frame + t);
        }
    }
    return {observed, mask};
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
            //    observed[0]            = prev 末帧（约束生成段首帧）
            //    observed[frames-1]     = next 首帧（约束生成段尾帧）
            //    中间帧 observed 全 0，mask 全 0，denoiser 自由生成
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
            auto sampled = kimodo::detail::sample_motion_from_noise_conditioned(
                weights, noise, *embedding_res, observed, mask,
                0.f, frames, steps, 2.f, 2.f);
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
