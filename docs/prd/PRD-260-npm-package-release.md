# PRD-260: npm Package Release & CLI Install

## Issue

<https://github.com/GhostComplex/isotopes/issues/260>

## Problem

用户无法通过 `npm install -g isotopes` 安装和运行 Isotopes。当前只能 clone 源码 + `npm run build`，部署门槛高，阻塞 1.0 release。

## Goal

`npm install -g isotopes && isotopes start` 即可运行。对标 OpenClaw 的安装体验。

## Requirements

### P0 — Must Have

1. **npm package 发布**
   - 包名：`isotopes`（或 `@isotopes/cli`，取决于可用性）
   - 发布到 npm registry
   - `bin` 入口指向编译后的 CLI

2. **CLI 入口正常工作**
   - `isotopes start` / `stop` / `restart` / `status`
   - `isotopes service install` / `uninstall`（systemd/launchd）
   - `isotopes --version` / `--help`

3. **构建产物完整**
   - TypeScript 编译为 JS（`dist/`）
   - 打包 web 静态资源（dashboard + webchat）
   - 不包含 `src/`、`test/`、`.github/` 等开发文件

4. **依赖声明正确**
   - `dependencies` vs `devDependencies` 区分清晰
   - `postinstall` 不依赖 TypeScript 编译
   - 运行时不需要 `tsx` / `ts-node`

5. **首次运行引导**
   - `isotopes` 无参数时，如果没有 config，提示引导创建
   - 或提供 `isotopes init` 交互式初始化 config

### P1 — Should Have

6. **Config 模板生成**
   - `isotopes init` 生成 `~/.isotopes/config.yaml` 模板
   - 带注释说明每个字段
   - 提示设置 API key、Discord token 等

7. **版本管理**
   - `package.json` version 与 git tag 对齐
   - CI 自动发布（GitHub Actions → npm publish）

8. **平台兼容性**
   - macOS (arm64/x64)
   - Linux (x64/arm64)
   - Node.js ≥ 20

### P2 — Nice to Have

9. **npx 一键运行**
   - `npx isotopes start` 无需全局安装

10. **Docker image**
    - `ghcr.io/ghostcomplex/isotopes:latest`

## package.json 关键配置

```json
{
  "name": "isotopes",
  "bin": {
    "isotopes": "dist/cli.js"
  },
  "files": [
    "dist/",
    "web/dist/",
    "README.md"
  ],
  "engines": {
    "node": ">=20"
  }
}
```

## 验证标准

- [ ] `npm install -g isotopes` 在干净环境中成功
- [ ] `isotopes --version` 输出版本号
- [ ] `isotopes init` 创建初始 config
- [ ] `isotopes start` 启动 daemon
- [ ] `isotopes status` 正常显示状态
- [ ] Dashboard 和 WebChat 静态资源能正常 serve

## 风险

- 包名 `isotopes` 在 npm 上是否可用 → 需要提前检查
- web 静态资源打包方式需要确定（直接 include 还是单独 build step）
- `claude` CLI 作为 subagent 后端是可选依赖，需要文档说明
