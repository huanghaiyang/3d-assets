"""临时烟测：用两个已有 Kimodo job 的 f32 切帧，构造双向约束喂给 shim。"""
import struct, os, subprocess, tempfile, shutil

def read_f32(path):
    with open(path, 'rb') as f:
        data = f.read()
    return list(struct.unpack(f'{len(data)//4}f', data))

def write_f32(path, floats):
    with open(path, 'wb') as f:
        f.write(struct.pack(f'{len(floats)}f', *floats))

base = r'D:\sgames\3d-desing\data\kimodo-output'
prev_job = '0254a53b43931d'
next_job = '18365d95b6ef5c'

def slice_frames(data, T, frame_start, frame_end, per_frame):
    """从 data 里切 [frame_start, frame_end) 帧，每帧 per_frame 个 float。"""
    out = []
    for t in range(frame_start, frame_end):
        out.extend(data[t * per_frame : (t + 1) * per_frame])
    return out

prev_root_all = read_f32(os.path.join(base, prev_job, 'root_positions.f32'))
prev_rot_all  = read_f32(os.path.join(base, prev_job, 'local_rotations_xyzw.f32'))
next_root_all = read_f32(os.path.join(base, next_job, 'root_positions.f32'))
next_rot_all  = read_f32(os.path.join(base, next_job, 'local_rotations_xyzw.f32'))

# 60 frames each
TAIL = 1
HEAD = 1
TRANSITION_FRAMES = 1
TOTAL_FRAMES = 24
STEPS = 50
SEED = 43  # 换个 seed 跟 API 那次不同

prev_T = len(prev_root_all) // 3
next_T = len(next_root_all) // 3
print(f'prev={prev_T} next={next_T}, tail={TAIL} head={HEAD}, total={TOTAL_FRAMES}')

# 切 prev 最后 TAIL 帧，next 最初 HEAD 帧
prev_root = slice_frames(prev_root_all, prev_T, prev_T - TAIL, prev_T, 3)
prev_rot  = slice_frames(prev_rot_all,  prev_T, prev_T - TAIL, prev_T, 30*4)
next_root = slice_frames(next_root_all, next_T, 0, HEAD, 3)
next_rot  = slice_frames(next_rot_all,  next_T, 0, HEAD, 30*4)

tmp = r'd:\sgames\3d-desing\data\shim-test'
import shutil as _sh
_sh.rmtree(tmp, ignore_errors=True)
os.makedirs(tmp, exist_ok=True)
prev_root_p = os.path.join(tmp, 'prev_root.f32')
prev_rot_p  = os.path.join(tmp, 'prev_rot.f32')
next_root_p = os.path.join(tmp, 'next_root.f32')
next_rot_p  = os.path.join(tmp, 'next_rot.f32')
prompt_p    = os.path.join(tmp, 'prompt.txt')
out_dir     = os.path.join(tmp, 'out')

write_f32(prev_root_p, prev_root)
write_f32(prev_rot_p,  prev_rot)
write_f32(next_root_p, next_root)
write_f32(next_rot_p,  next_rot)
with open(prompt_p, 'w') as f:
    f.write('smooth standing idle transition between two poses')

print(f'tmp={tmp}')
print(f'  prev_root={len(prev_root)} rot={len(prev_rot)}')
print(f'  next_root={len(next_root)} rot={len(next_rot)}')

shim = r'd:\sgames\3d-desing\tools\kimodo-shim\build\Release\kmd-conditioned-server.exe'
motion = r'D:\thirdparty\kimodo.cpp\models\kimodo-soma-rp-v1.1-f32.gguf'
textb  = r'D:\thirdparty\kimodo.cpp\text\Llama-3-Kimodo-Q4_K_M.gguf'

# 构造 shim 协议行
fields = [
    'CONDITIONED',
    '50',            # steps
    '42',            # seed
    out_dir,
    prev_root_p, prev_rot_p,
    next_root_p, next_rot_p,
    str(TRANSITION_FRAMES),
    str(TOTAL_FRAMES),
    prompt_p,
]
line = '\t'.join(fields)
print(f'LINE: {line}')

proc = subprocess.run(
    [shim, motion, textb],
    input=(line + '\n').encode(),
    capture_output=True,
    timeout=300,
)
print('STDOUT:', proc.stdout.decode(errors='replace'))
print('STDERR:', proc.stderr.decode(errors='replace')[:2000])
print('RC:', proc.returncode)

# 验证输出
out_root = os.path.join(out_dir, 'root_positions.f32')
out_rot  = os.path.join(out_dir, 'local_rotations_xyzw.f32')
if os.path.exists(out_root) and os.path.exists(out_rot):
    or_data = read_f32(out_root)
    ot_data = read_f32(out_rot)
    print(f'\nOUTPUT: root={len(or_data)} rot={len(ot_data)}')
    T_out = len(or_data) // 3
    print(f'T_out={T_out}, expect {TOTAL_FRAMES}')
    # 首帧 vs prev 最后一帧
    first_root = or_data[0:3]
    last_root_of_prev = prev_root_all[(prev_T - 1) * 3 : prev_T * 3]
    print(f'\n首帧 root: {first_root}')
    print(f'prev 末帧 root: {last_root_of_prev}')
    dx = sum((a - b) ** 2 for a, b in zip(first_root, last_root_of_prev)) ** 0.5
    print(f'首帧 vs prev 末帧 RMS 差: {dx:.6f}')

    # 尾帧 vs next 第一帧
    last_root = or_data[-3:]
    first_root_of_next = next_root_all[0:3]
    print(f'\n尾帧 root: {last_root}')
    print(f'next 首帧 root: {first_root_of_next}')
    dx = sum((a - b) ** 2 for a, b in zip(last_root, first_root_of_next)) ** 0.5
    print(f'尾帧 vs next 首帧 RMS 差: {dx:.6f}')
else:
    print('OUTPUT MISSING')
