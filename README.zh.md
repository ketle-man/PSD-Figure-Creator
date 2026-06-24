# ComfyUI PSD Figure Creator

**Language / 言語 / 语言:** [English](README.md) | [日本語](README.ja.md) | 中文

一个 ComfyUI 自定义节点，用于加载 PSD 文件、在图层上放置绑定控制点、
并将合成结果作为 `IMAGE` + `MASK` 输出。

---

## 功能

- **交互式图层查看器** — 切换图层显示/隐藏，重命名图层和自定义组
- **自定义组** — 将图层归入命名组，拖拽调整绘制顺序
- **绑定系统** — 直接在画布上为图层放置控制点：
  - **R**（蓝色）— 仅旋转
  - **MR**（红色/橙色）— 移动 ＋ 旋转
  - **LSW**（绿色）— L切换：旋转手柄以步进切换最多 12 个槽位；**+L** 添加单个图层（1 槽位），**+P** 将组/文件夹按图层逐一展开（Piece，N 槽位），**+C** 将组/文件夹整体合成为 1 槽位（Composite）
  - **PSW**（白色）— P切换：旋转手柄以切换已注册的姿势；以 30° 为间隔在最多 12 个槽位中注册 R/MR 姿势状态
- **设置模式 / 姿势模式** — 在设置模式中配置绑定，在姿势模式中进行动作
- **关键帧动画** — 在指定帧记录姿势，在关键帧之间自动插值（位置线性插值，角度取最短路径插值），支持播放预览、WebM 视频导出（推荐使用 Chrome/Edge）及透明动画GIF导出。可将完整动画项目保存到库中并重新加载。
- **库** — 保存/加载命名模型文件（`.psd-model.json`）、姿势文件及关键帧动画项目
- **背景选项** — 棋盘格图案 / 纯色 / 本地图像 / 上游 `IMAGE` 节点
- **Capture → Queue Prompt** — 将当前画布状态烘焙为输出图像
- **国际化** — 通过 `navigator.language` 自动检测语言（日语 / 英语 / 简体中文）

---

## 截图

### 动画输出示例

![动画输出](docs/Animation.gif)

### 节点

![节点基本视图](docs/0_node.png)

### 节点 — 关键帧动画面板展开

![展开关键帧面板的节点](docs/1_node.png)

### 编辑器 — 图层选项卡（设置模式）

![MR 点位放置中的图层选项卡](docs/2_setup_layers.png)

### 编辑器 — 父级选项卡

![显示全部绑定标签的父级选项卡](docs/3_setup_parent.png)

### 编辑器 — 切换选项卡

![SW 点位配置中的切换选项卡](docs/4_setup_switch.png)

### 节点预览 — 绑定完成

![显示所有绑定点的节点预览](docs/5_setup_complete.png)

### 库 — 模型与姿势浏览器

![库面板](docs/6_library.png)

### 在 ComfyUI 工作流中使用 Capture

![工作流中的 Capture 使用示例](docs/7_capture.png)

### 编辑器 — P切换选项卡（设置模式）

![PSW 点位配置中的P切换选项卡](docs/8_pose_switch.png)

---

## 安装

```bash
# 1. 将此文件夹复制或创建符号链接到 ComfyUI 的 custom_nodes 目录
#    例：ComfyUI/custom_nodes/psd-image-loader/

# 2. 安装 Python 依赖
pip install psd-tools
```

重启 ComfyUI，节点将显示在 **image/psd → PSD Figure Creator** 下。

---

## 示例数据

`user_data/` 目录中附带了可直接使用的示例：

| 文件 | 说明 |
|---|---|
| `user_data/sample_1.psd` | 示例角色 PSD |
| `user_data/models/sample.psd-model.json` | 预配置模型（R/MR 绑定、父级层级、SW 切换） |
| `user_data/models/sample2_lswpswset-model.psd-model.json` | 配置了 LSW 和 PSW 点位的预设模型 |
| `user_data/poses/pose1.pose.json` | 示例姿势 1 |
| `user_data/poses/pose2.pose.json` | 示例姿势 2 |
| `user_data/poses/project-psw.pose.json` | 使用 PSW 的示例关键帧动画项目 |

**使用方法：**
1. 将 `user_data/sample_1.psd` 复制到 `ComfyUI/input/psd/`
2. 打开 **Editor**，点击 **📂 model** — 库中将显示 `sample`
3. 加载模型；示例姿势可通过姿势库使用

