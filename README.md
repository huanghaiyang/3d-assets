# 混元 3D 工作台（Hunyuan3D Workbench）

一个模仿 Tripo3D 工作台的 Web 应用：**只保留工作区里真正会用到的功能** —— 文生3D / 图生3D / 多视角生成、生成参数、任务队列、3D 预览、素材库与导出。

后端对接 **腾讯混元生3D（专业版）OpenAI 兼容接口** `https://api.ai3d.cloud.tencent.com`。

![工作台界面](./docs/screenshot-workbench.png)

---

## 1. 功能清单

| 区域 | 能力 |
| --- | --- |
| 左侧「生成模型」 | 文生3D（提示词）、图生3D（拖拽 / 点击 / Ctrl+V 粘贴参考图）、多视角（7 个视角槽位，3.1 专属视角自动标注） |
| 生成设置 | 模型版本 3.0 / 3.1、生成类型 Normal / LowPoly / Geometry / Sketch、面数（对数滑块 + 预设 + 精确输入）、PBR 材质、多边形类型（三角面 / 四边形混合）、输出格式（默认 OBJ+GLB / 仅 GLB / 仅 OBJ / STL / FBX / USDZ） |
| 中间视口 | three.js 实时预览（GLB / GLTF / OBJ+MTL / STL / FBX）、线框叠加、网格地面、自动旋转、重置视角、全屏、三角面 / 顶点 / 网格 / 积分统计、生成进度（阶段 + 耗时） |
| 右侧「素材库」 | 上传 / 批量上传本地模型（按钮选择，或直接把文件拖进面板）、全部 / 进行中 / 已完成 / 失败筛选、名称与提示词搜索、缩略图、重命名、重试、取消、删除、下载主文件 / 全部文件、复用参数新建 |
| 底部任务条 | 当前任务阶段、耗时、JobId、积分消耗、取消 / 重试（区分「续查」与「重新生成」）、导出菜单（按格式与贴图 / 材质单独下载） |
| 设置弹窗 | 界面内填写 API Key（优先于 `.env`）、测试连接、清除、接口地址与并发/轮询参数展示 |
| **动画预览页** | 顶栏「动画预览」进入：**多文件夹**（可添加/移除，服务端持久记录）、分页浏览、**只加载当前页封面**、模糊搜索、点击即在 3D 视口播放、**骨骼渲染 + 骨骼树多选高亮（可在模型上直接点选骨骼）**、播放/暂停/进度/倍速、原地播放、左右镜像、地面网格、片段切换、文件与骨骼统计 |

### 动画预览（只读）

![动画预览页](./docs/screenshot-animation.png)

- **多文件夹**：默认 `<仓库上一级>/CozyVale/assets/mixamo`（可用 `.env` 的 `ANIMATION_DIR` 覆盖）。点「添加文件夹」可追加，
  每个文件夹是一个带删除按钮的标签；选择结果保存在服务端 `data/state.json`，刷新/重启后依然保留。
  已失效的文件夹会在标签上标红，扫描时自动跳过并在响应里返回 `missing`。
- **分页**：12 / 24 / 48 / 96 每页可选，页码窗口 + 首/末页跳转；搜索或切换文件夹筛选时自动回到第 1 页。
- **模糊搜索**（`apps/web/src/utils/fuzzy.ts`）：
  - 连续子串优先（`climbing` → `Climbing Up Wall.fbx`）
  - 支持缩写 / 跳字符（`cuw` → `Climbing Up Wall`，`stdwalk` → `Standard Walk`）
  - 空格分隔多关键词，全部命中共存（`unarmed forward`）
  - 关键词可分别命中**文件名或文件夹标签**（`mixamo sword`）
  - 按相关度排序（连续性、词首/驼峰边界、匹配位置、名称长度），命中字符在卡片上高亮
- **封面按页加载**：只对当前页中进入可视区域的卡片生成封面（离屏渲染，仅存内存不落盘）；
  翻页时丢弃上一页未完成的任务，切回已看过的页直接命中内存缓存、不重复解析。
