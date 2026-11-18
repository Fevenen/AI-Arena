import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
export async function acquireLocalSlot(endpoint, { signal, task='move', onProgress }={}) {
  const url=new URL(endpoint);
  if(!['127.0.0.1','localhost','[::1]','::1'].includes(url.hostname))return ()=>{};
  const hash=createHash('sha256').update('loopback:'+url.port).digest('hex').slice(0,24);
  const dir=path.join(os.tmpdir(),'dafeiyu-inference-v1',hash);
  fs.mkdirSync(dir,{recursive:true});
  const id=randomUUID(), ticket=path.join(dir,id+'.json'), lock=path.join(dir,'slot');
  const priority=task==='timed_move'?0:task==='question'||task==='chat'?1:task==='move'?2:4;
  const item={id,pid:process.pid,priority,created:Date.now()};
  fs.writeFileSync(ticket,JSON.stringify(item),{mode:0o600});
  const started=Date.now();let acquired=false;
  try{
    onProgress?.('queued',{});
    while(!acquired){
      signal?.throwIfAborted();
      const waiting=[];
      for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9-]+\.json$/.test(n))){
        const file=path.join(dir,name);
        try{const row=JSON.parse(fs.readFileSync(file,'utf8'));if(alive(row.pid))waiting.push(row);else fs.unlinkSync(file);}catch{}
      }
      waiting.sort((a,b)=>a.priority-b.priority||a.created-b.created||a.id.localeCompare(b.id));
      if(waiting[0]?.id===id){
        try{fs.mkdirSync(lock);acquired=true;fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify(item),{mode:0o600});}
        catch(e){
          if(e.code!=='EEXIST')throw e;
          try{const owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));
            if(!alive(owner.pid)){fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);}
          }catch{try{if(Date.now()-fs.statSync(lock).mtimeMs>5000)fs.rmdirSync(lock);}catch{}}
        }
      }
      if(!acquired)await new Promise(r=>setTimeout(r,60));
    }
    onProgress?.('requesting',{queueMs:Date.now()-started});
    return ()=>{
      try{const owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));
        if(owner.id===id){fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);}
      }catch{}
    };
  }finally{try{fs.unlinkSync(ticket);}catch{}}
}
