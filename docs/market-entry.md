# 插件市场收录草稿

> 目标：`awesome-dsh-plugin` 精选列表（市场会每天从它刷新）
> 状态：等 npm 包公开后提 PR；本文件先定稿条目文案。

## 条目

```yaml
name: dsh-neocortex
title: 智脑 · 读写养成的第二大脑
npm: dsh-neocortex
version: 1.0.0
repo: https://github.com/kelunisi/dsh-neocortex
tags: [dsh-plugin, memory, obsidian, bilibili, second-brain, automation]
summary: Markdown 分层记忆 + B 站每日喂养；会回忆、会看视频、会写回 Obsidian。
description: |
  智脑是 DeepSeek Harness 的本地第二大脑：L1/L2/L3 Markdown 记忆、本地账本、
  按问题回忆；每天自动去 B 站看视频、深读、进待判队列，收下后写 L2 来源页 + L3 近况；
  关注建议在悬浮球里点头，评论回复自动 @ 自己并过隐私/额度闸。
install: dsh plugin add dsh-neocortex
requires: DSH >= 0.2.1-rc.5
```

## PR 检查清单

- [ ] npm `dsh-neocortex@1.0.0` 已公开（`npm view` 能查到）；
- [ ] GitHub `main` 与 npm 版本一致（当前 `0c90a4c`）；
- [ ] README 有安装命令、功能、隐私说明；
- [ ] 按 `awesome-dsh-plugin` 仓库现有条目格式添加一行/一段；
- [ ] PR 标题：`Add dsh-neocortex: local second brain + Bilibili feeding`
- [ ] PR 描述附：npm 链接、GitHub 链接、展示手册、MIT 许可证。

## 备注

- 市场收录不等于背书；条目里不写账号、凭证、个人数据。
- 如果 npm 暂时不可用，市场也支持 GitHub-only 条目；但那会绕过 npm 版本校验，优先等 npm。
