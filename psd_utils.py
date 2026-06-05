import io
import inspect
from pathlib import Path
from PIL import Image
import numpy as np

# Pillow 10.x で PIL.ImageMath.eval が削除された互換パッチ
try:
    import PIL.ImageMath as _im
    if not hasattr(_im, "eval") and hasattr(_im, "unsafe_eval"):
        _im.eval = _im.unsafe_eval
except Exception:
    pass


def _path_id(path: list) -> str:
    # [1, 0] -> "1.0"  ツリー内位置パスを安定IDに変換
    return ".".join(str(i) for i in path)


def _build_layer_node(layer, path: list, id_map: dict) -> dict:
    node_id = _path_id(path)
    id_map[node_id] = layer

    node = {
        "id": node_id,
        "name": layer.name,
        "visible": layer.is_visible(),
        "kind": layer.kind.value if hasattr(layer.kind, "value") else str(layer.kind),
        "bbox": {
            "left": layer.left,
            "top": layer.top,
            "right": layer.right,
            "bottom": layer.bottom,
        },
    }

    if layer.is_group():
        node["kind"] = "group"
        node["children"] = [
            _build_layer_node(child, path + [i], id_map)
            for i, child in enumerate(layer)
        ]

    return node


def get_layer_tree(psd):
    id_map = {}
    tree = [_build_layer_node(layer, [i], id_map) for i, layer in enumerate(psd)]
    return tree, id_map


# ============================================================
# フォールバック手動合成
#   layer_filter 非対応・ignore_preview 無効な psd-tools 向け
# ============================================================
def _manual_composite(psd, effective_vis: dict, id_to_path: dict) -> Image.Image:
    canvas = Image.new("RGBA", (psd.width, psd.height), (0, 0, 0, 0))
    W, H = psd.width, psd.height

    def render(layer):
        path_id = id_to_path.get(id(layer))
        is_vis = effective_vis.get(path_id, layer.is_visible()) if path_id else layer.is_visible()
        if not is_vis:
            return

        if layer.is_group():
            for child in layer:
                render(child)
        else:
            try:
                img = layer.composite()
                if img is None:
                    return
                if img.mode != "RGBA":
                    img = img.convert("RGBA")
                tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                x, y = layer.left, layer.top
                # キャンバス範囲内にクリップして貼り付け
                if x < W and y < H and x + img.width > 0 and y + img.height > 0:
                    tmp.paste(img, (x, y))
                    canvas.alpha_composite(tmp)
            except Exception as e:
                print(f"[psd_figure_creator] layer composite error ({layer.name}): {e}")

    for layer in psd:
        render(layer)

    return canvas


# ============================================================
# layer_order 指定時の手動合成（指定された順番で描画）
# ============================================================
def _manual_composite_ordered(psd, effective_vis: dict, id_map: dict, layer_order: list) -> Image.Image:
    canvas = Image.new("RGBA", (psd.width, psd.height), (0, 0, 0, 0))
    W, H = psd.width, psd.height

    def render_node(order_entry):
        lid = order_entry["id"]
        children = order_entry.get("children")

        is_vis = effective_vis.get(lid, True)
        if not is_vis:
            return

        if children:
            for child_entry in children:
                render_node(child_entry)
        else:
            layer = id_map.get(lid)
            if layer is None:
                return
            try:
                img = layer.composite()
                if img is None:
                    return
                if img.mode != "RGBA":
                    img = img.convert("RGBA")
                tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                x, y = layer.left, layer.top
                if x < W and y < H and x + img.width > 0 and y + img.height > 0:
                    tmp.paste(img, (x, y))
                    canvas.alpha_composite(tmp)
            except Exception as e:
                print(f"[psd_figure_creator] layer composite error ({layer.name}): {e}")

    for entry in layer_order:
        render_node(entry)

    return canvas


# ============================================================
# メイン合成関数
# ============================================================
def composite_with_config(psd_path: str, layer_config: dict):
    from psd_tools import PSDImage

    psd = PSDImage.open(psd_path)

    visibility = layer_config.get("visibility", {})
    layer_order = layer_config.get("layer_order")  # フロントエンドで保存した順番

    # パスベースID で id_map / id_to_path を構築
    id_map: dict = {}
    id_to_path: dict = {}

    def collect_ids(layer, path):
        lid = _path_id(path)
        id_map[lid] = layer
        id_to_path[id(layer)] = lid
        if layer.is_group():
            for i, child in enumerate(layer):
                collect_ids(child, path + [i])

    for i, layer in enumerate(psd):
        collect_ids(layer, [i])

    # 実効 visibility を計算
    effective_vis: dict = {}
    for lid, layer in id_map.items():
        effective_vis[lid] = visibility.get(lid, layer.is_visible())

    # カスタムグループが非表示なら配下レイヤーも非表示
    for cg in layer_config.get("custom_groups", []):
        if cg.get("visible") is False:
            for lid in cg.get("layer_ids", []):
                effective_vis[lid] = False

    composite = None

    # ---- layer_order が指定されている場合は順番を反映した手動合成 ----
    if layer_order:
        composite = _manual_composite_ordered(psd, effective_vis, id_map, layer_order)
    else:
        # ---- 方法1: layer_filter パラメータが使える場合 ----
        try:
            sig = inspect.signature(psd.composite)
            if "layer_filter" in sig.parameters:
                def lf(layer):
                    pid = id_to_path.get(id(layer))
                    return effective_vis.get(pid, layer.is_visible()) if pid else layer.is_visible()
                composite = psd.composite(ignore_preview=True, layer_filter=lf)
            else:
                # ---- 方法2: layer.visible を変更して ignore_preview=True ----
                for lid, vis in effective_vis.items():
                    if lid in id_map:
                        id_map[lid].visible = vis
                composite = psd.composite(ignore_preview=True)
        except Exception as e:
            print(f"[psd_figure_creator] composite error, falling back to manual: {e}")

        # ---- 方法3: フォールバック手動合成 ----
        if composite is None:
            composite = _manual_composite(psd, effective_vis, id_to_path)

    if composite is None:
        composite = Image.new("RGBA", (psd.width, psd.height), (0, 0, 0, 0))

    if composite.mode != "RGBA":
        composite = composite.convert("RGBA")

    rgb   = composite.convert("RGB")
    alpha = composite.split()[3]
    return rgb, alpha


def get_layer_image_by_id(psd_path: str, layer_id: str):
    from psd_tools import PSDImage

    psd = PSDImage.open(psd_path)

    try:
        indices = [int(x) for x in layer_id.split(".")]
    except ValueError:
        return None

    current = psd
    for idx in indices:
        children = list(current)
        if idx >= len(children):
            return None
        current = children[idx]

    try:
        img = current.composite()
        if img is None:
            return None
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue(), current.left, current.top
    except Exception:
        return None


def pil_rgb_to_tensor(pil_image):
    import torch
    arr = np.array(pil_image.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr[np.newaxis, ...])


def pil_mask_to_tensor(pil_alpha):
    import torch
    arr = np.array(pil_alpha).astype(np.float32) / 255.0
    return torch.from_numpy(arr[np.newaxis, ...])
