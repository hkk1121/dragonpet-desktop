# 为 gaze 帧表预计算相邻帧之间的光流，供运行时 WebGL 按任意比例变形混合（代替淡入淡出）
# 两套光流，都用 RIFE 在 t=0.5 处求出：中间帧 -> 前一帧的光流 F0、中间帧 -> 后一帧的光流 F1、混合遮罩 M
#   <帧号>a.webp：方向光流 (a, m) -> (a+1, m)，帧号为 (a, m) 的帧号（m >= 1）
#   <帧号>m.webp：幅度光流 (a, m-1) -> (a, m)，帧号为 (a, m) 的帧号，m=1 时前一帧是正面帧
# 帧号即 gaze 目录里的文件序号（第 1 帧正面，(a, m) 为 1 + a*steps + m），两套都是 2 ~ 1+directions*steps
# 文件为无损 RGB，宽 2w+2 高 h（w、h 为 1/down 分辨率）：
#   左半 [0, w)：R=F0.x G=F0.y B=M；中间 2 列为两侧边缘的复制（避免双线性采样串到另一半）；右半 [w+2, 2w+2)：R=F1.x G=F1.y B=0
#   光流编码：字节 = 128 + 光流像素（按原图分辨率）× scale，scale 默认 2（±64px，精度 0.5px）
# 用法（在项目根目录）：python_embeded\python.exe -s scripts/build-gaze-flow.py <gaze 目录> <输出目录> <directions> <steps> [down=8] [scale=2]
# 加 --preview <输出 webp> 时额外按运行时着色器的算法渲染一段从正面螺旋向外绕两圈的预览（读回编码后的光流），以及同名 -fade 的淡入淡出对比
import os, sys
COMFY = os.environ["COMFYUI_DIR"]  # ComfyUI 根目录，需装有 ComfyUI-Frame-Interpolation 节点
NODE = os.path.join(COMFY, "custom_nodes", "ComfyUI-Frame-Interpolation")
sys.path.insert(0, COMFY)
sys.path.insert(0, NODE)
import numpy as np, torch
import torch.nn.functional as F
from PIL import Image
from vfi_models.rife import rife_arch
from vfi_models.rife.rife_arch import IFNet

args = [a for a in sys.argv[1:] if a != "--preview"]
preview = sys.argv[sys.argv.index("--preview") + 1] if "--preview" in sys.argv else None
if preview:
    args.remove(preview)
gaze_dir, out_dir, dirs, steps = args[0], args[1], int(args[2]), int(args[3])
down = int(args[4]) if len(args) > 4 else 8
scale = float(args[5]) if len(args) > 5 else 2.0

dev = torch.device("cuda")
model = IFNet(arch_ver="4.7")
model.load_state_dict(torch.load(os.path.join(NODE, "ckpts", "rife", "rife49.pth"), weights_only=False))
model.eval().to(dev)

# 截获 RIFE 最终的光流和遮罩：forward 末尾最后两次 warp 用的是最终光流，最后一次 sigmoid 是最终遮罩
cap = {}
orig_warp, orig_sigmoid = rife_arch.warp, torch.sigmoid


def warp_hook(x, f):
    cap["flows"] = (cap.get("flows") or [])[-1:] + [f]
    return orig_warp(x, f)


def sigmoid_hook(x):
    cap["mask"] = orig_sigmoid(x)
    return cap["mask"]


cache = {}


def load(i):
    if i not in cache:
        raw = torch.from_numpy(np.asarray(Image.open(os.path.join(gaze_dir, f"{i:03d}.webp")).convert("RGBA")).copy()).permute(2, 0, 1).float().div(255)
        cache[i] = torch.cat((raw[:3] * raw[3:4], raw[3:4]))[None].to(dev)
    return cache[i]


def frame_no(a, m):
    return 1 if m == 0 else 1 + (a % dirs) * steps + m


def save_flow(i0, i1, name):
    img0, img1 = load(i0), load(i1)
    H, W = img0.shape[2:]
    rife_arch.warp, torch.sigmoid = warp_hook, sigmoid_hook
    try:
        model(img0, img1, torch.tensor([[[[0.5]]]], device=dev), [8, 4, 2, 1], False, True)
    finally:
        rife_arch.warp, torch.sigmoid = orig_warp, orig_sigmoid
    f0, f1 = (f[:, :, :H, :W] for f in cap["flows"])
    mask = cap["mask"][:, :, :H, :W]
    h, w = H // down, W // down
    small = F.interpolate(torch.cat((f0, mask, f1), 1), size=(h, w), mode="area")[0]
    sat = ((small[[0, 1, 3, 4]] * scale).abs() > 127).sum().item()
    enc = lambda t: (128 + t * scale).round().clamp(0, 255)
    left = torch.stack((enc(small[0]), enc(small[1]), (small[2] * 255).round().clamp(0, 255)))
    right = torch.stack((enc(small[3]), enc(small[4]), torch.zeros_like(small[0])))
    pack = torch.cat((left, left[:, :, -1:], right[:, :, :1], right), 2)
    Image.fromarray(pack.permute(1, 2, 0).byte().cpu().numpy(), "RGB").save(os.path.join(out_dir, name), lossless=True, quality=100, method=6)
    return sat


