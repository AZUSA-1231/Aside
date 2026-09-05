# P4 - Skills and Resource Loading

Status: planning
Depends on: P2 - Capability Registry and Bounded Read Tools and P3 - Permission-Gated Writes and Verification
Unblocks: P5 - Session, IPC, and Protocol Integration
Source requirements: Cycle 5 PRD sections 3, 4, 8, 9, 10, 14, and 16.5

## Outcome

Load bounded `SKILL.md`-compatible workflow instructions and make them
available to the same TaskRun that owns the current workspace, tools, and
permission broker. Skills can improve method and verification guidance, but
they cannot execute filesystem operations, register tools, grant permission,
change the workspace, or create another agent loop.

## Resource Policy

- Aside-bundled skills are trusted for default enablement.
- User and workspace/project skills require an explicit resource policy and
  remain instruction data rather than authority.
- Malformed, duplicated, inaccessible, overlong, or untrusted resources are
  ignored or surfaced as bounded diagnostics according to the chosen policy.
- System and permission policy remains higher priority than skill content.

Pi-full's `packages/agent/src/harness/skills.ts` and
`packages/coding-agent/src/core/skills.ts` provide compatible reference
behavior for `SKILL.md` frontmatter, name/description validation, recursive
discovery, ignore files, source metadata, symlink/collision handling, and
bounded diagnostics. Aside must adapt the loader to its approved resource
roots; coding-agent project trust, global settings, and executable extensions
are not part of this policy.

The initial representatives are an inspect-and-summarize workflow, a
structure-preserving text-document revision workflow, and a bounded
transformation/report workflow. They use the existing workspace tools and do
not assume a coding-only repository.

## Tasks

1. Review the compatible Pi skill data/loading types and the two pi-full skill
   loaders without adopting coding-agent global settings, project trust UX,
   or executable plugins.
2. Define skill metadata, source/trust classification, bounded name and
   description, instruction loading, diagnostics, and activation contracts.
3. Implement loading for the initial built-in skills and the explicitly
   approved resource sources. Validate size, encoding, duplicate identity, and
   supported metadata before activation.
4. Project only the active skill summary/instructions and expected tool
   guidance through the Aside context boundary as untrusted reference data.
   Keep full hidden source content out of durable session records unless the
   user explicitly made it part of the conversation.
5. Ensure automatic and explicit invocation reuse the current TaskRun,
   workspace, tool registry, Pi loop, limits, and permission broker.
6. Add tests for valid, malformed, duplicated, inaccessible, untrusted, and
   capability-expanding skill content; ignore-file and collision diagnostics;
   invocation with and without a workspace; and attempts to call an
   unregistered tool.

## Deliverables

- Bounded skill/resource contract and trust classification.
- Initial built-in document/workspace skills.
- Safe skill projection and activation diagnostics.
- Tests proving skills cannot expand tool, workspace, or permission scope.

## Exit Criteria

- C5-27 valid skills expose only bounded intended instructions through the
  runtime boundary.
- C5-28 malformed/untrusted content is diagnosed or ignored without hidden
  tools, permissions, or provider leakage.
- C5-29 automatic and explicit invocation use the current TaskRun and same
  agent loop.
- C5-30 a skill cannot call an unregistered capability or bypass the broker.
- Skill summaries/instructions do not silently become durable workspace state.

## Checks

Run skill-loader and runtime isolation tests with faux resources. Inspect the
model-visible tool list before and after activation to prove it is unchanged
unless a separately reviewed registry decision made the change.