- **只读保证**：后端只调用 `readdir / stat / readFile`，**不写入任何文件**（封面在浏览器内存里生成，不落盘），
  读取时整块读入并立刻关闭句柄，因此不会锁文件——游戏引擎等其它进程仍可正常读写这些 FBX。
- 只列出 `.fbx`（Godot 的 `.fbx.import` 边车文件会被自动忽略），整体最多 3000 个文件、单目录递归 4 层、最多记录 20 个文件夹。
- 播放能力：`AnimationMixer` 播放片段、进度条拖动、0.25×–2× 倍速、**原地播放**（去掉髋部水平位移，便于看循环动作）、**左右镜像**、按动画范围的自动取景。
- **骨骼**（右侧面板「骨骼」页签，或用视口右上角的骨骼按钮快速开关）：
  - **两种显示方式，随时切换**（面板里的「点线 / 八面体」分段控件）：
    - **点线**：关节圆点 + 父子连线，看整体结构最清爽。
    - **八面体**：Blender 那种八面体骨头——头部一个点、腰身四点、尾部一个尖，一眼看出一根骨骼的长短与朝向；末端骨骼（手指尖、脚趾尖）顺着父骨方向补一小截，不会只剩一个孤零零的圆点。
    两种方式共用同一套关节圆点与选中状态，切换时选择不丢，切换模型后所选方式也会保留。
  - **渲染**：材质关闭深度测试并抬高 `renderOrder`，骨骼像 DCC 工具那样穿透模型显示（八面体另开平面着色，所以有明暗、能看出朝向）。逐帧从骨骼世界矩阵刷新，所以动画播放时骨骼跟着动。
  - **骨骼树**：完整层级、逐级折叠 / 展开全部 / 折叠到根、按名字搜索（自动展开命中项并高亮）；点击选中，`Ctrl/⌘` 加选或取消，`Shift` 连选。
  - **模型上点选**：直接在视口里点模型选骨骼。取的是**屏幕上离光标最近**的那根骨骼（把骨骼投影到屏幕，按像素距离比较），而不是「射线到点云的距离」——后者用的 `threshold` 是世界单位，投影到屏幕上的可点区域会随距离线性变宽，远处的骨骼反而能抢走光标正对着的那根，表现就是"点不准"。可点半径跟着圆点在屏幕上的大小走，并保底 16px，所以点在肢体中段也能命中最近的关节。
  - **点选前的反馈**：骨骼显示开启时，鼠标划过会实时高亮光标下的骨骼并在旁边显示名字，点下去选中的就是它；拖动超过 4px 视为旋转视角、不触发选择；点空白处清空选择；点选后右侧树会自动滚动到该骨骼。
  - **高亮**：选中的骨骼在 3D 视口与树里同时变琥珀色，视口左上角列出已选骨骼名，可一键清除。
  - **同名包装节点**：Mixamo 的 FBX 会给每根骨骼再套一层同名节点（`Model::` / `LimbNode::`），直接遍历会得到 129 个骨骼对象却只有 65 个唯一名字，树里每根骨头出现两次。这里按「祖先中存在同名骨骼」判定影子节点并剔除（与 three.js 解析动画轨道时按名字取首个匹配的行为一致），再把父子关系提级到最近的真实骨骼上，得到干净的 65 根骨骼树；被忽略的数量会在面板底部说明，不同分支下的同名骨骼不会误删。

**刻意移除**（Tripo3D 里非工作区的内容）：首页 / 资产导航页签、订阅与积分购买、模型私密性与分享、发送至 3D 软件、3D 打印、AI 模型试玩入口、ICP 备案footer、客服浮窗。

---

## 2. 技术栈

- **后端**：Node.js 22 + TypeScript + Fastify 5（ESM，`tsc` 编译，`tsx` 开发热重载）
- **前端**：Vue 3（`<script setup>` + TypeScript）+ Vite 6 + Pinia + three.js
- **持久化**：本地 JSON 状态文件 + 文件系统素材库（无外部数据库）

