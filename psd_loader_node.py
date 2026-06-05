import base64
import io
import json
from pathlib import Path

from PIL import Image
import folder_paths
from .psd_utils import composite_with_config, pil_rgb_to_tensor, pil_mask_to_tensor


def _composite_on_bg(psd_rgba: Image.Image, background_image, out_w: int, out_h: int) -> Image.Image:
    """background_image テンソルをキャンバス背景として psd_rgba を上に合成して返す。"""
    bg_np = (background_image[0].cpu().numpy() * 255).clip(0, 255).astype("uint8")
    bg_pil = Image.fromarray(bg_np, "RGB").convert("RGBA")
    bg_w, bg_h = bg_pil.size
    scale = min(out_w / bg_w, out_h / bg_h)
    new_bw = max(1, int(bg_w * scale))
    new_bh = max(1, int(bg_h * scale))
    bg_resized = bg_pil.resize((new_bw, new_bh), Image.LANCZOS)
    canvas = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 255))
    canvas.paste(bg_resized, ((out_w - new_bw) // 2, (out_h - new_bh) // 2))
    return Image.alpha_composite(canvas, psd_rgba)


class PSDFigureCreatorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "psd_filename": ("STRING", {"default": ""}),
                "layer_config": ("STRING", {"default": "{}"}),
                "output_width":  ("INT", {"default": 512, "min": 0, "max": 8192, "step": 64}),
                "output_height": ("INT", {"default": 512, "min": 0, "max": 8192, "step": 64}),
                "image_data":    ("STRING", {"default": ""}),
                "background_image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load_psd"
    CATEGORY = "image/psd"

    def load_psd(self, psd_filename="", layer_config="{}", output_width=0, output_height=0,
                 image_data="", unique_id=None, background_image=None):
        # image_data が設定されている場合はクライアントキャプチャを使用
        # background_image がある場合はその下に合成する（最優先）
        if image_data and image_data.strip():
            try:
                data = image_data
                if "," in data:
                    data = data.split(",", 1)[1]
                decoded = base64.b64decode(data)
                if len(decoded) > 8 and decoded.startswith(b"\x89PNG\r\n\x1a\n"):
                    pil = Image.open(io.BytesIO(decoded)).convert("RGBA")
                    if output_width > 0 and output_height > 0 and pil.size != (output_width, output_height):
                        pil = pil.resize((output_width, output_height), Image.LANCZOS)
                    out_w, out_h = pil.size
                    if background_image is not None:
                        pil = _composite_on_bg(pil, background_image, out_w, out_h)
                    rgb   = pil.convert("RGB")
                    alpha = pil.split()[-1]
                    return (pil_rgb_to_tensor(rgb), pil_mask_to_tensor(alpha))
            except Exception as e:
                print(f"[PSDFigureCreator] image_data decode error: {e}")

        # 通常の server-side compositing
        if not psd_filename:
            raise ValueError("PSDファイルが指定されていません。ノードのボタンからファイルを選択してください。")

        psd_dir = Path(folder_paths.get_input_directory()) / "psd"
        psd_path = psd_dir / Path(psd_filename).name

        if not psd_path.exists():
            raise FileNotFoundError(f"PSDファイルが見つかりません: {psd_path}")

        try:
            config = json.loads(layer_config) if layer_config else {}
        except json.JSONDecodeError:
            config = {}

        rgb, alpha = composite_with_config(str(psd_path), config)

        if output_width > 0 or output_height > 0:
            w, h = rgb.size
            if output_width > 0 and output_height > 0:
                new_w, new_h = output_width, output_height
            elif output_width > 0:
                new_h = max(1, int(h * output_width / w))
                new_w = output_width
            else:
                new_w = max(1, int(w * output_height / h))
                new_h = output_height
            rgb   = rgb.resize((new_w, new_h), Image.LANCZOS)
            alpha = alpha.resize((new_w, new_h), Image.LANCZOS)

        # background_image があれば最下層に合成
        if background_image is not None:
            out_w, out_h = rgb.size
            psd_rgba = rgb.convert("RGBA")
            psd_rgba.putalpha(alpha)
            result = _composite_on_bg(psd_rgba, background_image, out_w, out_h)
            rgb   = result.convert("RGB")
            alpha = result.split()[-1]

        return (pil_rgb_to_tensor(rgb), pil_mask_to_tensor(alpha))

    @classmethod
    def IS_CHANGED(cls, psd_filename="", layer_config="{}", output_width=0, output_height=0,
                   image_data="", unique_id=None, background_image=None):
        import hashlib
        bg_key = str(background_image.shape) if background_image is not None else ""
        key = f"{psd_filename}|{layer_config}|{output_width}|{output_height}|{image_data}|{bg_key}"
        return hashlib.md5(key.encode()).hexdigest()


NODE_CLASS_MAPPINGS = {
    "PSDFigureCreator": PSDFigureCreatorNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PSDFigureCreator": "PSD Figure Creator",
}
