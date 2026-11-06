/* Opt-in per browser/device. No automatic permission prompt, no key in storage/URLs. */
export function supportMessage(env=globalThis) {
 const nav=env.navigator,ios=/iPad|iPhone|iPod/.test(nav.userAgent)||(nav.platform==='MacIntel'&&nav.maxTouchPoints>1);
 if(!env.isSecureContext)return '通知需要通过 HTTPS 打开。';
 if(ios&&!env.matchMedia('(display-mode: standalone)').matches&&nav.standalone!==true)return 'iPhone 请先添加到主屏幕，再从「老白笔记」图标打开（需 iOS 16.4 或更新版本）。';
 if(!('Notification'in env)||!('PushManager'in env)||!('serviceWorker'in nav))return '当前浏览器不支持系统推送；页面更新记录仍可查看。';
 if(env.Notification.permission==='denied')return '系统通知已被拒绝，请到设备的通知设置中允许「老白笔记」，再回来刷新。';
 return '';
}
export function applicationKey(text) {
 const bytes=Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
 if(bytes.length!==65||bytes[0]!==4)throw new Error('PUSH_NOT_CONFIGURED');return bytes;
}
export function changeText(item) {
 const labels={created:'新增',status:'状态变化',claim:'认领变化',deleted:'从剧单删除',updated:'更新',progress:'进度更新',issue_done:'问题已处理'};
 const fields={zh:'剧名',en:'英文名',epsDone:'进度',epsTotal:'集数',issues:'问题',watchDate:'追剧日期',duration:'时长',note:'备注',claim:'认领',airing:'播出状态',official:'官中状态',pubLink:'发布链接',link:'链接',genre:'类型',status:'状态'};
 const detail=(item.fields||[]).map(f=>fields[f]).filter(Boolean).join('、');
 return `${labels[item.kind]||'更新'}${detail&&item.kind==='updated'?' · '+detail:''} · ${item.status}`;
}
const bounded=(promise,ms=12000)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('TIMEOUT')),ms)})]).finally(()=>clearTimeout(timer))};
async function pushWorker(reg) {
 if(!reg.active)throw new Error('WORKER_UPDATE');
 const channel=new MessageChannel();
 try{return await bounded(new Promise((resolve,reject)=>{channel.port1.onmessage=e=>e.data?.pushVersion===1?resolve(reg):reject(new Error('WORKER_UPDATE'));reg.active.postMessage({type:'LAOBAI_PUSH_VERSION'},[channel.port2])}),1500)}
 catch{throw new Error('WORKER_UPDATE')}finally{channel.port1.close();channel.port2.close()}
}
export function createNoticeUI(getCloud,getActor,{fetcher=globalThis.fetch.bind(globalThis)}={}) {
 let epoch=0,connected=false,busy=false,refreshing=false,config=null,registration=null,subscribed=false,rows=[],cursor=null,more=true,ready=false;
 const $=id=>document.getElementById(id),message=text=>{$('pkPushStatus').textContent=text};
 function paint(){
  $('pkPushEntry').hidden=!connected;
  $('pkPushEnable').hidden=subscribed;$('pkPushDisable').hidden=!subscribed;$('pkPushTest').hidden=!subscribed;
  $('pkPushEnable').disabled=busy||!ready||!!supportMessage()||!config?.enabled;
  $('pkPushDisable').disabled=busy;$('pkPushTest').disabled=busy||!ready;
  $('pkChangesMore').hidden=!more;$('pkChangesMore').disabled=refreshing;
 }
 async function rpc(op,payload={}) {
  const e=epoch,cloud=getCloud(),key=cloud.key;if(!connected||!key)throw new Error('CANCELLED');
  const r=await fetcher(cloud.url+'/rest/v1/rpc/ledger_picks_notice',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',apikey:cloud.anon},body:JSON.stringify({p_key:key,p_op:op,p_payload:payload})});
  const data=await r.json();if(e!==epoch||key!==getCloud().key)throw new Error('CANCELLED');
  if(!r.ok)throw new Error(data.message||'REQUEST_FAILED');return data;
 }
 function explain(error) {
  const m=error?.message||'';
  if(m==='CANCELLED')return;
  if(m==='WORKER_UPDATE')message('通知功能已更新。请关闭所有「老白笔记」页面，再从主屏幕重新打开。');
  else if(/PUSH_NOT_CONFIGURED/.test(m))message('后台推送尚未启用；更新记录可先使用。');
  else if(/TEST_COOLDOWN/.test(m))message('测试已排队，请等一分钟后再试。');
  else if(/permission|denied|NotAllowed/i.test(m))message('未获得通知许可。可以在系统设置中允许后重试。');
  else if(/23505|unique/.test(m))message('此设备已有订阅，请关闭通知后重新开启。');
  else message('这次未确认成功，请刷新核对后再试。剧单保存不受影响。');
 }
 function renderChanges(){
  const list=$('pkChangesList');list.replaceChildren();
  for(const item of rows){const li=document.createElement('li'),title=document.createElement('strong'),detail=document.createElement('span'),time=document.createElement('time');
   title.textContent=item.title;detail.textContent=changeText(item);time.dateTime=item.createdAt;time.textContent=new Date(item.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+(item.actor?' · '+item.actor:'');
   li.append(title,detail,time);list.append(li);
  }
  $('pkChangesEmpty').hidden=rows.length>0;
 }
 async function changes(append=false){
  if(!connected||refreshing)return;const e=epoch;refreshing=true;paint();
  try{const data=await rpc('changes',{limit:20,...(append&&cursor?{before:cursor}:{})});if(e!==epoch)return;
   rows=append?[...rows,...data]:data;cursor=rows.at(-1)?.id;more=data.length===20;renderChanges();$('pkChangesNote').textContent='记录启用后的变化；署名仅作协作标记。';
  }catch(error){if(e===epoch&&error.message!=='CANCELLED')$('pkChangesNote').textContent='更新记录暂时未能读取，稍后刷新即可。'}finally{if(e===epoch){refreshing=false;paint()}}
 }
 async function refresh(){
  if(!connected||busy)return;const e=epoch;ready=false;paint();
  try{
   config=await rpc('config');const state=await rpc('status',{deviceId:getActor().id});if(e!==epoch)return;subscribed=state.subscribed;
   const issue=supportMessage();if(issue){message(issue);return}
   if(!config.enabled){message('后台推送尚未启用；更新记录可先使用。');return}
   registration=await pushWorker(await bounded(navigator.serviceWorker.ready));if(e!==epoch)return;ready=true;
   const local=await registration.pushManager.getSubscription();if(e!==epoch)return;
   if(subscribed&&!local){subscribed=false;message('此设备的系统订阅已失效，请重新开启。')}
   else message(subscribed?'已开通系统通知。关闭网页后仍可接收，每分钟最多一条合并提醒。':'只在这台设备开启，另一台设备不会自动订阅。');
  }catch(error){if(e===epoch)explain(error)}finally{if(e===epoch)paint()}
 }
 function enable(){
  if(busy||!ready||!config?.enabled||supportMessage())return;const e=epoch;
  busy=true;paint();message('等待系统通知许可…');
  // Must be invoked synchronously inside this click, before any await (iOS requirement).
  const permission=Notification.permission==='granted'?Promise.resolve('granted'):Notification.requestPermission();
  void (async()=>{let created=null;
   try{if(await permission!=='granted')throw new Error('permission denied');if(e!==epoch)return;
    let sub=await registration.pushManager.getSubscription();if(e!==epoch)return;
    if(sub?.options?.applicationServerKey){const old=new Uint8Array(sub.options.applicationServerKey),next=applicationKey(config.publicKey);if(old.length!==next.length||old.some((v,i)=>v!==next[i])){await sub.unsubscribe();sub=null}}
    if(!sub){sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(config.publicKey)});created=sub}
    if(e!==epoch){if(created)await created.unsubscribe();return}
    await rpc('subscribe',{deviceId:getActor().id,actorId:getActor().id,subscription:sub.toJSON()});if(e!==epoch)return;
    subscribed=true;message('此设备已开启。可点「发送测试通知」，确认锁屏弹窗是否收到。');
   }catch(error){if(e===epoch)explain(error)}finally{if(e===epoch){busy=false;paint()}}
  })();
 }
 async function disable(){
  if(busy)return;const e=epoch;busy=true;paint();
  try{
   // Server first: confirmed removal stops future deliveries even if local API fails.
   await rpc('unsubscribe',{deviceId:getActor().id});if(e!==epoch)return;subscribed=false;
   let localRemoved=true;try{const reg=registration||await bounded(navigator.serviceWorker.ready);const sub=await reg.pushManager.getSubscription();if(sub)localRemoved=await sub.unsubscribe()}catch{localRemoved=false}
   if(e===epoch)message(localRemoved?'已关闭此设备的剧单通知。':'后台订阅已移除。设备清理未完成，可在系统通知设置中关闭。');
  }catch(error){if(e===epoch)explain(error)}finally{if(e===epoch){busy=false;paint()}}
 }
 async function test(){if(busy||!subscribed)return;const e=epoch;busy=true;paint();try{await rpc('test',{deviceId:getActor().id});if(e===epoch)message('测试已排队，通常一分钟左右送出。这里不能确认系统是否展示，请检查通知中心。')}catch(error){if(e===epoch)explain(error)}finally{if(e===epoch){busy=false;paint()}}}
 return {
  init(){ $('pkPushEntry').addEventListener('click',()=>{if(!$('pkNoticePanel').open){$('pkNoticePanel').showModal();void refresh()}});$('pkPushClose').addEventListener('click',()=>{$('pkNoticePanel').close();$('pkPushEntry').focus()});$('pkNoticePanel').addEventListener('click',e=>{if(e.target===$('pkNoticePanel')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});$('pkPushEnable').addEventListener('click',enable);$('pkPushDisable').addEventListener('click',disable);$('pkPushTest').addEventListener('click',test);$('pkChangesRefresh').addEventListener('click',()=>{void changes();void refresh()});$('pkChangesMore').addEventListener('click',()=>void changes(true));document.addEventListener('visibilitychange',()=>{if(!document.hidden&&connected){void refresh();void changes()}});paint(); },
  connect(){if(connected)return;connected=true;epoch++;void refresh();void changes();paint()},
  sync(){void changes()},
  clear(){if($('pkNoticePanel').open)$('pkNoticePanel').close();epoch++;connected=false;busy=false;refreshing=false;config=null;registration=null;subscribed=false;ready=false;rows=[];cursor=null;more=true;renderChanges();message('');paint()}
 };
}
