"""读 Kimodo GGUF 里的 motion stats。"""
import struct, os

path = r'D:\thirdparty\kimodo.cpp\models\kimodo-soma-rp-v1.1-f32.gguf'

# GGUF 格式：header 是 magic (4B) + version (4B) + tensor_count (4B) + metadata_count (4B) = 16B
# 然后 metadata kvs，每个 key 是 string，value 有不同类型
# tensor info 之后，actual tensor data 在尾部

with open(path, 'rb') as f:
    magic = f.read(4)
    version, tensor_count, metadata_count = struct.unpack('<III', f.read(12))
    print(f'magic={magic} version={version} tensors={tensor_count} metadata={metadata_count}')
    
    def read_string(f):
        l = struct.unpack('<Q', f.read(8))[0]
        s = f.read(l).decode('utf-8', errors='replace')
        return s
    
    def read_value(f, t):
        """GGUF value type: 0=uint8, 1=int8, 2=uint16, 3=int16, 4=uint32, 5=int32, 6=uint64, 7=int64, 8=float32, 9=float64, 10=bool, 11=string, 12=array, 13=map"""
        if t == 0: return struct.unpack('<B', f.read(1))[0]
        if t == 1: return struct.unpack('<b', f.read(1))[0]
        if t == 2: return struct.unpack('<H', f.read(2))[0]
        if t == 3: return struct.unpack('<h', f.read(2))[0]
        if t == 4: return struct.unpack('<I', f.read(4))[0]
        if t == 5: return struct.unpack('<i', f.read(4))[0]
        if t == 6: return struct.unpack('<Q', f.read(8))[0]
        if t == 7: return struct.unpack('<q', f.read(8))[0]
        if t == 8: return struct.unpack('<f', f.read(4))[0]
        if t == 9: return struct.unpack('<d', f.read(8))[0]
        if t == 10: return bool(f.read(1)[0])
        if t == 11: return read_string(f)
        if t == 12:
            arr_type = struct.unpack('<I', f.read(4))[0]
            arr_size = struct.unpack('<Q', f.read(8))[0]
            items = []
            for _ in range(arr_size):
                items.append(read_value(f, arr_type))
            return items
        if t == 13:
            msize = struct.unpack('<Q', f.read(8))[0]
            d = {}
            for _ in range(msize):
                k = read_string(f)
                vtype = struct.unpack('<I', f.read(4))[0]
                d[k] = read_value(f, vtype)
            return d
        return f'<unknown type {t}>'
    
    tensors_offsets = {}  # name -> (offset, size)
    
    for _ in range(metadata_count):
        key = read_string(f)
        vtype = struct.unpack('<I', f.read(4))[0]
        val = read_value(f, vtype)
        if 'stats' in key.lower() or 'motion_dim' in key.lower() or 'skeleton' in key.lower():
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], float):
                print(f'{key}: shape=({len(val)},) first_10={val[:10]}')
            else:
                print(f'{key}: {val}')
    
    # tensor info
    for _ in range(tensor_count):
        name = read_string(f)
        n_dims = struct.unpack('<Q', f.read(8))[0]
        dims = struct.unpack('<' + 'Q' * n_dims, f.read(8 * n_dims))
        dtype = struct.unpack('<I', f.read(4))[0]
        offset = struct.unpack('<Q', f.read(8))[0]
        if 'stats' in name.lower() or name.startswith('stats'):
            print(f'TENSOR {name}: dims={dims} dtype={dtype} offset={offset}')
        tensors_offsets[name] = (offset, dims, dtype)

# 读 stats 张量的实际值
with open(path, 'rb') as f:
    for name, (off, dims, dtype) in tensors_offsets.items():
        if 'stats' in name or name.startswith('stats'):
            f.seek(off)
            n = 1
            for d in dims: n *= d
            if dtype == 0:  # f32
                data = struct.unpack(f'{n}f', f.read(n*4))
            elif dtype == 1:  # f16, skip
                data = f'<f16 {n}>'
            elif dtype == 32: # f8, skip
                data = f'<f8 {n}>'
            else:
                data = f'<dtype={dtype}>'
            print(f'  {name}: {dims} first_20={list(data)[:20] if isinstance(data, tuple) else data}')
