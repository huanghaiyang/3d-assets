# Kimodo GPU 编译指南（Vulkan）

本文档记录如何在 Windows 上把 [kimodo.cpp](https://github.com/andrewyng/kimodo.cpp) 编译为带 **Vulkan** GPU 后端的 `kmd-generate.exe`，并接入本项目的文生动作管线。

> **重要：kimodo 不支持 CUDA。**
> 它的源码里只有两条推理路径 —— **Vulkan**（主路径）和 **CPU**（兜底）。
> `src/` 下零处 `ggml_backend_cuda_init`，`CMakeLists.txt` 也没有任何 CUDA 选项。
> 即使编译时打开 `GGML_CUDA=ON`，生成的 `ggml-cuda.dll` 也不会被调用。
> 想用 NVIDIA 显卡加速，走 **Vulkan**。

---

## 1. 实测效果

同一台机器（RTX 3060 Laptop 6GB）、同一提示词、同样 60 帧 / 20 步：

| 后端 | 耗时 | 说明 |
| --- | --- | --- |
| CPU | 69.8 s | 独立进程计时 |
| **Vulkan** | **35.7 s** | 独立进程计时，约 **2×** |
| **Vulkan（服务常驻）** | **30.0 s** | `--server` 模式，模型已驻留（`loadMs=0`） |

服务模式下与历史 CPU 任务（155–310 s）相比，提升约 **5–10×**。

---

## 2. 前置条件

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| NVIDIA 显卡 | 显存 ≥ 6 GB | 本文在 RTX 3060 Laptop（6 GB）验证 |
| NVIDIA 驱动 | 含 Vulkan 1.3+ 支持 | 用 `vulkaninfo --summary` 确认 |
| **Vulkan SDK** | LunarG，编译用 | 运行只需要 runtime，编译必须装 SDK（提供 `glslc`） |
| Visual Studio 2022 | 带「C++ 桌面开发」工作负载 | 本文用 v17.10 |
| CMake | ≥ 3.20 | — |

### 2.1 确认 Vulkan runtime 可用

Windows 自带 `vulkan-1.dll`（驱动安装时写入），先确认能看到显卡：

```powershell
vulkaninfo --summary
```

期望输出包含：

```
apiVersion = 1.4.351
deviceName = NVIDIA GeForce RTX 3060 Laptop GPU
driverName = NVIDIA
```

### 2.2 安装 Vulkan SDK

推荐用 winget：

```powershell
winget install --id KhronosGroup.VulkanSDK --exact --silent --accept-package-agreements --accept-source-agreements
```

或从 [LunarG 官网](https://vulkan.lunarg.com/sdk/home) 下载安装包。

安装后 SDK 位于 `C:\VulkanSDK\<版本>\`，并会写入机器级环境变量 `VULKAN_SDK`。
**注意：已打开的终端不会自动继承新环境变量**，编译前需手动设置（见 3.1）。

验证：

```powershell
Test-Path 'C:\VulkanSDK\1.4.363.0\Bin\glslc.exe'   # True
Test-Path 'C:\VulkanSDK\1.4.363.0\Lib\vulkan-1.lib' # True
```

---

## 3. 编译

### 3.1 准备环境变量

```powershell
$env:VULKAN_SDK = 'C:\VulkanSDK\1.4.363.0'   # 按实际版本改
$env:Path = "$env:VULKAN_SDK\Bin;" + $env:Path
```

> 不需要 `vcvars64.bat`：用 Visual Studio 生成器时 CMake 会自己定位 MSVC。

### 3.2 Configure

```powershell
cmake -S D:\thirdparty\kimodo.cpp `
      -B D:\thirdparty\kimodo.cpp\build-vulkan `
      -G "Visual Studio 17 2022" -A x64 `
      -DKIMODO_ENABLE_VULKAN=ON `
      -DGGML_VULKAN=ON `
      -DGGML_CUDA=OFF `
      -DCMAKE_BUILD_TYPE=Release
```

参数说明：

| 参数 | 作用 |
| --- | --- |
| `-G "Visual Studio 17 2022"` | 用 MSBuild，支持并行编译；且因为不编 CUDA，不会触发 "No CUDA toolset found" |
| `-DKIMODO_ENABLE_VULKAN=ON` | 关键开关。控制 `KIMODO_HAVE_GGML_VULKAN` 宏，决定是否编译 Vulkan 分支 |
| `-DGGML_VULKAN=ON` | 编译 ggml 的 Vulkan 后端。**注意**：kimodo 的 CMakeLists 会用 `set(GGML_VULKAN ${KIMODO_ENABLE_VULKAN} CACHE BOOL "" FORCE)` 覆盖它，所以真正生效的是 `KIMODO_ENABLE_VULKAN` |
| `-DGGML_CUDA=OFF` | 显式关闭，避免 cmake 去找 CUDA toolchain（kimodo 用不上） |

Configure 成功的关键输出：

```
-- Found Vulkan: C:/VulkanSDK/1.4.363.0/Lib/vulkan-1.lib (found version "1.4.363")
   found components: glslc glslangValidator
-- Vulkan found
-- Including Vulkan backend
```

> 如果看到 `-- Vulkan not found` 或没有 `Including Vulkan backend`，说明 `VULKAN_SDK` 没生效，回去检查 3.1。

### 3.3 编译

```powershell
cmake --build D:\thirdparty\kimodo.cpp\build-vulkan --config Release --target kmd-generate --parallel
```

> 只用编 `kmd-generate` 一个目标。Vulkan 后端要编译 100+ 个 compute shader（glslc），
> 并行下约 **10–20 分钟**（对比 NMake 单线程的 CUDA 方案快很多）。

### 3.4 产物位置

```
build-vulkan\
├── Release\
│   └── kmd-generate.exe          # 主程序
└── bin\Release\
    ├── ggml.dll
    ├── ggml-base.dll
    ├── ggml-cpu.dll
    └── ggml-vulkan.dll           # ~52 MB，Vulkan 后端
```

> **注意路径结构与 NMake 不同**：VS 生成器把 exe 放在 `Release\`、DLL 放在 `bin\Release\`。

---

## 4. 接入本项目

### 4.1 配置 `.env`

```ini
# 指向 VS 生成器的产物（注意是 Release 子目录）
KIMODO_GENERATE_EXE=D:\thirdparty\kimodo.cpp\build-vulkan\Release\kmd-generate.exe

KIMODO_MOTION_MODEL=D:\thirdparty\kimodo.cpp\models\kimodo-soma-rp-v1.1-f32.gguf
KIMODO_TEXT_BUNDLE=D:\thirdparty\kimodo.cpp\text\Llama-3-Kimodo-Q4_K_M.gguf

# GPU 后端：cpu / vulkan（不支持 cuda）
KIMODO_BACKEND=vulkan

# KIMODO_OUTPUT_DIR=
# KIMODO_PYTHON=python
```

`KIMODO_BACKEND` 的语义（见 `src/llm_text_encoder.cpp`）：

- `cpu` → 强制 CPU
- **任何其他值**（含 `vulkan`）→ 尝试 Vulkan，失败自动回落 CPU

### 4.2 DLL 自动发现

`apps/api/src/services/kimodo.ts` 的 `collectDllDirs()` 会从 exe 所在目录向上扫 3 层，
把所有含 `.dll` 的子目录加入进程 `PATH`：

```
exe 目录   = build-vulkan\Release
向上 1 层  = build-vulkan       → 子目录 bin（本身无 dll）
                                  → bin\Release 含 dll ✓ 加入 PATH
```

因此 **不需要手动把 `bin\Release` 加到系统 PATH**。

---

## 5. 验证

### 5.1 独立进程测试（最快确认 GPU 生效）

```powershell
$env:Path = 'D:\thirdparty\kimodo.cpp\build-vulkan\bin\Release;' + $env:Path
$env:KIMODO_BACKEND = 'vulkan'

& 'D:\thirdparty\kimodo.cpp\build-vulkan\Release\kmd-generate.exe' `
    'D:\thirdparty\kimodo.cpp\models\kimodo-soma-rp-v1.1-f32.gguf' `
    'D:\thirdparty\kimodo.cpp\text\Llama-3-Kimodo-Q4_K_M.gguf' `
    'D:\tmp\prompt.txt' 60 20 12345 'D:\tmp\out'
```

**必须看到这一行才算真正用上 GPU**：

```
ggml_vulkan: Found 1 Vulkan devices:
ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1 |
                warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2v
generated 60 frames with 30 joints
```

如果完全没有 `ggml_vulkan:` 前缀的日志，说明回落到了 CPU。

### 5.2 服务内验证

```powershell
# 1) 配置生效
Invoke-RestMethod http://127.0.0.1:8788/api/kimodo/status
# 期望 backend=vulkan

# 2) 提交任务
$body = @{ prompt = 'a person waves one hand'; frames = 60; steps = 20 } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8788/api/kimodo/generate `
         -Body $body -ContentType 'application/json; charset=utf-8'

# 3) 运行期确认进程加载了 Vulkan DLL，且出现在 GPU 计算进程列表
$p = Get-Process kmd-generate
tasklist /FI "PID eq $($p.Id)" /M | Select-String 'ggml-vulkan'
nvidia-smi --query-compute-apps=pid,used_memory --format=csv

# 4) 等完成，看 durationMs
$list = Invoke-RestMethod http://127.0.0.1:8788/api/kimodo/animations
$list | Where-Object { $_.id -eq $job.id }

# 5) 清理
Invoke-RestMethod -Method Delete "http://127.0.0.1:8788/api/kimodo/animations/$($job.id)"
```

判定标准：

| 检查项 | 期望 |
| --- | --- |
| `tasklist /M` 里的模块 | 包含 **`ggml-vulkan.dll`**（CPU-only 时只有 `ggml-base.dll` + `ggml-cpu.dll`） |
| `nvidia-smi --query-compute-apps` | 出现 `kmd-generate.exe` 的 PID |
| 60 帧 / 20 步 `durationMs` | 约 30 s（CPU 约 70 s，服务内历史 CPU 任务 155–310 s） |

---

## 6. 常见问题

### Q1：`-- Vulkan not found` / configure 失败

`VULKAN_SDK` 没生效。Vulkan SDK 安装后写入的是**机器级**环境变量，已打开的终端不会继承。
在同一个终端里显式设置：

```powershell
$env:VULKAN_SDK = 'C:\VulkanSDK\1.4.363.0'
$env:Path = "$env:VULKAN_SDK\Bin;" + $env:Path
```

确认 `glslc.exe` 和 `vulkan-1.lib` 存在。

### Q2：编译了 CUDA 但速度没变

这是预期行为 —— **kimodo 不调用 CUDA 后端**。`ggml-cuda.dll` 即使被编出来也不会被加载。
`tasklist /M` 会看到只有 `ggml-base.dll` + `ggml-cpu.dll`，`nvidia-smi` 的计算进程列表里也没有它。

用 Vulkan 重编（`-DKIMODO_ENABLE_VULKAN=ON`）。

### Q3：`error MSB8020` / 找不到 CUDA toolset

`GGML_CUDA` 没关掉，或 CMake 缓存里还留着旧的 CUDA 配置。
用**新目录** configure，并显式 `-DGGML_CUDA=OFF`。不要复用之前的 `build-cuda` 目录。

### Q4：运行时找不到 `ggml-vulkan.dll`

- 确认 `build-vulkan\bin\Release\ggml-vulkan.dll` 存在。
- `collectDllDirs()` 只向上扫 3 层。若把 exe 挪到更深目录，可能扫不到；
  此时手动把 `bin\Release` 加进系统 `PATH`，或把 DLL 复制到 exe 同目录。
- 别把 `Release\kmd-generate.exe` 单独拷到别处运行——它依赖 `bin\Release` 里的 DLL。

### Q5：`ggml_vulkan: Found 0 Vulkan devices`

驱动没装好或显卡不支持。先跑 `vulkaninfo --summary` 确认系统层面能看到设备。
虚拟机 / 远程桌面 / 无显卡环境可能只有软件实现，此时 GPU 加速不可用。

### Q6：小任务反而更慢

Vulkan 首次运行需要编译并缓存 shader pipeline。日志里能看出首次启动的额外开销：

| 参数 | 首次 | 缓存命中后 |
| --- | --- | --- |
| 16 帧 / 4 步 | 63 s | — |
| 60 帧 / 20 步 | — | 35.7 s |

小任务（如 16 帧 / 4 步）里固定开销占比过高，反而不如 CPU。
**但服务是 `--server` 常驻模式**，模型与 shader 缓存只加载一次，实际使用中不会反复付这笔钱。

### Q7：显存不足

6 GB 显存跑 60 帧 / 20 步可能接近上限。可：
- 减少帧数或步数；
- 设 `KIMODO_TEXT_LAYER_CHUNK=<1..32>` 限制文本编码器分层驻留块数（越小越省显存）；
- 设 `KIMODO_TEXT_RESIDENT_LIMIT_MIB=<MB>` 限制文本层常驻上限（服务默认 10000）。

---

## 7. 参考

- [kimodo.cpp 仓库](https://github.com/andrewyng/kimodo.cpp)
- [LunarG Vulkan SDK](https://vulkan.lunarg.com/sdk/home)
- [CUDA GPU 架构对照表](https://developer.nvidia.com/cuda-gpus)（仅用于确认硬件代际）
- 本项目 Kimodo 服务实现：[apps/api/src/services/kimodo.ts](../apps/api/src/services/kimodo.ts)
- 关键上游源码：
  - `src/ggml_weights.cpp` — 后端选择（Vulkan → CPU 兜底）
  - `src/llm_text_encoder.cpp` — `use_vulkan()` 判定 `KIMODO_BACKEND != "cpu"`
  - `CMakeLists.txt` — `KIMODO_ENABLE_VULKAN` 选项
