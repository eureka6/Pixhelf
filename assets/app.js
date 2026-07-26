const gallery=document.querySelector('#gallery'),sentinel=document.querySelector('#sentinel'),empty=document.querySelector('#empty');

const dialog=document.querySelector('#lightbox'),hero=dialog.querySelector('.stage'),preview=hero.querySelector('.preview'),photo=hero.querySelector('.original'),viewerFailure=hero.querySelector('.viewer-load-failure'),download=dialog.querySelector('.download'),infoButton=dialog.querySelector('.info'),detailsPanel=dialog.querySelector('.details-panel'),copyNameButton=detailsPanel.querySelector('.detail-copy'),viewerMenu=dialog.querySelector('.viewer-action-menu'),viewerMore=dialog.querySelector('.viewer-more'),viewerCount=dialog.querySelector('.viewer-count');

let rows=[],cursor=null,loading=false,loadTask=null,resetTask=null,loadController=null,listRevision=0,listSettled=false,waterfallTask=null,waterfallPending=false,viewerQueueTask=null,waterfallRetryTimer=0,waterfallRetryDelay=500,done=false,query='',folder='',active=-1,timer,randomMode=false,randomSeed=1,ready=false,scanning=false,needsReconcile=false;

let scale=1,tx=0,ty=0,switching=false,closing=false,lastTap=0,zoomStep=0,gesture=null,closeTimer,copyNameTimer=0,copyNameRequest=0,openToken=0,navigationToken=0,activeId=null,dismissProgress=0;

const pointers=new Map();

const DOUBLE_TAP_MS=300;

const PAGE_SIZE=48,WATERFALL_MARGIN=1200,DIRECTIONAL_PREFETCH=3,INITIAL_REVERSE_PREFETCH=2,decodedCache=new Map(),DECODE_BUDGET=matchMedia('(max-width:650px)').matches?96*1024*1024:256*1024*1024;

const human=n=>{const u=['B','KB','MB','GB','TB'];
let i=0;
while(n>=1024&&i<u.length-1){n/=1024;
i++}return `${n.toFixed(i?1:0)} ${u[i]}`};
const formatOf=x=>{const raw=(x.mime||'').split('/').at(-1)?.split('+')[0].toUpperCase();
return raw==='JPEG'?'JPG':raw||'IMAGE'};
function updateEmpty(){const showScanning=ready&&scanning&&rows.length===0,showEmpty=ready&&listSettled&&!scanning&&rows.length===0;
empty.hidden=!(showScanning||showEmpty);
const title=empty.querySelector('b'),detail=empty.querySelector('span');
if(scanning){title.textContent='正在建立图片索引';
detail.textContent='首批图片准备好后会自动显示。'}else{title.textContent='这里还没有图片';
detail.textContent='把图片放入 pictures 目录，然后点击右上角刷新。'}}
function setOriginalReady(ready){viewerMore.classList.toggle('original-ready',ready);
updateViewerMoreTitle();
viewerMore.setAttribute('aria-label',viewerMore.title)}
function setViewerLoading(loading){hero.classList.toggle('awaiting-image',loading);
if(loading)hero.setAttribute('aria-busy','true');
else hero.removeAttribute('aria-busy')}
function setViewerFailure(failed){viewerFailure.hidden=!failed;
hero.classList.toggle('load-failed',failed);
if(failed)setViewerLoading(false)}
function settleViewerSurface(){if(!preview.naturalWidth&&!photo.naturalWidth)return;
setViewerLoading(false);
setViewerFailure(false)}
preview.addEventListener('load',settleViewerSurface);
preview.addEventListener('error',()=>{preview.style.opacity='0'});
photo.addEventListener('load',settleViewerSurface);
photo.addEventListener('error',()=>{photo.style.opacity='0'});
function updateViewerMoreTitle(){const states=[];
if(viewerMore.classList.contains('original-ready'))states.push('原图已加载');
viewerMore.title='更多操作'+(states.length?' · '+states.join(' · '):'');
viewerMore.setAttribute('aria-label',viewerMore.title)}
function reconcileRenderedDimensions(index,image){const x=rows[index];
if(!x||!image?.naturalWidth||!image.naturalHeight)return;
const renderedRatio=image.naturalWidth/image.naturalHeight,currentRatio=x.width/x.height,swappedRatio=x.height/x.width;
if(Math.abs(Math.log(renderedRatio/currentRatio))<.015||Math.abs(Math.log(renderedRatio/swappedRatio))>=.015)return;
[x.width,x.height]=[x.height,x.width];
const card=gallery.children[index];
if(card?.dataset.id===String(x.id)){card.dataset.ratio=x.height/x.width;
card.style.setProperty('--ratio',`${x.width}/${x.height}`);
const meta=card.querySelector('.meta span');
if(meta)meta.textContent=`${x.width} × ${x.height} · ${human(x.bytes)}`;
scheduleLayout(index)}
if(dialog.open&&active===index){updateDetails(x);
if(scale===1)sizeHero(x)}}

