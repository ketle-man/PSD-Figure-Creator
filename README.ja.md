# ComfyUI PSD Figure Creator

**Language / 言語 / 语言:** [English](README.md) | 日本語 | [中文](README.zh.md)

PSDファイルを読み込み、レイヤーにリグポイントを配置してポーズをとらせ、
結果を `IMAGE` + `MASK` として出力する ComfyUI カスタムノードです。

---

## 機能

- **インタラクティブレイヤービューア** — 表示/非表示の切り替え、レイヤー名・グループ名のリネーム
- **カスタムグループ** — レイヤーをグループにまとめ、ドラッグで描画順を変更
- **リギングシステム** — キャンバス上でレイヤーにコントロールポイントを配置:
  - **R**（青）— 回転専用
  - **MR**（赤/オレンジ）— 移動 ＋ 回転
  - **SW**（緑）— スイッチ: ハンドルを回転させて最大12グループの表示状態を切り替え
- **セットアップモード / ポーズモード** — セットアップでリグを設定し、ポーズで動かす
- **ライブラリ** — モデルファイル（`.psd-model.json`）とポーズファイルを保存・読み込み
- **背景オプション** — チェッカーパターン / 単色 / ローカル画像 / 上流の `IMAGE` ノード
- **Capture → Queue Prompt** — 現在のキャンバス状態を出力画像として確定
- **i18n** — `navigator.language` で自動言語切り替え（日本語 / 英語 / 簡体字中国語）

---

## スクリーンショット

### ノード

![ノード全体ビュー](docs/1_node.png)

### エディタ — レイヤータブ（Setup モード）

![MR ポイント配置中のレイヤータブ](docs/2_setup_layers.png)

### エディタ — ペアレントタブ

![全リグラベル表示のペアレントタブ](docs/3_setup_parent.png)

### エディタ — スイッチタブ

![SW ポイント設定中のスイッチタブ](docs/4_setup_switch.png)

### ノードプレビュー — リグ設定済み

![全リグポイントを表示したノードプレビュー](docs/5_setup_complete.png)

### ライブラリ — モデル & ポーズブラウザ

![ライブラリパネル](docs/6_library.png)

### ComfyUI ワークフロー内での Capture

![ワークフロー内での Capture 使用例](docs/7_capture.png)

---

## インストール

```bash
# 1. このフォルダを ComfyUI の custom_nodes ディレクトリにコピーまたはシンボリックリンク
#    例: ComfyUI/custom_nodes/psd-image-loader/

# 2. Python 依存パッケージをインストール
pip install psd-tools
```

ComfyUI を再起動します。ノードは **image/psd → PSD Figure Creator** として表示されます。

> **PSD Loader（v2.16 以前）からのアップグレード:**  
> ワークフロー JSON に `"PSDLoader"` が含まれている場合は `"PSDFigureCreator"` に書き換えてください。

---

## ノードの入出力

| パラメータ | 型 | 説明 |
|---|---|---|
| `psd_filename` | STRING | `input/psd/` ディレクトリ内の PSD ファイルパス |
| `layer_config` | STRING | UI エディタが生成する JSON 文字列 |
| `output_width` | INT | 出力幅（ピクセル）。0 = PSD 本来のサイズ |
| `output_height` | INT | 出力高さ（ピクセル）。0 = PSD 本来のサイズ |
| `image_data` | STRING | Capture からの Base64 PNG（サーバー合成をスキップ） |
| `background_image` | IMAGE | 最背面に合成する上流ノードの画像（オプション） |

| 出力 | 型 | 説明 |
|---|---|---|
| `image` | IMAGE | 合成済み RGB 画像 |
| `mask` | MASK | アルファチャンネル |

---

## UI 概要

```
[✨ 新規] [📂 PSD ファイル]  [⟳]
[Editor]                    [RC]
[📸 Capture]
 ┌────────────────────────┐
 │  プレビューキャンバス    │
 └────────────────────────┘
 Point Size: ─────────────
 BG: [■ 色][✕] [🖼 画像][✕] [🔗 外部接続中?]
```

- **Editor** — フルスクリーンのセットアップ/ポーズモーダルを開く
- **RC** — カメラリセット（パン・ズーム）
- **✨ 新規** — リギング・SW レイヤー・ポーズをすべてクリア（確認ダイアログあり）

### セットアップモーダルのタブ

| タブ | 内容 |
|---|---|
| レイヤー | レイヤーツリー、カスタムグループ管理、リグモードボタン（R / MR / SW） |
| ペアレント | トランスフォームを伝播させる親子階層 |
| スイッチ | SW レイヤー一覧とグループスロットエディタ |

---

## リグシステム

### R — 回転
青いドット。ポーズモードでドラッグすると、配置したピボットを中心にレイヤーを回転させます。

### MR — 移動 ＋ 回転
赤いオリジン ＋ オレンジのハンドル。ハンドルをドラッグすると移動と回転を同時に行います。

### SW — スイッチ
緑のオリジン ＋ シアンのハンドル。ハンドルを回転させると登録したカスタムグループの表示状態を
30° ステップで切り替えます（最大 12 状態 × 30° ＝ 360°）。  
セットアップモードではオリジンをドラッグして位置を変更。ハンドルで半径と初期角度を調整します。

---

## 背景合成の優先順位（高 → 低）

1. **ComfyUI `background_image` 入力** — サーバー側合成（レターボックスリサイズ、アスペクト比保持）
2. **ローカル背景画像** — `🖼 画像` ボタンで読み込んだ画像をクライアント側で描画
3. **背景色** — カラーピッカーで選択した単色
4. **チェッカーパターン** — デフォルトの透明背景インジケータ

---

## ファイル構成

```
psd-image-loader/
├── __init__.py              # ノード登録
├── psd_loader_node.py       # PSDFigureCreatorNode
├── psd_utils.py             # psd-tools を使った合成処理
├── server.py                # aiohttp API ルート（upload / layers / preview / library）
├── requirements.txt
└── web/
    ├── js/
    │   ├── psd_loader.js    # フロントエンド（キャンバス・モーダル・リギング）
    │   └── i18n.js          # 翻訳辞書 + t() 関数
    └── css/
        └── psd_loader.css
```

---

## layer_config スキーマ

```jsonc
{
  "visibility":    { "<layerId>": true | false },
  "renamed":       { "<layerId>": "表示名" },
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
      "groups": ["<cgId>", ...]
    }]
  }]
}
```

---

## 動作環境

- **ComfyUI**（最新版）
- **Python 3.10+**
- **psd-tools ≥ 1.9.0**

---

## ライセンス

MIT
