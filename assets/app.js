const gallery=document.querySelector('#gallery'),sentinel=document.querySelector('#sentinel'),empty=document.querySelector('#empty');

const dialog=document.querySelector('#lightbox'),hero=dialog.querySelector('.stage'),preview=hero.querySelector('.preview'),photo=hero.querySelector('.original'),caption=dialog.querySelector('figcaption'),title=caption.querySelector('b'),detail=caption.querySelector('.detail'),download=caption.querySelector('.download');

let rows=[],cursor=null,loading=false,done=false,query='',folder='',active=-1,timer,randomMode=false,randomSeed=1,ready=false;

let scale=1,tx=0,ty=0,switching=false,closing=false,lastTap=0,zoomStep=0,gesture=null,closeTimer,openToken=0,currentObjectUrl=null,dismissProgress=0;

const pointers=new Map();

const DOUBLE_TAP_MS=300;

const PREFETCH_RADIUS=4,prefetched=new Set(),preloadImages=new Map();

const human=n=>{const u=['B','KB','MB','GB','TB'];
let i=0;
while(n>=1024&&i<u.length-1){n/=1024;
i++}return `${n.toFixed(i?1:0)} ${u[i]}`};

async function load(reset=false){if(loading||(!reset&&done))return;
loading=true;
if(reset){gallery.replaceChildren();
rows=[];
cursor=null;
done=false}const p=new URLSearchParams({limit:'40'});
if(randomMode){p.set('random','true');
p.set('seed',randomSeed);
p.set('offset',rows.length)}else if(cursor)p.set('cursor',cursor);
if(query)p.set('q',query);
if(folder)p.set('folder',folder);
try{const batch=await fetch('/api/images?'+p).then(r=>r.json());
for(const x of batch){const index=rows.push(x)-1,card=document.createElement('article');
card.className='card';
card.dataset.id=x.id;
card.dataset.ratio=x.height/x.width;
card.innerHTML=`<img loading="lazy" decoding="async" width="${x.width}" height="${x.height}" src="/thumb/${x.id}" alt="${escapeHtml(x.name)}"><div class="meta"><b>${escapeHtml(x.name)}</b><span>${x.width} × ${x.height} · ${human(x.bytes)}</span></div>`;
card.querySelector('img').onload=e=>e.target.classList.add('ready');
card.onclick=()=>open(index);
gallery.append(card)}layout();
cursor=batch.at(-1)?.id??cursor;
done=batch.length<40;
empty.hidden=rows.length>0}finally{loading=false}}
function layout(){const s=getComputedStyle(gallery),row=parseFloat(s.gridAutoRows),gap=parseFloat(s.rowGap);
for(const card of gallery.children){const h=card.clientWidth*Number(card.dataset.ratio);
card.style.gridRowEnd=`span ${Math.ceil((h+gap)/(row+gap))}`}}
function syncGrid(i){const card=rows[i]?gallery.querySelector(`.card[data-id="${rows[i].id}"]`):null;
if(card)card.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'})}
function escapeHtml(s){const d=document.createElement('div');
d.textContent=s;
return d.innerHTML}
const folderButton=document.querySelector('#folders'),folderMenu=document.querySelector('#folder-menu'),folderTree=document.querySelector('#folder-tree');
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
folderMenu.hidden=!folderMenu.hidden;
folderButton.setAttribute('aria-expanded',String(!folderMenu.hidden));
if(!folderMenu.hidden)refreshFolders()};
folderMenu.onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>{folderMenu.hidden=true;
folderButton.setAttribute('aria-expanded','false')});
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
function showProgress(value=null){caption.classList.add('loading');
caption.classList.toggle('indeterminate',value===null);
if(value!==null)caption.style.setProperty('--load-progress',Math.max(0,Math.min(1,value)))}
function hideProgress(token){setTimeout(()=>{if(token===openToken)caption.classList.remove('loading','indeterminate')},180)}
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
sizeHero(x);
photo.removeAttribute('src');
photo.style.opacity='0';
preview.src=`/thumb/${x.id}`;
preview.style.opacity='1';
photo.alt=x.name;
title.textContent=x.name;
detail.textContent=`${x.width} × ${x.height} · ${human(x.bytes)}`;
updateDownload(x);
if(!dialog.open)dialog.showModal();
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
detail.textContent=`${rows[i].width} × ${rows[i].height} · ${human(rows[i].bytes)} · 缩略图预览`;
return}detail.textContent=`${rows[i].width} × ${rows[i].height} · ${human(rows[i].bytes)} · 原图`;
photo.src=img.src;
requestAnimationFrame(()=>{if(token!==openToken||!dialog.open||active!==i)return;
photo.style.opacity='1';
setTimeout(()=>{if(token===openToken&&dialog.open&&active===i)preview.style.opacity='0'},130)})}
async function closeViewer(){if(closing||!dialog.open)return;
closing=true;
dialog.classList.add('closing');
openToken++;
switching=false;
clearTimeout(closeTimer);
const card=rows[active]?gallery.querySelector(`.card[data-id="${rows[active].id}"] img`):null,target=card?.getBoundingClientRect(),from=hero.getBoundingClientRect();
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
dialog.classList.remove('closing');
photo.removeAttribute('src');
preview.removeAttribute('src');
resetView();
closing=false}
async function decoded(i,token){const id=rows[i].id;
prefetched.add(id);
showProgress(null);
try{const response=await fetch(`/image/${id}`,{priority:'high'});
if(!response.ok)throw new Error(`HTTP ${response.status}`);
const total=Number(response.headers.get('content-length'))||0;
if(total)showProgress(0);
let blob;
if(response.body){const reader=response.body.getReader(),chunks=[];
let received=0;
for(;
;
){const {done,value}=await reader.read();
if(done)break;
chunks.push(value);
received+=value.byteLength;
if(total&&token===openToken)showProgress(received/total)}blob=new Blob(chunks,{type:response.headers.get('content-type')||rows[i].mime})}else blob=await response.blob();
if(token!==openToken)return null;
showProgress(1);
const url=URL.createObjectURL(blob),img=new Image;
img.src=url;
await img.decode();
if(currentObjectUrl)URL.revokeObjectURL(currentObjectUrl);
currentObjectUrl=url;
hideProgress(token);
return img}catch{prefetched.delete(id);
if(token===openToken)hideProgress(token);
return null}}
async function upgrade(i,token){reveal(await decoded(i,token),i,token)}
async function slide(dir){const next=active+dir;
if(switching||!rows[next]){resetView();
return}switching=true;
const token=++openToken,out=dir>0?-innerWidth:innerWidth,thumb=decodedThumb(next);
hero.style.transition='transform .16s ease-in';
hero.style.transform=`translate3d(${out}px,0,0) scale(1)`;
const [readyThumb]=await Promise.all([thumb,new Promise(r=>setTimeout(r,160))]);
active=next;
syncGrid(next);
const x=rows[next];
resetView();
sizeHero(x);
photo.style.transition='none';
photo.style.opacity='0';
photo.removeAttribute('src');
preview.src=readyThumb.src;
preview.style.opacity='1';
photo.alt=x.name;
title.textContent=x.name;
detail.textContent=`${x.width} × ${x.height} · ${human(x.bytes)}`;
updateDownload(x);
hero.style.transition='none';
hero.style.transform=`translate3d(${-out}px,0,0) scale(1)`;
const current=upgrade(next,token);
preloadAround(next,dir);
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
closeViewer()});

