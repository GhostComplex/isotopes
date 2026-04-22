# Docs Guide

`docs/` 统一按文档类型组织，尽量保持为 **一层子目录**，避免继续出现 `docs/x/y/z/...` 的深层结构。

## 目录结构

| 目录 | 用途 |
| --- | --- |
| `docs/prd/` | 产品需求、功能规划、待落地方案 |
| `docs/research/` | 调研、对比分析、可行性分析、RCA |

> 已过时、仅保留历史的文档已迁出本仓库，统一放在
> [`GhostComplex/docs` → `isotopes/archive/`](https://github.com/GhostComplex/docs/tree/main/isotopes/archive)。

## 放置规则

1. 新文档优先放到 `prd / research` 之一。
2. 已不再维护、仅作历史保留的文档不要放回本仓库，提交到 `GhostComplex/docs` 的 `isotopes/archive/`。
3. 不再新增 `docs/<type>/<subtype>/...` 这类多层嵌套目录。
4. 草稿 PRD 也直接放在 `docs/prd/`，不再单独建 `wip/`。
5. 设计方案如果仍处于需求和方案阶段，也统一放在 `docs/prd/`。
6. RCA 也统一放在 `docs/research/`，通过 `RCA-` 前缀区分。

## 命名建议

- PRD：`PRD-<issue>-<topic>.md` 或 `<topic>-m1.md`
- RCA：`RCA-<topic>.md` 或 `RCA-<date>-<topic>.md`
- Research：使用清晰的 kebab-case 文件名

## 维护原则

- 同类文档尽量放一起，不按人或临时项目再分层
- 文件名表达主题，目录只表达类型
- 目录深度尽量控制在 `docs/<category>/<file>.md`
