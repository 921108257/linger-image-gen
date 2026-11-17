# Linger Image Gen

[![npm version](https://img.shields.io/npm/v/linger-image-gen)](https://www.npmjs.com/package/linger-image-gen)
[![CI](https://github.com/921108257/linger-image-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/921108257/linger-image-gen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

通过自定义 OpenAI 兼容接口，在 **Codex** 和 **DeepSeek Harness（dsh）** 中生成、编辑和批量生成图片。

支持以下固定模型，可多选启用，不能修改 ID：

| 显示名称 | 固定模型 ID |
| --- | --- |
| GPT-Image-2.5 Flare | `gpt-image-2.5-flare` |
| GPT-Image-2.5 Sunburst | `gpt-image-2.5-sunburst` |
| GPT-Image-2.6 Sunburst | `gpt-image-2.6-sunburst` |

一个 npm 包同时提供两种插件形态：

| 平台 | 形态 | 安装方式 |
| --- | --- | --- |
| Codex | `.codex-plugin/plugin.json` + `skills/` | personal marketplace |
| DeepSeek Harness | `dsh.bundle.patch`（`cordis.patch.yml`）+ `lib/index.mjs` | `dsh plugin --profile <name> add` |

## 安装

需要 Node.js 22.13+、npm；配置 dsh 侧需要 pnpm（`dsh plugin` 会把安装转发给 pnpm）。

使用 npm 安装向导：

```bash
npx linger-image-gen
```

向导依次引导用户输入 `BASE_API`、隐藏输入 `API_KEY`、多选可用模型，并在
启用多个模型时选择默认模型。空格切换选项，回车确认；至少启用一个模型。
不会自动发送生成请求或产生图片生成费用。

向导随后安装两个平台，任一平台缺失只影响该平台：

- **Codex**：复制插件到 `~/plugins/linger-image-gen`，登记到 personal
  marketplace `~/.agents/plugins/marketplace.json`，再调用
  `codex plugin add linger-image-gen@<marketplace 名称>`。
- **DeepSeek Harness**：调用 `dsh plugin --profile <profile> add linger-image-gen`，
  由 dsh 用 pnpm 安装到 `~/.dsh/profiles/<profile>` 并写入 `dsh.profile.bundles`。

Profile 选择顺序：命令行 `--profile`、环境变量 `DSH_PROFILE`、已存在的 `web`
profile、已安装本插件的 profile、最近修改的 profile。dsh CLI 的查找顺序与官方
`dsh-web-run.sh` 一致：`DSH_BIN`、固定运行时、npx 缓存、`PATH`。找不到 dsh
时会打印手动命令，不会改动任何 profile。

也可以克隆源码后从本地项目运行：

```bash
npm install
npx --package . linger-image-gen
```

或测试实际发布包：

```bash
npm pack
npx --package ./linger-image-gen-0.2.0.tgz linger-image-gen
```

安装选项：

```bash
npx linger-image-gen install --skip-codex          # 只装 DeepSeek Harness
npx linger-image-gen install --skip-dsh            # 只装 Codex
npx linger-image-gen install --profile tui         # 指定 dsh profile
```

安装后：

- Codex：打开新任务，使用 `$linger-image-gen`。
- DeepSeek Harness：重启 dsh 后生效（`systemctl --user restart dsh-web`，或重新运行
  `dsh web`）；技能以 `/linger-image-gen` 调用，模型也可直接使用原生工具。

## DeepSeek Harness 插件

一个 Loader 行（`cordis.patch.yml`）挂载 `lib/index.mjs`，它提供：

- 内置技能 `linger-image-gen`：由打包的 `SKILL.md` 生成，同时出现在模型技能目录和
  `/` 菜单中；
- 原生工具 `linger_image_gen`：`mode: "generate" | "edit"`，支持 `prompt`、`model`、
  `image`、`mask`、`n`、`size`、`quality`、`format`、`background`、`out`、`cwd`；
- 原生工具 `linger_image_doctor`：只请求 `GET /models`，不生成图片。

与 CLI 相比，原生工具不需要 shell 转义，直接返回绝对路径；需要 JSONL 批量、
提示词文件或更多参数时再用下面的 CLI。两条路径共用同一份配置文件与“不覆盖已有
文件”的保存策略。

插件行为约定：

- 工具返回的图片是磁盘上的真实文件，`out` 已存在时自动加编号，绝不覆盖。
- 模型参数在发出请求前校验；计费请求失败后不自动重试，取消会中止请求。
- 配置每次调用时读取，`configure` 之后无需重启 dsh。
- 插件行可选配置（`dsh` profile 的 `cordis.patch.yml` 或 `--patch`）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `outputDir` | `output/imagegen` | 未指定 `out` 时的输出目录，相对路径按会话工作目录解析 |
| `configFile` | 环境变量/默认路径 | 指定 Linger 配置文件 |
| `environment` | `{}` | 额外环境变量，`BASE_API`、`API_KEY` 在此覆盖文件配置 |

```yaml
- insert:
    - id: linger-image-gen
      name: linger-image-gen
      config:
        outputDir: assets/generated
```

升级与卸载：

```bash
dsh plugin --profile web update linger-image-gen
dsh plugin --profile web remove linger-image-gen
```

## 配置

```bash
npx linger-image-gen configure
npx linger-image-gen config
npx linger-image-gen models
npx linger-image-gen doctor
```

`configure` 会重新打开向导，API Key 留空可保留当前密钥。配置即时生效。
已有配置需在向导中勾选 GPT-Image-2.6 Sunburst 后才能使用新模型。
`config` 隐藏密钥；`doctor` 仅请求 `/models`，模型列表不保证生成权限。
部分兼容服务不提供模型列表，此时可通过实际生成验证。

`BASE_API` 示例：`https://example.com/v1`。只填域名时自动追加 `/v1`；显式路径
如 `/api/v1` 原样保留。不能填完整的 `/images/generations` 地址。
接口需支持 Bearer 认证，以及 `/images/generations` 和 `/images/edits`。

密钥以本地明文保存在 `~/.config/linger-image-gen/config.json`，POSIX 文件权限
为 `0600`，不写入项目、插件 manifest、dsh profile 或 npm 包。Windows 用户应使用
当前用户的文件访问权限保护它。也可通过 `API_KEY`、`BASE_API` 环境变量覆盖本地
设置，使用 `LINGER_IMAGE_GEN_CONFIG` 自定义配置文件位置。不要把密钥放进命令行
参数或聊天。

## 使用

Codex 新任务中：

```text
使用 $linger-image-gen，用 Flare 生成一张白色陶瓷杯的产品摄影图片。
使用 Linger Image Gen 的 Sunburst 模型，只替换这张图片的背景，保留主体。
```

DeepSeek Harness 中：

```text
/linger-image-gen 用 Flare 生成一张白色陶瓷杯的产品摄影图片
用 linger_image_gen 把这张图背景改成纯白，保留主体
```

也可以直接使用 CLI：

```bash
npx linger-image-gen generate --model flare --prompt "白色陶瓷杯，简洁的产品摄影" --out output/imagegen/cup.png
npx linger-image-gen generate --model sunburst-2.6 --prompt "白色陶瓷杯，简洁的产品摄影" --out output/imagegen/cup-2.6.png
npx linger-image-gen edit --model sunburst --image input.png --prompt "只把背景改为纯白，保留主体" --out output/imagegen/edited.png
npx linger-image-gen generate --prompt-file prompt.txt --background transparent --format png
npx linger-image-gen generate-batch --input jobs.jsonl
npx linger-image-gen --help
```

允许 `--model flare`、`--model sunburst`、`--model sunburst-2.6` 或对应完整固定 ID。
其中 `sunburst` 仍指向 2.5 Sunburst，`sunburst-2.6` 指向 2.6 Sunburst。未启用的模型会被拒绝。
支持多张参考图、PNG 蒙版、尺寸、质量、透明背景、PNG/JPEG/WebP 输出和 JSONL 批量任务。
具体参数取决于接入服务的支持情况；不会自动改模型或降级。

默认保存到当前目录的 `output/imagegen/`，已有文件自动加编号，不覆盖。
`--dry-run` 仅验证；实际请求失败不自动重试。批量任务遇错停止，保留已保存结果。
安装后的技能脚本仅依赖 Node.js 标准库，不依赖 npx 缓存或全局 npm 包。

## 开发与发布

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

`npm run check` 额外校验 dsh 侧元数据：`cordis.patch.yml` 必须只插入本包名，
`package.json` 的 `dsh.bundle.patch`、`files`、`exports` 必须齐全。
测试在没有 dsh 的环境下会跳过依赖 dsh 运行时的用例，其余用例始终运行。

发布时保持 `package.json` 与插件 manifest 的版本一致，先提交并打包，再发布 npm 包，
最后创建对应的 `v<版本号>` GitHub Release。Release 附带相同的 npm 安装包、
SHA-256 校验文件及该版本的 npm 链接，便于对应源码与发布产物。

- [npm 包](https://www.npmjs.com/package/linger-image-gen)
- [GitHub Releases](https://github.com/921108257/linger-image-gen/releases)

CI 在 Node.js 22 和 24 上运行检查及测试；发布需要维护者的 npm 账号授权。

插件 manifest：`.codex-plugin/plugin.json`；技能：`skills/linger-image-gen/SKILL.md`
（两个平台共用同一份自包含的 SKILL.md，dsh 侧在前言提供绝对 CLI 路径和原生工具说明）；
dsh 入口：`lib/index.mjs`，bundle patch：`cordis.patch.yml`。
安装向导借鉴 Codex plugin-creator 的 personal marketplace 结构，技能工作流借鉴
imagegen，dsh 侧遵循 profile bundle 插件约定。这是独立的 Linger 插件，不会改写
系统 imagegen 技能，也不会手改任何 dsh profile。

## 许可证

本项目采用 [MIT License](LICENSE)。