dialog.onwheel=e=>{if(e.target.closest('button'))return;
e.preventDefault();
const next=Math.max(1,Math.min(16,scale+(e.deltaY<0?.75:-.75)));
setScaleAt(next,e.clientX,e.clientY);
zoomStep=scale===1?0:1;
apply()};

dialog.onpointerdown=e=>{if(switching||e.target.closest('button,a'))return;
clearTimeout(closeTimer);
dialog.setPointerCapture(e.pointerId);
pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
hero.classList.add('dragging');
gesture={x:e.clientX,y:e.clientY,tx,ty,scale,distance:0,time:performance.now(),axis:null};
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
const now=Date.now();
if(now-lastTap<DOUBLE_TAP_MS){clearTimeout(closeTimer);
lastTap=0;
zoom(e.clientX,e.clientY)}else{lastTap=now;
apply();
closeTimer=setTimeout(closeViewer,DOUBLE_TAP_MS)}return}const viewportWidth=innerWidth*.98,maxX=Math.max(0,(hero.clientWidth*scale-viewportWidth)/2),zoomEdge=110,swipeDistance=touch?36:60;
if(scale===1&&(Math.abs(tx)>swipeDistance||flick))return slide(dx<0?1:-1);
if(scale>1&&tx>maxX+zoomEdge&&dx>0)return slide(-1);
if(scale>1&&tx<-(maxX+zoomEdge)&&dx<0)return slide(1);
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
e.currentTarget.title=randomMode?'恢复默认顺序':'随机顺序';
load(true)};

document.querySelector('#scan').onclick=async e=>{e.currentTarget.disabled=true;
await fetch('/api/scan',{method:'POST'});
await refreshFolders();
await load(true);
e.currentTarget.disabled=false};

new ResizeObserver(()=>requestAnimationFrame(layout)).observe(gallery);
addEventListener('resize',()=>{if(dialog.open&&rows[active]){resetView();
sizeHero(rows[active])}});
new IntersectionObserver(es=>ready&&es[0].isIntersecting&&load(),{rootMargin:'800px'}).observe(sentinel);
async function init(){const paths=await refreshFolders();
if(paths.length){folder=paths[0];
folderButton.title=folder;
folderButton.setAttribute('aria-label',`当前路径：${folder}`);
renderFolders(paths)}
ready=true;
load()}
init();