```
3d-desing/
├── apps/
│   ├── api/                     # Fastify 服务 + 混元接口客户端 + 任务调度
│   │   └── src/
│   │       ├── config.ts        # 环境变量与运行参数
│   │       ├── app.ts           # 应用装配（路由 / 静态资源 / 错误处理）
│   │       ├── index.ts         # 启动入口
│   │       ├── hunyuan/         # 混元生3D 接口封装（提交 / 查询 / 下载）
│   │       ├── services/        # 调度器、素材转存、任务输入、设置
│   │       ├── routes/          # /api/* 与 /files/*
│   │       └── store/           # 工作区状态（state.json）
│   └── web/                     # Vue 3 工作台
│       └── src/
│           ├── api/             # 接口客户端与类型
│           ├── components/      # 顶栏 / 生成面板 / 视口 / 素材库 / 任务条 / 设置
│           │   └── animation/   # 动画预览页：网格 / 视口 / 信息面板 / 文件夹选择
│           ├── stores/          # Pinia 工作区状态与轮询
│           ├── viewer/          # three.js 预览器（ModelViewer / FbxPlayer / SkeletonOverlay / 缩略图渲染）
│           └── utils/           # 图片压缩与校验、格式化
└── data/                        # 运行期数据（自动创建，已 gitignore）
    ├── state.json               # 任务与素材元数据
    ├── payloads/                # 提交任务的完整输入（供重试复用）
    └── storage/<jobId>/         # 转存后的模型、材质、贴图、缩略图
```

---

## 3. 快速开始

要求：Node.js ≥ 20（开发建议 22），npm 10+。

```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key（可跳过，改为启动后在界面右上角「设置」里填写）
copy .env.example .env        # Windows
# cp .env.example .env        # macOS / Linux
# 编辑 .env，填入 HUNYUAN3D_API_KEY=sk-xxxxxxxx

# 3. 开发模式（前端 5173 + 后端 8787，已配置代理）
npm run dev

# 4. 生产模式：构建后由后端统一托管前端
npm run build
npm start                     # 打开 http://127.0.0.1:8787
```

常用脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动 API（`tsx watch`）与 Vite 开发服务器 |
| `npm run build` | 构建前端静态资源 + 编译后端 TypeScript |
| `npm start` | 启动生产服务（同时托管 `apps/web/dist`） |
| `npm run typecheck` | 前后端类型检查（`tsc` + `vue-tsc`） |
| `npm run smoke -- --prompt "一只小猫" --faces 3000 --yes` | 直连混元接口跑一次完整生成（**会消耗积分**） |

> 如果 `npm install` 在受限环境（例如带文件沙箱的容器）里因 esbuild 的安装脚本失败，可改用
> `npm install --ignore-scripts`：esbuild 的平台二进制由可选依赖提供，不跑安装脚本也能正常工作。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HUNYUAN3D_API_KEY` | 空 | 控制台创建的 `sk-` 开头密钥；界面里填写的 Key 优先级更高 |
| `HUNYUAN3D_BASE_URL` | `https://api.ai3d.cloud.tencent.com` | 接口域名 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 本地服务监听地址 |
| `POLL_INTERVAL_MS` | `5000` | 远端任务轮询间隔 |
| `MAX_CONCURRENCY` | `3` | 本地并发上限（接口默认提供 3 个并发，代码里强制作不超过 3） |
| `ANIMATION_DIR` | `../CozyVale/assets/mixamo` | 动画预览默认打开的 FBX 文件夹（只读） |

---

## 4. 混元生3D 接口对接

### 4.1 鉴权与地址

```
Authorization: sk-xxxxxxxxxxxxxxxx        # 直接放 API Key，无需 Bearer 前缀
Content-Type:  application/json
```