function appendCards(from){if(from>=rows.length)return;
const fragment=document.createDocumentFragment(),pendingImages=[];
for(let index=from;index<rows.length;index++){const x=rows[index],card=document.createElement('article');
card.className='card';
card.dataset.id=x.id;
card.dataset.ratio=x.height/x.width;
card.style.setProperty('--ratio',`${x.width}/${x.height}`);
card.tabIndex=0;
card.setAttribute('role','button');
card.setAttribute('aria-label',`打开图片：${x.name}`);
card.innerHTML=`<img loading="lazy" decoding="async" width="${x.width}" height="${x.height}" alt="${escapeHtml(x.name)}"><div class="load-failure" role="status" hidden><span class="load-failure-mark" aria-hidden="true"></span><span>资源不可用</span></div><div class="meta"><div class="meta-copy"><b>${escapeHtml(x.name)}</b><span>${x.width} × ${x.height} · ${human(x.bytes)}</span></div></div>`;
const cardImage=card.querySelector('img'),failure=card.querySelector('.load-failure');
pendingImages.push([card,cardImage,`/thumb/${x.id}?v=${x.thumb_key}`]);
cardImage.onload=()=>{if(card.isConnected&&rows[index]===x)reconcileRenderedDimensions(index,cardImage);
cardImage.hidden=false;
cardImage.classList.add('ready');
card.classList.add('has-image');
card.classList.remove('load-failed');
failure.hidden=true};
cardImage.onerror=()=>{cardImage.removeAttribute('src');
cardImage.hidden=true;
cardImage.classList.remove('ready');
card.classList.remove('has-image');
card.classList.add('load-failed');
failure.hidden=false};
card.onclick=()=>open(index);
card.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();
open(index);
return}
if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();
moveCardFocus(card,e.key)}};
galleryWarmObserver.observe(card);
galleryVisibleObserver.observe(card);
fragment.append(card)}
gallery.append(fragment);
scheduleLayout(from);
requestAnimationFrame(()=>setTimeout(()=>{for(const [card,image,src] of pendingImages){if(!image.isConnected||image.hasAttribute('src'))continue;
image.src=src;
if(visibleGalleryCards.has(card))warmCard(card,'high')}},0))}
function moveCardFocus(card,key){const source=card.getBoundingClientRect(),sx=source.left+source.width/2,sy=source.top+source.height/2,direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[key];
let best=null,bestScore=Infinity;
for(const candidate of gallery.children){if(candidate===card)continue;
const rect=candidate.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,dx=x-sx,dy=y-sy,primary=direction[0]?dx*direction[0]:dy*direction[1];
if(primary<=1)continue;
const cross=Math.abs(direction[0]?dy:dx),score=primary+cross*1.7;
if(score<bestScore){best=candidate;
bestScore=score}}
if(best){best.focus({preventScroll:true});
ensureCardVisible(best)}}
function ensureCardVisible(card){const rect=card.getBoundingClientRect(),headerBottom=document.querySelector('header').getBoundingClientRect().bottom,top=headerBottom+10,bottom=innerHeight-12;
if(rect.top<top||rect.bottom>bottom)card.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'})}
function resetGallery(){cancelDistantPreloads(null);
for(const card of gallery.children){galleryWarmObserver.unobserve(card);
galleryVisibleObserver.unobserve(card)}
visibleGalleryCards.clear();
gallery.replaceChildren();
rows=[];
cursor=null;
done=false;
listSettled=false;
updateEmpty();
if(waterfallRetryTimer){clearTimeout(waterfallRetryTimer);
waterfallRetryTimer=0}
waterfallRetryDelay=500}
function loadPage(revision=listRevision){if(revision!==listRevision||done)return Promise.resolve([]);
if(loading)return loadTask;
loading=true;
const controller=new AbortController();
loadController=controller;
let task;
task=(async()=>{const p=new URLSearchParams({limit:String(PAGE_SIZE)});
if(randomMode){p.set('random','true');
p.set('seed',randomSeed);
p.set('offset',rows.length)}else if(cursor)p.set('cursor',cursor);
if(query)p.set('q',query);
if(folder)p.set('folder',folder);
const response=await fetch('/api/images?'+p,{signal:controller.signal,cache:'no-store'});
if(!response.ok)throw new Error(`HTTP ${response.status}`);
const batch=await response.json();
if(revision!==listRevision)return [];
listSettled=true;
const firstNewCard=rows.length;
rows.push(...batch);
appendCards(firstNewCard);
updateViewerCount();
cursor=batch.at(-1)?.id??cursor;
done=batch.length<PAGE_SIZE;
updateEmpty();
return batch})().catch(error=>{if(error.name==='AbortError'||revision!==listRevision)return [];
throw error}).finally(()=>{if(loadTask===task){loading=false;
loadTask=null}
if(loadController===controller)loadController=null});
loadTask=task;
return loadTask}
function resetAndLoad(){const revision=++listRevision;
loadController?.abort();
const prior=resetTask||loadTask||Promise.resolve([]);
let task;
task=(async()=>{try{await prior}catch{}
if(revision!==listRevision)return [];
resetGallery();
const batch=await loadPage(revision);
if(revision===listRevision&&!dialog.open)requestAnimationFrame(fillWaterfall);
return batch})().finally(()=>{if(resetTask===task)resetTask=null});
resetTask=task;
return task}
function load(reset=false){if(reset)return resetAndLoad();
if(resetTask)return resetTask;
return loadPage()}
const VIEWER_BUFFER=16,VIEWER_LOAD_RETRIES=2;
function extendViewerQueue(index,urgent=false){if(closing||done||(!urgent&&rows.length-index>VIEWER_BUFFER))return Promise.resolve();
if(viewerQueueTask)return viewerQueueTask.then(()=>urgent&&!rows[index]&&!done?extendViewerQueue(index,true):undefined);
viewerQueueTask=(async()=>{let failures=0;
while(!closing&&dialog.open&&!done&&(urgent?!rows[index]:rows.length-index<=VIEWER_BUFFER)){const before=rows.length;
try{await load();
failures=0}catch{if(++failures>=VIEWER_LOAD_RETRIES)break;
await new Promise(resolve=>setTimeout(resolve,300))}
if(rows.length===before&&failures===0)break}})().finally(()=>{viewerQueueTask=null});
return viewerQueueTask}
async function ensureViewerRow(index){if(!rows[index]&&!done)await extendViewerQueue(index,true);
return Boolean(rows[index])}
function retryWaterfall(){if(waterfallRetryTimer||done||dialog.open)return;
const delay=waterfallRetryDelay;
waterfallRetryDelay=Math.min(8000,waterfallRetryDelay*2);
waterfallRetryTimer=setTimeout(()=>{waterfallRetryTimer=0;
fillWaterfall()},delay)}
function nearWaterfallEnd(){return sentinel.getBoundingClientRect().top<=innerHeight+WATERFALL_MARGIN}
async function drainWaterfall(){while(ready&&!done&&!dialog.open&&nearWaterfallEnd()){let batch;
try{batch=await load();
if(waterfallRetryTimer){clearTimeout(waterfallRetryTimer);
waterfallRetryTimer=0}
waterfallRetryDelay=500}catch{waterfallPending=false;
retryWaterfall();
break}
if(!batch.length)break;
await new Promise(resolve=>requestAnimationFrame(resolve))}}
function fillWaterfall(){waterfallPending=true;
if(waterfallTask)return waterfallTask;
waterfallTask=(async()=>{do{waterfallPending=false;
await drainWaterfall()}while(waterfallPending)})().finally(()=>{waterfallTask=null;
if(waterfallPending)queueMicrotask(fillWaterfall)});
return waterfallTask}
let layoutFrame=0,layoutFrom=0,lastCardWidth=0;
function layout(from=0){const cards=gallery.children;
if(!cards.length)return;
const s=getComputedStyle(gallery),row=parseFloat(s.gridAutoRows),gap=parseFloat(s.rowGap),width=cards[0].clientWidth;
// Column width only changes at a breakpoint/resize. Appends therefore touch just
// the new cards instead of forcing reads and writes across the entire gallery.
if(Math.abs(width-lastCardWidth)>.5){from=0;
lastCardWidth=width}
for(let index=from;index<cards.length;index++){const card=cards[index],span=Math.ceil((width*Number(card.dataset.ratio)+gap)/(row+gap));
card.style.gridRowEnd=`span ${span}`}}
function scheduleLayout(from=0){layoutFrom=Math.min(layoutFrom,from);
if(layoutFrame)return;
layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;
const from=layoutFrom;
layoutFrom=gallery.children.length;
layout(from);
if(!dialog.open&&nearWaterfallEnd())queueMicrotask(fillWaterfall)})}
function escapeHtml(s){const d=document.createElement('div');
d.textContent=s;
return d.innerHTML}
function warmCard(card,priority='auto'){const image=card.querySelector('img');
if(!image)return Promise.resolve();
image.loading='eager';
image.fetchPriority=priority;
if(!image.hasAttribute('src'))return Promise.resolve();
if(!image._decodeTask)image._decodeTask=image.decode().catch(()=>{}).then(()=>{if(image.naturalWidth)image.classList.add('ready')}).finally(()=>{image._decodeTask=null});
return image._decodeTask}
const visibleGalleryCards=new Set(),galleryWarmObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)warmCard(entry.target)},{rootMargin:'100% 0px'}),galleryVisibleObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){visibleGalleryCards.add(entry.target);
warmCard(entry.target,'high')}else visibleGalleryCards.delete(entry.target)}});
const folderButton=document.querySelector('#folders'),folderMenu=document.querySelector('#folder-menu'),folderTree=document.querySelector('#folder-tree'),moreButton=document.querySelector('#more'),moreMenu=document.querySelector('#more-menu'),themeButton=document.querySelector('#theme'),themeLabel=themeButton.querySelector('.theme-label'),themeValue=themeButton.querySelector('.menu-value'),themeColor=document.querySelector('meta[name="theme-color"]');
const expandedFolders=new Set();
function closeFolders(){folderMenu.hidden=true;
folderButton.setAttribute('aria-expanded','false')}
function closeMore(){moreMenu.hidden=true;
moreButton.setAttribute('aria-expanded','false')}
function chooseFolder(path){folder=path;
folderButton.title=path||'选择文件夹';
folderButton.setAttribute('aria-label',path?`当前路径：${path}`:'选择文件夹');
closeFolders();
renderFolders(folderTree._paths||[]);
load(true)}
function renderFolders(paths){folderTree._paths=paths;
const scrollTop=folderMenu.scrollTop,parentFolders=new Set(paths.map(path=>path.split('/').slice(0,-1).join('/')).filter(Boolean));
folderTree.replaceChildren();
const all=document.createElement('button');
all.className='folder-item root'+(!folder?' selected':'');
all.textContent='全部图片';
all.setAttribute('role','treeitem');
all.onclick=()=>chooseFolder('');
folderTree.append(all);
for(const path of paths){const parts=path.split('/'),depth=parts.length,ancestors=parts.slice(0,-1).map((_,index)=>parts.slice(0,index+1).join('/')),hasChildren=parentFolders.has(path),row=document.createElement('div'),item=document.createElement('button');
row.className='folder-row';
row.hidden=ancestors.some(ancestor=>!expandedFolders.has(ancestor));
row.style.setProperty('--folder-indent',`${(depth-1)*17}px`);
if(hasChildren){const toggle=document.createElement('button'),expanded=expandedFolders.has(path);
toggle.className='folder-toggle';
toggle.type='button';
toggle.dataset.path=path;
toggle.setAttribute('aria-label',`${expanded?'折叠':'展开'} ${parts.at(-1)}`);
toggle.setAttribute('aria-expanded',String(expanded));
toggle.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4.5 5.5 5.5-5.5 5.5"/></svg>';
toggle.onclick=()=>{if(expanded)expandedFolders.delete(path);
else expandedFolders.add(path);
renderFolders(paths);
requestAnimationFrame(()=>[...folderTree.querySelectorAll('.folder-toggle')].find(button=>button.dataset.path===path)?.focus())};
row.append(toggle)}
item.className='folder-item'+(folder===path?' selected':'');
item.textContent=parts.at(-1);
item.title=path;
item.setAttribute('role','treeitem');
item.setAttribute('aria-level',String(depth));
if(hasChildren)item.setAttribute('aria-expanded',String(expandedFolders.has(path)));
item.onclick=()=>chooseFolder(path);
row.append(item);
folderTree.append(row)}
folderMenu.scrollTop=scrollTop}
let folderLoadTask=null;
function refreshFolders(){if(folderLoadTask)return folderLoadTask;
folderLoadTask=(async()=>{try{const response=await fetch('/api/folders',{cache:'no-store'});
if(!response.ok)throw new Error(`HTTP ${response.status}`);
const paths=await response.json();
renderFolders(paths);
folderTree._loaded=true;
return paths}catch{renderFolders([]);
return []}})().finally(()=>{folderLoadTask=null});
return folderLoadTask}
folderButton.onclick=e=>{e.stopPropagation();
closeMore();
folderMenu.hidden=!folderMenu.hidden;
folderButton.setAttribute('aria-expanded',String(!folderMenu.hidden));
if(!folderMenu.hidden&&!folderTree._loaded)refreshFolders()};
folderMenu.onclick=e=>{if(e.target.closest('button')){e.stopPropagation();
return}
closeFolders()};
moreButton.onclick=e=>{e.stopPropagation();
closeFolders();
moreMenu.hidden=!moreMenu.hidden;
moreButton.setAttribute('aria-expanded',String(!moreMenu.hidden))};
moreMenu.onclick=e=>e.stopPropagation();
document.addEventListener('pointerdown',e=>{const target=e.target;
if(!folderMenu.hidden&&(!target.closest('.folder-picker')||(folderMenu.contains(target)&&!target.closest('button'))))closeFolders();
if(!moreMenu.hidden&&!target.closest('.more-picker'))closeMore()},{capture:true});
document.addEventListener('click',()=>{closeFolders();
closeMore()});
function setTheme(theme){document.documentElement.dataset.theme=theme;
localStorage.setItem('gallery-theme',theme);
const light=theme==='light';
themeLabel.textContent=light?'切换暗色主题':'切换浅色主题';
themeValue.textContent=light?'浅色':'暗色';
themeButton.setAttribute('aria-label',themeLabel.textContent);
themeColor.content=light?'#e8e5de':'#343a44'}
setTheme(document.documentElement.dataset.theme==='light'?'light':'dark');
themeButton.onclick=()=>{setTheme(document.documentElement.dataset.theme==='light'?'dark':'light');
closeMore()};
function sizeHero(x){const mobile=innerWidth<=650,maxW=innerWidth*(mobile?.965:.92),maxH=innerHeight*(mobile?.91:.9),ratio=Math.min(maxW/x.width,maxH/x.height),w=Math.round(x.width*ratio),h=Math.round(x.height*ratio);
hero.style.width=`${w}px`;
hero.style.height=`${h}px`;
hero.style.flexBasis=`${w}px`;
hero.style.aspectRatio=`${x.width}/${x.height}`}
function resetView(){scale=1;
tx=ty=0;
zoomStep=0;
dismissProgress=0;
dialog.classList.remove('dismissing');
dialog.style.removeProperty('--dismiss-progress');
apply(false)}
function resetCopyNameFeedback(){copyNameRequest++;
clearTimeout(copyNameTimer);
copyNameButton.classList.remove('copied');
copyNameButton.setAttribute('aria-label','复制文件名');
copyNameButton.title='点击复制文件名'}
async function writeClipboard(value){try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);
return true}}catch{}
const textarea=document.createElement('textarea');
textarea.value=value;
Object.assign(textarea.style,{position:'fixed',left:'-9999px',top:'0',opacity:'0'});
document.body.append(textarea);
textarea.focus();
textarea.select();
let copied=false;
try{copied=document.execCommand('copy')}catch{}
textarea.remove();
copyNameButton.focus({preventScroll:true});
return copied}
copyNameButton.onclick=async()=>{const value=detailsPanel.querySelector('[data-detail="name"]').textContent,request=++copyNameRequest;
if(!value)return;
const copied=await writeClipboard(value);
if(request!==copyNameRequest)return;
clearTimeout(copyNameTimer);
copyNameButton.classList.toggle('copied',copied);
copyNameButton.setAttribute('aria-label',copied?'文件名已复制':'复制文件名失败');
copyNameButton.title=copied?'已复制':'复制失败';
copyNameTimer=setTimeout(resetCopyNameFeedback,1400)};
function updateDetails(x){resetCopyNameFeedback();
for(const [key,value] of Object.entries({name:x.name,path:x.path,dimensions:`${x.width} × ${x.height}`,format:formatOf(x),size:human(x.bytes)})){const node=detailsPanel.querySelector(`[data-detail="${key}"]`);
node.textContent=value;
node.title=value}}
function closeDetails(){detailsPanel.hidden=true;
infoButton.setAttribute('aria-expanded','false')}
function closeViewerMenu(){viewerMenu.hidden=true;
viewerMore.setAttribute('aria-expanded','false')}
infoButton.onclick=()=>{detailsPanel.hidden=!detailsPanel.hidden;
infoButton.setAttribute('aria-expanded',String(!detailsPanel.hidden));
closeViewerMenu()};
viewerMore.onclick=()=>{const opening=viewerMenu.hidden;
if(opening)closeDetails();
viewerMenu.hidden=!viewerMenu.hidden;
viewerMore.setAttribute('aria-expanded',String(!viewerMenu.hidden))};
download.onclick=closeViewerMenu;
detailsPanel.onpointerdown=e=>e.stopPropagation();
detailsPanel.onwheel=e=>e.stopPropagation();
dialog.querySelector('.viewer-actions').onpointerdown=e=>e.stopPropagation();
function apply(animate=true){hero.style.transition=animate?'transform .24s cubic-bezier(.2,.75,.25,1)':'none';
const visualScale=scale===1?1-dismissProgress*.055:scale;
hero.style.transform=`translate3d(${tx}px,${ty}px,0) scale(${visualScale})`}
function setDismiss(dy,animate=false){ty=Math.max(0,dy);
tx=0;
dismissProgress=Math.min(1,ty/(innerHeight*.55));
dialog.classList.toggle('dismissing',dismissProgress>0);
dialog.style.setProperty('--dismiss-progress',dismissProgress);
apply(animate)}
function cancelDismiss(){ty=0;
dismissProgress=0;
dialog.style.setProperty('--dismiss-progress',0);
apply();
setTimeout(()=>{if(!dismissProgress){dialog.classList.remove('dismissing');
dialog.style.removeProperty('--dismiss-progress')}},240)}
function updateDownload(x){download.href=`/image/${x.id}?v=${x.thumb_key}`;
download.download=x.name}
function updateViewerCount(){viewerCount.textContent=active>=0&&dialog.open?`${active+1} / ${rows.length}`:''}
async function open(i){if(!rows[i])return;
const token=++openToken;
navigationToken++;
active=i;
switching=false;
const x=rows[i];
activeId=x.id;
resetView();
closeDetails();
closeViewerMenu();
setOriginalReady(false);
setViewerFailure(false);
setViewerLoading(true);
updateDetails(x);
sizeHero(x);
photo.removeAttribute('src');
photo.style.opacity='0';
preview.removeAttribute('src');
preview.style.opacity='0';
const cardImage=gallery.children[i]?.querySelector('img');
if(cardImage?.naturalWidth){preview.src=cardImage.currentSrc||cardImage.src;
preview.style.opacity='1';
settleViewerSurface()}
preview.alt=x.name;
photo.alt=x.name;
updateDownload(x);
if(!dialog.open){document.documentElement.classList.add('viewer-open');
dialog.showModal()}
updateViewerCount();
extendViewerQueue(i);
const thumbTask=decodedThumb(i),current=decoded(i,token);
revealPreviewWhenReady(thumbTask,i,token);
trackViewerFailure(i,token,thumbTask,current);
preloadDirectional(i,1,true);
reveal(await current,i,token)}
function trimDecodedCache(keepId){let used=0;
for(const entry of decodedCache.values())used+=entry.bytes;
if(used<=DECODE_BUDGET)return;
for(const [id,entry] of [...decodedCache].sort((a,b)=>a[1].used-b[1].used)){if(used<=DECODE_BUDGET)break;
if(id===keepId||id===activeId||!entry.settled||!entry.url)continue;
decodedCache.delete(id);
URL.revokeObjectURL(entry.url);
used-=entry.bytes}}
function releaseDecodedEntry(id,entry){if(entry.url){URL.revokeObjectURL(entry.url);
entry.url=null}
if(decodedCache.get(id)===entry)decodedCache.delete(id)}
function decodedAsset(i,priority='auto'){if(!rows[i])return Promise.resolve(null);
const x=rows[i],cached=decodedCache.get(x.id);
if(cached){cached.used=performance.now();
return cached.promise}
const controller=new AbortController(),entry={bytes:x.width*x.height*4,used:performance.now(),url:null,promise:null,controller,cancelled:false,settled:false};
entry.promise=(async()=>{try{const response=await fetch(`/image/${x.id}?v=${x.thumb_key}`,{priority,signal:controller.signal});
if(!response.ok)throw new Error(`HTTP ${response.status}`);
const blob=await response.blob(),url=URL.createObjectURL(blob),img=new Image;
entry.url=url;
if(entry.cancelled){releaseDecodedEntry(x.id,entry);
return null}
img.src=url;
await img.decode();
if(entry.cancelled){releaseDecodedEntry(x.id,entry);
return null}
entry.settled=true;
entry.used=performance.now();
trimDecodedCache(x.id);
return img}catch{releaseDecodedEntry(x.id,entry);
return null}})();
decodedCache.set(x.id,entry);
return entry.promise}
function preload(i){decodedAsset(i,'low')}
function cancelDistantPreloads(center,direction=1){const keep=new Set();
if(center!=null){for(let distance=0;
distance<=DIRECTIONAL_PREFETCH;
distance++){const row=rows[center+distance*direction];
if(row)keep.add(row.id)}
for(let distance=1;
distance<=INITIAL_REVERSE_PREFETCH;
distance++){const row=rows[center-distance*direction];
if(row)keep.add(row.id)}}for(const [id,entry] of decodedCache){if(entry.settled||keep.has(id))continue;
entry.cancelled=true;
entry.controller.abort();
releaseDecodedEntry(id,entry)}}
function preloadDirectional(center,direction=1,includeReverse=false){for(let distance=1;
distance<=DIRECTIONAL_PREFETCH;
distance++)preload(center+distance*direction);
if(includeReverse){for(let distance=1;
distance<=INITIAL_REVERSE_PREFETCH;
distance++)preload(center-distance*direction)}
cancelDistantPreloads(center,direction)}
function decodedThumb(i){return new Promise(resolve=>{if(!rows[i]){resolve(null);
return}const img=new Image;
let settled=false;
const finish=value=>{if(settled)return;
settled=true;
clearTimeout(timeout);
img.onload=img.onerror=null;
resolve(value)};
const timeout=setTimeout(()=>finish(null),3000);
img.fetchPriority='high';
img.onload=async()=>{try{await img.decode()}catch{}finish(img)};
img.onerror=()=>finish(null);
img.src=`/thumb/${rows[i].id}?v=${rows[i].thumb_key}`})}
function firstDrawable(...tasks){return new Promise(resolve=>{let settled=false,pending=tasks.length;
const finish=value=>{if(settled)return;
settled=true;
clearTimeout(timeout);
resolve(value)},failed=()=>{if(!--pending)finish(null)},timeout=setTimeout(()=>finish(null),3500);
for(const task of tasks)Promise.resolve(task).then(image=>image?finish(image):failed(),failed)})}
function trackViewerFailure(i,token,...tasks){Promise.all(tasks.map(task=>Promise.resolve(task).catch(()=>null))).then(images=>{if(token!==openToken||!dialog.open||active!==i)return;
if(images.every(image=>!image)&&!preview.naturalWidth&&!photo.naturalWidth)setViewerFailure(true)})}
function revealPreviewWhenReady(task,i,token){task.then(image=>{if(!image||token!==openToken||!dialog.open||active!==i)return;
reconcileRenderedDimensions(i,image);
preview.src=image.currentSrc||image.src;
preview.style.opacity='1';
settleViewerSurface();
setViewerFailure(false)}).catch(()=>{})}
async function syncGalleryPosition(i){appendCards(gallery.children.length);
const card=gallery.children[i];
if(!card)return null;
// Let the already scheduled incremental layout cover newly appended cards;
// avoid an O(total cards) forced layout on every viewer navigation.
await nextFrame();
const image=card.querySelector('img');
warmCard(card,'high');
card.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});
await nextFrame();
if(image&&!image.complete)await Promise.race([image.decode().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,500))]);
if(image?.naturalWidth)image.classList.add('ready');
return image?.naturalWidth?image:null}
function reveal(img,i,token,instant=false){if(token!==openToken||!dialog.open||active!==i)return;
if(!img){photo.removeAttribute('src');
photo.style.opacity='0';
preview.style.opacity='1';
setOriginalReady(false);
if(instant)photo.style.transition='opacity 120ms ease-out';
return}
reconcileRenderedDimensions(i,img);
setOriginalReady(true);
if(instant)photo.style.transition='none';
photo.src=img.src;
settleViewerSurface();
requestAnimationFrame(()=>{if(token!==openToken||!dialog.open||active!==i)return;
photo.style.opacity='1';
if(instant){preview.style.opacity='0';
requestAnimationFrame(()=>{photo.style.transition='opacity 120ms ease-out'})}
else setTimeout(()=>{if(token===openToken&&dialog.open&&active===i)preview.style.opacity='0'},130)})}
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
function returnTarget(id){if(id==null)return null;
const from=gallery.children.length;
appendCards(from);
if(gallery.children.length>from)layout(from);
const card=gallery.querySelector(`.card[data-id="${id}"]`);
if(!card)return null;
const image=card.querySelector('img');
if(image){image.loading='eager';
image.fetchPriority='high';
warmCard(card,'high')}
let target=card.getBoundingClientRect();
if(target.top<16||target.bottom>innerHeight-16){card.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});
target=card.getBoundingClientRect()}
if(image?.naturalWidth)image.classList.add('ready');
return image?.getBoundingClientRect()||target}
async function closeViewer(){if(closing||!dialog.open)return;
closing=true;
const returnId=activeId;
openToken++;
navigationToken++;
cancelDistantPreloads(null);
if(switching){switching=false;
apply(false)}
clearTimeout(closeTimer);
const target=returnTarget(returnId),from=hero.getBoundingClientRect();
dialog.classList.add('closing');
let animation;
const source=Number(getComputedStyle(photo).opacity)>.5?photo:preview,sourceReady=source.complete&&source.naturalWidth;
if(target&&target.width&&target.height&&sourceReady){const clone=document.createElement('img'),dx=target.left-from.left,dy=target.top-from.top,sx=target.width/from.width,sy=target.height/from.height;
clone.src=source.currentSrc||source.src;
Object.assign(clone.style,{position:'fixed',left:`${from.left}px`,top:`${from.top}px`,width:`${from.width}px`,height:`${from.height}px`,objectFit:'contain',zIndex:'10',pointerEvents:'none',transformOrigin:'top left',willChange:'transform,opacity'});
dialog.append(clone);
hero.style.visibility='hidden';
animation=clone.animate([{transform:'translate3d(0,0,0) scale(1)',opacity:1},{transform:`translate3d(${dx}px,${dy}px,0) scale(${sx},${sy})`,opacity:.92}],{duration:260,easing:'cubic-bezier(.22,.72,.2,1)',fill:'forwards'});
await animation.finished.catch(()=>{});
clone.remove();
hero.style.visibility=''}else{animation=dialog.animate([{opacity:1},{opacity:0}],{duration:180,easing:'cubic-bezier(.22,.61,.36,1)',fill:'forwards'});
await animation.finished.catch(()=>{});
animation.cancel()}dialog.close();
if(returnId!=null){const returnCard=gallery.querySelector(`.card[data-id="${returnId}"]`);
returnCard?.focus({preventScroll:true})}
document.documentElement.classList.remove('viewer-open');
dialog.classList.remove('closing');
closeDetails();
closeViewerMenu();
photo.removeAttribute('src');
preview.removeAttribute('src');
setViewerLoading(false);
activeId=null;
resetView();
closing=false;
// The covered gallery may already have moved its sentinel into view. Wait for
// the modal-era observer task to settle, then explicitly resume pagination;
// IntersectionObserver will not emit another entry while it stays intersecting.
requestAnimationFrame(()=>needsReconcile?reconcileList():fillWaterfall())}
async function decoded(i,token){const img=await decodedAsset(i,'high');
return token===openToken?img:null}
async function upgrade(i,token,instant=false){reveal(await decoded(i,token),i,token,instant)}
function stopSwitching(navigation){if(navigation===navigationToken)switching=false}
function interruptSwitching(){if(!switching)return;
navigationToken++;
switching=false;
hero.style.transition='none';
resetView()}
function afterTransition(element,property,fallback){return new Promise(resolve=>{let settled=false;
const finish=()=>{if(settled)return;
settled=true;
clearTimeout(timer);
element.removeEventListener('transitionend',ended);
element.removeEventListener('transitioncancel',finish);
resolve()};
const ended=e=>{if(e.target===element&&e.propertyName===property)finish()},timer=setTimeout(finish,fallback);
element.addEventListener('transitionend',ended);
element.addEventListener('transitioncancel',finish)})}
async function slide(dir,instant=false){if(switching)return;
switching=true;
const navigation=++navigationToken;
const next=active+dir;
if(dir>0&&!rows[next])await ensureViewerRow(next);
if(navigation!==navigationToken||closing||!dialog.open){stopSwitching(navigation);
return}
if(!rows[next]){stopSwitching(navigation);
resetView();
return}
const token=++openToken,out=dir>0?-innerWidth:innerWidth;
// Keep the covered gallery aligned in parallel for the eventual close animation.
// Viewer navigation must not wait for that card or either image asset to decode.
const galleryTask=syncGalleryPosition(next),thumbTask=decodedThumb(next),originalTask=decodedAsset(next,'high');
const incomingTask=firstDrawable(galleryTask.catch(()=>null),thumbTask,originalTask);
if(navigation!==navigationToken||closing||!dialog.open){stopSwitching(navigation);
return}
if(instant){active=next;
const x=rows[next];
activeId=x.id;
updateViewerCount();
resetView();
closeDetails();
closeViewerMenu();
setOriginalReady(false);
setViewerFailure(false);
setViewerLoading(true);
updateDetails(x);
sizeHero(x);
photo.style.transition='none';
preview.style.opacity='0';
preview.removeAttribute('src');
photo.style.opacity='0';
photo.removeAttribute('src');
preview.alt=x.name;
photo.alt=x.name;
updateDownload(x);
revealPreviewWhenReady(incomingTask,next,token);
trackViewerFailure(next,token,galleryTask,thumbTask,originalTask);
const current=upgrade(next,token,true);
preloadDirectional(next,dir);
extendViewerQueue(next);
current.catch(()=>{});
stopSwitching(navigation);
return}
hero.style.transition='transform .16s ease-in';
const slideOut=afterTransition(hero,'transform',220);
hero.style.transform=`translate3d(${out}px,0,0) scale(1)`;
await slideOut;
if(navigation!==navigationToken||closing||!dialog.open){stopSwitching(navigation);
return}
active=next;
const x=rows[next];
activeId=x.id;
updateViewerCount();
resetView();
closeDetails();
closeViewerMenu();
setOriginalReady(false);
setViewerFailure(false);
setViewerLoading(true);
updateDetails(x);
sizeHero(x);
photo.style.transition='none';
photo.style.opacity='0';
photo.removeAttribute('src');
preview.style.opacity='0';
preview.removeAttribute('src');
preview.alt=x.name;
photo.alt=x.name;
updateDownload(x);
revealPreviewWhenReady(incomingTask,next,token);
trackViewerFailure(next,token,galleryTask,thumbTask,originalTask);
hero.style.transition='none';
hero.style.transform=`translate3d(${-out}px,0,0) scale(1)`;
const current=upgrade(next,token);
preloadDirectional(next,dir);
extendViewerQueue(next);
current.catch(()=>{});
requestAnimationFrame(()=>requestAnimationFrame(()=>{if(navigation!==navigationToken||closing||!dialog.open)return;
photo.style.transition='opacity 120ms ease-out';
hero.style.transition='transform .2s cubic-bezier(.2,.75,.25,1)';
const slideIn=afterTransition(hero,'transform',260);
hero.style.transform='translate3d(0,0,0) scale(1)';
slideIn.then(()=>stopSwitching(navigation))}))}
function setScaleAt(next,x=innerWidth/2,y=innerHeight/2){const rect=hero.getBoundingClientRect(),baseX=rect.left+rect.width/2-tx,baseY=rect.top+rect.height/2-ty,ratio=next/scale;
tx=x-baseX-ratio*(x-baseX-tx);
ty=y-baseY-ratio*(y-baseY-ty);
scale=next;
if(scale===1)tx=ty=0;
clampVertical()}
function zoom(x,y){setScaleAt(scale===1?4:1,x,y);
zoomStep=scale===1?0:1;
apply()}
function verticalLimit(){const viewportHeight=innerHeight*(innerWidth<=650?.96:.985);
return Math.max(0,(hero.clientHeight*scale-viewportHeight)/2)}
function clampVertical(){const maxY=verticalLimit();
ty=scale===1?0:Math.max(-maxY,Math.min(maxY,ty))}
dialog.querySelector('.close').onclick=closeViewer;
dialog.querySelector('.prev').onclick=()=>slide(-1,true);
dialog.querySelector('.next').onclick=()=>slide(1,true);
dialog.addEventListener('cancel',e=>{e.preventDefault();
if(!viewerMenu.hidden){closeViewerMenu();
return}
if(!detailsPanel.hidden){closeDetails();
return}closeViewer()});

