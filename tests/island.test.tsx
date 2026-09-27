import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import { nativeClient } from '../src/lib/ipc';
import type { RuntimeEvent, HostCaptureResult } from '../src/lib/contracts';

let root: Root, container: HTMLDivElement;
let emit: (event: RuntimeEvent) => void;
let capture: (result: HostCaptureResult) => void;
const state = {visibility: 'hidden' as const, surface: 'side' as const, pinned: false};
const button = (name: string) => [...container.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === name || el.textContent?.trim() === name)!;
async function click(el: HTMLElement) { expect(el).toBeTruthy(); await act(async () => el.click()); }
async function expand() { await click(container.querySelector('.edge-capsule')!); }
async function send() {
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Test prompt');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await click(button('Send message'));
  return vi.mocked(nativeClient.runtimePrompt).mock.calls.at(-1)![0];
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(nativeClient,'getAgentState').mockResolvedValue(state);
  vi.spyOn(nativeClient,'showAgent').mockResolvedValue({...state,visibility:'visible'});
  vi.spyOn(nativeClient,'hideAgent').mockResolvedValue(state);
  vi.spyOn(nativeClient,'onRuntimeEvent').mockImplementation(async handler => {emit=handler;return ()=>{};});
  vi.spyOn(nativeClient,'onHostCapture').mockImplementation(async handler => {capture=handler;return ()=>{};});
  vi.spyOn(nativeClient,'runtimePrompt').mockResolvedValue();
  vi.spyOn(nativeClient,'runtimeCancel').mockResolvedValue();
  vi.spyOn(nativeClient,'runtimePermissionResponse').mockResolvedValue();
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await act(async()=>root.render(<App/>));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});

it('keeps the draft across collapse and reopening; Escape collapses', async()=>{
  await expand();
  const input=container.querySelector('textarea')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Unsent draft');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));
  expect(container.querySelector('.edge-capsule')).toBeTruthy();
  await expand();expect(container.querySelector('textarea')!.value).toBe('Unsent draft');
});
it('streams while collapsed and only Stop cancels the active request',async()=>{
  await expand();const id=await send();
  await click(button('Collapse Aside'));
  await act(async()=>emit({type:'text_delta',request_id:id,delta:'Still running'}));
  expect(nativeClient.runtimeCancel).not.toHaveBeenCalled();
  expect(container.querySelector('.edge-capsule')!.getAttribute('aria-label')).toContain('Working');
  await expand();expect(container.textContent).toContain('Still running');
  await click(button('Stop response'));expect(nativeClient.runtimeCancel).toHaveBeenCalledWith(id);
});
it.each(['Allow once','Deny'])('preserves permission identity and details through collapse: %s',async decision=>{
  await expand();const id=await send();
  await act(async()=>emit({type:'permission_requested',request_id:id,permission_id:'p',task_id:'task',tool_call_id:'call',operation:'workspace.write',effect:'write',egress:'none',source:'builtin',status:'pending',expires_at:Date.now()+60000,explanation:'Create the requested report',workspace:{path:'D:/reports'},targets:['report.docx'],preview:{text:'Preview body'},risk:{boundary:'workspace',note:'Write access'}} as RuntimeEvent));
  await click(button('Collapse Aside'));
  expect(container.querySelector('.edge-capsule')!.getAttribute('aria-label')).toContain('permission');
  await expand();expect(container.textContent).toContain('Create the requested report');expect(container.textContent).toContain('report.docx');
  await click(button(decision));
  expect(nativeClient.runtimePermissionResponse).toHaveBeenCalledWith('p',decision==='Deny'?'deny':'allow',{request_id:id,task_id:'task',tool_call_id:'call'});
});
it('retains captured JSON, dismisses preview before panel, and removes attachments',async()=>{
  await expand();
  await act(async()=>capture({captureId:'cap',filePath:'D:/capture.json',formattedJson:'{"title":"Report"}',attachment:{id:'cap',host:'word',source:'Report.docx',summary:'Current document',capturedAt:Date.now(),expiresAt:Date.now()+60000,sensitivity:'local_content',blocks:[]}}));
  await click(button('Preview JSON for Report.docx'));
  expect(container.querySelector('[aria-modal="true"]')).toBeTruthy();
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));
  expect(container.querySelector('[aria-modal="true"]')).toBeNull();expect(container.querySelector('.app-shell')).toBeTruthy();
  await click(button('Remove Report.docx'));expect(container.querySelector('.attachment-item')).toBeNull();
});

it('clears expired permission and waiting indicators on the runtime resolution event',async()=>{
  await expand();const id=await send();
  await act(async()=>{
    emit({type:'permission_requested',request_id:id,permission_id:'expired',task_id:'task',tool_call_id:'call',operation:'write',effect:'write',expires_at:Date.now()+1,risk:{}} as RuntimeEvent);
    emit({type:'run_waiting',request_id:id,reason:'Permission required'} as RuntimeEvent);
  });
  expect(container.querySelector('.permission-card')).toBeTruthy();
  await act(async()=>emit({type:'permission_resolved',request_id:id,permission_id:'expired',task_id:'task',tool_call_id:'call',decision:'deny',status:'expired'}));
  expect(container.querySelector('.permission-card')).toBeNull();expect(container.querySelector('.waiting-chip')).toBeNull();
});
