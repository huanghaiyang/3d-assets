# Kimodo CUDA 编译指南

本文档记录如何在 Windows 上把 [kimodo.cpp](https://github.com/andrewyng/kimodo.cpp) 编译为带 CUDA 后端的 `kmd-generate.exe`，并接入本项目的文生动作管线。

> CPU 版本开箱即用，但单段 60 帧 / 20 步需要数分钟；切到 CUDA 后同一段约 1.5–3 分钟（取决于显卡）。

---

## 1. 前置条件

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| 显卡 | NVIDIA，显存 ≥ 6 GB | 本项目在 RTX 3060 Laptop（6 GB）上验证通过 |
| NVIDIA 驱动 | 支持对应 CUDA 版本 | `nvidia-smi` 可查看驱动支持的最高 CUDA 版本 |
| CUDA Toolkit | 与驱动匹配（本文用 v12.2） | 安装时勾选 **Visual Studio Integration** |
| Visual Studio 2022 | Community / Pro 均可，带「C++ 桌面开发」工作负载 | 本文用 v17.10（MSVC 14.40） |
| CMake | ≥ 3.20 | `cmake --version` 确认 |
| Git | 用于拉取 kimodo.cpp 源码 | — |

确认 CUDA 安装：

```powershell
nvcc --version        # 应输出 CUDA 版本
nvidia-smi            # 确认显卡与驱动
```

---

## 2. 获取源码

```powershell
git clone https://github.com/andrewyng/kimodo.cpp D:\thirdparty\kimodo.cpp
```

路径可自选，下文统一记作 `KIMODO_SRC=D:\thirdparty\kimodo.cpp`。

---

## 3. 配置（CMake）

### 3.1 为什么用 NMake 而不是 VS 生成器

kimodo.cpp 用 `ggml`，启用 CUDA 需要 CMake 能找到 CUDA toolset。如果直接用

```powershell
cmake -G "Visual Studio 17 2022" -DGGML_CUDA=ON ...
```

通常会报 **"No CUDA toolset found"**——即使 CUDA Toolkit 已安装，
CUDA 的 VS 集成文件（`C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.2\extras\visual_studio_integration\MSBuildExtensions`）
也需要被复制到 VS 的 MSBuild 目录，而该目录需要管理员权限。

**绕过方法**：改用 **NMake Makefiles** 生成器，由 `nvcc` 直接编译，不依赖 VS 的 CUDA toolset 注册。

### 3.2 准备编译环境

在 PowerShell 里加载 VS 编译环境并把 CUDA 加入 PATH：

```powershell
# 加载 VS 2022 环境（路径按实际安装位置调整）
& "D:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

# 把 CUDA bin 加入 PATH（供 cmake 找 nvcc）
$env:Path = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.2\bin;" + $env:Path
```

### 3.3 Configure

```powershell
cmake -S D:\thirdparty\kimodo.cpp `
      -B D:\thirdparty\kimodo.cpp\build-cuda `
      -G "NMake Makefiles" `
      -DGGML_CUDA=ON `
      -DKIMODO_ENABLE_VULKAN=OFF `
      -DCMAKE_BUILD_TYPE=Release `
      -DCMAKE_CUDA_ARCHITECTURES=86 `
      -DCMAKE_CUDA_FLAGS="-allow-unsupported-compiler"
```

参数说明：

| 参数 | 作用 |
| --- | --- |
| `-G "NMake Makefiles"` | 绕过 VS CUDA toolset 注册问题，直接用 nvcc |
| `-DGGML_CUDA=ON` | 启用 CUDA 后端 |
| `-DKIMODO_ENABLE_VULKAN=OFF` | **关键**：kimodo 的 CMakeLists 里写死了 `set(GGML_VULKAN ${KIMODO_ENABLE_VULKAN} ... FORCE)`，直接传 `-DGGML_VULKAN=OFF` 会被覆盖。关 Vulkan 是为了在没装 Vulkan SDK 的机器上也能过 configure |
| `-DCMAKE_CUDA_ARCHITECTURES=86` | 显卡架构。RTX 30 系（Ampere）是 `86`；40 系（Ada）用 `89`；可用 `nvidia-smi --query-gpu=name --format=csv` 查型号后对照 [CUDA GPU 列表](https://developer.nvidia.com/cuda-gpus) |
| `-DCMAKE_CUDA_FLAGS="-allow-unsupported-compiler"` | CUDA 12.2 不认 MSVC 14.40，加此 flag 跳过编译器版本检查 |

> 如果你的 CUDA 版本 ≥ 12.4 且 VS 版本较新，可能不需要 `-allow-unsupported-compiler`。

---

## 4. 编译

只编 `kmd-generate` 目标即可（不用编测试与示例，省时间）：

```powershell
cmake --build D:\thirdparty\kimodo.cpp\build-cuda --target kmd-generate --config Release
```

> nmake 是单线程编译，CUDA 模板编译较慢，首次约需 **40–70 分钟**。
> 想并行可以用 `cmake --build ... -- -j`，但 nmake 的 `-j` 支持有限，收益不大。

编译产物：

```
build-cuda\
├── kmd-generate.exe          # 主程序
└── bin\
    ├── ggml.dll
    ├── ggml-base.dll
    ├── ggml-cpu.dll
    └── ggml-cuda.dll         # ~180 MB，CUDA 后端
```

---

## 5. 接入本项目

### 5.1 配置 `.env`

在项目根目录 `.env` 中设置（不要提交到仓库，`.env` 已被 gitignore）：

```ini
# 指向刚编译的可执行文件
KIMODO_GENERATE_EXE=D:\thirdparty\kimodo.cpp\build-cuda\kmd-generate.exe

# 动作模型与文本 bundle 路径（从 kimodo.cpp 官方发布页下载）
KIMODO_MOTION_MODEL=D:\thirdparty\kimodo.cpp\models\kimodo-motion.safetensors
KIMODO_TEXT_BUNDLE=D:\thirdparty\kimodo.cpp\models\text-bundle.safetensors

# 选 cuda 后端
KIMODO_BACKEND=cuda

# 输出目录（默认 data/kimodo-output，可不填）
# KIMODO_OUTPUT_DIR=

# 用于把生成结果转成 Mixamo JSON 的 Python（默认 python）
# KIMODO_PYTHON=python
```

### 5.2 DLL 自动发现

`apps/api/src/services/kimodo.ts` 的 `collectDllDirs()` 会从 `kmd-generate.exe` 所在目录向上扫描 3 层，
把所有含 `.dll` 的子目录自动加入进程 `PATH`，因此 **不需要手动把 `build-cuda\bin` 加到系统 PATH**——
只要 `ggml-cuda.dll` 等在 `build-cuda\` 或其下任意子目录，运行时就能找到。

如果运行时仍报找不到 DLL，可手动确认：

```powershell
# 列出 build-cuda 下的 dll
Get-ChildItem -Path D:\thirdparty\kimodo.cpp\build-cuda -Recurse -Filter *.dll | Select-Object FullName
```

---

## 6. 验证

启动 API 后查状态：

```powershell
npm start -w @h3d/api
# 另开终端
Invoke-RestMethod http://127.0.0.1:8788/api/kimodo/status | ConvertTo-Json -Depth 3
```

期望返回：

```json
{
  "backend": "cuda",
  "running": true,
  ...
}
```

跑一个小任务（8 帧 / 5 步）确认 GPU 被占用：

```powershell
# 提交任务
$body = @{ prompt = "a person waves one hand"; frames = 8; steps = 5 } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8788/api/kimodo/generate `
          -Body $body -ContentType "application/json"
$id = $resp.task.id

# 观察 GPU（另开终端，反复运行）
nvidia-smi

# 轮询直到 status=ready
while ((Invoke-RestMethod "http://127.0.0.1:8788/api/kimodo/animation/$id").status -ne "ready") {
  Start-Sleep -Seconds 5
}
"done: $id"

# 清理测试任务
Invoke-RestMethod -Method Delete "http://127.0.0.1:8788/api/kimodo/animations/$id"
```

`nvidia-smi` 应能看到 `kmd-generate.exe` 进程占用显存（6 GB 卡上约 3–4 GB）。

---

## 7. 常见问题

### Q1：`No CUDA toolset found` / `Could NOT find CUDA`

- 确认 `nvcc --version` 有输出。
- 确认已用 `-G "NMake Makefiles"` 而不是 VS 生成器。
- 确认 `vcvars64.bat` 已加载，且 CUDA `bin` 在 `PATH` 里。

### Q2：`unsupported Microsoft Visual Studio version`

CUDA 版本与 VS 版本不匹配时，nvcc 会拒绝编译。加 `-DCMAKE_CUDA_FLAGS="-allow-unsupported-compiler"` 跳过检查。
若仍失败，升级 CUDA Toolkit 到支持该 MSVC 的版本（CUDA 12.4+ 支持 VS 17.10）。

### Q3：`Could NOT find Vulkan`

kimodo 的 CMakeLists 默认开 Vulkan。如果机器没装 Vulkan SDK，configure 会失败。
用 `-DKIMODO_ENABLE_VULKAN=OFF`（注意是 `KIMODO_ENABLE_VULKAN`，不是 `GGML_VULKAN`，
后者会被 CMakeLists 里的 `FORCE` 覆盖）。

### Q4：运行时 `ggml-cuda.dll not found` / `0xc000007b`

- 确认 `build-cuda\bin\` 下有 `ggml-cuda.dll`。
- `collectDllDirs()` 只向上扫 3 层；如果 exe 放得太深，DLL 目录可能扫不到。
  把 `build-cuda\bin` 手动加到系统 `PATH`，或把 DLL 复制到 `kmd-generate.exe` 同目录。

### Q5：`CUDA out of memory`

6 GB 显存跑 60 帧 / 20 步可能吃满。可：
- 减少帧数或步数；
- 设置 `KIMODO_TEXT_LAYER_CHUNK=<MB>` 限制文本层常驻显存大小（服务端默认 10000）。

### Q6：编译太慢

CUDA 模板实例化耗时。可考虑：
- 只编 `kmd-generate` 目标（不要编全量）；
- 升级到 CUDA 12.4 + 新版 VS，可用 Ninja 生成器并行编译。

---

## 8. 参考

- [kimodo.cpp 仓库](https://github.com/andrewyng/kimodo.cpp)
- [ggml CUDA 后端文档](https://github.com/ggerganov/ggml)
- [CUDA GPU 架构对照表](https://developer.nvidia.com/cuda-gpus)
- 本项目 Kimodo 服务实现：[apps/api/src/services/kimodo.ts](../apps/api/src/services/kimodo.ts)