dialog.onwheel=e=>{if(e.target.closest('button'))return;
e.preventDefault();
const next=Math.max(1,Math.min(16,scale+(e.deltaY<0?.75:-.75)));
setScaleAt(next,e.clientX,e.clientY);
zoomStep=scale===1?0:1;
apply()};

dialog.onpointerdown=e=>{const dismissedMenu=!viewerMenu.hidden&&!e.target.closest('.viewer-actions');
if(dismissedMenu)closeViewerMenu();
const dismissedDetails=!detailsPanel.hidden&&!e.target.closest('.details-panel,.info');
if(dismissedDetails)closeDetails();
if(e.target.closest('button,a'))return;
interruptSwitching();
clearTimeout(closeTimer);
dialog.setPointerCapture(e.pointerId);
pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
hero.classList.add('dragging');
gesture={x:e.clientX,y:e.clientY,tx,ty,scale,distance:0,time:performance.now(),axis:null,dismissedOverlay:dismissedMenu||dismissedDetails};
if(pointers.size===2){gesture.axis='pinch';
const [a,b]=[...pointers.values()];
gesture.distance=Math.hypot(a.x-b.x,a.y-b.y)}};

dialog.onpointermove=e=>{if(!pointers.has(e.pointerId)||!gesture)return;
pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
if(pointers.size===2){gesture.axis='pinch';
dismissProgress=0;
dialog.classList.remove('dismissing');
const [a,b]=[...pointers.values()],d=Math.hypot(a.x-b.x,a.y-b.y),next=gesture.distance?Math.max(1,Math.min(16,gesture.scale*d/gesture.distance)):scale;
setScaleAt(next,(a.x+b.x)/2,(a.y+b.y)/2);
zoomStep=scale===1?0:1}else{const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
if(scale===1&&!gesture.axis&&Math.hypot(dx,dy)>8)gesture.axis=Math.abs(dy)>Math.abs(dx)*1.15?(dy>0?'dismiss':'vertical'):'horizontal';
if(scale===1&&gesture.axis==='dismiss'){setDismiss(dy);
return}
if(scale===1&&gesture.axis==='vertical'){tx=ty=0;
return}tx=gesture.tx+dx;
ty=scale===1?0:gesture.ty+dy}clampVertical();
apply(false)};

