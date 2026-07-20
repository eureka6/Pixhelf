const gallery=document.querySelector('#gallery'),sentinel=document.querySelector('#sentinel'),empty=document.querySelector('#empty');

const dialog=document.querySelector('#lightbox'),hero=dialog.querySelector('.stage'),preview=hero.querySelector('.preview'),photo=hero.querySelector('.original'),download=dialog.querySelector('.download'),infoButton=dialog.querySelector('.info'),detailsPanel=dialog.querySelector('.details-panel'),viewerMenu=dialog.querySelector('.viewer-action-menu'),viewerMore=dialog.querySelector('.viewer-more');

let rows=[],cursor=null,loading=false,loadTask=null,waterfallTask=null,done=false,query='',folder='',active=-1,timer,randomMode=false,randomSeed=1,ready=false;

let scale=1,tx=0,ty=0,switching=false,closing=false,lastTap=0,zoomStep=0,gesture=null,closeTimer,openToken=0,currentObjectUrl=null,dismissProgress=0;

const pointers=new Map();

const DOUBLE_TAP_MS=300;

const PREFETCH_RADIUS=4,prefetched=new Set(),preloadImages=new Map();

const human=n=>{const u=['B','KB','MB','GB','TB'];
let i=0;
while(n>=1024&&i<u.length-1){n/=1024;
i++}return `${n.toFixed(i?1:0)} ${u[i]}`};
const formatOf=x=>{const raw=(x.mime||'').split('/').at(-1)?.split('+')[0].toUpperCase();
return raw==='JPEG'?'JPG':raw||'IMAGE'};
function setOriginalReady(ready){viewerMore.classList.toggle('original-ready',ready);
viewerMore.title=ready?'更多操作 · 原图已加载':'更多操作';
viewerMore.setAttribute('aria-label',viewerMore.title)}

