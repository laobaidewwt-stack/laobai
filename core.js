export const STATUSES = ['待看','想做','不做','翻译中','已翻完','已上传','已发微博'];
export const AIRING = ['','未开播','未完结','已完结'];
export const OFFICIAL = ['','还没出官中','已出官中'];
export const ISSUE_KINDS = ['缺集','字幕有误','画质差','音画不同步','其他'];
export const ISSUE_ACTIONS = ['补齐','汰换','修正','待定'];
export const FIELD_KEYS = ['zh','en','link','genre','duration','note','status','airing','official','epsDone','epsTotal','issues','pubLink','watchDate'];
export function escapeHTML(v) { return String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function safeURL(value) {
  if (!value) return '';
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
export function dateKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0,4)<'1900' || value.slice(0,4)>'2100') return false;
  const d = new Date(`${value}T12:00:00`); return !Number.isNaN(d.getTime()) && dateKey(d)===value;
}
export function monthDays(month) {
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error('日期无效');
  const first=new Date(`${month}-01T12:00:00`), offset=(first.getDay()+6)%7;
  const start=new Date(first);start.setDate(1-offset);
  return Array.from({length:42},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return {date:dateKey(d),inMonth:dateKey(d).startsWith(month),day:d.getDate()};});
}
export function shiftMonth(month,delta) { const d=new Date(`${month}-01T12:00:00`); d.setMonth(d.getMonth()+delta);return dateKey(d).slice(0,7); }
export function defaults() { return {zh:'',en:'',link:'',genre:'',duration:'',note:'',status:'待看',airing:'',official:'',epsDone:0,epsTotal:0,issues:[],pubLink:'',watchDate:null}; }
export function editable(row={}) { row=row||{}; const d=defaults(); for(const k of FIELD_KEYS) if(Object.hasOwn(row,k))d[k]=structuredClone(row[k]); return d; }
export function patchBetween(before,after) { return Object.fromEntries(FIELD_KEYS.filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k])).map(k=>[k,after[k]])); }
export function validateDraft(d) {
  if(typeof d.duration!=='string'||d.duration.length>80)throw new Error('时长请用 80 字以内的文字，例如每集 20 分钟');
  if (!d.zh.trim()) throw new Error('请写上剧名');
  for(const k of ['link','pubLink']) if(d[k]&&!safeURL(d[k]))throw new Error('链接只能使用 http:// 或 https://，不能包含账号密码');
  if(d.watchDate&&!validDate(d.watchDate))throw new Error('请选择有效日期');
  if(!STATUSES.includes(d.status))throw new Error('状态无效');
  for(const k of ['epsDone','epsTotal'])if(!Number.isInteger(d[k])||d[k]<0||d[k]>10000)throw new Error('集数需要是 0 到 10000 的整数');
  if(d.epsTotal&&d.epsDone>d.epsTotal)throw new Error('已完成集数不能超过总集数');
  return d;
}
export class RowStore {
  constructor(){this.rows=new Map();}
  apply(rows){for(const r of rows){if(!r||typeof r.id!=='string'||!Number.isSafeInteger(r.revision)||r.revision<1)throw new Error('服务器返回了无效版本');const old=this.rows.get(r.id);if(!old||r.revision>old.revision)this.rows.set(r.id,structuredClone(r));}}
  live(){return [...this.rows.values()].filter(r=>!r.deleted);}
  clear(){this.rows.clear();}
}
export class ApiError extends Error { constructor(code,message,status){super(message);this.code=code;this.status=status;} }
// Reuses the existing full-access ledger key. Actor labels do not authenticate people.
export class OwnerKeyPicksClient {
  constructor(getCloud,getActor,fetcher=globalThis.fetch.bind(globalThis)){this.getCloud=getCloud;this.getActor=getActor;this.fetcher=fetcher;this.epoch=0;this.active=new Set();}
  clear(){this.epoch++;for(const c of this.active)c.abort();this.active.clear();}
  async rpc(name,args={}){
    if(!/^ledger_picks_(list|create|update|claim|delete)$/.test(name))throw new Error('不允许访问此剧单接口');
    const cloud=this.getCloud(),key=cloud.key,epoch=this.epoch;if(!key)throw new ApiError('bad_key','请先输入原账本钥匙');
    const actor=this.getActor();if(name!=='ledger_picks_list'&&(!actor.id||!actor.name))throw new ApiError('actor_required','先写一个协作署名');
    const controller=new AbortController();this.active.add(controller);const timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const body={...args,p_key:key,...(name==='ledger_picks_list'?{}:{p_actor_id:actor.id,p_actor_name:actor.name})};
      const r=await this.fetcher(cloud.url+'/rest/v1/rpc/'+name,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json',apikey:cloud.anon},body:JSON.stringify(body)});
      let result;try{result=await r.json()}catch{throw new ApiError('response','服务器响应无法读取')}
      if(!r.ok)throw new ApiError(/bad key/i.test(result.message||'')?'bad_key':result.code||String(r.status),result.message||'请求失败',r.status);
      if(epoch!==this.epoch||key!==this.getCloud().key)throw new ApiError('cancelled','钥匙已变化，本次响应不再使用');
      return result;
    }finally{clearTimeout(timeout);this.active.delete(controller)}
  }
}
