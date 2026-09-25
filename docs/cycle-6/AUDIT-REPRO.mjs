// Independent audit: node docs/cycle-6/AUDIT-REPRO.mjs
// Synthetic temporary files only; no network/provider. Runs against unmodified code.
import { mkdtemp, writeFile, readFile, readdir, unlink, rmdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocx } from '../../agent-runtime/test/docx-fixtures.mjs';
import { createWorkspaceReadTools } from '../../agent-runtime/src/workspace-tools.mjs';
import { createDocumentTools } from '../../agent-runtime/src/docx-tools.mjs';
import { resolveTaskWorkspace } from '../../agent-runtime/src/workspace.mjs';
import { createPdfAdapter } from '../../agent-runtime/src/pdf-adapter.mjs';
import { McpController } from '../../agent-runtime/src/mcp-adapter.mjs';
import { validateServerConfig } from '../../agent-runtime/src/mcp-config.mjs';
import { PermissionBroker } from '../../agent-runtime/src/permission-broker.mjs';
import { createAsideToolRegistry } from '../../agent-runtime/src/capability-contract.mjs';
import { loadMcpServerConfigs } from '../../agent-runtime/src/mcp-runtime.mjs';
import { createConversationRuntime } from '../../agent-runtime/src/runtime.mjs';
import { Agent } from '@earendil-works/pi-agent-core/aside';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
const root = await mkdtemp(join(tmpdir(), 'aside-independent-audit-'));
const findings = [];
const record = (probe, evidence) => findings.push({ probe, ...evidence });
const text = r => r.content.map(b => b.text ?? '').join('\n');
const run = { request_id:'audit-request', task_id:'audit-task', limits:{maxPendingPermissionMs:5000,maxToolResultBytes:32768} };
try {
  const workspace = (await resolveTaskWorkspace({workspaceHint:root})).environment;
  const read = await createWorkspaceReadTools().find(t=>t.name==='workspace.read').createForRun({workspace,taskRun:run});
  await writeFile(join(root,'changing.txt'),'A'.repeat(30000));
  const firstSegment=await read.execute('first-segment',{path:'changing.txt'});
  await writeFile(join(root,'changing.txt'),'B'.repeat(31000));
  const secondSegment=await read.execute('second-segment',{path:'changing.txt',byte_offset:firstSegment.details.next_byte_offset});
  record('text_continuation_changed_identity',{firstNextOffset:firstSegment.details.next_byte_offset,secondStatus:secondSegment.details.status,secondCode:secondSegment.details.code??null,secondContainsNewVersion:text(secondSegment).includes('BBBBBBBB')});
  await writeFile(join(root,'AUDITSEARCH-a.txt'),'one');
  await writeFile(join(root,'AUDITSEARCH-b.txt'),'two');
  const search=await createWorkspaceReadTools().find(t=>t.name==='workspace.search').createForRun({workspace,taskRun:run});
  const searched=await search.execute('search',{query:'AUDITSEARCH',mode:'name',max_results:1});
  record('search_missing_continuation',{status:searched.details.status,truncated:searched.details.truncated,resultCount:searched.details.result_count,continuationFields:Object.keys(searched.details).filter(k=>/next|cursor|offset/.test(k))});
  await writeFile(join(root,'table.docx'),buildDocx([{type:'table',rows:[['AUDIT_CELL_8731','Total'],['Revenue','42']]}]));
  const table=await read.execute('table',{path:'table.docx'});
  record('docx_table_provider_content',{status:table.details.status,markerAnywhere:JSON.stringify(table).includes('AUDIT_CELL_8731'),content:text(table)});
  await writeFile(join(root,'long.docx'),buildDocx([{type:'paragraph',text:'X'.repeat(30000)}],{level:0}));
  const long=await read.execute('long',{path:'long.docx'});
  const resumed=await read.execute('resume',{path:'long.docx',byte_offset:24064});
  record('docx_long_paragraph',{status:long.details.status,truncated:long.details.truncated,nextOffset:long.details.next_byte_offset??null,sameOnByteOffset:text(long)===text(resumed),contentBytes:text(long).length});
  const loader=(numPages,items)=>async()=>({promise:Promise.resolve({numPages,getPage:async n=>({getTextContent:async()=>({items:items(n)})}),getMetadata:async()=>({info:{}}),destroy:async()=>{}}),destroy(){}});
  const item=(str,y=1)=>({str,transform:[1,0,0,1,0,y]});
  const pdfAdapter=createPdfAdapter({load:loader(2,n=>[item(n===1?'X'.repeat(25000):'SECOND_PAGE')])});
  await writeFile(join(root,'dense.pdf'),new Uint8Array([37,80,68,70]));
  const pdfRead=await createWorkspaceReadTools({documentAdapters:[pdfAdapter]}).find(t=>t.name==='workspace.read').createForRun({workspace,taskRun:run});
  const pdf=await pdfRead.execute('pdf',{path:'dense.pdf'});
  record('pdf_continuation_skips_current_page',{status:pdf.details.status,truncated:pdf.details.truncated,nextPage:pdf.details.next_page,content:text(pdf)});
  const blockPdf=createPdfAdapter({load:loader(1,()=>Array.from({length:2100},(_,i)=>item('L'+i,i)))});
  const block=await blockPdf.read({bytes:new Uint8Array([1]),path:'synthetic.pdf'});
  record('pdf_block_limit_honesty',{blocks:block.blocks.length,partial:block.partial,warnings:block.warnings,pagesRead:block.metadata.pages_read});
  const child=spawnSync(process.execPath,['--input-type=module','-e',"import {parsePageRange} from './agent-runtime/src/pdf-adapter.mjs'; console.log(parsePageRange('9007199254740992'));"],{cwd:resolve('.'),timeout:2000,encoding:'utf8'});
  record('unsafe_pdf_page_number',{timedOut:child.error?.code==='ETIMEDOUT',exitStatus:child.status,signal:child.signal});
  const config=validateServerConfig({id:'audit',display_name:'Audit server',command:process.execPath,enabled:true,trust_acknowledged:true});
  const controller=new McpController({servers:[config],connectionFactory:async()=>({state:'ready',listTools:async()=>[{name:'lookup',description:'Lookup a value',inputSchema:{type:'object',properties:{}}}],callTool:async()=>({content:[{type:'text',text:'AUDIT_RESULT_4291'}]}),close:async()=>{}})});
  const mcpTool=(await controller.tools())[0];
  const mcpBound=await mcpTool.createForRun({taskRun:run,permissionBroker:{waitForDecision:async()=>({decision:'allow'})}});
  const mcpResult=await mcpBound.execute('mcp',{});
  record('mcp_content_vs_details',{status:mcpResult.details.status,markerInContent:text(mcpResult).includes('AUDIT_RESULT_4291'),markerInDetails:JSON.stringify(mcpResult.details).includes('AUDIT_RESULT_4291'),content:text(mcpResult)});
  await controller.close();
  for (const [name, advertised] of [
    ['duplicate_names',[{name:'same'},{name:'same'}]],
    ['long_description',[{name:'ordinary',description:'a'.repeat(1000)}]],
  ]) {
    const ctl=new McpController({servers:[config],connectionFactory:async()=>({state:'ready',listTools:async()=>advertised.map(t=>({...t,inputSchema:{type:'object',properties:{}}})),close:async()=>{}})});
    const adapted=await ctl.tools();
    let registryError;
    try { createAsideToolRegistry(adapted); } catch(e) {registryError=e.message;}
    record('mcp_registry_isolation_'+name,{adaptedTools:adapted.length,diagnostics:ctl.diagnostics,registryError:registryError??null});
    await ctl.close();
  }
  const tooMany=await loadMcpServerConfigs({configDir:root,readTextFile:async()=>JSON.stringify({servers:Array.from({length:9},(_,i)=>({id:'server'+i,display_name:'Server '+i,command:process.execPath,enabled:true,trust_acknowledged:true}))})});
  record('mcp_config_server_limit',{configured:tooMany.servers.length,declaredLimit:8,diagnostics:tooMany.diagnostics});
  const faux=fauxProvider({tokensPerSecond:1000});
  const models=createModels();models.setProvider(faux.provider);
  let providerCalls=0;
  faux.setResponses([()=>{providerCalls++;return fauxAssistantMessage('done');}]);
  const agent=new Agent({initialState:{systemPrompt:'Audit',model:faux.getModel(),thinkingLevel:'off',tools:[]},streamFn:models.streamSimple.bind(models),convertToLlm:m=>m});
  let releaseDiscovery, discoveryStarted;
  const discovered=new Promise(r=>{discoveryStarted=r});
  const runtimeEvents=[];
  const runtime=await createConversationRuntime({agent,tools:[],emit:e=>runtimeEvents.push(e),mcp:{toolFactory:async()=>{discoveryStarted();return new Promise(r=>{releaseDiscovery=()=>r([])})},close:async()=>{}}});
  const cancelledPrompt=runtime.prompt('cancel-during-discovery','Do not send after stop');
  await discovered;
  runtime.cancel('cancel-during-discovery');
  releaseDiscovery();
  await cancelledPrompt;
  record('cancel_during_mcp_discovery',{providerCallsAfterCancel:providerCalls,terminalEvents:runtimeEvents.filter(e=>['completed','cancelled','failed'].includes(e.type)).map(e=>e.type)});
  runtime.dispose();
  await writeFile(join(root,'source.docx'),buildDocx([{type:'paragraph',text:'Original source'}]));
  let permission;
  const broker=new PermissionBroker({emit:e=>{if(e.type==='permission_requested')permission=e},maxPendingMs:5000});
  const transform=await createDocumentTools().find(t=>t.name==='document.transform').createForRun({workspace,taskRun:run,permissionBroker:broker});
  const pending=transform.execute('transform',{path:'source.docx',output_path:'changed.docx',document:{blocks:[{type:'paragraph',text:'Output based on original source'}]}});
  while(!permission) await new Promise(r=>setTimeout(r,5));
  await writeFile(join(root,'source.docx'),buildDocx([{type:'paragraph',text:'Different and longer source after preview'}]));
  broker.resolve(permission.permission_id,'allow',{request_id:run.request_id,task_id:run.task_id,tool_call_id:'transform'});
  const transformed=await pending;
  record('docx_stale_source',{status:transformed.details.status,code:transformed.details.code??null,outputCreated:(await readdir(root)).includes('changed.docx')});
  broker.dispose();
  let raceHit=false;
  const raceWorkspace=(await resolveTaskWorkspace({workspaceHint:root,fileSystem:{rename:async(from,to)=>{await writeFile(to,'CONCURRENT_OUTPUT');raceHit=true;return rename(from,to)}}})).environment;
  const target=await raceWorkspace.resolvePath('race.docx',{expectedKind:'file',allowMissing:true});
  await raceWorkspace.writeBytesAtomic('race.docx',new TextEncoder().encode('ASIDE_OUTPUT'),{maxBytes:100,expected:target,expectMissing:true,beforeRename:()=>raceWorkspace.revalidate(target,{expectedKind:'file',allowMissing:true,expectMissing:true})});
  record('no_overwrite_commit_race',{raceHit,finalBytes:await readFile(join(root,'race.docx'),'utf8')});
} finally {
  for(const name of await readdir(root)) await unlink(join(root,name));
  await rmdir(root);
}
console.log(JSON.stringify(findings,null,2));