function load(reset=false){if(loading)return loadTask;
if(!reset&&done)return Promise.resolve([]);
loading=true;
loadTask=(async()=>{if(reset){gallery.replaceChildren();
rows=[];
cursor=null;
done=false}const p=new URLSearchParams({limit:'40'});
if(randomMode){p.set('random','true');
p.set('seed',randomSeed);
p.set('offset',rows.length)}else if(cursor)p.set('cursor',cursor);
if(query)p.set('q',query);
if(folder)p.set('folder',folder);
const batch=await fetch('/api/images?'+p).then(r=>r.json());
const firstNewCard=rows.length,fragment=document.createDocumentFragment();
for(const x of batch){const index=rows.push(x)-1,card=document.createElement('article');
card.className='card';
card.dataset.id=x.id;
card.dataset.ratio=x.height/x.width;
card.style.setProperty('--ratio',`${x.width}/${x.height}`);
card.innerHTML=`<img loading="lazy" decoding="async" width="${x.width}" height="${x.height}" src="/thumb/${x.id}" alt="${escapeHtml(x.name)}"><div class="meta"><b>${escapeHtml(x.name)}</b><span>${x.width} × ${x.height} · ${human(x.bytes)}</span></div>`;
card.querySelector('img').onload=e=>e.target.classList.add('ready');
card.onclick=()=>open(index);
fragment.append(card)}gallery.append(fragment);
scheduleLayout(firstNewCard);
cursor=batch.at(-1)?.id??cursor;
done=batch.length<40;
empty.hidden=rows.length>0;
return batch})().finally(()=>{loading=false;
loadTask=null});
return loadTask}
async function extendViewerQueue(index){if(done||index<rows.length-8)return;
if(!done&&index>=rows.length-8)try{await load()}catch{}}
async function ensureViewerRow(index){while(!rows[index]&&!done){const before=rows.length;
try{await load()}catch{break}
if(rows.length===before)break}
return Boolean(rows[index])}
function fillWaterfall(){if(waterfallTask)return waterfallTask;
waterfallTask=(async()=>{while(ready&&!done&&!dialog.open&&sentinel.getBoundingClientRect().top<=innerHeight+800){const before=rows.length;
try{await load()}catch{break}
if(rows.length===before)break;
await new Promise(resolve=>requestAnimationFrame(resolve))}})().finally(()=>{waterfallTask=null});
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
layout(from)})}
function escapeHtml(s){const d=document.createElement('div');
d.textContent=s;
return d.innerHTML}
const folderButton=document.querySelector('#folders'),folderMenu=document.querySelector('#folder-menu'),folderTree=document.querySelector('#folder-tree'),moreButton=document.querySelector('#more'),moreMenu=document.querySelector('#more-menu'),themeButton=document.querySelector('#theme'),themeLabel=themeButton.querySelector('.theme-label'),themeValue=themeButton.querySelector('.menu-value'),themeColor=document.querySelector('meta[name="theme-color"]');
function closeMore(){moreMenu.hidden=true;
moreButton.setAttribute('aria-expanded','false')}
function chooseFolder(path){folder=path;
folderButton.title=path||'选择文件夹';
folderButton.setAttribute('aria-label',path?`当前路径：${path}`:'选择文件夹');
folderMenu.hidden=true;
folderButton.setAttribute('aria-expanded','false');
renderFolders(folderTree._paths||[]);
load(true)}
function renderFolders(paths){folderTree._paths=paths;
folderTree.replaceChildren();
const all=document.createElement('button');
all.className='folder-item root'+(!folder?' selected':'');
all.textContent='全部图片';
all.setAttribute('role','treeitem');
all.onclick=()=>chooseFolder('');
folderTree.append(all);
for(const path of paths){const item=document.createElement('button'),depth=path.split('/').length;
item.className='folder-item'+(folder===path?' selected':'');
item.style.setProperty('--depth',depth);
item.textContent=path.split('/').at(-1);
item.title=path;
item.setAttribute('role','treeitem');
item.onclick=()=>chooseFolder(path);
folderTree.append(item)}}
async function refreshFolders(){try{const paths=await fetch('/api/folders').then(r=>r.json());
renderFolders(paths);
return paths}catch{renderFolders([]);
return []}}
folderButton.onclick=e=>{e.stopPropagation();
closeMore();
folderMenu.hidden=!folderMenu.hidden;
folderButton.setAttribute('aria-expanded',String(!folderMenu.hidden));
if(!folderMenu.hidden)refreshFolders()};
folderMenu.onclick=e=>e.stopPropagation();
moreButton.onclick=e=>{e.stopPropagation();
folderMenu.hidden=true;
folderButton.setAttribute('aria-expanded','false');
moreMenu.hidden=!moreMenu.hidden;
moreButton.setAttribute('aria-expanded',String(!moreMenu.hidden))};
moreMenu.onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>{folderMenu.hidden=true;
folderButton.setAttribute('aria-expanded','false');
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
function sizeHero(x){const maxW=innerWidth<=650?innerWidth:innerWidth*.99,maxH=innerHeight*(innerWidth<=650?.96:.985),ratio=Math.min(maxW/x.width,maxH/x.height),w=Math.round(x.width*ratio),h=Math.round(x.height*ratio);
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
function updateDetails(x){for(const [key,value] of Object.entries({name:x.name,path:x.path,dimensions:`${x.width} × ${x.height}`,format:formatOf(x),size:human(x.bytes)})){const node=detailsPanel.querySelector(`[data-detail="${key}"]`);
node.textContent=value;
node.title=value}}
function closeDetails(){detailsPanel.hidden=true;
infoButton.setAttribute('aria-expanded','false')}
function closeViewerMenu(){viewerMenu.hidden=true;
viewerMore.setAttribute('aria-expanded','false')}
infoButton.onclick=()=>{detailsPanel.hidden=!detailsPanel.hidden;
infoButton.setAttribute('aria-expanded',String(!detailsPanel.hidden));
closeViewerMenu()};
viewerMore.onclick=()=>{viewerMenu.hidden=!viewerMenu.hidden;
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
function updateDownload(x){download.href=`/image/${x.id}`;
download.download=x.name}
async function open(i){if(!rows[i])return;
const token=++openToken;
active=i;
switching=false;
const x=rows[i];
resetView();
closeDetails();
closeViewerMenu();
setOriginalReady(false);
updateDetails(x);
sizeHero(x);
photo.removeAttribute('src');
photo.style.opacity='0';
preview.src=`/thumb/${x.id}`;
preview.style.opacity='1';
photo.alt=x.name;
updateDownload(x);
if(!dialog.open){document.documentElement.classList.add('viewer-open');
dialog.showModal()}
extendViewerQueue(i);
const current=decoded(i,token);
preloadAround(i,1);
reveal(await current,i,token)}
function preload(i){if(!rows[i]||prefetched.has(rows[i].id))return;
const id=rows[i].id,img=new Image;
prefetched.add(id);
preloadImages.set(id,img);
img.fetchPriority='low';
img.onload=()=>preloadImages.delete(id);
img.onerror=()=>{preloadImages.delete(id);
prefetched.delete(id)};
img.src=`/image/${id}`}
function preloadAround(center,direction=1){for(let distance=1;
distance<=PREFETCH_RADIUS;
distance++){preload(center+distance*direction);
preload(center-distance*direction)}}
function decodedThumb(i){return new Promise(resolve=>{const img=new Image;
img.onload=async()=>{try{await img.decode()}catch{}resolve(img)};
img.onerror=()=>resolve(img);
img.src=`/thumb/${rows[i].id}`})}
function reveal(img,i,token){if(token!==openToken||!dialog.open||active!==i)return;
if(!img){photo.removeAttribute('src');
photo.style.opacity='0';
preview.style.opacity='1';
setOriginalReady(false);
return}
setOriginalReady(true);
photo.src=img.src;
requestAnimationFrame(()=>{if(token!==openToken||!dialog.open||active!==i)return;
photo.style.opacity='1';
setTimeout(()=>{if(token===openToken&&dialog.open&&active===i)preview.style.opacity='0'},130)})}
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
async function returnTarget(){const card=rows[active]?gallery.querySelector(`.card[data-id="${rows[active].id}"]`):null;
if(!card)return null;
const image=card.querySelector('img');
if(image){image.loading='eager';
image.fetchPriority='high'}
layout();
await nextFrame();
let target=card.getBoundingClientRect();
if(target.top<16||target.bottom>innerHeight-16){card.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});
await nextFrame();
layout();
await nextFrame();
target=card.getBoundingClientRect()}
if(image&&!image.complete)await Promise.race([image.decode().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,120))]);
return image?.getBoundingClientRect()||target}
async function closeViewer(){if(closing||!dialog.open)return;
closing=true;
openToken++;
switching=false;
clearTimeout(closeTimer);
const target=await returnTarget(),from=hero.getBoundingClientRect();
dialog.classList.add('closing');
let animation;
if(target&&target.width&&target.height){const clone=document.createElement('img'),source=Number(getComputedStyle(photo).opacity)>.5?photo:preview,dx=target.left-from.left,dy=target.top-from.top,sx=target.width/from.width,sy=target.height/from.height;
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
document.documentElement.classList.remove('viewer-open');
dialog.classList.remove('closing');
closeDetails();
closeViewerMenu();
photo.removeAttribute('src');
preview.removeAttribute('src');
resetView();
closing=false;
fillWaterfall()}
async function decoded(i,token){const id=rows[i].id;
prefetched.add(id);
try{const response=await fetch(`/image/${id}`,{priority:'high'});
if(!response.ok)throw new Error(`HTTP ${response.status}`);
const blob=await response.blob();
if(token!==openToken)return null;
const url=URL.createObjectURL(blob),img=new Image;
img.src=url;
await img.decode();
if(currentObjectUrl)URL.revokeObjectURL(currentObjectUrl);
currentObjectUrl=url;
return img}catch{prefetched.delete(id);
return null}}
async function upgrade(i,token){reveal(await decoded(i,token),i,token)}
async function slide(dir){if(switching)return;
switching=true;
const next=active+dir;
if(dir>0&&!rows[next])await ensureViewerRow(next);
if(!rows[next]){switching=false;
resetView();
return}
const token=++openToken,out=dir>0?-innerWidth:innerWidth,thumb=decodedThumb(next);
hero.style.transition='transform .16s ease-in';
hero.style.transform=`translate3d(${out}px,0,0) scale(1)`;
const [readyThumb]=await Promise.all([thumb,new Promise(r=>setTimeout(r,160))]);
active=next;
const x=rows[next];
resetView();
closeDetails();
closeViewerMenu();
setOriginalReady(false);
updateDetails(x);
sizeHero(x);
photo.style.transition='none';
photo.style.opacity='0';
photo.removeAttribute('src');
preview.src=readyThumb.src;
preview.style.opacity='1';
photo.alt=x.name;
updateDownload(x);
hero.style.transition='none';
hero.style.transform=`translate3d(${-out}px,0,0) scale(1)`;
const current=upgrade(next,token);
preloadAround(next,dir);
extendViewerQueue(next);
current.catch(()=>{});
requestAnimationFrame(()=>requestAnimationFrame(()=>{photo.style.transition='opacity 120ms ease-out';
hero.style.transition='transform .2s cubic-bezier(.2,.75,.25,1)';
hero.style.transform='translate3d(0,0,0) scale(1)';
setTimeout(()=>{switching=false},200)}))}
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
dialog.querySelector('.prev').onclick=()=>slide(-1);
dialog.querySelector('.next').onclick=()=>slide(1);
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
if(switching||e.target.closest('button,a'))return;
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
if(scale===1&&!gesture.axis&&Math.hypot(dx,dy)>8)gesture.axis=dy>0&&Math.abs(dy)>Math.abs(dx)*1.15?'dismiss':'horizontal';
if(scale===1&&gesture.axis==='dismiss'){setDismiss(dy);
return}tx=gesture.tx+dx;
ty=scale===1?0:gesture.ty+dy}clampVertical();
apply(false)};