dialog.onpointerup=dialog.onpointercancel=e=>{if(!pointers.has(e.pointerId))return;
const dx=gesture?e.clientX-gesture.x:0,dy=gesture?e.clientY-gesture.y:0,moved=gesture?Math.hypot(dx,dy):99,elapsed=Math.max(1,performance.now()-(gesture?.time??0)),touch=e.pointerType!=='mouse',flick=touch&&Math.abs(dx)>16&&Math.abs(dx)/elapsed>.25,wasDismissing=gesture?.axis==='dismiss',wasVertical=gesture?.axis==='vertical';
pointers.delete(e.pointerId);
hero.classList.remove('dragging');
if(pointers.size)return;
if(e.type==='pointercancel'){if(wasDismissing)cancelDismiss();
else apply();
return}if(wasDismissing){const fast=dy>42&&dy/elapsed>.55,far=dy>Math.min(140,innerHeight*.17);
if(fast||far)return closeViewer();
cancelDismiss();
return}if(wasVertical){apply();
return}if(moved<12){tx=gesture.tx;
ty=gesture.ty;
if(gesture.dismissedOverlay){apply();
return}
const edgeTapWidth=Math.min(144,innerWidth*.31);
if(touch&&scale===1&&e.clientX<=edgeTapWidth)return slide(-1,true);
if(touch&&scale===1&&e.clientX>=innerWidth-edgeTapWidth)return slide(1,true);
const now=Date.now();
if(scale>1){if(now-lastTap<DOUBLE_TAP_MS){clearTimeout(closeTimer);
lastTap=0;
zoom(e.clientX,e.clientY)
}else{lastTap=now;
closeTimer=setTimeout(()=>{if(scale>1){scale=1;
tx=ty=0;
zoomStep=0;
apply()}},DOUBLE_TAP_MS)}return}
if(now-lastTap<DOUBLE_TAP_MS){clearTimeout(closeTimer);
lastTap=0;
zoom(e.clientX,e.clientY)}else{lastTap=now;
apply();
closeTimer=setTimeout(closeViewer,DOUBLE_TAP_MS)}return}const viewportWidth=innerWidth*.98,maxX=Math.max(0,(hero.clientWidth*scale-viewportWidth)/2),zoomEdge=touch?190:260,zoomSwipeDistance=touch?90:140,swipeDistance=touch?30:60,horizontalIntent=Math.abs(dx)>Math.abs(dy)*1.2;
if(scale===1&&(Math.abs(tx)>swipeDistance||flick))return slide(dx<0?1:-1);
if(scale>1&&horizontalIntent&&dx>zoomSwipeDistance&&tx>maxX+zoomEdge)return slide(-1);
if(scale>1&&horizontalIntent&&dx<-zoomSwipeDistance&&tx<-(maxX+zoomEdge))return slide(1);
tx=Math.max(-maxX,Math.min(maxX,tx));
clampVertical();
apply()};