> **从 PSD Loader（≤ v2.16）升级：**  
> 如果工作流 JSON 中包含 `"PSDLoader"`，请替换为 `"PSDFigureCreator"`。

---

## 迁移到新电脑

迁移到新电脑时，需要分别传输以下两项内容。

### 1. PSD 文件
PSD 文件保存在 ComfyUI 的 `input/psd/` 目录中。
```
ComfyUI/input/psd/  →  复制到新电脑的同路径下
```

### 2. 库数据（模型与姿势）
库数据保存在自定义节点文件夹内的 `user_data/` 目录中。
```
ComfyUI/custom_nodes/PSD-Figure-Creator/user_data/  →  复制到新电脑的同路径下
```

> **携带工作流 JSON 时的注意事项：** 如果工作流中已保存 `psd_filename`，但新电脑的 `input/psd/` 中不存在该 PSD 文件，则会弹出「获取图层信息失败」的提示。此时直接点击 **Setup** 按钮，编辑器仍会以空图层状态打开（v0.5.2 起），然后通过 **Open PSD** 按钮重新选择文件即可。

---

## 节点输入输出

| 参数 | 类型 | 说明 |
|---|---|---|
| `psd_filename` | STRING | 相对于 `input/psd/` 目录的 PSD 文件路径 |
| `layer_config` | STRING | UI 编辑器生成的 JSON 字符串 |
| `output_width` | INT | 输出宽度（像素，可按 1px 单位调整），0 = 使用 PSD 原始尺寸 |
| `output_height` | INT | 输出高度（像素，可按 1px 单位调整），0 = 使用 PSD 原始尺寸 |
| `image_data` | STRING | 来自 Capture 的 Base64 PNG（跳过服务端合成） |
| `background_image` | IMAGE | 合成为最底层的上游节点图像（可选） |

| 输出 | 类型 | 说明 |
|---|---|---|
| `image` | IMAGE | 合成后的 RGB 图像 |
| `mask` | MASK | Alpha 通道 |

---

## 界面概览

```
[✨ 新建] [📂 PSD 文件]  [⟳]
[Editor]          [⏱] [RC]
[📸 Capture]
 ┌──────────────────────────────────┐   ← 关键帧面板（⏱ 切换开关）
 │ [+KF][🗑KF]|[+CK][-CK]|[↔]|[0][◀][f]/[t][▶] │
 │ ◆────◆──────── 时间轴 ────────── │
 │ [New] FPS[24] [💾Proj] [🎬WebM][🎞️GIF] [▶▶] [■] │
 └──────────────────────────────────┘
 ┌────────────────────────┐
 │  预览画布               │
 └────────────────────────┘
 Point Size: ─────────────
 BG: [■ 颜色][✕] [🖼 图像][✕] [🔗 已连接?]
```

- **Editor** — 打开全屏设置/姿势模态框
- **⏱** — 切换关键帧动画面板的显示/隐藏
- **RC** — 重置摄像机（平移 + 缩放）
- **✨ 新建** — 清除所有绑定、SW 图层和姿势（有确认提示）

### 设置模态框标签页

| 标签页 | 内容 |
|---|---|
| 图层 | 图层树、自定义组管理、绑定模式按钮（R / MR / LSW / PSW） |
| 父级 | 用于传播变换的父子层级 |
| L切换 | LSW 图层列表和组槽编辑器 |
| P切换 | PSW 点位列表、槽位管理及姿势注册 |

---

## 绑定系统

### R — 旋转
蓝色圆点。在姿势模式下拖拽，可绕放置的轴心旋转图层。

### MR — 移动 ＋ 旋转
红色原点 ＋ 橙色手柄。拖拽手柄可同时进行移动和旋转。

### LSW — L切换
绿色原点 ＋ 青色手柄。旋转手柄以 30° 为步进切换已注册的槽位（最多 12 个槽位 × 30° ＝ 360°）。  
在设置模式下拖拽原点可重新定位；拖拽手柄可调整半径和初始角度。

**槽位条目类型**（在 L切换 选项卡中配置）：

| 按钮 | 条目 | 标记 | 槽位数 |
|---|---|---|---|
| `+L` | 单个 PSD 图层 | `[L]` | 1 个槽位 |
| `+P` | 自定义组 / PSD 文件夹（Piece） | `[P]` | 每个成员 / 叶图层 1 个槽位 |
| `+C` | 自定义组 / PSD 文件夹（Composite） | `[C]` | 1 个槽位（所有成员合成渲染） |