| 用途 | 方法与路径 |
| --- | --- |
| 提交生成任务 | `POST https://api.ai3d.cloud.tencent.com/v1/ai3d/submit` |
| 查询任务结果 | `POST https://api.ai3d.cloud.tencent.com/v1/ai3d/query` |

提交成功返回 `{"Response":{"JobId":"...","RequestId":"..."}}`；
业务校验失败（HTTP 200）返回 `{"Response":{"Error":{"Code":"...","Message":"..."}}}`；
鉴权失败返回 HTTP 401 `{"error":{"code":"invalid_api_key", ...}}`。客户端对这三类都做了区分处理
（见 `apps/api/src/hunyuan/client.ts`）。

### 4.2 请求参数（PascalCase）

| 参数 | 说明 |
| --- | --- |
| `Model` | `3.0` / `3.1`；**3.1 不支持 `LowPoly` 与 `Sketch`** |
| `Prompt` | 文生3D 描述，≤1024 字符；与其他图片输入互斥（`Sketch` 模式除外） |
| `ImageBase64` | 参考图 base64（可带 `data:image/...;base64,` 前缀，本项目发送裸 base64），≤6MB，单边 128–5000 |
| `MultiViewImages` | `[{ViewType, ViewImageUrl \| ViewImageBase64}]`，`ViewType` 取值 `left/right/back/top/bottom/left_front/right_front` |
| `GenerateType` | `Normal` / `LowPoly` / `Geometry` / `Sketch` |
| `FaceCount` | 3000–1500000；`LowPoly` 时忽略 |
| `EnablePBR` | `Geometry` 时忽略 |
| `PolygonType` | `triangle` / `quadrilateral`，仅 `LowPoly` 生效 |
| `ResultFormat` | `OBJ` / `GLB` / `STL` / `FBX` / `USDZ`，**必须大写**；不传则默认同时返回 OBJ 与 GLB |

### 4.3 查询结果

```jsonc
{
  "Response": {
    "Status": "WAIT | RUN | FAIL | DONE",
    "ErrorCode": "...", "ErrorMessage": "...",
    "ResultFile3Ds": [
      { "Type": "OBJ", "Url": "https://.../xxx.zip", "PreviewImageUrl": "https://.../preview.png" },
      { "Type": "GLB", "Url": "https://.../xxx.glb" }
    ],
    "ResultCreditConsumed": 30,
    "ResultCreditDetails": "{\"FaceCount\":10,\"GenerateType-Normal\":20}"
  }
}
```

> **结果 URL 仅 24 小时有效**，因此服务端在任务完成时会立即把文件下载并转存到
> `data/storage/<jobId>/`，界面与下载链接都指向本地 `/files/...`，不会过期。
> `Type=OBJ` 返回的是 zip 包，服务端会自动解包并识别主模型 / `.mtl` / 贴图
> （`apps/api/src/services/assets.ts`）。

---

## 5. 运行时设计

- **任务队列**：`GenerationWorker` 最多同时推进 3 个远端任务；每 5 秒轮询一次状态。
- **断点续跑**：任务与 `remoteJobId` 落盘，服务重启后会自动接管仍在执行的远端任务继续查询，
  **不会重复提交、不会重复计费**。
- **重试语义**：因网络中断导致的失败，重试只「续查」远端任务；远端明确判定失败时，
  重试会重新提交（界面按钮文案会明确提示「再次计费」）。
- **进度展示**：接口只返回 `WAIT/RUN/FAIL/DONE`，不返回百分比，界面按耗时给出收敛的估算进度并标注为估算值。
- **缩略图**：优先使用接口返回的 `PreviewImageUrl`；若缺失，浏览器渲染完成后回填截图
  （`POST /api/jobs/:id/thumbnail`）。
- **图片输入**：前端在浏览器内校验格式 / 最小边长（≥128）、等比压缩到长边 1600、控制体积 ≤6MB，
  再以 base64 提交（`apps/web/src/utils/image.ts`）。

