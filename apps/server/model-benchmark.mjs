import { randomUUID, createHash } from 'node:crypto';
import { requestModelCompletion, validateModelConfig } from '../../packages/models/index.mjs';

export class ModelBenchmarks {
  constructor(service, monitor) { this.service=service;this.monitor=monitor;this.jobs=new Map(); }
  start(input) {
    const fail=message=>{throw Object.assign(new Error(message),{status:400,code:'invalid_benchmark'});};
    if([...this.jobs.values()].some(j=>j.status==='running'))fail('已有固定局面测速在运行，请完成或取消后再开始。');
    const model=this.service.configStore.modelConfig(input.modelId);
    if(!model)fail('请选择一个已保存的模型配置。');
    const repetitions=Number(input.repetitions??3);
    if(!Number.isInteger(repetitions)||repetitions<1||repetitions>5)fail('重复次数必须为1–5。');
    const variants=input.variants;
    if(!Array.isArray(variants)||variants.length<1||variants.length>5)fail('请选择1–5组原生推理设置。');
    const configs=variants.map(v=>{
      const copy={...model,thinkingMode:v.thinkingMode??'default',reasoningEffort:v.reasoningEffort??'default',reasoningAdapter:v.reasoningAdapter??model.reasoningAdapter??'auto'};
      const check=validateModelConfig(copy);if(!check.ok)fail(check.errors.join(' '));return copy;
    });
    const fixture=this.service.benchmarkPosition(input.matchId,Number(input.step??0),input.moveMode==='pure'?'pure':'assisted',model);
    const id=randomUUID(), controller=new AbortController();
    const job={id,status:'running',createdAt:new Date().toISOString(),modelId:model.id,gameId:fixture.game.id,matchId:input.matchId,
      step:Number(input.step??0),repetitions,total:repetitions*configs.length,done:0,controller};
    this.jobs.set(id,job);
    const promptHash=createHash('sha256').update(JSON.stringify(fixture.messages)).digest('hex');
    job.promise=(async()=>{
      // Rotate variant order between repetitions to reduce a fixed warm/cold ordering effect.
      for(let rep=0;rep<repetitions;rep++)for(let j=0;j<configs.length;j++){
        if(controller.signal.aborted)break;
        const config=configs[(j+rep)%configs.length];
        try{
          const result=await requestModelCompletion(config,{messages:fixture.messages,temperature:.2,
            maxTokens:Math.min(model.maxOutputTokens??4800,32768),measureStream:true,signal:controller.signal,
            monitor:this.monitor,monitorContext:{task:'benchmark',benchmarkId:id,promptHash,gameId:fixture.game.id,
              matchId:input.matchId,step:job.step,moveMode:input.moveMode==='pure'?'pure':'assisted',pace:'benchmark',repetition:rep+1}});
          const parsed=fixture.game.parseModelMove(result.text);
          const legal=parsed.ok && fixture.game.validateAction(fixture.state,fixture.seat,parsed.action).ok;
          this.monitor.outcome(result.monitorId,Boolean(legal),legal?null:'invalid_move');
        }catch(error){if(controller.signal.aborted)break;}
        job.done++;
      }
      job.status=controller.signal.aborted?'cancelled':'completed';job.finishedAt=new Date().toISOString();
    })().catch(()=>{job.status='failed';});
    return this.publicJob(job);
  }
  publicJob(job){const {controller,promise,...view}=job;return view;}
  list(){return [...this.jobs.values()].map(j=>this.publicJob(j));}
  cancel(id){const job=this.jobs.get(id);if(job?.status==='running')job.controller.abort();return Boolean(job);}
  async close(){for(const j of this.jobs.values())j.controller.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));}
}
