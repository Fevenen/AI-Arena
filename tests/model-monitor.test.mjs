import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeReasoning, validateReasoning } from '../packages/models/reasoning.mjs';
import { requestModelCompletion } from '../packages/models/client.mjs';
import { acquireLocalSlot } from '../packages/models/local-queue.mjs';
import { ModelMonitor, summarizeRequests } from '../apps/server/model-monitor.mjs';
import { createMockOpenAI } from './helpers/mock-openai.mjs';

test('原生推理值与引擎扩展分开，旧配置不冒充实际生效',()=>{
  assert.deepEqual(describeReasoning({baseUrl:'https://api.deepseek.com',modelId:'deepseek-flash',thinkingMode:'on',reasoningEffort:'max'}).sent,{thinking:{type:'enabled'},reasoning_effort:'max'});
  const legacy=describeReasoning({modelId:'kvmem-polystrata-qwen35',reasoningEffort:'low'});
  assert.equal(legacy.legacyIgnoredEffort,'low');assert.deepEqual(legacy.sent,{});
  assert.deepEqual(describeReasoning({reasoningAdapter:'qwen',thinkingMode:'on'}).sent,{chat_template_kwargs:{enable_thinking:true}});
  assert.deepEqual(describeReasoning({reasoningAdapter:'qwen',thinkingMode:'off'}).sent,{chat_template_kwargs:{enable_thinking:false}});
  assert.equal(describeReasoning({reasoningAdapter:'kvmem',reasoningEffort:'medium'}).source,'engine');
  assert.match(validateReasoning({reasoningAdapter:'qwen',reasoningEffort:'max'}),/支持/);
  assert.match(validateReasoning({reasoningAdapter:'deepseek',reasoningEffort:'medium'}),/支持/);
});

test('同一本地接口可分别开关思考，监控不保存正文与密钥',async()=>{
  const mock=await createMockOpenAI();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arena-monitor-test-'));
  const monitor=new ModelMonitor(dir);
  const config={name:'fixture',provider:'openai-compatible',baseUrl:mock.baseUrl,modelId:'mock-model',apiKey:'private-test-key',timeoutMs:1000,reasoningAdapter:'qwen'};
  try{
    for(const thinkingMode of ['on','off'])await requestModelCompletion({...config,thinkingMode},{messages:[{role:'user',content:'private-question'}],maxTokens:512,monitor,monitorContext:{task:'move',gameId:'gomoku'}});
    assert.equal(mock.requests[0].body.chat_template_kwargs.enable_thinking,true);
    assert.equal(mock.requests[1].body.chat_template_kwargs.enable_thinking,false);
    assert.equal(monitor.active.size,0);assert.equal(monitor.snapshot().count,2);
    assert.doesNotMatch(fs.readFileSync(monitor.file,'utf8'),/private-question|private-test-key|Bearer|"messages"|"content"/);
    assert.equal(new ModelMonitor(dir).snapshot().count,2);
  }finally{await mock.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('队列取消清理排队项，并保留当前执行请求',async()=>{
  const endpoint='http://127.0.0.1:59172/v1/chat/completions';
  const release=await acquireLocalSlot(endpoint);const controller=new AbortController();
  const waiting=acquireLocalSlot(endpoint,{signal:controller.signal});
  setTimeout(()=>controller.abort(),40);await assert.rejects(waiting,/abort/i);release();
  const next=await acquireLocalSlot(endpoint);next();
});

test('统计包含失败和超时，不混淆任务与未知旧档位',()=>{
  const rows=[{modelId:'m',task:'move',reasoning:{label:'low'},status:'completed',elapsedMs:1000,legal:true},
    {modelId:'m',task:'move',reasoning:{label:'low'},status:'failed',elapsedMs:30000,errorCode:'model_timeout'},
    {modelId:'m',task:'comment',reasoning:{label:'low'},status:'completed',elapsedMs:500},
    {modelId:'m',task:'move',status:'legacy_completed',elapsedMs:2000}];
  const stats=summarizeRequests(rows);assert.equal(stats.length,3);
  const group=stats.find(g=>g.count===2);assert.equal(group.meanMs,15500);assert.equal(group.timeoutCount,1);assert.equal(group.failureCount,1);
});