若已注册的组或文件夹被删除，对应行将显示红色背景和 ⚠ 图标（孤立条目）。请在添加新条目前手动删除孤立条目。

### PSW — P切换
白色原点 ＋ 紫色手柄。旋转手柄可切换已注册的姿势（R/MR 状态）。

**使用方法**（在 P切换 选项卡中配置）：

1. 在 Setup 模式下点击 **PSW** 按钮（首次使用时自动创建 PSW 图层），然后点击画布放置点位
2. 使用 **`+Slot`** 以 30° 为间隔添加槽位（最多 12 个）；**`−Slot`** 删除最后一个槽位
3. 选中 **0° 槽位**行，在 Pose 模式下摆好姿势后点击 **`+MLP`** 批量注册所有图层，或在图层树中选中图层后点击 **`+SLP`** 注册单图层（**`−LP`** 清除）
4. 其他槽位：点击槽位行 → 点击 **`✏编辑`** 加载姿势 → 调整 → 点击 **`✓确定`** 保存
5. 手柄角度决定激活的槽位（0°~30°→槽位 0，30°~60°→槽位 1…）。可移动范围锁定为 **（槽位数 − 1）× 30°**

多个 PSW 点位相互独立，各自的姿势会叠加合成。

节点 Capture 按钮左侧的 **`PSW` 切换按钮**可全局启用/禁用 PSW：

| 状态 | 颜色 | 效果 |
|---|---|---|
| ON（默认） | 蓝色 | 根据手柄角度应用预设姿势 |
| OFF | 红色 | 禁用 PSW — 包括 PSW 已注册图层在内均可用 R/MR 自由操作 |

PSW ON/OFF 状态会保存并在以下所有操作中恢复：

- **关键帧** — 逐帧保存，播放时自动切换
- **姿势保存（📷 姿势 / 右键姿势+SW）** — 加载时恢复切换状态
- **模型保存/加载** — 切换状态包含在模型文件中
- **项目保存（ComfyUI工作流）** — 持久化至 `layer_config`

---

## 关键帧动画

点击节点上的 **⏱** 按钮可展开/收起关键帧面板。

### 操作说明

**Row A**

| 按钮 / 输入框 | 操作 |
|---|---|
| `+KF` | 在当前帧记录姿势（可见性、位置、角度） |
| `🗑KF` | 删除当前帧的姿势关键帧（保留摄像机数据） |
| `+CK` | 在当前帧记录摄像机关键帧（zoom / x / y / roll） |
| `-CK` | 删除当前帧的摄像机关键帧（保留姿势数据） |
| `↔` | 切换键帧移动模式：开启时可在时间轴上拖动关键帧（播放头禁用） |
| `0` | 跳转到第 0 帧 |
| `◀` / `▶` | 后退 / 前进一帧 |
| 帧编号输入框 | 跳转到指定帧 |
| 总帧数输入框 | 设置动画总帧数 |

**Row B**

| 按钮 / 输入框 | 操作 |
|---|---|
| `New` | 清除所有关键帧并重置到第 0 帧（需确认） |
| `FPS` | 播放和导出的帧率（默认 24） |
| `💾 Proj` | 将动画项目保存到库（文件名：`project-YYYYMMDDHHMMSS`） |
| `🎬 WebM` | 导出为 WebM 视频文件（推荐使用 Chrome/Edge） |
| `🎞️ GIF` | 导出为透明动画GIF图像 |
| `▶` / `■` | 开始 / 停止播放预览（`▶` 为双倍宽度） |

### 时间轴

点击或拖拽时间轴画布可快速跳转到任意帧。已记录的关键帧以 **◆** 标记显示。

### 插值方式

| 属性 | 插值方式 |
|---|---|
| 位置（tx / ty） | 线性插值 |
| 旋转角度 | 最短路径角度插值（处理 0° ↔ 360° 环绕） |
| SW 手柄角度 | 最短路径角度插值 |
| PSW 手柄角度 | 最短路径角度插值 |
| 可见性 | 阶跃：保持前一关键帧的值 |

### 项目保存 / 加载

`💾 Proj` 将关键帧数据（帧列表、总帧数、FPS）以 `_type: "kf_project"` 格式保存到库的**姿势**面板。从库加载时将还原完整时间轴，并将第 0 帧的姿势应用到画布。

关键帧同时保存在 `layer_config.keyframes` 中，因此保存/加载 ComfyUI 工作流 JSON 时会自动还原。

---

## 剪贴蒙版图层