dialog.onpointerup=dialog.onpointercancel=e=>{if(!pointers.has(e.pointerId))return;
const dx=gesture?e.clientX-gesture.x:0,dy=gesture?e.clientY-gesture.y:0,moved=gesture?Math.hypot(dx,dy):99,elapsed=Math.max(1,performance.now()-(gesture?.time??0)),touch=e.pointerType!=='mouse',flick=touch&&Math.abs(dx)>18&&Math.abs(dx)/elapsed>.28,wasDismissing=gesture?.axis==='dismiss';
pointers.delete(e.pointerId);
hero.classList.remove('dragging');
if(pointers.size)return;
if(e.type==='pointercancel'){wasDismissing?cancelDismiss():apply();
return}if(wasDismissing){const fast=dy>42&&dy/elapsed>.55,far=dy>Math.min(140,innerHeight*.17);
if(fast||far)return closeViewer();
cancelDismiss();
return}if(moved<12){tx=gesture.tx;
ty=gesture.ty;
if(gesture.dismissedOverlay){apply();
return}
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
closeTimer=setTimeout(closeViewer,DOUBLE_TAP_MS)}return}const viewportWidth=innerWidth*.98,maxX=Math.max(0,(hero.clientWidth*scale-viewportWidth)/2),zoomEdge=touch?190:260,zoomSwipeDistance=touch?90:140,swipeDistance=touch?36:60,horizontalIntent=Math.abs(dx)>Math.abs(dy)*1.2;
if(scale===1&&(Math.abs(tx)>swipeDistance||flick))return slide(dx<0?1:-1);
if(scale>1&&horizontalIntent&&dx>zoomSwipeDistance&&tx>maxX+zoomEdge)return slide(-1);
if(scale>1&&horizontalIntent&&dx<-zoomSwipeDistance&&tx<-(maxX+zoomEdge))return slide(1);
tx=Math.max(-maxX,Math.min(maxX,tx));
clampVertical();
apply()};

addEventListener('keydown',e=>{if(!dialog.open)return;
if(e.key==='ArrowLeft')slide(-1);
if(e.key==='ArrowRight')slide(1)});

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

document.querySelector('#scan').onclick=async e=>{e.currentTarget.disabled=true;
e.currentTarget.querySelector('span').textContent='正在扫描…';
await fetch('/api/scan',{method:'POST'});
await refreshFolders();
await load(true);
e.currentTarget.disabled=false;
e.currentTarget.querySelector('span').textContent='重新扫描';
closeMore()};

new ResizeObserver(scheduleLayout).observe(gallery);
addEventListener('resize',()=>{if(dialog.open&&rows[active]){resetView();
sizeHero(rows[active])}});
new IntersectionObserver(es=>es[0].isIntersecting&&fillWaterfall(),{rootMargin:'800px'}).observe(sentinel);
async function init(){const paths=await refreshFolders();
if(paths.length){folder=paths[0];
folderButton.title=folder;
folderButton.setAttribute('aria-label',`当前路径：${folder}`);
renderFolders(paths)}
ready=true;
fillWaterfall()}
init();