addEventListener('keydown',e=>{if(!dialog.open)return;
if(e.key==='ArrowLeft'){e.preventDefault();
slide(-1,true)}
if(e.key==='ArrowRight'){e.preventDefault();
slide(1,true)}
if(e.key==='ArrowDown'){e.preventDefault();
closeViewer()}});

const searchInput=document.querySelector('#search'),searchBox=document.querySelector('#search-box'),searchToggle=document.querySelector('#search-toggle'),pageHeader=document.querySelector('header'),mobileSearch=matchMedia('(max-width:650px)');
function setSearchOpen(open){pageHeader.classList.toggle('search-open',open);
searchToggle.setAttribute('aria-expanded',String(open));
searchToggle.setAttribute('aria-label',open?'收起搜索':'展开搜索');
if(open)requestAnimationFrame(()=>searchInput.focus());
else if(document.activeElement===searchInput)searchInput.blur()}
searchToggle.onclick=e=>{e.stopPropagation();
if(mobileSearch.matches)setSearchOpen(!pageHeader.classList.contains('search-open'));
else searchInput.focus()};
searchBox.onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>{if(mobileSearch.matches&&!searchInput.value)setSearchOpen(false)});
searchInput.addEventListener('keydown',e=>{if(e.key==='Escape'){searchInput.blur();
setSearchOpen(false)}});
mobileSearch.addEventListener('change',e=>{if(!e.matches)setSearchOpen(false)});
searchInput.oninput=e=>{clearTimeout(timer);
timer=setTimeout(()=>{query=e.target.value.trim();
load(true)},250)};

