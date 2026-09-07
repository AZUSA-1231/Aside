---
name: inspect-summarize
description: Inspect and summarize one workspace resource using only the registered workspace read tools.
expects: workspace.stat, workspace.list, workspace.read
---

# Inspect and summarize a workspace resource

## When it applies

Use when the task is to understand and summarize a specific file or directory
inside the active workspace.

## Method

1. Locate the resource with `workspace.stat` or `workspace.search`, using a
   path inside the active workspace.
2. If the resource is a directory, list its bounded contents with
   `workspace.list` before summarizing.
3. Read the file with `workspace.read`. Respect the returned `truncated` flag
   and the `next_offset` hint by reading further bounded chunks when needed.
4. Ground every statement in the returned tool output. Do not invent content
   you did not read.

## Output conventions

- State the resolved relative path and document format in the summary.
- Keep the summary concise and reference the file path you inspected.
- When a read is truncated, say so and offer to continue reading.

## Boundaries

Use only the registered workspace tools. A skill never grants shell, process,
network, or host access.