设置了 Photoshop「剪贴到下方图层」标志的图层，在图层面板和 SW 的 `+L` 下拉列表中会显示 **✂** 标记。画布合成器使用 `source-atop` 混合模式渲染 — 每个剪贴蒙版图层被遮罩到其正下方基础图层的不透明区域。放置在剪贴蒙版图层上的 R/MR 绑定在该遮罩区域内正常工作。剪贴蒙版在 PSD 文档根级、文件夹内以及自定义组内均可生效。

> **⚠ 父级设置注意：** 若基础图层设置了绑定并会移动，剪贴蒙版图层需在**父级选项卡中设置相同的父级**才能随之移动。若未设置匹配的父级，剪贴蒙版图层将停留在画布原始位置，导致遮罩错位。

---

## 背景合成优先级（从高到低）

1. **ComfyUI `background_image` 输入** — 服务端合成（信箱式缩放，保持宽高比）
2. **本地背景图像** — 通过 `🖼 图像` 按钮加载，在客户端渲染
3. **背景颜色** — 通过颜色选择器选定的纯色
4. **棋盘格图案** — 默认透明背景指示器

---

## 文件结构

```
psd-image-loader/
├── __init__.py              # 节点注册
├── psd_loader_node.py       # PSDFigureCreatorNode
├── psd_utils.py             # psd-tools 合成辅助函数
├── server.py                # aiohttp API 路由（upload / layers / preview / library）
├── requirements.txt
└── web/
    ├── js/
    │   ├── psd_loader.js    # 前端（画布、模态框、绑定）
    │   └── i18n.js          # 翻译字典 + t() 函数
    └── css/
        └── psd_loader.css
```

---

## layer_config 数据结构

```jsonc
{
  "visibility":    { "<layerId>": true | false },
  "renamed":       { "<layerId>": "显示名称" },
  "custom_groups": [{ "name": "...", "layer_ids": [...], "visible": true }],
  "layer_order":   [{ "id": "...", "children": [...] }],
  "rigging": {
    "<layerId>": {
      "r":         { "x": 0, "y": 0 },
      "mr":        { "x": 0, "y": 0 },
      "mr_radius": 40
    }
  },
  "pose": {
    "<layerId>": { "angle": 0, "tx": 0, "ty": 0 }
  },
  "sw_layers": [{
    "id": "...", "name": "sw1",
    "points": [{
      "id": "...", "name": "pt1",
      "x": 512, "y": 512,
      "radius": 60, "angle": 0,
      "groups": [
        "<layerId>",                                              // +L — 单个图层，1 个槽位
        { "type": "custom_group", "id": "...", "mode": "piece" },     // +P — 每个成员图层 1 个槽位
        { "type": "psd_group",    "id": "...", "mode": "composite" }  // +C — 1 个槽位（合成）
        // mode 省略时默认为 "piece"（向下兼容）
      ]
    }]
  }],
  "psw_layers": [{
    "id": "...", "name": "PSW1",
    "points": [{
      "id": "...", "name": "PSW1",
      "x": 512, "y": 512,
      "radius": 80, "angle": 0,
      "slots": [
        { "degree": 0,  "pose": null },                          // 未注册
        { "degree": 30, "pose": { "<layerId>": { "angle": 0.5, "tx": 10, "ty": -5 } } }
      ]
    }]
  }],
  "keyframes": [
    {
      "frame": 0,
      "visibility": { "<layerId>": true },
      "pose":       { "<layerId>": { "angle": 0, "tx": 0, "ty": 0 } },
      "sw_angles":  { "<pointId>": 0 },
      "psw_angles": { "<pointId>": 0 }
    }
  ],
  "kf_total_frames": 60,
  "kf_fps": 24
}
```

---

## 运行环境

- **ComfyUI**（最新版）
- **Python 3.10+**
- **psd-tools ≥ 1.9.0**

---

## 故障排除

### 控制台出现 `[INFO] Unknown image resource` / `Unknown tagged block`

```
[INFO] Unknown image resource 1092
[INFO] Unknown tagged block: <Tag.CAI: b'CAI '>, ...
```

这是 **psd-tools** 库输出的信息提示（非错误）。当 PSD 文件包含 psd-tools 尚不支持的元数据时会出现此提示，例如较新版本 Photoshop 添加的生成式填充（Generative Fill）的 `CAI` 标签等资源。文件的读取和合成不受影响，未知数据会被自动跳过。无需任何处理。

---

## 许可证

MIT
