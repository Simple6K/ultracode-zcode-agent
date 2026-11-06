---
description: 多代理编排模式：加载 ultracode 手册，把本次任务作为编排对象（opt-in 通道）
argument-hint: "要编排的任务"
skills: ultracode
---

用户通过 /ultracode 显式进入多代理编排模式。先加载 ultracode 技能（若本会话尚未加载），再按手册以编排者身份处理本次请求：

## User input

$ARGUMENTS

若上文为空：向用户确认要编排的任务，并给出一个默认建议（如对当前改动做对抗式审计）。
