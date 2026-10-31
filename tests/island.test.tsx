import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import { nativeClient } from '../src/lib/ipc';
import type { AgentState, RuntimeEvent, HostCaptureResult, NativeError } from '../src/lib/contracts';

let root: Root;
let container: HTMLDivElement;
let emit: (event: RuntimeEvent) => void;
let capture: (result: HostCaptureResult) => void;
let changeState: (state: AgentState) => void;
let nativeError: (error: NativeError) => void;
const state: AgentState = { visibility: 'hidden', surface: 'side', pinned: false, material: 'solid' };
const button = (name: string) => [...container.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === name || element.textContent?.trim() === name)!;

async function click(element: HTMLElement) {
  expect(element).toBeTruthy();
  await act(async () => element.click());
}

async function expand() {
  await act(async () => changeState({ ...state, visibility: 'visible' }));
}

async function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send() {
  await setInput(container.querySelector('textarea')!, 'Test prompt');
  await click(button('Send message'));
  return vi.mocked(nativeClient.runtimePrompt).mock.calls.at(-1)![0];
}

function permission(requestId: string): RuntimeEvent {
  return {
    type: 'permission_requested', request_id: requestId, permission_id: 'permission',
    task_id: 'task', tool_call_id: 'call', operation: 'workspace.write',
    effect: 'write', egress: 'none', source: 'builtin', status: 'pending',
    expires_at: Date.now() + 60000, explanation: 'Create the requested report',
    workspace: { path: 'D:/reports' }, targets: ['report.docx'], preview: { text: 'Preview body' },
    risk: { boundary: 'aside_enforced', effect: 'write', egress: 'none', source: 'builtin', origin_label: 'Aside files', note: 'Write access' },
  };
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(nativeClient, 'getAgentState').mockResolvedValue(state);
  vi.spyOn(nativeClient, 'showAgent').mockResolvedValue({ ...state, visibility: 'visible' });
  vi.spyOn(nativeClient, 'hideAgent').mockResolvedValue(state);
  vi.spyOn(nativeClient, 'onAgentState').mockImplementation(async handler => { changeState = handler; return () => {}; });
  vi.spyOn(nativeClient, 'onNativeError').mockImplementation(async handler => { nativeError = handler; return () => {}; });
  vi.spyOn(nativeClient, 'onRuntimeEvent').mockImplementation(async handler => { emit = handler; return () => {}; });
  vi.spyOn(nativeClient, 'onHostCapture').mockImplementation(async handler => { capture = handler; return () => {}; });
  vi.spyOn(nativeClient, 'runtimePrompt').mockResolvedValue();
  vi.spyOn(nativeClient, 'runtimeCancel').mockResolvedValue();
  vi.spyOn(nativeClient, 'runtimePermissionResponse').mockResolvedValue();
  vi.spyOn(nativeClient, 'runtimeSetWorkspace').mockResolvedValue();
  vi.spyOn(nativeClient, 'runtimeClearWorkspace').mockResolvedValue();
  vi.spyOn(nativeClient, 'revealPath').mockResolvedValue();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('starts with no resident surface and opens on the native state event', async () => {
  expect(container.childElementCount).toBe(0);
  expect(nativeClient.showAgent).not.toHaveBeenCalled();
  await expand();
  expect(container.querySelector('.app-shell')).toBeTruthy();
  expect(container.querySelector('.edge-capsule')).toBeNull();
});

it('keeps the draft across Escape and reopening', async () => {
  await expand();
  await setInput(container.querySelector('textarea')!, 'Unsent draft');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(nativeClient.hideAgent).toHaveBeenCalledOnce();
  expect(container.childElementCount).toBe(0);
  await expand();
  expect(container.querySelector('textarea')!.value).toBe('Unsent draft');
});

it('preserves input and controls when native material falls back to solid', async () => {
  await act(async () => changeState({ ...state, visibility: 'visible', material: 'acrylic' }));
  await setInput(container.querySelector('textarea')!, 'Keep this draft');
  expect(container.querySelector('main')!.dataset.material).toBe('acrylic');
  await act(async () => changeState({ ...state, visibility: 'visible', material: 'solid' }));
  expect(container.querySelector('main')!.dataset.material).toBe('solid');
  expect(container.querySelector('textarea')!.value).toBe('Keep this draft');
  expect(button('Send message').disabled).toBe(false);
});

it('honors hidden state after a restore failure and keeps the error for reopening', async () => {
  await expand();
  vi.mocked(nativeClient.hideAgent).mockImplementationOnce(async () => {
    changeState(state);
    throw { operation: 'restore_host', recoverable: true, message: 'Hide Aside again to retry restoration.' };
  });
  await click(button('Hide Aside'));
  expect(container.childElementCount).toBe(0);
  await expand();
  expect(container.textContent).toContain('Hide Aside again to retry restoration.');
  expect(nativeClient.runtimeCancel).not.toHaveBeenCalled();
});

it('streams while hidden and only Stop cancels the active request', async () => {
  await expand();
  const requestId = await send();
  await click(button('Hide Aside'));
  await act(async () => emit({ type: 'text_delta', request_id: requestId, delta: 'Still running' }));
  expect(nativeClient.runtimeCancel).not.toHaveBeenCalled();
  expect(container.childElementCount).toBe(0);
  await expand();
  expect(container.textContent).toContain('Still running');
  await click(button('Stop response'));
  expect(nativeClient.runtimeCancel).toHaveBeenCalledWith(requestId);
});

it('receives completion while hidden without reopening the surface', async () => {
  await expand();
  const requestId = await send();
  await act(async () => changeState(state));
  await act(async () => {
    emit({ type: 'text_delta', request_id: requestId, delta: 'Finished in the background' });
    emit({ type: 'completed', request_id: requestId });
  });
  expect(container.childElementCount).toBe(0);
  await expand();
  expect(container.textContent).toContain('Finished in the background');
  expect(button('Stop response')).toBeUndefined();
});

it.each(['Allow once', 'Deny'])('preserves permission identity and details through hiding: %s', async decision => {
  await expand();
  const requestId = await send();
  await click(button('Hide Aside'));
  await act(async () => emit(permission(requestId)));
  expect(container.childElementCount).toBe(0);
  await expand();
  expect(container.textContent).toContain('Create the requested report');
  expect(container.textContent).toContain('report.docx');
  await click(button(decision));
  expect(nativeClient.runtimePermissionResponse).toHaveBeenCalledWith('permission', decision === 'Deny' ? 'deny' : 'allow', { request_id: requestId, task_id: 'task', tool_call_id: 'call' });
  expect(button(decision).disabled).toBe(true);
  await act(async () => emit({ type: 'permission_resolved', request_id: requestId, permission_id: 'permission', task_id: 'task', tool_call_id: 'call', decision: 'deny', status: 'resolved' }));
  expect(container.querySelector('.permission-card')).toBeNull();
});

it('keeps permission available for retry when the native response fails', async () => {
  await expand();
  const requestId = await send();
  await act(async () => emit(permission(requestId)));
  vi.mocked(nativeClient.runtimePermissionResponse).mockRejectedValueOnce(new Error('Response could not be delivered'));
  await click(button('Allow once'));
  expect(container.textContent).toContain('Response could not be delivered');
  expect(button('Allow once').disabled).toBe(false);
  await click(button('Allow once'));
  expect(nativeClient.runtimePermissionResponse).toHaveBeenCalledTimes(2);
});

it('retains captured JSON, dismisses preview before panel, and removes attachments', async () => {
  await expand();
  await act(async () => capture({ captureId: 'cap', host: { kind: 'word', availability: 'available', capabilities: ['capture_context'] }, filePath: 'D:/capture.json', formattedJson: '{"title":"Report"}', attachment: { id: 'cap', host: 'word', source: 'Report.docx', summary: 'Current document', capturedAt: Date.now(), expiresAt: Date.now() + 60000, sensitivity: 'local_content', blocks: [] } }));
  await click(button('Preview JSON for Report.docx'));
  expect(container.querySelector('[aria-modal="true"]')).toBeTruthy();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(container.querySelector('[aria-modal="true"]')).toBeNull();
  expect(container.querySelector('.app-shell')).toBeTruthy();
  await click(button('Hide Aside'));
  await expand();
  expect(button('Preview JSON for Report.docx')).toBeTruthy();
  await click(button('Remove Report.docx'));
  expect(container.querySelector('.attachment-item')).toBeNull();
});

it('clears expired permission and waiting indicators on the runtime resolution event', async () => {
  await expand();
  const requestId = await send();
  await act(async () => {
    emit(permission(requestId));
    emit({ type: 'run_waiting', request_id: requestId, task_id: 'task', permission_id: 'permission', expires_at: Date.now() + 1, reason: 'Permission required' });
  });
  expect(container.querySelector('.permission-card')).toBeTruthy();
  await act(async () => emit({ type: 'permission_resolved', request_id: requestId, permission_id: 'permission', task_id: 'task', tool_call_id: 'call', decision: 'deny', status: 'expired' }));
  expect(container.querySelector('.permission-card')).toBeNull();
  expect(container.querySelector('.waiting-chip')).toBeNull();
});

it('reports blocks actually returned and the precise continuation without claiming completion', async () => {
  await expand();
  const requestId = await send();
  await act(async () => emit({ type: 'tool_result', request_id: requestId, task_id: 'task', tool_call_id: 'read', tool: 'workspace.read', status: 'succeeded', text: 'Partial text', truncated: true, details: { status: 'succeeded', format: 'pdf', block_count: 20, blocks_read: 2, page_count: 10, pages_read: 3, next_block: 2, resume_page: 1, partial: true, truncated: true, warnings: [] } }));
  const chip = container.querySelector('.document-chip')!;
  expect(chip.textContent).toContain('2 of 20 blocks returned');
  expect(chip.textContent).toContain('3 of 10 pages loaded');
  expect(chip.textContent).toContain('block offset 2 (page 1)');
  expect(chip.textContent).toContain('Partial extraction');
  expect(chip.textContent).not.toContain('Read complete');
});

it('keeps every document warning visible', async () => {
  await expand();
  const requestId = await send();
  await act(async () => emit({ type: 'tool_result', request_id: requestId, task_id: 'task', tool_call_id: 'read', tool: 'workspace.read', status: 'succeeded', text: 'Text', truncated: false, details: { status: 'succeeded', format: 'docx', block_count: 3, warnings: [{ code: 'one', message: 'First warning' }, { code: 'two', message: 'Second warning' }, { code: 'three', message: 'Third warning' }] } }));
  expect(container.querySelector('.document-chip')!.textContent).toContain('Third warning');
});

it('shows the generated filename and path, reveals the file, and retains final verification', async () => {
  await expand();
  const requestId = await send();
  await act(async () => {
    emit({ type: 'tool_result', request_id: requestId, task_id: 'task', tool_call_id: 'write', tool: 'workspace.write_docx', status: 'succeeded', text: 'Created', truncated: false, details: { status: 'succeeded', operation: 'transform', output_path: 'D:\\reports\\report.docx', source_path: 'D:\\reports\\source.docx', verification: { status: 'failed' } } });
    emit({ type: 'verification_completed', request_id: requestId, task_id: 'task', tool: 'workspace.write_docx', path: 'D:\\reports\\report.docx', status: 'failed' });
    emit({ type: 'completed', request_id: requestId });
  });
  expect(container.querySelector('.document-chip strong')!.textContent).toContain('report.docx');
  expect(container.querySelector('.document-path')!.textContent).toBe('D:\\reports\\report.docx');
  expect(container.textContent).toContain('Structure not reported');
  expect(container.querySelector('.verification-chip.failed')).toBeTruthy();
  await click(button('Show report.docx in folder'));
  expect(nativeClient.revealPath).toHaveBeenCalledWith('D:\\reports\\report.docx');
});

it('displays live tool output and the full bounded final result with limit notices', async () => {
  await expand();
  const requestId = await send();
  await act(async () => {
    emit({ type: 'tool_call_started', request_id: requestId, task_id: 'task', tool_call_id: 'call', tool: 'workspace.read', arguments: '{"path":"report.txt"}', arguments_truncated: true });
    emit({ type: 'tool_call_update', request_id: requestId, task_id: 'task', tool_call_id: 'call', tool: 'workspace.read', text: 'Reading report', truncated: false });
  });
  expect(container.querySelector('.tool-activity')!.textContent).toContain('Reading report');
  const output = 'x'.repeat(400) + 'End of bounded result';
  await act(async () => emit({ type: 'tool_result', request_id: requestId, task_id: 'task', tool_call_id: 'call', tool: 'workspace.read', status: 'succeeded', text: output, truncated: true, details: { status: 'succeeded' } }));
  expect(container.querySelector('.tool-activity')!.textContent).toContain('End of bounded result');
  expect(container.querySelector('.tool-activity')!.textContent).toContain('report.txt');
  expect(container.querySelector('.tool-activity summary')!.textContent).toContain('shortened by runtime limits');
});

it('shows model, skill diagnostics and configuration facts without claiming MCP connectivity', async () => {
  await expand();
  await act(async () => {
    emit({ type: 'ready', provider: 'configured-provider', model: 'configured-model', skills: [{ name: 'documents', description: 'Read local documents', source: 'bundled', model_invocation: true }], skill_diagnostics: [{ code: 'invalid_skill', message: 'Invalid manifest', path: 'D:/skills/broken' }] });
    emit({ type: 'mcp_servers', servers: [{ id: 'disabled', display_name: 'Disabled server', enabled: false, trust_acknowledged: true }, { id: 'untrusted', display_name: 'Pending trust', enabled: true, trust_acknowledged: false }] });
  });
  expect(container.textContent).toContain('configured-provider · configured-model');
  expect(container.textContent).toContain('Read local documents');
  expect(container.textContent).toContain('Invalid manifest');
  expect(container.textContent).toContain('Disabled server · Disabled');
  expect(container.textContent).toContain('Pending trust · Trust not acknowledged');
  expect(container.querySelector('.server-chip.unavailable')).toBeNull();
});

it('keeps MCP classification warnings through run start, hidden completion and reopening', async () => {
  await expand();
  const requestId = await send();
  const message = 'MCP classification changed. Conservative defaults apply; review mcp.json.';
  await act(async () => {
    emit({ type: 'runtime_warning', code: 'mcp_classification_changed', server_id: 'search', tool: 'search', message });
    emit({ type: 'run_started', request_id: requestId, task_id: 'task' });
  });
  expect(container.textContent).toContain(message);
  await click(button('Hide Aside'));
  await act(async () => emit({ type: 'completed', request_id: requestId, task_id: 'task' }));
  expect(container.childElementCount).toBe(0);
  await expand();
  expect(container.textContent).toContain(message);
});

it('connects workspace controls and preserves the per-run capture override', async () => {
  await expand();
  await setInput(container.querySelector('[aria-label="Workspace folder path"]')!, 'D:/reports');
  await click(button('Set'));
  expect(nativeClient.runtimeSetWorkspace).toHaveBeenCalledWith('D:/reports');
  const requestId = await send();
  await act(async () => emit({ type: 'run_started', request_id: requestId, workspace: { status: 'resolved', addressed_path: 'D:/reports', canonical_path: 'D:/reports', kind: 'directory', source: 'explicit' }, workspace_overridden: { replaced_by: 'D:/reports', captured_path: 'D:/other' } }));
  expect(container.querySelector('.override-chip')!.textContent).toContain('D:/other');
  await act(async () => emit({ type: 'completed', request_id: requestId }));
  await click(button('Clear workspace'));
  expect(nativeClient.runtimeClearWorkspace).toHaveBeenCalledOnce();
  await act(async () => emit({ type: 'workspace_cleared' }));
  expect(container.querySelector('[aria-label="Workspace folder path"]')).toBeTruthy();
});

it('preserves errors across hiding and respects a nonretryable runtime failure', async () => {
  await expand();
  await act(async () => nativeError({ operation: 'host_capture', recoverable: true, message: 'Capture unavailable' }));
  await click(button('Hide Aside'));
  await expand();
  expect(container.textContent).toContain('Capture unavailable');
  const requestId = await send();
  await act(async () => emit({ type: 'failed', request_id: requestId, message: 'This request cannot be retried', retryable: false }));
  expect(container.textContent).toContain('This request cannot be retried');
  expect(button('Retry')).toBeUndefined();
});

it('keeps the response truncation notice after completion', async () => {
  await expand();
  const requestId = await send();
  await act(async () => {
    emit({ type: 'text_delta', request_id: requestId, delta: 'Bounded response', truncated: true });
    emit({ type: 'completed', request_id: requestId });
  });
  expect(container.textContent).toContain('Response shortened by runtime limits');
});

it('keeps the draft when a prompt cannot reach the runtime', async () => {
  await expand();
  vi.mocked(nativeClient.runtimePrompt).mockRejectedValueOnce(new Error('Runtime could not start'));
  await send();
  expect(container.querySelector('textarea')!.value).toBe('Test prompt');
  expect(container.textContent).toContain('Runtime could not start');
});

it('clears pending runtime state on failure received while hidden', async () => {
  await expand();
  const requestId = await send();
  await act(async () => {
    emit(permission(requestId));
    emit({ type: 'run_waiting', request_id: requestId, task_id: 'task', permission_id: 'permission', expires_at: Date.now() + 60000, reason: 'Permission required' });
  });
  await click(button('Hide Aside'));
  await act(async () => emit({ type: 'runtime_unavailable', message: 'Runtime disconnected' }));
  expect(container.childElementCount).toBe(0);
  await expand();
  expect(container.querySelector('.permission-card')).toBeNull();
  expect(container.querySelector('.waiting-chip')).toBeNull();
  expect(container.textContent).toContain('Runtime disconnected');
});

it('can reopen the browser preview with the local shortcut', async () => {
  vi.spyOn(nativeClient, 'toggleAgent').mockResolvedValueOnce({ ...state, visibility: 'visible' }).mockResolvedValueOnce(state);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, altKey: true })));
  expect(container.querySelector('.app-shell')).toBeTruthy();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, altKey: true })));
  expect(container.childElementCount).toBe(0);
  expect(nativeClient.toggleAgent).toHaveBeenCalledTimes(2);
});

it('shows the resolved workspace root and its captured target separately', async () => {
  await expand();
  await act(async () => emit({ type: 'workspace_resolved', request_id: 'request', task_id: 'task', workspace: { status: 'resolved', source: 'descriptor_handoff', kind: 'directory', addressed_path: 'D:/reports', canonical_path: 'D:/reports', target: { role: 'selected_item', addressed_path: 'D:/reports/input.pdf', canonical_path: 'D:/reports/input.pdf', relative_path: 'input.pdf', kind: 'file' } } }));
  expect(container.querySelector('.workspace-chip')!.textContent).toContain('Captured root & target');
  expect(container.querySelector('.workspace-chip')!.textContent).toContain('Target · D:/reports/input.pdf');
});
