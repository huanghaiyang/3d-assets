"""把 kimodo.cpp 生成的动作（SOMA 30 关节）重定向为项目可导入的 FBX 动画 JSON。

输入（kmd-generate 的 OUTPUT_DIR 下）：
- local_rotations_xyzw.f32  [FRAMES, 30, 4]  局部旋转，XYZW
- root_positions.f32        [FRAMES, 3]      根位移（米，Y-up / Z-forward）

输出：与项目「动画数据提取」相同格式的 JSON（format=fbx-animation-data），
可直接在新建动画里导入，轨道值单位为度以外的四元数（x,y,z,w），时间为秒。

重定向思路：
SOMA 静止姿态是 T-pose 且静止朝向为单位四元数，所以每帧的全局四元数就是相对静止姿态的
世界空间增量。把该增量左乘到 Mixamo 对应骨骼的静止世界朝向上，再按 Mixamo 层级求局部旋转，
即可在骨骼长度、局部轴约定都不同的情况下得到正确姿态。Mixamo 缺失的中间关节（如 Neck2）
只是不输出轨道，其旋转已经包含在子关节的全局旋转里。

用法：
  python tools/kimodo/to_mixamo.py --motion-dir out_run --clip-name "raise hands" `
      --out d:/sgames/3d-desing/data/generated/raise-hands.json
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

# SOMA 30 关节：名称与父索引（来自 kimodo.cpp demo/skeletons_extra.go，NVIDIA Apache-2.0 骨架定义）
SOMA_JOINTS = [
    'Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Head', 'Jaw',
    'LeftEye', 'RightEye', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
    'LeftHandThumbEnd', 'LeftHandMiddleEnd', 'RightShoulder', 'RightArm',
    'RightForeArm', 'RightHand', 'RightHandThumbEnd', 'RightHandMiddleEnd',
    'LeftLeg', 'LeftShin', 'LeftFoot', 'LeftToeBase',
    'RightLeg', 'RightShin', 'RightFoot', 'RightToeBase',
]
SOMA_PARENTS = [
    -1, 0, 1, 2, 3, 4, 5, 6, 6, 6, 3, 10, 11, 12, 13, 13,
    3, 16, 17, 18, 19, 19, 0, 22, 23, 24, 0, 26, 27, 28,
]

# SOMA 关节 → Mixamo 关节；Mixamo 没有 Neck2 / Jaw / 眼球，这些关节不输出轨道
SOMA_TO_MIXAMO = {
    0: 'mixamorigHips',
    1: 'mixamorigSpine',
    2: 'mixamorigSpine1',
    3: 'mixamorigSpine2',
    4: 'mixamorigNeck',
    6: 'mixamorigHead',
    10: 'mixamorigLeftShoulder',
    11: 'mixamorigLeftArm',
    12: 'mixamorigLeftForeArm',
    13: 'mixamorigLeftHand',
    16: 'mixamorigRightShoulder',
    17: 'mixamorigRightArm',
    18: 'mixamorigRightForeArm',
    19: 'mixamorigRightHand',
    22: 'mixamorigLeftUpLeg',
    23: 'mixamorigLeftLeg',
    24: 'mixamorigLeftFoot',
    25: 'mixamorigLeftToeBase',
    26: 'mixamorigRightUpLeg',
    27: 'mixamorigRightLeg',
    28: 'mixamorigRightFoot',
    29: 'mixamorigRightToeBase',
}

FPS = 30
# SOMA 单位是米，Mixamo FBX 是厘米
UNIT_SCALE = 100.0


def load_skeleton(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding='utf-8'))
    nodes = data.get('skeleton')
    if not isinstance(nodes, list) or not nodes:
        raise SystemExit(f'骨架文件缺少 skeleton：{path}')
    return nodes


def real_nodes(nodes: list[dict]) -> list[dict]:
    """只要真实层级的关节。

    Mixamo 的 FBX 会把每根骨骼再包一层同名节点（parent 指向自己、rest 为单位变换），
    抽取缓存里因此同名出现两次。这里按名字保留第一次出现的真实节点。
    """
    seen: set[str] = set()
    result: list[dict] = []
    for node in nodes:
        name = node.get('name')
        if not name or name in seen:
            continue
        seen.add(name)
        result.append(node)
    return result


def clean_label(name: str) -> str:
    trimmed = name.replace('mixamorig', '', 1) if name.lower().startswith('mixamorig') else name
    return trimmed or name


def quat_normalize(q: np.ndarray) -> np.ndarray:
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """四元数乘法，输入/输出均为 (x, y, z, w)。"""
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
        axis=-1,
    )


def quat_conj(q: np.ndarray) -> np.ndarray:
    return np.concatenate([-q[..., :3], q[..., 3:]], axis=-1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--motion-dir', type=Path, required=True, help='kmd-generate 的输出目录')
    parser.add_argument('--skeleton', type=Path, help='参考 Mixamo 骨架 JSON（默认从 data/cache/motion 取）')
    parser.add_argument('--clip-name', default='kimodo motion')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fps', type=float, default=FPS)
    args = parser.parse_args()

    rotation_path = args.motion_dir / 'local_rotations_xyzw.f32'
    root_path = args.motion_dir / 'root_positions.f32'
    rotations = np.fromfile(rotation_path, dtype='<f4').astype(np.float64)
    roots = np.fromfile(root_path, dtype='<f4').astype(np.float64)
    joints_count = len(SOMA_JOINTS)
    frames = rotations.size // (joints_count * 4)
    rotations = rotations.reshape(frames, joints_count, 4)
    roots = roots.reshape(frames, 3)
    if not (np.isfinite(rotations).all() and np.isfinite(roots).all()):
        raise SystemExit('输出里含 NaN/Inf，先检查生成是否成功')

    skeleton_path = args.skeleton
    if skeleton_path is None:
        cache = Path(__file__).resolve().parents[2] / 'data' / 'cache' / 'motion' / 'clips'
        for candidate in sorted(cache.glob('*.json')):
            if len(json.loads(candidate.read_text(encoding='utf-8')).get('skeleton', [])) >= 120:
                skeleton_path = candidate
                break
        if skeleton_path is None:
            raise SystemExit('找不到可用的 Mixamo 骨架缓存，请用 --skeleton 指定')

    nodes = real_nodes(load_skeleton(skeleton_path))
    name_to_index = {node['name']: index for index, node in enumerate(nodes)}
    parent_of = [node.get('parent') for node in nodes]
    rest_local = quat_normalize(np.array([node['rest']['q'] for node in nodes], dtype=np.float64))
    rest_world = np.zeros_like(rest_local)
    for index, parent in enumerate(parent_of):
        rest_world[index] = (
            rest_local[index]
            if parent is None
            else quat_mul(rest_world[name_to_index[parent]], rest_local[index])
        )

    # SOMA 全局旋转：静止姿态是单位四元数，逐帧沿父链累乘局部旋转
    soma_global = np.zeros_like(rotations)
    for index, parent in enumerate(SOMA_PARENTS):
        local = quat_normalize(rotations[:, index])
        soma_global[:, index] = local if parent < 0 else quat_mul(soma_global[:, parent], local)

    tracks: list[dict] = []
    times = [round(index / args.fps, 6) for index in range(frames)]
    mixamo_to_soma = {bone: index for index, bone in SOMA_TO_MIXAMO.items()}

    for soma_index, bone_name in sorted(SOMA_TO_MIXAMO.items()):
        if bone_name not in name_to_index:
            print(f'[retarget] 骨架里没有 {bone_name}，跳过')
            continue
        target_index = name_to_index[bone_name]
        # 目标骨骼的世界朝向 = 源骨骼的静止增量 × 目标静止朝向
        world = quat_mul(soma_global[:, soma_index], rest_world[target_index])
        parent_name = parent_of[target_index]
        if parent_name is None:
            parent_world = np.array([0.0, 0.0, 0.0, 1.0])
        else:
            parent_index = name_to_index[parent_name]
            parent_soma = mixamo_to_soma.get(parent_name)
            # 父骨骼也是动画过的：必须用「父级的静止增量 × 父级静止朝向」，
            # 否则父级旋转会被重复计入子级。父级在 SOMA 里没有对应关节时才退回静止朝向。
            parent_world = (
                quat_mul(soma_global[:, parent_soma], rest_world[parent_index])
                if parent_soma is not None
                else rest_world[parent_index]
            )
        local = quat_normalize(quat_mul(quat_conj(parent_world), world))
        tracks.append(
            {
                'name': f'{bone_name}.quaternion',
                'joint': bone_name,
                'property': 'quaternion',
                'valueType': 'quaternion',
                'valueSize': 4,
                'interpolation': 'LINEAR',
                'times': times,
                'values': np.round(local.reshape(-1), 7).tolist(),
            }
        )

    # 根位移：SOMA 米 → Mixamo 厘米；以 Mixamo 髋部绑定位置为基准，只保留相对首帧的位移
    if 'mixamorigHips' in name_to_index:
        hips_node = nodes[name_to_index['mixamorigHips']]
        hips_rest = np.array(hips_node['rest']['p'], dtype=np.float64)
        positions = hips_rest + (roots - roots[0]) * UNIT_SCALE
        tracks.append(
            {
                'name': 'mixamorigHips.position',
                'joint': 'mixamorigHips',
                'property': 'position',
                'valueType': 'vector',
                'valueSize': 3,
                'interpolation': 'LINEAR',
                'times': times,
                'values': np.round(positions, 4).reshape(-1).tolist(),
            }
        )

    joints = [
        {
            'name': node['name'],
            'label': clean_label(node['name']),
            'parent': node.get('parent'),
            'depth': node.get('depth', 0),
            'rest': {
                'position': [round(v, 6) for v in node['rest']['p']],
                'rotation': [round(v, 6) for v in node['rest']['q']],
                'scale': [round(v, 6) for v in node['rest']['s']],
            },
        }
        for node in nodes
    ]

    payload = {
        'format': 'fbx-animation-data',
        'version': 1,
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'extractor': 'kimodo.cpp retarget',
        'source': {'name': 'kimodo.cpp SOMA RP v1.1'},
        'skeleton': {'jointCount': len(joints), 'joints': joints},
        'timeline': {
            'clipCount': 1,
            'totalDuration': round(frames / args.fps, 6),
            'longestDuration': round(frames / args.fps, 6),
            'fps': args.fps,
            'interval': round(1 / args.fps, 6),
        },
        'clips': [
            {
                'name': args.clip_name,
                'duration': round(frames / args.fps, 6),
                'fps': args.fps,
                'interval': round(1 / args.fps, 6),
                'keyframes': frames,
                'tracks': tracks,
            }
        ],
        'excluded': ['mesh', 'skin', 'material', 'texture'],
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    print(f'[retarget] {frames} 帧 × {len(tracks)} 条轨道 → {args.out}')


if __name__ == '__main__':
    main()
