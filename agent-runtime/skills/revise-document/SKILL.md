---
name: revise-document
description: Revise a supported text, Markdown, or JSON document while preserving its requested structure.
expects: workspace.read, workspace.edit, workspace.write, workspace.stat
---

# Revise a document while preserving its structure

## When it applies

Use when the task is to change a specific supported document in the active
workspace and the user has approved the change.

## Method

1. Read the current document with `workspace.read` and note its format.
2. For JSON, preserve valid JSON syntax and the existing key structure unless
   the change explicitly requires otherwise.
3. Prepare the smallest bounded change and use `workspace.edit` or
   `workspace.write` for the exact replacement.
4. After the write result reports success, verify with a follow-up
   `workspace.read` or `workspace.stat` when the adapter can validate.

## Permission

Writes require a fresh exact user decision. Never claim a write succeeded
unless the tool result reports success, and never apply a second write
without its own decision.

## Boundaries

Use only the registered workspace tools. A skill never grants shell, process,
network, or host access.
