---
name: transform-report
description: Produce a bounded transformed document or report from supported workspace content.
expects: workspace.read, workspace.search, workspace.write, workspace.stat
---

# Produce a transformed document or report

## When it applies

Use when the task is to transform existing workspace content into a new
document or a short report.

## Method

1. Read the source content with `workspace.read` or gather bounded context
   with `workspace.search`.
2. Keep the transformation faithful to the source. State assumptions or
   limitations explicitly.
3. When a new file is required, propose the exact path inside the active
   workspace and prepare it with `workspace.write`. Do not overwrite an
   existing file without an explicit approved decision.
4. Verify the written output with a bounded `workspace.read` or
   `workspace.stat` when possible.

## Output conventions

- Report the source paths and the destination path in the result.
- Never present an unverified transformation as a completed write.

## Boundaries

Use only the registered workspace tools. A skill never grants shell, process,
network, or host access.