### HTTP 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 前端唯一轮询入口：任务列表 + 队列 + 设置摘要 |
| POST | `/api/jobs` | 创建生成任务 |
| GET | `/api/jobs/:id` | 任务详情 |
| PATCH | `/api/jobs/:id` | 重命名；未提交的任务可改参数 |
| POST | `/api/jobs/:id/retry` | 重试（自动选择续查 / 重新提交） |
| POST | `/api/jobs/:id/cancel` | 取消 |
| DELETE | `/api/jobs/:id` | 删除任务与本地素材文件 |
| POST | `/api/jobs/:id/thumbnail` | 回填浏览器渲染的缩略图 |
| GET | `/api/jobs/:id/preview` | 输入参考图预览 |
| GET | `/api/settings` · PUT/DELETE `/api/settings/api-key` · POST `/api/settings/verify` | 设置与鉴权自检 |
| GET | `/api/library/upload-info` | 允许上传的扩展名与单文件上限 |
| PUT | `/api/library/staging/:batchId?filename=xxx` | 上传单个文件（`application/octet-stream` 原始字节流，服务端流式落盘） |
| POST | `/api/library/commit` | 把一个批次转成素材库条目（支持批量，按规则分组） |
| DELETE | `/api/library/staging/:batchId` | 放弃该批次并清理暂存文件 |
| GET | `/files/:jobId/<相对路径>` | 本地素材文件（`?download=1` 触发附件下载） |
| GET | `/api/anim/info` | 动画预览的文件夹、默认目录与限制 |
| GET | `/api/anim/dirs` · PUT `/api/anim/dirs` | 读取 / 保存记录的 FBX 文件夹（持久化，只做存在性校验） |
| GET | `/api/anim/list?dir=&dir=` | 递归列出多个文件夹下的 `.fbx`（重复 `?dir=`；不传则用已记录的） |
| GET | `/api/anim/browse?dir=` | 浏览子目录，用于「选择文件夹」（只读） |
| GET | `/api/anim/file?path=\|dir=&name=` | 读取单个 `.fbx`（只读、不落盘、不锁文件、`no-store`） |

### 上传 / 批量上传规则

- 前端把选中的文件逐个 PUT 到同一 `batchId` 的暂存目录，全部暂存完成后才调用 `commit`，
  由服务端按批次统一分组；无论成功或失败都会清理暂存目录。
- 分组规则：
  - `.zip` → 单独一个素材并自动解包（与原接口结果处理方式一致）
  - `.glb` / `.stl` / `.fbx` / `.usdz` → 各自一个素材
  - `.obj` / `.gltf` → 一个素材，并自动吸收同批次的 `.mtl` / `.bin` / 贴图，材质引用保持可解析
  - 只选了 `.mtl` / 贴图而没有主文件 → 明确报错「和 .obj/.gltf 一起选，或打包成 .zip」
- 扩展名白名单与单文件上限由 `/api/library/upload-info` 下发（默认 17 种扩展名，单文件 ≤ 200MB）。
- 上传素材与生成素材共用同一套存储与接口，预览 / 导出 / 重命名 / 删除直接可用；
  卡片上带「上传」标识，且不显示无意义的「复用参数」按钮。
- **缩略图自动生成**：上传的模型没有接口返回的预览图，前端用一个挂在屏幕外、固定 512×512 的
  `ModelViewer`（`apps/web/src/viewer/thumbnailRenderer.ts`）逐个渲染并回填，因此批量上传后无需任何手动操作。
  - 上传完成后立即为本次新增的素材生成；页面首次加载时也会自动补全历史缺失的缩略图（一次最多 30 个）。
  - 顺序处理（同一时刻只占一个 WebGL 上下文），页面标题栏显示 `缩略图 3/13` 进度；缺少缩略图时
    标题栏会出现「补全缩略图 N」按钮可手动触发。
  - WebGL 上下文创建失败时自动放弃并且不反复重试，不影响其它功能。

---

## 6. 已验证情况

