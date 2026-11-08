/* Page-only activity. Shares the push event log; never asks for notification permission.
 * Actor IDs are device collaboration labels under a shared key, not authenticated people.
 * Only the numeric acknowledgment cursor is persisted. Event contents remain in memory.
 */
export const SEEN_KEY='ledger_feed_seen_id';
export function eventId(value) {
 const text=String(value??'');
 if(!/^(0|[1-9][0-9]*)$/.test(text)||text.length>19||BigInt(text)>9223372036854775807n)throw new Error('INVALID_EVENT_ID');
 return text;
}
const compare=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export function relativeTime(value,now=Date.now()) {
 const at=Date.parse(value);if(!Number.isFinite(at))return '';
 const minutes=Math.floor(Math.max(0,now-at)/60000);
 if(minutes<1)return '刚刚';
 if(minutes<60)return `${minutes} 分钟前`;
 if(minutes<1440)return `${Math.floor(minutes/60)} 小时前`;
 const d=new Date(at);return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
}
function readSeen(storage){try{const value=storage?.getItem(SEEN_KEY);return value==null?null:eventId(value)}catch{return null}}
function safeEvent(item){
 const id=eventId(item.id);
 if(typeof item.actorId!=='string'||typeof item.actorName!=='string'||typeof item.text!=='string'||!Number.isFinite(Date.parse(item.createdAt)))throw new Error('INVALID_EVENT');
 return {...item,id,actorName:item.actorName.slice(0,80),text:item.text.slice(0,1500)};
}
/** Pure state machine, injected RPC/view/storage make full boundary tests deterministic. */
export function createActivityFeed({request,getActor,storage,view,onError=()=>{},onUnreadChange=()=>{}}) {
 let epoch=0,connected=false,seen=null,fetched=null,pending=[],shown=null,running=null,again=false,storageWarned=false,foregroundReady=false,suspendedMode=null,needsRefresh=true,openRequested=false,loaded=false,snapshotVersion=0,lastUnreadState=null;
 // The header shares this complete snapshot, never a second polling/count source.
 const unreadState=()=>({connected,loaded,unread:pending.length});
 function publishUnread(){const state=unreadState(),key=JSON.stringify(state);if(key===lastUnreadState)return;lastUnreadState=key;onUnreadChange(state)}
 const writeSeen=id=>{
  // A sibling tab may have acknowledged a newer snapshot before its storage event arrives.
  const persisted=readSeen(storage);
  if(persisted!==null&&compare(persisted,id)>0)id=persisted;
  if(seen!==null&&compare(id,seen)<0)return;
  seen=id;try{storage?.setItem(SEEN_KEY,id)}catch{if(!storageWarned){storageWarned=true;onError(new Error('STORAGE_UNAVAILABLE'))}}
 };
 function reconcileStorage(){
  const persisted=readSeen(storage);
  if(persisted!==null&&seen!==null&&compare(persisted,seen)>0){seen=persisted;pending=pending.filter(e=>compare(e.id,seen)>0);if(shown&&compare(shown.through,seen)<=0){shown=null;view.hide()}}
  if(seen!==null&&fetched!==null&&compare(seen,fetched)>0)fetched=seen;
  publishUnread();
 }
 function maybeShow(){
  if(!connected||view.blocked()||needsRefresh)return;
  reconcileStorage();
  if((shown&&shown.mode!=='inbox'&&!openRequested)||fetched===null)return;
  if(openRequested&&shown){shown=null;view.hide()}
  pending=pending.filter(e=>compare(e.id,seen)>0&&e.actorId!==getActor().id);publishUnread();
  if(!pending.length){if(shown){shown=null;view.hide()}openRequested=false;writeSeen(fetched);foregroundReady=true;return}
  const items=[...pending].sort((a,b)=>-compare(a.id,b.id));
  let mode=openRequested?'modal':shown?.mode==='inbox'?'inbox':suspendedMode||(foregroundReady?'banner':'modal');
  // The page UI offers a persistent entry instead of opening a comeback dialog.
  if(mode==='modal'&&view.deferModal&&!openRequested)mode='inbox';
  openRequested=false;suspendedMode=null;
  // A banner shows one complete event. Never acknowledge unseen queued banners.
  const visible=mode==='banner'?[items[items.length-1]]:items;
  shown={mode,through:mode==='banner'?visible[0].id:fetched,items:visible,count:visible.length};
  const snapshot=shown;foregroundReady=true;
  view.show({mode,items:visible.slice(0,12),count:visible.length,older:Math.max(0,visible.length-12)},go=>{if(shown===snapshot)acknowledge(go)});
 }
 function acknowledge(go=false){
  if(!shown||shown.mode==='inbox')return;
  if(view.blocked()){needsRefresh=true;suspendedMode=suspendedMode||shown.mode;shown=null;view.hide();return}
  const through=shown.through;shown=null;writeSeen(through);pending=pending.filter(e=>compare(e.id,seen)>0);publishUnread();view.hide();
  if(go)view.go();
  // A newer batch must not be swallowed by the previous popup's acknowledgment.
  needsRefresh=true;queueMicrotask(()=>{void sync()});
 }
 async function collect(e){
  if(seen===null){const data=await request('events_head');if(e!==epoch)return;const head=eventId(data.latestId);writeSeen(head);fetched=head;foregroundReady=!view.blocked();needsRefresh=view.blocked();loaded=true;snapshotVersion++;publishUnread();return}
  reconcileStorage();
  // Re-read the unacknowledged interval: deleted replies redact existing event IDs.
  let cursor=seen,through=null,batch=[];
  for(;;){
   const data=await request('events_since',{after:cursor,...(through!==null?{through}:{})});if(e!==epoch)return;
   const latest=eventId(data.latestId);
   if(through!==null&&latest!==through)throw new Error('CHANGED_EVENT_SNAPSHOT');
   if(compare(latest,cursor)<0)throw new Error('EVENT_CURSOR_AHEAD');
   through=latest;
   if(!Array.isArray(data.items)||data.items.length>50||typeof data.hasMore!=='boolean')throw new Error('INVALID_EVENT_PAGE');
   const items=data.items.map(safeEvent);
   for(const item of items){if(compare(item.id,cursor)<=0||compare(item.id,through)>0)throw new Error('UNORDERED_EVENT_PAGE');cursor=item.id;batch.push(item)}
   if(!data.hasMore)break;
   if(!items.length)throw new Error('NON_ADVANCING_EVENT_PAGE');
  }
  if(e!==epoch)return;
  // Commit the complete snapshot only. A failed later page leaves no holes on retry.
  fetched=through;
  const byId=new Map();
  for(const item of batch)if(compare(item.id,seen)>0&&item.actorId!==getActor().id)byId.set(item.id,item);
  pending=[...byId.values()];loaded=true;snapshotVersion++;publishUnread();needsRefresh=view.blocked();maybeShow();
  if(!view.blocked()&&!pending.length&&!shown)suspendedMode=null;
 }
 function sync(){
  if(!connected)return Promise.resolve();
  if(running){again=true;return running}
  const e=epoch;
  const task=(async()=>{do{again=false;try{await collect(e)}catch(error){if(e===epoch){openRequested=false;onError(error)}}if(e!==epoch)break}while(again&&connected)})();
  running=task;
  void task.finally(()=>{if(running===task)running=null});return task;
 }
 return {
  connect(){if(connected)return running||Promise.resolve();connected=true;epoch++;foregroundReady=false;suspendedMode=null;needsRefresh=true;openRequested=false;seen=readSeen(storage)??'0';fetched=seen;loaded=false;publishUnread();return sync()},
  sync,
  away(){foregroundReady=false;suspendedMode='modal';needsRefresh=true;openRequested=false;},
  reconsider(){reconcileStorage();if(view.blocked()){openRequested=false;needsRefresh=true;if(shown){suspendedMode=suspendedMode||shown.mode;shown=null;view.hide()}return}if(needsRefresh)return running||sync();maybeShow()},
  // Explicit header entry also works while a single foreground banner is visible.
  async open(){
   if(!connected||view.blocked())return{...unreadState(),refreshed:false};
   const before=snapshotVersion,e=epoch;openRequested=true;needsRefresh=true;await sync();
   return{...unreadState(),refreshed:e===epoch&&snapshotVersion>before};
  },
  openInbox(){if(!connected||view.blocked()||shown?.mode!=='inbox')return Promise.resolve();openRequested=true;needsRefresh=true;return sync()},
  acknowledge,
  clear(){epoch++;connected=false;seen=null;fetched=null;pending=[];shown=null;running=null;again=false;needsRefresh=true;openRequested=false;loaded=false;view.hide();publishUnread()},
  // Numeric cursors only: useful for deterministic tests without exporting private events.
  state(){return{...unreadState(),seen,fetched,pending:pending.length,shown:shown?.count||0}}
 };
}
export function createActivityUI(getCloud,getActor,{fetcher=globalThis.fetch.bind(globalThis),document:doc=globalThis.document,window:win=globalThis,onError=()=>{},onUnreadChange=()=>{}}={}) {
 let initialized=false,overlay,card,list,title,older,storage,restoreFocus=null,oldOverflow=null,observer,inbox,inboxLabel=null,banner,bannerText,bannerAck=null,bannerTimer=null;
 try{storage=win.localStorage}catch{}
 const make=(tag,className,text)=>{const el=doc.createElement(tag);if(className)el.className=className;if(text)el.textContent=text;return el};
 function otherModal(){return [...doc.querySelectorAll('.ov,dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"]')].some(el=>el!==overlay&&!el.hidden&&el.getAttribute('aria-hidden')!=='true'&&el.getClientRects().length>0)}
 const blocked=()=>doc.hidden||otherModal();
 const hide=()=>{
  if(bannerTimer!==null){win.clearTimeout(bannerTimer);bannerTimer=null}
  if(banner)banner.hidden=true;if(inbox)inbox.hidden=true;bannerAck=null;
  if(!overlay?.hasAttribute('open'))return;
  if(typeof overlay.close==='function')overlay.close();else overlay.removeAttribute('open');
  overlay.hidden=true;
  if(oldOverflow!==null){doc.body.style.overflow=oldOverflow;oldOverflow=null}
  if(!otherModal()&&restoreFocus?.isConnected)restoreFocus.focus({preventScroll:true});restoreFocus=null;
 };
 const view={blocked,hide,deferModal:true,go(){win.location.hash='picks'},show(data,ack){
  if(!initialized||blocked())return;
  if(data.mode==='inbox'){
   const label=`新动静 ${data.count}`;if(inboxLabel!==label){inboxLabel=label;inbox.textContent=label;}
   if(inbox.hidden)inbox.hidden=false;return;
  }
  if(inbox&&!inbox.hidden)inbox.hidden=true;
  if(data.mode==='banner'){
   const item=data.items[0];bannerText.replaceChildren(make('strong','',item.actorName||'对方'),doc.createTextNode('　'+item.text));
   bannerAck=ack;banner.hidden=false;
   // Visibility and blocking are checked again by the feed at acknowledgment time.
   bannerTimer=win.setTimeout(()=>{bannerTimer=null;ack()},7000);return;
  }
  title.textContent=`有 ${data.count} 条新动静`;list.replaceChildren();
  for(const item of data.items){const li=make('li'),text=make('div','pk-feed-text'),name=make('strong','',item.actorName||'对方'),detail=make('span','',item.text),time=make('time','',relativeTime(item.createdAt));time.dateTime=item.createdAt;time.title=new Date(item.createdAt).toLocaleString('zh-CN');text.append(name,doc.createTextNode('　'),detail);li.append(text,time);list.append(li)}
  older.hidden=!data.older;older.textContent=data.older?`还有更早的 ${data.older} 条`:'';
  restoreFocus=doc.activeElement;oldOverflow=doc.body.style.overflow;doc.body.style.overflow='hidden';overlay.hidden=false;
  if(typeof overlay.showModal==='function')overlay.showModal();else overlay.setAttribute('open','');
  card.querySelector('button').focus({preventScroll:true});
  try{win.navigator.vibrate?.(30)}catch{}
 }};
 async function request(op,payload={}){
  const cloud=getCloud(),key=cloud.key;if(!key)throw new Error('CANCELLED');
  const controller=new AbortController(),timer=win.setTimeout(()=>controller.abort(),15000);
  try{const response=await fetcher(cloud.url+'/rest/v1/rpc/ledger_picks_notice',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'Content-Type':'application/json',apikey:cloud.anon},body:JSON.stringify({p_key:key,p_op:op,p_payload:payload})});const data=await response.json();if(getCloud().key!==key)throw new Error('CANCELLED');if(!response.ok)throw new Error(data.message||'EVENTS_UNAVAILABLE');return data}finally{win.clearTimeout(timer)}
 }
 const feed=createActivityFeed({request,getActor,storage,view,onError,onUnreadChange});
 function init(){
  if(initialized)return;initialized=true;
  inbox=make('button','pk-feed-inbox');inbox.id='pkFeedInbox';inbox.type='button';inbox.hidden=true;inbox.setAttribute('aria-haspopup','dialog');inbox.setAttribute('aria-controls','pkFeedDialog');inbox.addEventListener('click',()=>{void feed.openInbox()});
  const pageHeader=doc.querySelector('.app > header,body > header');if(pageHeader)pageHeader.after(inbox);else doc.body.prepend(inbox);
  banner=make('aside','pk-feed-banner');banner.id='pkFeedBanner';banner.hidden=true;banner.setAttribute('aria-label','剧单新动静');
  bannerText=make('div','pk-feed-banner-text');bannerText.setAttribute('role','status');bannerText.setAttribute('aria-live','polite');bannerText.setAttribute('aria-atomic','true');
  const bannerClose=make('button','pk-feed-banner-close','×');bannerClose.type='button';bannerClose.setAttribute('aria-label','关闭新动静');bannerClose.addEventListener('click',()=>bannerAck?.());banner.append(bannerText,bannerClose);doc.body.append(banner);
  overlay=make('dialog','pk-feed-overlay');overlay.id='pkFeedDialog';overlay.hidden=true;overlay.setAttribute('aria-labelledby','pkFeedTitle');overlay.setAttribute('aria-modal','true');overlay.setAttribute('role','dialog');if(typeof overlay.showModal!=='function')overlay.setAttribute('data-fallback','');
  card=make('section','pk-feed-card paper');const label=make('p','pk-feed-label','Shared Picks · While You Were Away');title=make('h2','pk-feed-title');title.id='pkFeedTitle';list=make('ol','pk-feed-list');older=make('p','pk-feed-older');older.hidden=true;
  const actions=make('div','pk-feed-actions'),dismiss=make('button','btn ghost','知道了'),visit=make('button','btn','去剧单看看');dismiss.type=visit.type='button';dismiss.addEventListener('click',()=>feed.acknowledge());visit.addEventListener('click',()=>feed.acknowledge(true));actions.append(dismiss,visit);card.append(label,title,list,older,actions);overlay.append(card);doc.body.append(overlay);
  overlay.addEventListener('click',e=>{if(e.target===overlay)feed.acknowledge()});overlay.addEventListener('cancel',e=>{e.preventDefault();feed.acknowledge()});
  overlay.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();feed.acknowledge()}else if(e.key==='Tab'){const first=dismiss,last=visit;if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus()}}});
  doc.addEventListener('visibilitychange',()=>{if(doc.hidden)feed.away();feed.reconsider();if(!doc.hidden)void feed.sync()});
  win.addEventListener('storage',e=>{if(e.key===SEEN_KEY||e.key===null)feed.reconsider()});
  win.navigator.serviceWorker?.addEventListener('message',e=>{if(e.data?.type==='LAOBAI_PICK_ACTIVITY')void feed.sync()});
  let scheduled=false;observer=new win.MutationObserver(()=>{if(scheduled)return;scheduled=true;win.queueMicrotask(()=>{scheduled=false;feed.reconsider()})});
  observer.observe(doc.body,{subtree:true,attributes:true,attributeFilter:['hidden','open','aria-hidden','class'],childList:true});
 }
 return{init,connect(){init();return feed.connect()},sync:feed.sync,clear:feed.clear,open:feed.open,state(){const {connected,loaded,unread}=feed.state();return{connected,loaded,unread}}};
}