os.makedirs(out_dir, exist_ok=True)
with torch.inference_mode():
    for a in range(dirs):
        for m in range(1, steps + 1):
            for i0, i1, name in ((frame_no(a, m), frame_no(a + 1, m), f"{frame_no(a, m):03d}a.webp"),
                                 (frame_no(a, m - 1), frame_no(a, m), f"{frame_no(a, m):03d}m.webp")):
                sat = save_flow(i0, i1, name)
                if sat:
                    print(f"[gaze-flow] {name} {sat} pixels clamped, consider a smaller scale")
    print(f"[gaze-flow] {dirs} x {steps} x 2 flows -> {out_dir}")

    if preview:
        H, W = load(1).shape[2:]
        base = torch.stack(torch.meshgrid(torch.linspace(-1, 1, H, device=dev), torch.linspace(-1, 1, W, device=dev), indexing="ij")[::-1], -1)[None]
        zero = None

        def read_flow(name):
            # 返回原图分辨率的 (F0, M, F1)，F 单位为像素；没有时为零光流、遮罩 0.5
            if name is None:
                return torch.zeros(2, H, W, device=dev), torch.full((1, H, W), 0.5, device=dev), torch.zeros(2, H, W, device=dev)
            arr = torch.from_numpy(np.asarray(Image.open(os.path.join(out_dir, name)).convert("RGB")).copy()).permute(2, 0, 1).float().to(dev)
            w = (arr.shape[2] - 2) // 2
            big = F.interpolate(torch.cat((arr[:, :, :w], arr[:, :, w + 2:]), 0)[None], size=(H, W), mode="bilinear", align_corners=False)[0]
            return (big[0:2] - 128) / scale, big[2:3] / 255, (big[3:5] - 128) / scale

        def sample(img, pos):
            # pos 为 [1, H, W, 2] 的归一化坐标
            return F.grid_sample(img, pos, mode="bilinear", padding_mode="border", align_corners=True)

        def sample_field(t, pos):
            return F.grid_sample(t[None], pos, mode="bilinear", padding_mode="border", align_corners=True)[0]

        def px(flow):
            return torch.stack((flow[0] / ((W - 1) / 2), flow[1] / ((H - 1) / 2)), -1)[None]

        def weight(s, msk):
            return (1 - s) * msk / ((1 - s) * msk + s * (1 - msk) + 1e-6)

        def mag(i0, i1, flow, pos, s):
            # 在 pos 处按光流把 i0、i1 变形到比例 s 后混合，和着色器的 mag() 一致
            f0, msk, f1 = (sample_field(x, pos) for x in flow)
            wa = sample(load(i0), pos + px(f0) * s * 2)
            wb = sample(load(i1), pos + px(f1) * (1 - s) * 2)
            k = weight(s, msk)
            return wa * k + wb * (1 - k)

        def morph(a, m):
            # 和着色器一致：先按幅度光流在每一列变形，再按两行插值后的方向光流在两列之间变形
            a0, m0 = int(a), int(m)
            t, fm = a - a0, m - m0
            m1 = min(m0 + 1, steps)
            a1 = (a0 + 1) % dirs
            n00, n10, n01, n11 = frame_no(a0, m0), frame_no(a1, m0), frame_no(a0, m1), frame_no(a1, m1)
            d0 = read_flow(f"{n00:03d}a.webp" if m0 else None)
            d1 = read_flow(f"{n01:03d}a.webp" if m1 else None)
            g0 = read_flow(f"{n01:03d}m.webp" if m1 > m0 else None)
            g1 = read_flow(f"{n11:03d}m.webp" if m1 > m0 else None)
            f0, msk, f1 = (x * (1 - fm) + y * fm for x, y in zip(d0, d1))
            wa = mag(n00, n01, g0, base + px(f0) * t * 2, fm)
            wb = mag(n10, n11, g1, base + px(f1) * (1 - t) * 2, fm)
            k = weight(t, msk)
            return wa * k + wb * (1 - k)

        def fade(a, m):
            a0, m0 = int(a), int(m)
            t, fm = a - a0, m - m0
            m1 = min(m0 + 1, steps)
            a1 = (a0 + 1) % dirs
            return ((load(frame_no(a0, m0)) * (1 - t) + load(frame_no(a1, m0)) * t) * (1 - fm)
                    + (load(frame_no(a0, m1)) * (1 - t) + load(frame_no(a1, m1)) * t) * fm)

        def to_pil(pre):
            pre = pre[0]
            alpha = pre[3:4]
            rgb = torch.where(alpha > 1e-3, pre[:3] / alpha.clamp(min=1e-3), torch.zeros_like(pre[:3])).clamp(0, 1)
            rgba = (torch.cat((rgb, alpha)).permute(1, 2, 0).cpu().numpy() * 255 + 0.5).astype(np.uint8)
            # 只取头部区域，铺白底方便看
            im = Image.fromarray(rgba, "RGBA").crop((W // 6, 0, W * 5 // 6, H // 2))
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            return Image.alpha_composite(bg, im).convert("RGB").resize((im.width // 2, im.height // 2), Image.LANCZOS)

        # 从正面螺旋向外，两圈到最大幅度，30fps 播放约 16 秒
        n = dirs * 20
        for fn, path in ((morph, preview), (fade, preview.replace(".webp", "-fade.webp"))):
            frames = []
            for k in range(n):
                a = (k / 10) % dirs
                m = min(steps, k / (n - 1) * steps * 1.15)
                frames.append(to_pil(fn(a, m)))
            frames[0].save(path, save_all=True, append_images=frames[1:], duration=33, loop=0, quality=85)
            print(f"[gaze-flow] preview -> {path}")