本版本已用提供的 API Key 做过真实端到端验证：

| 用例 | 结果 |
| --- | --- |
| 文生3D（`一只低多边…陶瓷小猫摆件`，Normal / 3000 面 / GLB） | 2 分 42 秒完成，返回 OBJ(zip)+GLB 两组文件，扣 30 积分；OBJ 自动解包出 `.obj` + `material.mtl` + `texture_20250901.png`，GLB 校验为合法 glTF 2.0（magic `glTF`，version 2） |
| 图生3D（用上一轮的预览图作为输入，Geometry / GLB） | 1 分 45 秒完成，扣 25 积分，仅返回 GLB，输入预览图正常落盘与展示 |
| 请求体形状 | 逐一校验 `ImageBase64`(裸/data URI)、`MultiViewImages`、`GenerateType`、`PolygonType`、`ResultFormat`（大小写敏感）、`FaceCount` 范围等参数行为 |
| 前端 | 无头 Chrome 截图核对：文生3D / 图生3D（浏览器内压缩出 512×512、88.1 KB）/ 多视角 7 槽位 / 设置弹窗 / 线框叠加 / 素材库两列布局（固定 300px，每行 2 个，无横向溢出）/ 上传与批量上传；页面同源请求 0 失败、0 个 4xx/5xx、0 条控制台错误 |
| 上传 / 批量上传 | 混批 4 个文件（GLB + OBJ 套装）→ 正确生成 2 个素材：OBJ+MTL+贴图合并为一个且材质可解析（视口中带贴图渲染成功），GLB 独立成条；`.zip` 自动解包；不支持的扩展名返回 415；只有贴图无主文件时给出明确提示且暂存目录不残留 |
| 缩略图自动生成 | 通过 UI 批量上传 5 个 GLB（各 17MB）后**不做任何点击**，缩略图在约 43 秒内从 11/16 自动补全到 16/16，全程 0 控制台错误 |
| 存储清理 | 启动时清理无任务记录 / 空的素材目录（实测把 15 个目录收敛到与 12 个任务一一对应）；上传中途失败会回滚半成品目录 |
| 动画预览 | 打开 `D:\sgames\CozyVale\assets\mixamo`：识别 18 个 Mixamo FBX（129 骨骼 / 49,112 三角面 / 带蒙皮），自动播放首个动画、进度推进正常、缩略图 18/18 自动生成；文件夹选择器可向上导航到 `assets` 并列出 6 个子目录及各自的 FBX 数量；0 控制台错误、0 请求失败 |
| 多文件夹 + 分页 + 按页封面 | 记录 `mixamo` + `models` 两个文件夹 → 374 个 FBX、共 16 页（24/页）；第 1 页只渲染 24 张卡片且只加载可视区封面（发出 18 个 FBX 请求）；翻到第 2 页只新增 18 个请求、**回到第 1 页新增 0 个请求**（内存缓存命中）；每页改 12 后变为 32 页 |
| 模糊搜索 | 单元测试 20 项断言全通过（`apps/web/scripts/fuzzy.test.ts`：子串优先、`cuw`/`stdwalk`/`gsi` 缩写、多关键词、不命中、高亮）；浏览器实测 `cuw` → `Climbing Up Wall.fbx`、`stdwalk` → `Standard Walk.fbx`、`unarmed forward` 精确命中 1 条、`mixamo sword` 一词命中标签一词命中名称得 9 条、`zzzz` 显示「没有匹配」 |
| 骨骼渲染与选择 | Mixamo FBX：129 个骨骼对象识别出 **65 根真实骨骼**、忽略 64 个同名包装节点，树里 0 重名、层级为 `Hips→Spine→Spine1→Spine2→Neck→Head` 与 `RightShoulder→RightArm→RightForeArm→RightHand→各手指`；`Ctrl` 加选（1→2→3 根）、再点已选中的取消（3→2）、`Shift` 连选得到准确计数；搜索 `hand` 过滤到 94 行并高亮命中的 47 根；**在模型上直接点击命中骨骼**，悬停显示的骨骼名与点击选中的完全一致（store 与树 DOM 双向核对），点空白处清空；0 控制台错误 |
| 点选精度 | 暂停动画后测量关节的可点范围：以命中点为圆心，四向逐像素探测仍命中同一骨骼的距离为 4–12px（即"最近关节"边界），±5px 内 7/7 保持同一根；网格扫描覆盖 30 根不同骨骼 |
| 骨骼显示方式切换 | 面板出现「点线 / 八面体」两个选项；切到八面体后骨头按 DCC 风格渲染、切回后无残留；两种模式下选中状态都保持；**换模型后显示开关与所选方式都会保留**；八面体模式下模型点选照常命中（如 `Head`）；0 控制台错误 |
| 只读验证 | 读取全部 18 个 FBX 前后：SHA256 全部一致、目录内无新增文件（非 fbx 项 0）、API 并发读取期间其它进程独占读取 40/40 次成功 |
| 类型与构建 | `tsc` 后端 + `vue-tsc` 前端类型检查 0 错误；`vite build` 产物约 803 KB（gzip 226 KB） |

