# Kimodo：扩展可控的人体动作生成（Scaling Controllable Human Motion Generation）

> 本文翻译自 NVIDIA 官方项目主页：<https://research.nvidia.com/labs/sil/projects/kimodo>
> 翻译整理日期：2026-10-28。原文中的演示视频以列表形式保留，动画效果请参见原页面。

Kimodo 是一个在**大规模光学动捕数据**上训练的 **ki**nematic **mo**tion **d**iffusi**o**n（运动学动作扩散）模型。它通过**文本与约束**进行控制，可生成高质量的 3D 人体与机器人动作。

- [代码（GitHub）](https://github.com/nv-tlabs/kimodo)
- [模型（Hugging Face）](https://huggingface.co/collections/nvidia/kimodo-v1)
- [在线演示（Hugging Face Space）](https://huggingface.co/spaces/nvidia/Kimodo)
- [技术报告（PDF）](https://research.nvidia.com/labs/sil/projects/kimodo/assets/kimodo_tech_report.pdf)

## 摘要

高质量的人体动作数据对于机器人、仿真和娱乐等领域的应用正变得越来越重要。近期的生成模型提供了一种潜在的数据来源，可以通过文本提示或姿态上的运动学约束等直观输入来合成人体动作。然而，公开动捕数据集规模较小，限制了这类模型的动作质量、控制精度与泛化能力。

在本工作中，我们提出了 **Kimodo**——一个表现力强且可控的**运动学动作扩散**模型，它在 **700 小时**的光学动捕数据上训练。我们的模型能够生成高质量动作，同时可通过文本以及一整套完整的运动学约束轻松控制，这些约束包括：**全身关键帧、稀疏关节位置/旋转、2D 路点（waypoints）以及稠密 2D 路径（paths）**。

这得益于精心设计的**动作表示**与**两阶段去噪器架构**：后者将根节点（root）与身体（body）的预测解耦，从而在支持灵活约束条件的同时最大程度减少动作伪影。在大规模动捕数据集上的实验验证了关键设计决策，并分析了数据集规模与模型规模的扩展对性能的影响。

## Kimodo 的核心能力

（原页面此处为 6 段演示动图，展示了在数字人 SOMA 模型上根据详细文本提示生成动作的效果。）

通过详细的文本提示为 SOMA 等数字人生成动作。

### 文本生成动作（Text-to-Motion Generation）

Kimodo 可以通过文本提示直观控制，生成范围广泛的行为：

- 位移运动（Locomotion）
- 组合式位移运动（Compositional Locomotion）
- 物体交互（Object Interactions）
- 舞蹈（Dancing）
- 特技/高难动作（Stunts）
- 手势（Gestures）
- 风格化动作（Stylized Motion）
- 多样化采样（Diverse Samples）
- 连续提示序列（Sequence of Prompts）

### 全身约束（Full Body Constraints）

模型可以以动作上的运动学姿态约束作为条件，例如在特定帧上约束全身关节位置。约束以**红色骨架**可视化：

- 稀疏关键帧（Sparse Keyframes）
- 中间补间（Inbetweening）
- 环境交互（Environment Interaction）

### 末端执行器约束（End-Effector Constraints）

手与脚（末端执行器）的各种组合也可以通过关节的位置和旋转进行约束。在视频中，红色表示被约束的关节：

- 手 + 脚（Hands + Feet）
- 仅手（Hands Only）
- 仅脚（Feet Only）

### 根节点约束（Root Constraints）

角色的全局位移可通过 **2D 路点**与**稠密路径**控制。我们平滑化的根运动表示（smoothed root motion representation）使得角色既能紧密跟随直线与曲线路径，又能保持自然的骨盆运动：

- 路点（SOMA）
- 路点（G1）
- 舞蹈路点（Dancing Waypoints）
- 稠密路径（Dense Path）
- 混合约束（Mixed Constraints）

## Kimodo 代码与创作演示

我们的代码中包含一个**动作创作演示（motion authoring demo）**，作为在实际中使用该模型的参考实现。该演示支持在 **SOMA** 与 **G1** 骨架上进行本地生成，并可通过约束与提示序列轻松创作动作。我们还提供了使用 **Python API** 生成动作并导出到下游应用的简单示例。

- [在 GitHub 上查看代码](https://github.com/nv-tlabs/kimodo)

（原页面此处为 5 段演示动图：在时间轴中编辑提示词即可轻松由文本生成动作。）

## 应用：面向机器人学的数据

在 **G1** 骨架上训练的 Kimodo 可以比遥操作（teleoperation）更快、更轻松地生成人形机器人的示范数据。生成的动作可导出为与 [ProtoMotions](https://github.com/NVlabs/ProtoMotions) 和 MuJoCo 兼容的格式，用于训练基于物理的策略（physics-based policies）。

（原页面此处为 4 段演示动图。）

作为概念验证，我们还将 Kimodo 集成进了[交互式 GEAR-SONIC 演示](https://nvlabs.github.io/GEAR-SONIC/demo.html)。在该演示中，Kimodo 可用于在 G1 机器人骨架上生成运动学动作，再由 GEAR-SONIC 在仿真中跟踪该动作。

## Kimodo：运动学动作扩散（Kinematic Motion Diffusion）

Kimodo 是一个**显式动作扩散模型**，通过对一系列骨架姿态进行去噪来生成 3D 人体动作。模型运行在**精心设计的动作表示**之上，既能对生成动作进行精确控制，又能尽量减少常见伪影，例如**漂浮（floating）**与**脚部滑步（foot skating）**。该动作表示包含一个**平滑化的根节点**（模拟实际动画工具中绘制的路径），以及便于施加稀疏关键帧约束的**全局关节旋转与位置**。

在去噪过程的每一步，模型接收文本提示的嵌入、一组运动学约束，以及当前带噪动作。约束使用与输入动作相同的动作表示来指定，并用于**覆盖**带噪动作中的对应数值。此外，一个指示哪些元素被约束的**掩码（mask）**会与输入动作拼接在一起。

在这些输入下，**两阶段 Transformer 去噪器**会预测出一段与文本及约束一致的干净动作。两阶段去噪器将根节点与身体动作的预测解耦：**根去噪器**首先预测全局根运动，该运动随后被转换为局部表示，作为**身体去噪器**的输入。最终输出是两个阶段结果的拼接。

有效训练 Kimodo 的一个关键要素是 [Bones Rigplay 数据集](https://bones.studio/ai-datasets/)——一个大型摄影棚动捕数据集，包含超过 **700 小时**制作级质量的人体动作及其对应的文本描述。这一大型数据集还使得构建全面的基准成为可能，用于在广泛的行为与场景上评估各种设计决策。更多细节请参见论文。

## NVIDIA 的人形机器人动作研究

Kimodo 是 NVIDIA 支持人形机器人与 Physical AI 的更大研究计划的一部分，该计划致力于开发用于 3D 人形动作的模型与工具。Kimodo 依赖并与下列项目互操作：

- **[ARDY](https://research.nvidia.com/labs/sil/projects/ardy/)**：在 Kimodo 之上构建，为交互式应用实现实时可控的动作生成。
- **[MotionBricks](https://nvlabs.github.io/motionbricks/)**：实时动作生成框架，专注于快速、鲁棒的动画补间（motion in-betweening）。
- **[SOMA 人体模型](https://github.com/NVlabs/SOMA-X)**：Kimodo 是在 SOMA 参数化人体模型的骨架上训练的。
- **[BONES-SEED 数据集](https://huggingface.co/datasets/bones-studio/seed)**：Kimodo 的部分版本在公开可用的 BONES-SEED 数据集上训练，该数据集包含数百小时制作级质量的动捕数据（SOMA 与 G1 骨架）。
- **[ProtoMotions](https://github.com/NVlabs/ProtoMotions)**：Kimodo 生成的动作可导出到 ProtoMotions 框架，用于训练人形机器人的基于物理的策略。
- **[SOMA Retargeter](https://github.com/NVIDIA/soma-retargeter)**：Kimodo 的 G1 训练数据使用基于 Newton 的 SOMA 重定向工具（retargeter）生成。
- **[GEM](https://github.com/NVlabs/GEM-X)**：与 Kimodo 思路类似，GEM 是一个从单目视频重建动作的动作扩散模型。
- **[GEAR SONIC](https://nvlabs.github.io/SONIC/)**：Kimodo 生成的动作可作为示范数据，用于训练 GEAR-SONIC 等机器人跟踪策略。

## 贡献者

- **项目负责人：** Davis Rempe
- **模型：** Mathis Petrovich、Davis Rempe、Ye Yuan、Haotian Zhang、Xue Bin (Jason) Peng、Yifeng Jiang、Tingwu Wang、Umar Iqbal、David Minor、Michael de Ruyter、Jiefeng Li、Chen Tessler
- **数据：** Edy Lim、Eugene Jeong、Sam Wu、Ehsan Hassani、Michael Huang、Jin-Bey Yu、Chaeyeon Chung、Lina Song、Olivier Dionne
- **指导：** Sanja Fidler、Simon Yuen、Jan Kautz

### 致谢

感谢 John Malaska、Will Telford、Jon Shepard 和 Anna Minx 在开发过程中提供的帮助与指导。感谢 Or Litany、Zhengyi Luo、Yeongho Seol、Jun Saito 和 Michael Buttner 关于人体动作的深入讨论。感谢 Cyrus Hogg、Lindsey Pavao、Jenna Diamond、Rizwan Khan、Samantha Shinagawa 和 Akanksha Shukla 在数据采集与标注方面的工作。感谢 Kaifeng Zhao 和 Sunmin Lee 的研究讨论以及对模型和代码的测试与反馈。
