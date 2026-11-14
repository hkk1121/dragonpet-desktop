# 用 8 个方向的转头帧拼出 360° 视线帧表 gaze：第 1 帧为正面，之后按 [方向][幅度] 排列
# 方向从画面右侧开始顺时针（右、右下、下、左下、左、左上、上、右上），相邻方向之间用 RIFE 补 sub 个中间方向
# 每条射线取 steps 个幅度：从正面帧出发，依次经过 起~止 之间（跳过眨眼帧）的帧，按头部累计变化量（相邻两帧头部差异之和）均分成 steps 档，
# 每档落在两帧之间时用 RIFE 按比例补出，这样每档转动的幅度差不多，第 1 档离正面很近，转头快或中间夹着眨眼时也不会一步跨太大
# 起 取刚开始转头处，止 取刚转到最大角度处；可选的 跳过 为眨眼帧，如 59-61 或 7-9,33-35
# 用法：python_embeded\python.exe -s scripts/build-gaze.py <输出目录> <steps> <sub> <正面 目录:帧> <右 目录:起:止[:跳过]> <右下 ...> ... <右上 ...> [方向序号=目录:起:止[:跳过] ...]
# 目录均相对当前目录，通常在 raw/third_24fps 下运行，输出目录写 ../../assets/pet/gaze
# 末尾可选的 方向序号=目录:起:止（序号从 0 开始，0 为右侧）用真实转头帧代替该方向的插值，其余方向在两侧最近的真实方向之间插值
import os, sys
COMFY = os.environ["COMFYUI_DIR"]  # ComfyUI 根目录，需装有 ComfyUI-Frame-Interpolation 节点
NODE = os.path.join(COMFY, "custom_nodes", "ComfyUI-Frame-Interpolation")
sys.path.insert(0, COMFY)
sys.path.insert(0, NODE)
import numpy as np, torch
from PIL import Image
from vfi_models.rife.rife_arch import IFNet

out_dir, steps, sub = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
center_arg, ray_args = sys.argv[4], sys.argv[5:13]

dev = torch.device("cuda")
model = IFNet(arch_ver="4.7")
model.load_state_dict(torch.load(os.path.join(NODE, "ckpts", "rife", "rife49.pth"), weights_only=False))
model.eval().to(dev)
scale_list = [8, 4, 2, 1]
HEAD = (80, 430)  # 头部所在的行范围（867x867 帧），用于计算头部变化量
icc = None


def load(d, k):
    global icc
    im = Image.open(os.path.join(d, f"{k:03d}.webp"))
    icc = icc or im.info.get("icc_profile")
    raw = torch.from_numpy(np.asarray(im.convert("RGBA")).copy()).permute(2, 0, 1).float().div(255)
    # 预乘 alpha
    return torch.cat((raw[:3] * raw[3:4], raw[3:4]))


def save(pre, idx):
    alpha = pre[3:4]
    rgb = torch.where(alpha > 1e-3, pre[:3] / alpha.clamp(min=1e-3), torch.zeros_like(pre[:3])).clamp(0, 1)
    arr = (torch.cat((rgb, alpha)).permute(1, 2, 0).cpu().numpy() * 255 + 0.5).astype(np.uint8)
    Image.fromarray(arr, "RGBA").save(os.path.join(out_dir, f"{idx:03d}.webp"), quality=90, method=4, icc_profile=icc)


os.makedirs(out_dir, exist_ok=True)
d, k = center_arg.rsplit(":", 1)
center = load(d, int(k))
save(center, 1)
specs = {i * (sub + 1): arg for i, arg in enumerate(ray_args)}
specs.update((int(k), v) for k, v in (arg.split("=", 1) for arg in sys.argv[13:]))
rays = {}
with torch.inference_mode():
    for ai, arg in specs.items():
        d, a, b, *skip = arg.split(":")
        skipped = {k for r in ",".join(skip).split(",") if r for k in range(int(r.split("-")[0]), int(r.split("-")[-1]) + 1)}
        anchors = [(0.0, center)]
        for k in range(int(a), int(b) + 1):
            if k not in skipped:
                img = load(d, k)
                anchors.append((anchors[-1][0] + (img - anchors[-1][1])[:, HEAD[0]:HEAD[1]].abs().mean().item(), img))
        rays[ai] = []
        for m in range(1, steps + 1):
            target = anchors[-1][0] * m / steps
            i = next(i for i in range(1, len(anchors)) if anchors[i][0] >= target)
            (d0, a0), (d1, a1) = anchors[i - 1], anchors[i]
            t = (target - d0) / (d1 - d0)
            rays[ai].append(a1 if t > 0.98 else model(a0[None].to(dev), a1[None].to(dev), torch.tensor([[[[t]]]], device=dev), scale_list, False, True).clamp(0, 1)[0].cpu())
        print(f"[gaze] ray {ai} {arg}: {len(anchors) - 1} anchors, total change {anchors[-1][0] * 1000:.0f}")

    n = len(ray_args) * (sub + 1)
    for ai in range(n):
        for m in range(steps):
            if ai in rays:
                img = rays[ai][m]
            else:
                lo = max(k for k in rays if k < ai)
                hi = min((k for k in rays if k > ai), default=n)
                a, b = rays[lo][m], rays[hi % n][m]
                t = (ai - lo) / (hi - lo)
                img = model(a[None].to(dev), b[None].to(dev), torch.tensor([[[[t]]]], device=dev), scale_list, False, True).clamp(0, 1)[0]
            save(img, 2 + ai * steps + m)
    print(f"[gaze] {n} directions x {steps} steps + center = {1 + n * steps} frames -> {out_dir}")
