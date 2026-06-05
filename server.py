import io
import json
from pathlib import Path

from aiohttp import web
from server import PromptServer

import folder_paths


def _get_psd_dir() -> Path:
    psd_dir = Path(folder_paths.get_input_directory()) / "psd"
    psd_dir.mkdir(parents=True, exist_ok=True)
    return psd_dir


def _build_layer_tree(psd) -> list:
    def _node(layer, path):
        lid = ".".join(str(i) for i in path)
        node = {
            "id": lid,
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
            node["children"] = [_node(child, path + [i]) for i, child in enumerate(layer)]
        return node

    return [_node(layer, [i]) for i, layer in enumerate(psd)]


@PromptServer.instance.routes.post("/psd_loader/upload")
async def upload_psd(request: web.Request):
    try:
        from psd_tools import PSDImage

        reader = await request.multipart()
        field = await reader.next()

        if field is None or field.name != "file":
            return web.json_response({"error": "ファイルフィールドが見つかりません"}, status=400)

        filename = Path(field.filename or "").name  # ディレクトリ成分を除去
        if not filename or not filename.lower().endswith(".psd"):
            return web.json_response({"error": "PSDファイルのみアップロード可能です"}, status=400)

        psd_dir = _get_psd_dir()
        save_path = psd_dir / filename
        if not save_path.resolve().is_relative_to(psd_dir.resolve()):
            return web.json_response({"error": "invalid filename"}, status=400)

        with open(save_path, "wb") as f:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                f.write(chunk)

        psd = PSDImage.open(str(save_path))
        tree = _build_layer_tree(psd)

        return web.json_response({
            "filename": filename,
            "width": psd.width,
            "height": psd.height,
            "layers": tree,
        })

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/psd_loader/layers")
async def get_layers(request: web.Request):
    try:
        from psd_tools import PSDImage

        filename = Path(request.rel_url.query.get("filename", "")).name
        if not filename:
            return web.json_response({"error": "filenameパラメータが必要です"}, status=400)

        psd_dir = _get_psd_dir()
        psd_path = psd_dir / filename

        if not psd_path.exists():
            return web.json_response({"error": "ファイルが見つかりません"}, status=404)

        psd = PSDImage.open(str(psd_path))
        tree = _build_layer_tree(psd)

        return web.json_response({
            "filename": filename,
            "width": psd.width,
            "height": psd.height,
            "layers": tree,
        })

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/psd_loader/layer_image")
async def get_layer_image(request: web.Request):
    import asyncio

    filename = Path(request.rel_url.query.get("filename", "")).name
    layer_id = request.rel_url.query.get("id", "")

    if not filename or not layer_id:
        return web.Response(status=400)

    psd_dir = _get_psd_dir()
    psd_path = psd_dir / filename

    if not psd_path.exists():
        return web.Response(status=404)

    try:
        from .psd_utils import get_layer_image_by_id
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, get_layer_image_by_id, str(psd_path), layer_id)

        if result is None:
            return web.Response(status=404)

        img_bytes, left, top = result

        return web.Response(
            body=img_bytes,
            content_type="image/png",
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Layer-Left": str(left),
                "X-Layer-Top": str(top),
            },
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/psd_loader/preview")
async def get_preview(request: web.Request):
    import asyncio
    from PIL import Image as PilImage

    filename = Path(request.rel_url.query.get("filename", "")).name
    config_str = request.rel_url.query.get("config", "{}")
    try:
        thumb_w = min(int(request.rel_url.query.get("width", "256")), 4096)
    except ValueError:
        thumb_w = 256

    if not filename:
        return web.json_response({"error": "filenameが必要です"}, status=400)

    try:
        config = json.loads(config_str)
    except Exception:
        config = {}

    psd_dir = _get_psd_dir()
    psd_path = psd_dir / filename

    if not psd_path.exists():
        return web.Response(status=404)

    try:
        from .psd_utils import composite_with_config
        loop = asyncio.get_event_loop()
        rgb, alpha = await loop.run_in_executor(
            None, composite_with_config, str(psd_path), config
        )

        rgba = rgb.convert("RGBA")
        rgba.putalpha(alpha)

        w, h = rgba.size
        if w > 0:
            thumb_h = int(h * thumb_w / w)
            rgba = rgba.resize((thumb_w, thumb_h), PilImage.LANCZOS)

        buf = io.BytesIO()
        rgba.save(buf, format="PNG")

        return web.Response(
            body=buf.getvalue(),
            content_type="image/png",
            headers={"Cache-Control": "no-store"},
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


# ================================================
# Library API  (user_data/models, user_data/poses)
# ================================================

def _get_library_dir(subdir: str) -> Path:
    d = Path(__file__).parent / "user_data" / subdir
    d.mkdir(parents=True, exist_ok=True)
    return d


@PromptServer.instance.routes.get("/psd_loader/library/models")
async def library_list_models(request: web.Request):
    d = _get_library_dir("models")
    result = []
    for f in sorted(d.glob("*.psd-model.json")):
        try:
            data = json.loads(f.read_text("utf-8"))
            result.append({
                "filename":     f.name,
                "name":         f.name[: -len(".psd-model.json")],
                "psd_filename": data.get("psd_filename", ""),
                "thumbnail":    data.get("thumbnail"),
            })
        except Exception:
            pass
    return web.json_response(result)


@PromptServer.instance.routes.get("/psd_loader/library/models/{name}")
async def library_get_model(request: web.Request):
    name = request.match_info["name"]
    if any(c in name for c in ("\\", "/", "..")):
        return web.json_response({"error": "invalid name"}, status=400)
    f = _get_library_dir("models") / name
    if not f.exists():
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(json.loads(f.read_text("utf-8")))


@PromptServer.instance.routes.post("/psd_loader/library/models")
async def library_save_model(request: web.Request):
    try:
        body  = await request.json()
        fname = body.get("filename", "").strip()
        if not fname:
            return web.json_response({"error": "filename required"}, status=400)
        if any(c in fname for c in ("\\", "/", "..")):
            return web.json_response({"error": "invalid filename"}, status=400)
        if not fname.endswith(".psd-model.json"):
            fname += ".psd-model.json"
        f = _get_library_dir("models") / fname
        f.write_text(json.dumps(body.get("content", {}), ensure_ascii=False, indent=2), "utf-8")
        return web.json_response({"ok": True, "filename": fname})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.delete("/psd_loader/library/models/{name}")
async def library_delete_model(request: web.Request):
    name = request.match_info["name"]
    if any(c in name for c in ("\\", "/", "..")):
        return web.json_response({"error": "invalid name"}, status=400)
    f = _get_library_dir("models") / name
    if f.exists():
        f.unlink()
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/psd_loader/library/poses")
async def library_list_poses(request: web.Request):
    d = _get_library_dir("poses")
    result = []
    for f in sorted(d.glob("*.pose.json")):
        try:
            data = json.loads(f.read_text("utf-8"))
            result.append({
                "filename":  f.name,
                "name":      f.name[: -len(".pose.json")],
                "thumbnail": data.get("thumbnail"),
            })
        except Exception:
            pass
    return web.json_response(result)


@PromptServer.instance.routes.get("/psd_loader/library/poses/{name}")
async def library_get_pose(request: web.Request):
    name = request.match_info["name"]
    if any(c in name for c in ("\\", "/", "..")):
        return web.json_response({"error": "invalid name"}, status=400)
    f = _get_library_dir("poses") / name
    if not f.exists():
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(json.loads(f.read_text("utf-8")))


@PromptServer.instance.routes.post("/psd_loader/library/poses")
async def library_save_pose(request: web.Request):
    try:
        body  = await request.json()
        fname = body.get("filename", "").strip()
        if not fname:
            return web.json_response({"error": "filename required"}, status=400)
        if any(c in fname for c in ("\\", "/", "..")):
            return web.json_response({"error": "invalid filename"}, status=400)
        if not fname.endswith(".pose.json"):
            fname += ".pose.json"
        f = _get_library_dir("poses") / fname
        f.write_text(json.dumps(body.get("content", {}), ensure_ascii=False, indent=2), "utf-8")
        return web.json_response({"ok": True, "filename": fname})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.delete("/psd_loader/library/poses/{name}")
async def library_delete_pose(request: web.Request):
    name = request.match_info["name"]
    if any(c in name for c in ("\\", "/", "..")):
        return web.json_response({"error": "invalid name"}, status=400)
    f = _get_library_dir("poses") / name
    if f.exists():
        f.unlink()
    return web.json_response({"ok": True})
