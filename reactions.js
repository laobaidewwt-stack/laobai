import {escapeHTML as esc} from './core.js?v=20261106-reactions1';
import {relativeTime} from './activity.js?v=20261106-reactions1';
export const MARKS=Object.freeze(['已存','已看','想做','已翻译','已上传','先不做','收到 ✦']);
const ORDER=['待看','想做','不做','翻译中','已翻完','已上传','已发微博'];
export const charCount=text=>Array.from(text).length;
export function replyText(text){const value=String(text).trim();if(!value||charCount(value)>60)throw new Error('请写 1 到 60 个字');return value;}
export function promoted(status,mark){const target=mark==='已翻译'?'已翻完':mark==='已上传'?'已上传':status;return ORDER.indexOf(target)>ORDER.indexOf(status)?target:status;}
export function unanswered(row,actor){return row.byId!==actor.id&&!(row.reactions?.[actor.id]?.marks?.length);}
export function applyOptimistic(row,operation){
 const r=structuredClone(row),o=operation;r.reactions??={};r.replies??=[];
 if(o.kind==='react'){
  const entry=r.reactions[o.actor.id]||{name:o.actor.name,marks:[]},marks=new Set(entry.marks);
  o.on?marks.add(o.mark):marks.delete(o.mark);
  if(marks.size)r.reactions[o.actor.id]={name:o.actor.name,marks:MARKS.filter(m=>marks.has(m)),at:o.at};else delete r.reactions[o.actor.id];
  if(o.on)r.status=promoted(r.status,o.mark);
 }else if(o.kind==='reply')r.replies=[...r.replies.filter(x=>x.id!==o.id),{id:o.id,actor_id:o.actor.id,name:o.actor.name,text:o.text,at:o.at,pending:true}].slice(-50);
 else{const original=r.replies.find(x=>x.id===o.replyId);r.replies=r.replies.filter(x=>x.id!==o.replyId);if(original)r.reply_deletions=[...(r.reply_deletions||[]),{id:o.id,reply_id:o.replyId,actor_id:o.actor.id,name:o.actor.name,reply_name:original.name,at:o.at,pending:true}].slice(-50);}
 return r;
}
// One lane per pick. Confirmed rows and pending intent never share revision numbers.
// An uncertain write pauses its lane; only its same ID/payload can be retried.
export class ReactionController{
 constructor({store,request,getActor,onChange=()=>{},onError=()=>{},onCommit=()=>{},uuid=()=>crypto.randomUUID()}){Object.assign(this,{store,request,getActor,onChange,onError,onCommit,uuid});this.epoch=0;this.lanes=new Map();this.ui=new Map();}
 state(id){if(!this.ui.has(id))this.ui.set(id,{open:false,expanded:false,auditExpanded:false,draft:''});return this.ui.get(id);}
 view(row){let r=row;for(const op of this.lanes.get(row.id)?.queue||[])r=applyOptimistic(r,op);return r;}
 live(){return this.store.live().map(row=>this.view(row));}
 pending(id){return !!this.lanes.get(id)?.queue.length;}
 uncertain(id){return this.lanes.get(id)?.uncertain||null;}
 enqueue(id,detail){
  const actor={...this.getActor()},row=this.store.rows.get(id);if(!actor.id||!actor.name)throw new Error('先写一个协作署名');if(!row||row.deleted)throw new Error('这部剧已删除');
  let lane=this.lanes.get(id);if(lane?.uncertain)throw new Error('上次保存还未确认，请先核对并重试');
  if(!lane){lane={queue:[],running:false,uncertain:null};this.lanes.set(id,lane)}
  const op={...detail,id:this.uuid(),pick:id,actor,at:new Date().toISOString()};lane.queue.push(op);this.onChange();void this.drain(id,lane);return op.id;
 }
 toggle(id,mark){if(!MARKS.includes(mark))throw new Error('回应无效');const row=this.view(this.store.rows.get(id));return this.enqueue(id,{kind:'react',mark,on:!row.reactions?.[this.getActor().id]?.marks?.includes(mark)});}
 reply(id){if(this.lanes.get(id)?.queue.some(o=>o.kind==='reply'))return;return this.enqueue(id,{kind:'reply',text:replyText(this.state(id).draft)});}
 remove(id,replyId){const reply=this.view(this.store.rows.get(id)).replies?.find(x=>x.id===replyId);if(!reply||reply.pending)return;if(reply.actor_id!==this.getActor().id)throw new Error('只能删除当前设备署名的留言');return this.enqueue(id,{kind:'reply_delete',replyId});}
 async drain(id,lane){
  if(lane.running||lane.uncertain||!lane.queue.length)return;lane.running=true;const epoch=this.epoch;
  try{
   while(lane.queue.length&&epoch===this.epoch){
    const op=lane.queue[0],args={p_id:id,p_operation_id:op.id,...(op.kind==='react'?{p_mark:op.mark,p_on:op.on}:op.kind==='reply'?{p_text:op.text}:{p_reply_id:op.replyId})};
    try{
     if(this.getActor().id!==op.actor.id||this.getActor().name!==op.actor.name)throw Object.assign(new Error('署名已变化'),{code:'cancelled'});
     const row=await this.request('ledger_picks_'+op.kind,args);if(epoch!==this.epoch)return;
     this.store.apply([row]);lane.queue.shift();
     if(op.kind==='reply'&&this.state(id).draft.trim()===op.text)this.state(id).draft='';
     this.onChange();this.onCommit(row);
    }catch(error){
     if(epoch!==this.epoch)return;
     // HTTP rejection is definite; a lost response may already have committed.
     if((!error.status||error.status>=500||error.status===408)&&error.code!=='cancelled'&&error.code!=='actor_required'&&error.code!=='bad_key')lane.uncertain=op;
     lane.queue=[];this.onChange();this.onError(error,!!lane.uncertain);break;
    }
   }
  }finally{if(epoch===this.epoch){lane.running=false;if(!lane.queue.length&&!lane.uncertain)this.lanes.delete(id)}}
 }
 retry(id){const lane=this.lanes.get(id);if(!lane?.uncertain||lane.running)return;lane.queue=[lane.uncertain];lane.uncertain=null;this.onChange();void this.drain(id,lane);}
 clear(){this.epoch++;this.lanes.clear();this.ui.clear();}
}
export function summaryHTML(row,actor,state){
 const entries=Object.entries(row.reactions||{}).filter(([,v])=>v.marks?.length),replies=row.replies||[],deletions=row.reply_deletions||[];if(!entries.length&&!replies.length&&!deletions.length)return '';
 const tags=entries.map(([id,v])=>'<div class="pk-response-person"><strong>'+esc(v.name)+'</strong><span>'+MARKS.filter(m=>v.marks.includes(m)).map(m=>'<span class="pk-response-tag'+(['已翻译','已上传'].includes(m)?' complete':'')+'">'+esc(m)+'</span>').join('')+'</span></div>').join('');
 const visible=state.expanded?replies:replies.slice(-3);
 const text=visible.map(r=>'<div class="pk-response-reply"><strong>'+esc(r.name)+'</strong><span>'+esc(r.text)+' <time datetime="'+esc(r.at)+'" title="'+esc(new Date(r.at).toLocaleString('zh-CN'))+'">'+esc(r.pending?'保存中…':relativeTime(r.at))+'</time></span>'+(r.actor_id===actor.id&&!r.pending?'<button type="button" class="linkbtn pk-reply-delete" data-act="pk-reply-delete" data-id="'+esc(row.id)+'" data-reply="'+esc(r.id)+'" aria-label="删除自己的这句留言">删除</button>':'')+'</div>').join('');
 const audit=(state.auditExpanded?deletions:deletions.slice(-3)).map(d=>'<p class="pk-response-deletion">'+esc(d.name)+' 删除了'+(d.reply_name&&d.reply_name!==d.name?' '+esc(d.reply_name)+' 的':'自己的一条')+'留言 <time datetime="'+esc(d.at)+'" title="'+esc(new Date(d.at).toLocaleString('zh-CN'))+'">'+esc(d.pending?'保存中…':relativeTime(d.at))+'</time></p>').join('')+(deletions.length>3?'<button type="button" class="linkbtn" data-act="pk-deletions-all" data-id="'+esc(row.id)+'" aria-expanded="'+state.auditExpanded+'">'+(state.auditExpanded?'收起删除记录':'看全部 '+deletions.length+' 条删除记录')+'</button>':'');
 return '<section class="pk-responses" aria-label="回应与留言">'+tags+text+audit+(replies.length>3?'<button type="button" class="linkbtn" data-act="pk-replies-all" data-id="'+esc(row.id)+'" aria-expanded="'+state.expanded+'">'+(state.expanded?'收起':'看全部 '+replies.length+' 句')+'</button>':'')+'</section>';
}
export function panelHTML(row,actor,state,controller){
 if(!state.open)return '';const selected=row.reactions?.[actor.id]?.marks||[],uncertain=controller.uncertain(row.id),id=esc(row.id),pending=controller.pending(row.id);
 return '<section class="pk-response-panel" id="pk-response-'+id+'" aria-label="对这部剧回应"><p class="pk-response-hint">点一下表示，再点一下取消</p><div class="pk-response-marks">'+MARKS.map(m=>'<button type="button" class="pk-response-mark" data-act="pk-react" data-id="'+id+'" data-v="'+esc(m)+'" aria-pressed="'+selected.includes(m)+'"'+(uncertain?' disabled':'')+'>'+esc(m)+'</button>').join('')+'</div><form class="pk-response-form" data-pick="'+id+'"><label class="sr-only" for="pk-reply-'+id+'">说一句，最多 60 字</label><input id="pk-reply-'+id+'" class="pk-reply-input" data-pick="'+id+'" value="'+esc(state.draft)+'" placeholder="说一句……" autocomplete="off" aria-describedby="pk-count-'+id+'"><button type="submit" class="pk-reply-send"'+(pending||uncertain?' disabled':'')+'>发出</button><small id="pk-count-'+id+'" class="pk-reply-count">'+charCount(state.draft.trim())+'/60</small></form>'+(uncertain?'<p class="pk-response-error" role="status">没存上，请再试一次。结果尚未确认。<button type="button" class="linkbtn" data-act="pk-response-retry" data-id="'+id+'">核对并重试</button></p>':'')+'</section>';
}
export function captureResponseFocus(doc){const el=doc.activeElement;if(!el?.closest?.('#pkList'))return null;return{input:el.classList.contains('pk-reply-input'),id:el.dataset.pick||el.dataset.id,act:el.dataset.act,value:el.dataset.v,reply:el.dataset.reply,start:el.selectionStart,end:el.selectionEnd};}
export function restoreResponseFocus(doc,focus){if(!focus)return;const el=[...doc.querySelectorAll('#pkList [data-pick],#pkList button[data-act]')].find(el=>focus.input?el.classList.contains('pk-reply-input')&&el.dataset.pick===focus.id:el.dataset.id===focus.id&&el.dataset.act===focus.act&&el.dataset.v===focus.value&&el.dataset.reply===focus.reply);if(!el||el.disabled)return;el.focus({preventScroll:true});if(focus.input&&focus.start!=null)el.setSelectionRange(focus.start,focus.end);}
