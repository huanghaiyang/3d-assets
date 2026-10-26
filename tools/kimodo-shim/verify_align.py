"""验证 conditioned 任务首尾对齐。"""
import struct, os

def read_f32(path):
    with open(path, 'rb') as f:
        data = f.read()
    return list(struct.unpack(f'{len(data)//4}f', data))

base = r'D:\sgames\3d-desing\data\kimodo-output'

# conditioned 任务输出
out_root = os.path.join(base, '6fdb3526d03c6e', 'root_positions.f32')
out_rot  = os.path.join(base, '6fdb3526d03c6e', 'local_rotations_xyzw.f32')
out_r = read_f32(out_root)
T = len(out_r) // 3

# prev / next 原始 root（API 切了最后 1 帧 / 开头 1 帧）
prev_root = os.path.join(base, '0254a53b43931d', 'root_positions.f32')
next_root = os.path.join(base, '18365d95b6ef5c', 'root_positions.f32')
prev_r_all = read_f32(prev_root); prev_T = len(prev_r_all) // 3
next_r_all = read_f32(next_root); next_T = len(next_r_all) // 3

first = out_r[0:3]
last  = out_r[(T-1)*3 : T*3]
prev_last = prev_r_all[(prev_T-1)*3 : prev_T*3]
next_first = next_r_all[0:3]

print(f'输出 T={T} 帧')
print(f'首帧 root: {first}')
print(f'prev 末帧: {prev_last}')
dx1 = sum((a-b)**2 for a,b in zip(first, prev_last))**0.5
print(f'首帧 vs prev 末 RMS 差: {dx1:.6f} m')
print()
print(f'尾帧 root: {last}')
print(f'next 首帧: {next_first}')
dx2 = sum((a-b)**2 for a,b in zip(last, next_first))**0.5
print(f'尾帧 vs next 首 RMS 差: {dx2:.6f} m')
print()
print('PASS' if dx1 < 0.01 and dx2 < 0.01 else 'FAIL')
