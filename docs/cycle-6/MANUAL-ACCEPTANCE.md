# Cycle 6 Manual Acceptance Checklist

Owner: P7 ([task 18](./plans/P7-surface-and-release.md))
Runner: the developer, at a Windows desktop
Status: **not started — indefinitely deferred as of 2026-09-23.** This is a
decision, not a backlog item: the checklist has no target cycle and no date.
Nothing in it has been performed, no criterion is closed by it, and the manual
column of [`ACCEPTANCE-MATRIX.md`](./ACCEPTANCE-MATRIX.md) stays empty. The
record of the decision is
[`docs/cycle-7/LEGACY.md`](../cycle-7/LEGACY.md#manual-acceptance-indefinitely-deferred).

This is the runner for everything in Cycle 6 that deterministic tests cannot
establish. It is a companion to P7's C6-01 through C6-45 matrix, not a second
matrix: each item names the criterion it closes, and the result recorded here is
what the matrix links to.

Two classes of item appear here.

**Carried over from Cycle 5.** Its acceptance matrix is complete and
evidence-linked, but 26 criteria were marked `test + manual` and the manual
column was never performed. [C6-I020](./ISSUES.md#c6-i020---cycle-5-manual-acceptance-moves-to-the-p7-release-gate)
moved that pass here so both cycles are accepted in one sitting. Cycle 5 is **not**
recorded as released anywhere, and nothing below has been relabelled as passed.

**New in Cycle 6.** P1's handoff sub-claims, the P3/P4 document capabilities,
the P6 MCP adapter, and the cycle-level audits.

### What this list no longer covers

Removed on 2026-09-19 by
[C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7),
which corrected this cycle's scope:

- **Installed-application acceptance** (Part C4). Packaging is Cycle 7 work and
  no installable artifact exists.
- **Frontend interaction quality** — accessibility, keyboard and focus, resizing,
  text containment. Never had items here because it was never planned as a
  checklist pass, but P7 claimed to audit it and did not. It is Cycle 7 work.

C6-40 is **not** in that list. It asks whether the surface says the right thing,
which is a product criterion, and its items remain below.

## How to run this

- Work top to bottom. Items are ordered so that state set up by one is reused by
  the next where that is safe, and explicitly reset where it is not.
- Record the actual observation, not "passed". Where an item did not behave as
  described, that is the finding, and it goes to [ISSUES.md](./ISSUES.md)
  before anything is marked complete.
- **Never record a credential, a full document body, a raw MCP frame, or a raw
  provider payload as evidence.** Record the shape and the outcome.
- A manual pass supplements the automated gate. It never replaces it: run
  `npm.cmd run runtime:test` and the rest of the root gate before starting, and
  note the counts in the run record.

## Preconditions

| # | Requirement | Notes |
| --- | --- | --- |
| P-1 | Root quality gate green | `typecheck`, `build`, `runtime:test`, `cargo fmt --check`, `cargo check`, `cargo test`, `git diff --check` |
| P-2 | Provider configured in `.env.local` | `ASIDE_PROVIDER`, `ASIDE_API_KEY`-equivalent, optionally `ASIDE_API_URL`, `ASIDE_MODEL`. A working conversation is a precondition, not an item. |
| P-3 | A scratch folder with test files | Include a small `.txt`, a small `.json`, a `.pdf` with real text, a `.docx`, and one file in an unsupported format (e.g. `.xlsx`). |
| P-4 | A `report.docx` | Referenced by C5-06. Any real Word document. |
| P-5 | `mcp.json` prepared but **not yet placed** | Contents are given in Part B4. |

---

## Part A — Cycle 5 carried over

### A1. Summon, workspace binding, and context

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C5-01 | Ask a question that touches no file, with nothing captured. | The answer streams. No workspace is bound and none is requested. A second overlapping request is refused without disturbing the first. | |
| C5-02 | Summon on a file from a real Explorer window, then ask it to read the file. | The workspace binds **before** the first read. The read resolves without you typing a path. | |
| C5-06 | Repeat with `report.docx`. | A single-file capture binds the containing folder as the workspace. | |
| C5-07 | Summon with a folder selected rather than a file. | A workspace-root descriptor binds the folder. | |
| C5-08 | Ask for a relative read of a file you can see named in the rail. | It resolves inside the workspace the rail displays — not against some other directory. | |
| C5-10 | Clear the workspace, then ask a file question. | It asks for a workspace instead of failing obscurely or running against nothing. | |
| C5-11 | Switch workspace in the middle of a task. | The switch is reported as a recoverable warning. Session storage is unchanged by it. | |

### A2. Tool activity and terminal states

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C5-04 | Approve a write, then force the underlying operation to fail if you can; otherwise watch a normal write. | The rail **never** shows an unexecuted write as complete. | |
| C5-05 | Press Stop during a model turn; then again while a permission card is pending. | Both stop cleanly with one terminal event each. | |
| C5-14 | List, stat, read, and search. | All four work and **no write prompt appears** for any of them. | |
| C5-16 | Point it at the unsupported file. | A typed unsupported result appears in the rail. Nothing shells out, and nothing pretends to have read it. | |
| C5-31 | Ask for a read and a summary. | Works with no write prompt. | |
| C5-33 | After a write, ask it to read back or stat the result. | The verification is shown in the rail. | |

### A3. Permission: exact operation, denial, and races

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C5-19 | Ask for a write; read the card before answering. | The card shows the exact operation, and the write has **not** started. | |
| C5-21 | Allow it. | It executes exactly once and the conversation continues. | |
| C5-22 | Ask for a write and **deny** it. | The file is unchanged and the UI settles exactly once. | |
| C5-23 | Ask for a write and let the permission expire or cancel it while pending. | It fails closed. The file is unchanged. | |
| C5-26 | Ask for two writes in one response. | The second prompts again; the first approval does not cover it. | |
| C5-12 | Start a write, and replace the target file before you answer the card. | The replacement is detected and the stale write does not proceed. | |
| C5-24 | As above, then approve the stale card. | It is rejected. The replacement file is not overwritten. | |

### A4. Persistence, secrets, and restart

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C5-25 | Approve a write, then restart **before** it executes if you can arrange it. | It does not replay after restart. | |
| C5-34 | Complete a task, then restart Aside. | History is restored. **No** workspace authority, pending permission, or active skill is restored with it. | |
| C5-35 | Open the JSONL session store under `%LOCALAPPDATA%\Aside\sessions`. | No credentials, no file handles, no raw document bodies. Only bounded conversation records. | |

### A5. Skills

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C5-29 | Run a bundled skill that writes, with a workspace bound. | It uses the active workspace, still asks for permission, and leaves the transcript clean. | |

### A6. Window and desktop integration

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C5-38 | One pass covering: summon and focus; Side/Workspace restore; attachment removal; streaming, Stop, retry; target closure; restart restoration. | Each behaves as described. Record which sub-step failed if any. | |

---

## Part B — Cycle 6 capabilities

### B1. Handoff sub-claims P1 did not separately confirm

The M2 checkpoint passed on 2026-09-17, but it confirmed the happy path only.
[PLAN.md](./PLAN.md) records these as still unverified.

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| B1-a | Capture a file from Explorer and look at the rail. | It shows the **containing directory** as the workspace and the captured file as the **target** — not the file as the workspace. | |
| B1-b | Same capture, and inspect the emitted descriptors if you can. | Explorer emitted **both** a directory descriptor and a selected-item descriptor. | |
| B1-c | Deliver an ambiguous capture (two plausible workspace candidates). | It refuses and asks, rather than picking one. | |
| B1-d | Deliver a stale descriptor (capture, then move the file before asking). | It refuses as stale rather than resolving to the old location. | |

### B2. PDF (P3)

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C6-16 | Read the text PDF, then read a specific page range. | Text and page numbers come back. The range is honored. | |
| C6-17 | Read a PDF that is mostly images. | A **text-poor** warning is shown. It does not pretend to have read content it could not extract. | |
| C6-18 | Ask it to modify the PDF. | It refuses, and the rail says PDF is read-only. No write prompt appears. | |

### B3. Word (P4)

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C6-20 | Read `report.docx`. | Structured content comes back, not raw XML. | |
| C6-21 | Read one with formatting and headings. | Headings, paragraphs, and lists are distinguished. | |
| C6-22 | Create a new `.docx` from a description. | The permission card names the destination, and the write happens only after Allow. | |
| C6-23 | Transform `report.docx` to a new path. | A new file appears. The source is untouched. | |
| C6-24 | Ask it to write to the source path, then to an existing file. | Both are refused with a clear reason. Nothing is overwritten. | |
| C6-25 | Inspect the warnings before transforming something with features it may lose. | Fidelity warnings appear **before** the transformation, not after. | |
| **B3-open** | **Open both generated `.docx` files in real Word.** | They open without a repair prompt and the structure is as requested. | |

**B3-open is the evidence P4 explicitly left to P7.** A reopen check through our
own reader proves the package parses; only Word proves it is a document.

### B4. MCP (P6)

Preparation: run `npm install @modelcontextprotocol/server-everything` in a
scratch directory, note the absolute path to `node.exe` and to the installed
server entry point, then write `mcp.json` next to your `.env.local`:

```json
{
  "servers": [
    {
      "id": "smoke",
      "display_name": "MCP smoke server",
      "command": "<absolute path to node.exe>",
      "args": ["<absolute path to the server's entry point>"],
      "enabled": true,
      "trust_acknowledged": true
    }
  ]
}
```

`server-everything` is a **manual development-time smoke target only**. It is
not bundled, not default-configured, and not named in the system prompt. Aside
ships no server.

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C6-31 | Start Aside with that `mcp.json`, then ask a question. | The server's tools appear as `mcp.smoke.*`. They are not visible before it is configured. | |
| C6-39 | Ask a question that does not need MCP. | The conversation is unaffected by the server's presence. | |
| C6-34 | Call one adapted tool. | A permission card appears naming the server and the tool, stating it is **not sandboxed**, and showing bounded arguments. | |
| C6-34b | Deny it. | Denial is reported, and feel free to confirm the server call never happened. | |
| C6-33 | Allow one. | It executes and returns a bounded result. | |
| C6-37 | Ask for a long-running or cancellable call and cancel it. | One terminal result, and the connection is not reported as failed. | |
| C6-38 | If you can observe it, watch for the server's sampling/elicitation requests. | They are refused. Nothing enters the conversation on the server's initiative. | |
| B4-a | **Remove** the server from `mcp.json` and restart. | Its tools are gone. No `mcp.smoke.*` tool is offered. | |
| B4-b | Set `"enabled": false` and restart. | Same: no tools. | |
| B4-c | Set `"trust_acknowledged": false` and restart. | Same: configured but inert. | |
| B4-d | Ask the model something only the server could answer, with the server disabled. | It reports no such capability. It does **not** claim to have searched, fetched, or read anything. | |

---

## Part C — Cycle-level audits

### C1. Surface legibility (C6-40)

**This criterion has no automated evidence, and cannot have any as the
repository stands.** There is no frontend test infrastructure: no test runner,
no test script for `src/`, and no test files. The React surface is verified by
`tsc` and `vite build`, which prove it compiles, not that it says the right
thing. Everything below is therefore manual-only, and P7 must not describe
C6-40 as covered by tests.

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C6-40-a | Run a task that reads a file and writes one. | Workspace, tool activity, permission, verification, and terminal state are each understandable without expanding a protocol payload. | |
| C6-40-b | Inspect every state above for raw detail. | No raw schema, credential, captured file content, stack trace, or MCP frame appears anywhere in the rail. | |
| C6-40-c | Trigger a capture, then select a different folder explicitly before the first read. | The rail says the selection outranked the capture, naming both. It does not silently use one. | |
| C6-40-d | Ask for a write and leave the permission card pending. | The rail says the run is waiting. It does not appear stalled. | |
| C6-40-e | Connect the smoke server and run a task that calls one of its tools. | The activity line marks the call as **outside Aside**, naming the server. The permission card carries the same boundary. | |
| C6-40-f | Configure a server, then break it (point `command` at a missing executable) and restart. | The rail reports the configured server as providing no tools — distinguishable from a server that was never configured. | |
| C6-40-g | Confirm the ordinary successful path stayed quiet. | A read-and-answer task shows no warning chips. Caution is reserved for decisions and divergences. | |

### C2. Registry absence

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C6-42 | Inspect the model-visible tool list for a run (serialized `run_started` payload or the provider request). | No shell, PowerShell, process, code-execution, PDF-edit, arbitrary-fetch, or deferred Tier 2 tool. | |
| C6-42b | Same inspection **with** the smoke server connected. | The adapted tools are the only additions, and they carry `source: user_mcp`. | |

### C3. Persistence and privacy

| ID | Do this | Observe | Result |
| --- | --- | --- | --- |
| C6-29 | After an MCP session, inspect the JSONL store, React events, and logs. | No credentials, no raw MCP frames, no unbounded results. | |
| C6-41 | Restore a session that has a pending permission or an active MCP connection. | Neither is restored as authority. No server is silently invoked. | |

### C4. Installed application — DEFERRED

**Removed from this pass on 2026-09-19 by
[C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**

Building and installing on a clean profile is Cycle 7 work, together with the
packaging it depends on. It needs a VM and a network, and no installable artifact
is produced by this cycle — so there is nothing here for this pass to observe.

Do not run it, and do not record it as "not run": it is out of scope, not
pending. A reader comparing this list to an earlier version will find the section
gone; [C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7)
is the record of why.

---

## Run record

| Field | Value |
| --- | --- |
| Date | |
| Build/commit | |
| Windows version | |
| Provider / model | |
| Automated gate counts before the pass | |
| Items run | |
| Items failed or not run, with reasons | |
| New issues filed | |
| Cycle 6 acceptance | met / not met — **not a release decision** |

The last row records whether this cycle's criteria have evidence. It is not a
statement that anything is ready to ship, and the distinction is not pedantic:
packaging and installed-application support are deferred
([C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7)),
so no installable artifact exists to ship. Do not record a version, a release
date, or a distribution decision here.

## What this list does not cover

- **Web Search.** Removed from Cycle 6
  ([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)). There
  is no search workflow, no provider, and no attribution to verify. Do not
  record one.
- **Third-party MCP servers other than the smoke target.** Cycle 6 ships an
  adapter verified against adversarial fixtures and one manual smoke server. It
  does not claim field validation, and this list must not imply it.
- **Any capability deferred in the PLAN's release boundary** — Excel,
  PowerPoint, GitHub, VSCode actions, Notion, general browsing, PDF mutation,
  OCR, full Word round-trip fidelity, bundled MCP servers, marketplace flows,
  permanent trust, multi-workspace execution, and background agents.