document.querySelector('#random').onclick=e=>{randomMode=!randomMode;
if(randomMode)randomSeed=Math.floor(Math.random()*2147483646)+1;
e.currentTarget.setAttribute('aria-pressed',String(randomMode));
e.currentTarget.title=randomMode?'退出探索列队':'探索列队';
e.currentTarget.querySelector('span').textContent=randomMode?'退出探索列队':'探索列队';
closeMore();
load(true)};

const scanButton=document.querySelector('#scan'),scanLabel=scanButton.querySelector('span');
let scanMonitorTask=null;
function setScanningUI(value){scanning=value;
scanButton.disabled=value;
scanLabel.textContent=value?'正在扫描…':'重新扫描';
scanButton.setAttribute('aria-busy',String(value));
updateEmpty()}
async function reconcileList(){needsReconcile=false;
await load(true);
await fillWaterfall()}
async function refreshAfterScan(removed=0){await refreshFolders();
if(removed>0){if(dialog.open){needsReconcile=true;
return}await reconcileList();
return}
if(done){done=false;
await fillWaterfall()}}
function monitorBackgroundScan(){if(scanMonitorTask)return scanMonitorTask;
setScanningUI(true);
scanMonitorTask=(async()=>{let removed=0;
for(;;){const response=await fetch('/api/config',{cache:'no-store'});
if(!response.ok)throw new Error(`HTTP ${response.status}`);
const config=await response.json();
if(!config.scanning){removed=Number(config.last_scan_removed)||0;
break}
if(done){done=false;
await fillWaterfall()}
await new Promise(resolve=>setTimeout(resolve,1000))}
await refreshAfterScan(removed)})().catch(error=>{console.error('scan monitoring failed',error);
scanButton.title='无法获取扫描状态'}).finally(()=>{scanMonitorTask=null;
setScanningUI(false)});
return scanMonitorTask}
scanButton.onclick=async()=>{if(scanMonitorTask)return;
setScanningUI(true);
try{const response=await fetch('/api/scan',{method:'POST'});
if(response.status===409){await monitorBackgroundScan();
return}
if(!response.ok)throw new Error(`HTTP ${response.status}`);
const result=await response.json();
await refreshAfterScan(Number(result.removed)||0);
scanButton.removeAttribute('title')}catch(error){console.error('gallery scan failed',error);
scanButton.title='扫描失败，请重试'}finally{setScanningUI(false);
closeMore()}};

new ResizeObserver(()=>scheduleLayout(0)).observe(gallery);
addEventListener('resize',()=>{if(dialog.open&&rows[active]){resetView();
sizeHero(rows[active])}
requestWaterfallCheck()});
let waterfallCheckFrame=0;
function requestWaterfallCheck(){if(waterfallCheckFrame)return;
waterfallCheckFrame=requestAnimationFrame(()=>{waterfallCheckFrame=0;
if(!dialog.open&&nearWaterfallEnd())fillWaterfall()})}
addEventListener('scroll',requestWaterfallCheck,{passive:true});
new IntersectionObserver(entries=>entries.some(entry=>entry.isIntersecting)&&!dialog.open&&fillWaterfall(),{rootMargin:`${WATERFALL_MARGIN}px 0px`}).observe(sentinel);
async function init(){refreshFolders();
let config={scanning:true};
try{const response=await fetch('/api/config',{cache:'no-store'});
if(!response.ok)throw new Error(`HTTP ${response.status}`);
config=await response.json()}catch(error){console.error('initial gallery state failed',error)}
ready=true;
setScanningUI(Boolean(config.scanning));
fillWaterfall();
if(config.scanning)monitorBackgroundScan()}
init();
