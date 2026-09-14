# Linger Image Gen

[![npm version](https://img.shields.io/npm/v/linger-image-gen)](https://www.npmjs.com/package/linger-image-gen)
[![CI](https://github.com/921108257/linger-image-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/921108257/linger-image-gen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

通过自定义 OpenAI 兼容接口，在 Codex 中生成、编辑和批量生成图片。

仅支持以下两个固定模型，可多选启用，不能修改 ID：

| 显示名称 | 固定模型 ID |
| --- | --- |
| GPT-Image-2.5 Flare | `gpt-image-2.5-flare` |
| GPT-Image-2.5 Sunburst | `gpt-image-2.5-sunburst` |

## 安装

需要 Node.js 22.13+、npm，以及支持插件的 Codex 桌面应用或 CLI。

使用 npm 安装向导：

```bash
npx linger-image-gen
```

向导依次引导用户输入 `BASE_API`、隐藏输入 `API_KEY`、多选可用模型，并在
启用两个模型时选择默认模型。空格切换选项，回车确认；至少启用一个模型。
不会自动发送生成请求或产生图片生成费用。

也可以克隆源码后从本地项目运行：

```bash
npm install
npx --package . linger-image-gen
```

或测试实际发布包：

```bash
npm pack
npx --package ./linger-image-gen-0.1.0.tgz linger-image-gen
```

安装程序将插件复制到 `~/plugins/linger-image-gen`，并在默认 personal
marketplace `~/.agents/plugins/marketplace.json` 中登记。保留现有 marketplace
名称、展示名称、顺序及其他插件。已有同名条目指向其他来源时停止安装。

随后自动调用 `codex plugin add linger-image-gen@<实际 marketplace 名称>`。
找不到 Codex CLI 时会说明尚未激活，并提供手动安装命令和插件页链接。
不需要为默认 personal marketplace 执行 `marketplace add`。
使用 `install --skip-codex` 可仅写入插件与配置，稍后在应用中安装。
安装成功后请打开新任务，再使用 `$linger-image-gen`。

## 配置

```bash
npx linger-image-gen configure
npx linger-image-gen config
npx linger-image-gen models
npx linger-image-gen doctor
```

`configure` 会重新打开向导，API Key 留空可保留当前密钥。配置即时生效。
`config` 隐藏密钥；`doctor` 仅请求 `/models`，模型列表不保证生成权限。
部分兼容服务不提供模型列表，此时可通过实际生成验证。

`BASE_API` 示例：`https://example.com/v1`。只填域名时自动追加 `/v1`；显式路径
如 `/api/v1` 原样保留。不能填完整的 `/images/generations` 地址。
接口需支持 Bearer 认证，以及 `/images/generations` 和 `/images/edits`。

密钥以本地明文保存在 `~/.config/linger-image-gen/config.json`，POSIX 文件权限
为 `0600`，不写入项目、插件 manifest 或 npm 包。Windows 用户应使用当前用户的
文件访问权限保护它。也可通过 `API_KEY`、`BASE_API` 环境变量覆盖本地设置，
使用 `LINGER_IMAGE_GEN_CONFIG` 自定义配置文件位置。不要把密钥放进命令行参数或聊天。

## 使用

Codex 新任务中：

```text
使用 $linger-image-gen，用 Flare 生成一张白色陶瓷杯的产品摄影图片。
使用 Linger Image Gen 的 Sunburst 模型，只替换这张图片的背景，保留主体。
```

也可以直接使用 CLI：

```bash
npx linger-image-gen generate --model flare --prompt "白色陶瓷杯，简洁的产品摄影" --out output/imagegen/cup.png
npx linger-image-gen edit --model sunburst --image input.png --prompt "只把背景改为纯白，保留主体" --out output/imagegen/edited.png
npx linger-image-gen generate --prompt-file prompt.txt --background transparent --format png
npx linger-image-gen generate-batch --input jobs.jsonl
npx linger-image-gen --help
```

允许 `--model flare`、`--model sunburst` 或对应完整固定 ID。未启用的模型会被拒绝。
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

发布时保持 `package.json` 与插件 manifest 的版本一致，先提交并打包，再发布 npm 包，
最后创建对应的 `v<版本号>` GitHub Release。Release 附带相同的 npm 安装包、
SHA-256 校验文件及该版本的 npm 链接，便于对应源码与发布产物。

- [npm 包](https://www.npmjs.com/package/linger-image-gen)
- [npm 0.1.0](https://www.npmjs.com/package/linger-image-gen/v/0.1.0)
- [GitHub Release v0.1.0](https://github.com/921108257/linger-image-gen/releases/tag/v0.1.0)

CI 在 Node.js 22 和 24 上运行检查及测试；发布需要维护者的 npm 账号授权。

插件 manifest：`.codex-plugin/plugin.json`；技能：`skills/linger-image-gen/SKILL.md`。
安装向导借鉴 Codex plugin-creator 的 personal marketplace 结构，技能工作流借鉴 imagegen。
这是独立的 Linger 插件，不会改写系统 imagegen 技能。

## 许可证

本项目采用 [MIT License](LICENSE)。