> 说明：验证过程共消耗账号积分 55 分（30 + 25），生成的素材保留在 `data/` 目录中，启动后即可在素材库看到。

---

## 7. 注意事项

- `.env` 中的 API Key 为明文存放且已被 `.gitignore` 忽略；不要把该文件提交到版本库。
- 前端也可在「设置」里填写 Key：该值写入 `data/settings.json`，优先级高于 `.env`，可随时清除。
- 接口默认并发为 3，超出会失败，因此本地队列上限固定为 3。
- 删除素材会一并删除 `data/storage/<jobId>/` 中的转存文件，请先导出再删除。
- 浏览器无法预览 USDZ，选择该格式时界面会提示下载后用本地软件查看。

---

## 8. 安全与版本控制

仓库**不包含任何后端运行数据或凭据**：

| 内容 | 处理 |
| --- | --- |
| `.env`（`HUNYUAN3D_API_KEY` 等真实密钥） | `.gitignore` 排除，只提交 `.env.example` 模板 |
| `data/`：`state.json`（含界面填写的 API Key 与素材元数据）、`payloads/`（上传的输入图 base64）、`storage/`（转存与上传的模型）、`uploads/`（上传暂存） | `.gitignore` 排除 |
| `node_modules/` `dist/` `.npm-cache/` `.tmp*/` | `.gitignore` 排除 |
| `*.pem` `*.key` `*.p12` `*.pfx` | `.gitignore` 排除 |

两道自动拦截：

1. **提交时** —— `.githooks/pre-commit` 先查暂存路径黑名单，再扫描内容里的
   `sk-<24 位以上>`、`AKID...`、私钥块，命中即中止提交（输出已打码）。
   `core.hooksPath` 是本地配置、**不会随 clone 生效**，克隆后需启用一次：
   ```bash
   git config core.hooksPath .githooks   # npm install 时会自动执行
   ```
   确需跳过：`git commit --no-verify`。
2. **整体自查** —— `npm run check:secrets` 按 `.gitignore` 过滤整个工作区，只检查
   "会被提交的内容"，本地必需的 `.env` / `data/` 只要被正确忽略就不报错，
   一旦有人把它们移出 `.gitignore` 会立刻失败。适合放进 CI。

> 文档截图（`docs/`）里的账号区域（并发状态与 API Key 标签）已做留白处理。

参考文档：[HY-3D 调用指南](https://cloud.tencent.com/document/product/1823/137181) ·
[OpenAI 兼容接口调用示例](https://cloud.tencent.com/document/product/1804/126189) ·
[提交混元生3D专业版任务](https://cloud.tencent.com/document/product/1804/123447) ·
[查询混元生3D专业版任务](https://cloud.tencent.com/document/product/1804/123448)
