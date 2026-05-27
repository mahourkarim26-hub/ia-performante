if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
 
const CONVS_KEY='ia_convs_v5',CUR_KEY='ia_cur_v5',SETTINGS_KEY='ia_settings_v1';
let convs={},currentId=null,loading=false,pendingFiles=[];
let settings={systemPrompt:'',fontSize:13.5,theme:'dark'};
let currentModel='llama-3.3-70b-versatile';
let lastAssistantRow=null,currentReader=null,currentTTS=null;
 
const msgEl=document.getElementById('messages');
const ta=document.getElementById('ta');
const sb=document.getElementById('sbtn');
const stopBtn=document.getElementById('stop-btn');
const chatTitleEl=document.getElementById('chat-title');
const emptyState=document.getElementById('empty-state');
const filePreviewBar=document.getElementById('file-preview-bar');
 
// ── MODÈLES VISION ──
// Ces modèles supportent les images (vision)
const VISION_MODELS=['meta-llama/llama-4-scout-17b-16e-instruct','meta-llama/llama-4-maverick-17b-128e-instruct'];
const DEFAULT_VISION_MODEL='meta-llama/llama-4-scout-17b-16e-instruct';
const TEXT_MODELS=['llama-3.3-70b-versatile','mixtral-8x7b-32768','gemma2-9b-it','llama-3.1-8b-instant'];
 
function hasImageInMessages(apiMessages){
  return apiMessages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url'));
}
 
// ── SETTINGS ──
function loadSettings(){
  try{const s=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}');Object.assign(settings,s)}catch(e){}
  applySettings();
  document.getElementById('system-prompt-input').value=settings.systemPrompt||'';
}
function applySettings(){
  document.documentElement.setAttribute('data-theme',settings.theme||'dark');
  document.getElementById('theme-btn').textContent=settings.theme==='light'?'🌙':'☀️';
  document.documentElement.style.setProperty('--font-size',(settings.fontSize||13.5)+'px');
  const hlTheme=document.getElementById('hljs-theme');
  hlTheme.href=settings.theme==='light'
    ?'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css'
    :'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
}
function saveSettingsData(){localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings))}
function saveSettings(){settings.systemPrompt=document.getElementById('system-prompt-input').value.trim();saveSettingsData();closeSettings();toast('Paramètres sauvegardés')}
function resetSettings(){document.getElementById('system-prompt-input').value='';settings.systemPrompt='';saveSettingsData();closeSettings();toast('Prompt réinitialisé')}
function openSettings(){document.getElementById('settings-panel').classList.add('open');document.getElementById('settings-backdrop').classList.add('open')}
function closeSettings(){document.getElementById('settings-panel').classList.remove('open');document.getElementById('settings-backdrop').classList.remove('open')}
function toggleTheme(){settings.theme=settings.theme==='dark'?'light':'dark';applySettings();saveSettingsData()}
function changeFont(d){settings.fontSize=Math.min(18,Math.max(11,(settings.fontSize||13.5)+d));applySettings();saveSettingsData()}
function onModelChange(){
  currentModel=document.getElementById('model-select').value;
  const labels={
    'llama-3.3-70b-versatile':'Llama 3.3 70B',
    'mixtral-8x7b-32768':'Mixtral 8x7B',
    'gemma2-9b-it':'Gemma2 9B',
    'llama-3.1-8b-instant':'Llama 3.1 8B',
    'meta-llama/llama-4-scout-17b-16e-instruct':'Llama 4 Scout (Vision)',
    'meta-llama/llama-4-maverick-17b-128e-instruct':'Llama 4 Maverick (Vision)'
  };
  document.getElementById('model-label').textContent=labels[currentModel]||currentModel;
}
function toggleFocus(){
  document.body.classList.toggle('focus-mode');
  document.getElementById('focus-btn').classList.toggle('active',document.body.classList.contains('focus-mode'));
  toast(document.body.classList.contains('focus-mode')?'Mode focus activé':'Mode focus désactivé');
}
 
// ── STOP ──
function setStopVisible(v){stopBtn.style.display=v?'flex':'none';sb.style.display=v?'none':'flex'}
function stopGeneration(){
  if(currentReader){try{currentReader.cancel()}catch(e){}currentReader=null}
  loading=false;setStopVisible(false);updateSendBtn();rmTyping();toast('Génération arrêtée');
}
 
// ── TOKEN DISPLAY ──
function estTok(t){return Math.ceil((t||'').length/4)}
function updateTokenDisplay(){
  const el=document.getElementById('token-display');
  if(!currentId||!convs[currentId]){el.textContent='0 tok';el.classList.remove('warn');return}
  const n=convs[currentId].messages.reduce((s,m)=>s+estTok(typeof m.content==='string'?m.content:(m.displayContent||'')),0);
  el.textContent=n>1000?(n/1000).toFixed(1)+'k tok':n+' tok';
  el.classList.toggle('warn',n>6000);
}
 
// ── CTX BAR ──
function updateCtxBar(){
  const bar=document.getElementById('ctx-bar');
  if(!currentId||!convs[currentId]){bar.classList.add('hidden');return}
  const total=convs[currentId].messages.length;
  const pct=Math.min(total/20,1);
  bar.classList.remove('hidden');
  document.getElementById('ctx-label').textContent=total+'/20 messages en contexte';
  const fill=document.getElementById('ctx-fill');
  fill.style.width=(pct*100)+'%';
  fill.className=pct>=1?'danger':pct>=0.75?'warn':'';
  const warn=document.getElementById('ctx-warn');
  if(total>20) warn.textContent='⚠️ Les '+(total-20)+' premiers msgs sont ignorés';
  else if(total>=15) warn.textContent='⚠️ Contexte presque plein';
  else warn.textContent='';
}
 
// ── SCROLL TO BOTTOM ──
function scrollToBottom(){msgEl.scrollTo({top:msgEl.scrollHeight,behavior:'smooth'})}
function updateScrollBtn(){
  const btn=document.getElementById('scroll-btn');
  const fromBottom=msgEl.scrollHeight-msgEl.scrollTop-msgEl.clientHeight;
  btn.classList.toggle('visible',fromBottom>120);
}
msgEl.addEventListener('scroll',updateScrollBtn);
 
// ── MESSAGE SEARCH ──
let searchMatches=[],searchIdx=0;
function openMsgSearch(){
  document.getElementById('msg-search-bar').classList.add('open');
  document.getElementById('msg-search-input').focus();
}
function closeMsgSearch(){
  document.getElementById('msg-search-bar').classList.remove('open');
  clearSearchHighlights();searchMatches=[];searchIdx=0;
  document.getElementById('msg-search-count').textContent='';
}
function clearSearchHighlights(){
  msgEl.querySelectorAll('.search-highlight').forEach(el=>{
    const parent=el.parentNode;parent.replaceChild(document.createTextNode(el.textContent),el);parent.normalize();
  });
}
function doMsgSearch(){
  clearSearchHighlights();searchMatches=[];searchIdx=0;
  const q=document.getElementById('msg-search-input').value.trim();
  if(!q){document.getElementById('msg-search-count').textContent='';return}
  [...msgEl.querySelectorAll('.bubble')].forEach(bubble=>highlightInNode(bubble,q));
  searchMatches=[...msgEl.querySelectorAll('.search-highlight')];
  document.getElementById('msg-search-count').textContent=searchMatches.length?`1/${searchMatches.length}`:'0 résultat';
  if(searchMatches.length){searchMatches[0].classList.add('current');searchMatches[0].scrollIntoView({behavior:'smooth',block:'center'})}
}
function highlightInNode(node,q){
  if(node.nodeType===3){
    const idx=node.textContent.toLowerCase().indexOf(q.toLowerCase());if(idx<0)return;
    const before=document.createTextNode(node.textContent.slice(0,idx));
    const mark=document.createElement('mark');mark.className='search-highlight';mark.textContent=node.textContent.slice(idx,idx+q.length);
    const after=document.createTextNode(node.textContent.slice(idx+q.length));
    const frag=document.createDocumentFragment();frag.appendChild(before);frag.appendChild(mark);frag.appendChild(after);
    node.parentNode.replaceChild(frag,node);
  } else if(node.nodeType===1&&!['SCRIPT','STYLE','BUTTON'].includes(node.tagName)){
    [...node.childNodes].forEach(c=>highlightInNode(c,q));
  }
}
function navSearch(dir){
  if(!searchMatches.length)return;
  searchMatches[searchIdx].classList.remove('current');
  searchIdx=(searchIdx+dir+searchMatches.length)%searchMatches.length;
  searchMatches[searchIdx].classList.add('current');
  searchMatches[searchIdx].scrollIntoView({behavior:'smooth',block:'center'});
  document.getElementById('msg-search-count').textContent=`${searchIdx+1}/${searchMatches.length}`;
}
 
// ── CONFIRM DIALOG ──
let confirmCallback=null;
function openConfirm(cb){
  confirmCallback=cb;
  document.getElementById('confirm-dialog').classList.add('open');
  document.getElementById('confirm-backdrop').classList.add('open');
}
function closeConfirm(){
  document.getElementById('confirm-dialog').classList.remove('open');
  document.getElementById('confirm-backdrop').classList.remove('open');
  confirmCallback=null;
}
document.getElementById('confirm-ok-btn').onclick=()=>{if(confirmCallback)confirmCallback();closeConfirm()};
document.getElementById('confirm-backdrop').onclick=closeConfirm;
 
// ── EXPORT PDF ──
function exportPDF(){
  if(!currentId||!convs[currentId]){toast('Aucune conversation ouverte');return}
  closeSettings();
  const c=convs[currentId];
  let html='<html><head><meta charset="UTF-8"><title>'+c.title+'</title>';
  html+='<style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;color:#111;line-height:1.7}';
  html+='h1{font-size:22px;margin-bottom:4px}.meta{font-size:11px;color:#888;margin-bottom:28px}';
  html+='.msg{margin-bottom:20px;padding:12px 16px;border-radius:8px}';
  html+='.usr{background:#e8f5e9;border-left:3px solid #2d7a50}.ai{background:#f5f5f5;border-left:3px solid #aaa}';
  html+='.role{font-size:10px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:4px}';
  html+='pre{background:#1e1e1e;color:#d4d4d4;padding:10px;border-radius:4px;font-size:12px;overflow-x:auto}';
  html+='code{background:#eee;padding:1px 4px;border-radius:3px;font-size:12px}';
  html+='@media print{body{margin:20px}}</style></head><body>';
  html+='<h1>'+esc(c.title)+'</h1>';
  html+='<div class="meta">Exporté le '+new Date().toLocaleString('fr-FR')+' · '+c.messages.length+' messages</div>';
  c.messages.forEach(m=>{
    if(m.type==='image')return;
    const role=m.role==='user'?'Vous':'IA Performante';
    const cls=m.role==='user'?'usr':'ai';
    const content=(m.displayContent||m.content||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    html+=`<div class="msg ${cls}"><div class="role">${role}</div>${content}</div>`;
  });
  html+='</body></html>';
  const win=window.open('','_blank');
  win.document.write(html);win.document.close();
  setTimeout(()=>{win.print()},400);
  toast('Fenêtre d\'impression ouverte');
}
 
// ── LOAD / SAVE ──
function load(){
  loadSettings();
  try{convs=JSON.parse(localStorage.getItem(CONVS_KEY)||'{}')}catch(e){convs={}}
  currentId=localStorage.getItem(CUR_KEY)||null;
  renderSidebar();
  if(currentId&&convs[currentId])loadConv(currentId);
}
function save(){
  try{localStorage.setItem(CONVS_KEY,JSON.stringify(convs));if(currentId)localStorage.setItem(CUR_KEY,currentId)}
  catch(e){console.warn('localStorage plein',e)}
}
 
// ── EXPORT / IMPORT ──
function exportConvs(){
  const blob=new Blob([JSON.stringify(convs,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='ia_conversations_'+new Date().toISOString().slice(0,10)+'.json';a.click();toast('Conversations exportées');
}
function importConvs(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{const imported=JSON.parse(e.target.result);Object.assign(convs,imported);save();renderSidebar();toast(Object.keys(imported).length+' conversations importées')}
    catch(err){toast('Fichier invalide')}
  };reader.readAsText(file);input.value='';
}
function exportCurrentConv(){
  if(!currentId||!convs[currentId]){toast('Aucune conversation ouverte');return}
  const c=convs[currentId];let txt=`# ${c.title}\n\n`;
  c.messages.forEach(m=>{txt+=`**${m.role==='user'?'Vous':'IA'}** (${new Date(m.ts).toLocaleString('fr-FR')})\n${m.displayContent||m.content}\n\n---\n\n`});
  const blob=new Blob([txt],{type:'text/markdown'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=c.title.replace(/[^a-z0-9]/gi,'_').slice(0,40)+'.md';a.click();closeSettings();toast('Conversation exportée');
}
 
// ── TITRE IA ──
async function generateTitle(){
  if(!currentId||!convs[currentId]){toast('Aucune conversation ouverte');closeSettings();return}
  const c=convs[currentId];if(!c.messages.length){toast('Conversation vide');return}
  closeSettings();
  try{
    const ctx=c.messages.slice(0,4).map(m=>`${m.role}: ${(m.displayContent||m.content||'').slice(0,200)}`).join('\n');
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'llama-3.1-8b-instant',temperature:0.3,stream:false,
        messages:[{role:'user',content:`Génère un titre très court (5 mots max, sans guillemets) pour cette conversation :\n${ctx}`}]})});
    const data=await r.json();
    const title=data.choices?.[0]?.message?.content?.replace(/["'«»]/g,'').trim().slice(0,50);
    if(title){convs[currentId].title=title;chatTitleEl.textContent=title;save();renderSidebar();toast('Titre généré ✨')}
  }catch(e){toast('Erreur génération titre')}
}
 
// ── RENAME ──
function startRename(){
  if(!currentId)return;chatTitleEl.style.display='none';
  const ri=document.getElementById('rename-input');ri.style.display='block';ri.value=convs[currentId]?.title||'';ri.focus();ri.select();
}
function finishRename(){
  const ri=document.getElementById('rename-input');const val=ri.value.trim();
  if(val&&currentId&&convs[currentId]){convs[currentId].title=val;chatTitleEl.textContent=val;save();renderSidebar()}
  ri.style.display='none';chatTitleEl.style.display='';
}
function cancelRename(){document.getElementById('rename-input').style.display='none';chatTitleEl.style.display=''}
 
// ── FILES ──
function fileIcon(name,type){
  if(type&&type.startsWith('image/'))return'🖼️';if(name.endsWith('.pdf'))return'📄';
  if(name.match(/\.(js|ts|jsx|tsx)$/))return'📜';if(name.endsWith('.py'))return'🐍';
  if(name.match(/\.(html|css)$/))return'🌐';if(name.match(/\.(json|csv|xml|yaml|yml)$/))return'📊';return'📝';
}
function fmtSize(b){if(b<1024)return b+'o';if(b<1048576)return(b/1024).toFixed(0)+'Ko';return(b/1048576).toFixed(1)+'Mo'}
 
async function extractPdfText(file){
  return new Promise(resolve=>{
    const reader=new FileReader();
    reader.onload=async e=>{
      try{const pdf=await pdfjsLib.getDocument({data:e.target.result}).promise;let text='';
        for(let i=1;i<=Math.min(pdf.numPages,20);i++){const page=await pdf.getPage(i);const content=await page.getTextContent();text+=content.items.map(s=>s.str).join(' ')+'\n'}
        resolve(text.trim()||'[PDF sans texte extractible]')}catch(err){resolve('[Erreur PDF: '+err.message+']')}
    };reader.onerror=()=>resolve('[Erreur lecture]');reader.readAsArrayBuffer(file);
  });
}
async function extractText(file){return new Promise(resolve=>{const r=new FileReader();r.onload=e=>resolve(e.target.result||'');r.onerror=()=>resolve('[Erreur]');r.readAsText(file,'utf-8')})}
async function readImageAsDataUrl(file){return new Promise(resolve=>{const r=new FileReader();r.onload=e=>resolve(e.target.result);r.onerror=()=>resolve(null);r.readAsDataURL(file)})}
 
async function handleFiles(fileList){
  const MAX=5,MAX_SIZE=10*1024*1024;
  for(const file of Array.from(fileList)){
    if(pendingFiles.length>=MAX){toast('Maximum 5 fichiers');break}
    if(file.size>MAX_SIZE){toast(file.name+' trop lourd (max 10Mo)');continue}
    const idx=pendingFiles.length;
    pendingFiles.push({name:file.name,size:file.size,type:file.type,text:'',isImage:false,dataUrl:null,loading:true});
    renderFilePreview();
    const isImg=file.type.startsWith('image/'),isPdf=file.name.endsWith('.pdf')||file.type==='application/pdf';
    let text='',isImage=false,dataUrl=null;
    if(isImg){
      isImage=true;
      dataUrl=await readImageAsDataUrl(file);
      text=`[Image jointe: ${file.name} (${fmtSize(file.size)})]`;
      // Notification si le modèle actuel ne supporte pas la vision
      if(!VISION_MODELS.includes(currentModel)){
        toast(`🖼️ Image détectée → passage auto sur ${DEFAULT_VISION_MODEL.split('/').pop()}`);
      }
    }
    else if(isPdf){text=window.pdfjsLib?(await extractPdfText(file)).slice(0,6000):'[PDF.js non disponible]'}
    else{text=(await extractText(file)).slice(0,6000)}
    pendingFiles[idx]={name:file.name,size:file.size,type:file.type,text,isImage,dataUrl,loading:false};
    renderFilePreview();updateSendBtn();
  }
  document.getElementById('file-input').value='';
}
 
function renderFilePreview(){
  filePreviewBar.innerHTML='';
  if(!pendingFiles.length){filePreviewBar.classList.remove('has-files');return}
  filePreviewBar.classList.add('has-files');
  pendingFiles.forEach((f,i)=>{
    const chip=document.createElement('div');chip.className='file-chip';
    if(f.loading){chip.innerHTML=`<span class="file-chip-icon">⏳</span><span class="file-chip-name">${esc(f.name)}</span>`}
    else if(f.isImage&&f.dataUrl){chip.innerHTML=`<img src="${f.dataUrl}" style="width:26px;height:26px;border-radius:4px;object-fit:cover;flex-shrink:0"><span class="file-chip-name">${esc(f.name)}</span><span class="file-chip-size">${fmtSize(f.size)}</span><button class="file-chip-del" onclick="removeFile(${i})">×</button>`}
    else{chip.innerHTML=`<span class="file-chip-icon">${fileIcon(f.name,f.type)}</span><span class="file-chip-name">${esc(f.name)}</span><span class="file-chip-size">${fmtSize(f.size)}</span><button class="file-chip-del" onclick="removeFile(${i})">×</button>`}
    filePreviewBar.appendChild(chip);
  });
}
function removeFile(i){pendingFiles.splice(i,1);renderFilePreview();updateSendBtn()}
function updateSendBtn(){sb.disabled=(!ta.value.trim()&&!pendingFiles.length)||loading||pendingFiles.some(f=>f.loading)}
 
// ── SIDEBAR ──
function renderSidebar(){
  const el=document.getElementById('sidebar-list');
  const query=(document.getElementById('search-input')?.value||'').toLowerCase().trim();
  let list=Object.values(convs).sort((a,b)=>b.date-a.date);
  if(query)list=list.filter(c=>c.title.toLowerCase().includes(query)||(c.messages||[]).some(m=>(m.displayContent||m.content||'').toLowerCase().includes(query)));
  if(!list.length){el.innerHTML='<div style="padding:20px 14px;text-align:center;font-size:11px;color:var(--text4);line-height:1.6">'+(query?'Aucun résultat':'Aucune conversation<br>Commencez à écrire !')+'</div>';return}
  const today=new Date();today.setHours(0,0,0,0);
  const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
  const week=new Date(today);week.setDate(week.getDate()-7);
  const groups={"Aujourd'hui":[],"Hier":[],"Cette semaine":[],"Plus ancien":[]};
  list.forEach(c=>{const d=new Date(c.date);d.setHours(0,0,0,0);if(d>=today)groups["Aujourd'hui"].push(c);else if(d>=yesterday)groups["Hier"].push(c);else if(d>=week)groups["Cette semaine"].push(c);else groups["Plus ancien"].push(c)});
  el.innerHTML='';
  Object.entries(groups).forEach(([label,items])=>{
    if(!items.length)return;
    const g=document.createElement('div');
    g.innerHTML=`<div class="group-label">${label}</div>`;
    items.forEach(c=>{
      const item=document.createElement('div');
      item.className='conv-item'+(c.id===currentId?' active':'');
      const msgs=c.messages||[];const icon=msgs.length>10?'🔥':msgs.length>4?'💬':'✨';
      item.innerHTML=`
        <div class="conv-icon">${icon}</div>
        <div class="conv-text">
          <div class="conv-title">${esc(c.title)}</div>
          <div class="conv-date">${fmtDate(c.date)} · ${msgs.length} msg</div>
        </div>
        <div class="conv-actions">
          <button class="conv-action-btn" onclick="startRenameConv('${c.id}',event)" title="Renommer">✏️</button>
          <button class="conv-action-btn del" onclick="delConv('${c.id}',event)" title="Supprimer">🗑️</button>
        </div>`;
      item.onclick=e=>{if(!e.target.closest('.conv-actions')){loadConv(c.id);closeSidebar()}};
      g.appendChild(item);
    });
    el.appendChild(g);
  });
}
function startRenameConv(id,e){
  e.stopPropagation();const newTitle=prompt('Nouveau nom :',convs[id]?.title||'');
  if(newTitle&&newTitle.trim()){convs[id].title=newTitle.trim();if(currentId===id)chatTitleEl.textContent=newTitle.trim();save();renderSidebar()}
}
function esc(t){return(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fmtDate(ts){const d=new Date(ts),now=new Date();if(d.toDateString()===now.toDateString())return d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});return d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'})}
function fmtTime(ts){return new Date(ts).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}
 
// ── CONVERSATIONS ──
function newChat(){
  currentId=null;pendingFiles=[];renderFilePreview();
  msgEl.innerHTML='';emptyState.style.display='flex';
  chatTitleEl.textContent='Nouvelle conversation';
  localStorage.removeItem(CUR_KEY);renderSidebar();closeSidebar();ta.focus();lastAssistantRow=null;
  updateTokenDisplay();updateCtxBar();
}
function loadConv(id){
  currentId=id;const c=convs[id];if(!c)return;
  msgEl.innerHTML='';emptyState.style.display='none';
  chatTitleEl.textContent=c.title;lastAssistantRow=null;
  c.messages.forEach(m=>{
    if(m.type==='image')addMsgImageDOM(m.url,m.ts);
    else{const row=addMsgDOM(m.role,m.displayContent||m.content,m.ts,m.chips||[],m.id);if(m.role==='assistant')lastAssistantRow=row;}
  });
  localStorage.setItem(CUR_KEY,id);renderSidebar();msgEl.scrollTop=msgEl.scrollHeight;
  updateTokenDisplay();updateCtxBar();
}
function delConv(id,e){
  e.stopPropagation();
  openConfirm(()=>{delete convs[id];if(currentId===id)newChat();save();renderSidebar();toast('Conversation supprimée')});
}
function getOrCreate(firstMsg){
  if(!currentId||!convs[currentId]){
    const id='c'+Date.now();const title=firstMsg.length>42?firstMsg.slice(0,42)+'…':firstMsg;
    convs[id]={id,title,messages:[],date:Date.now()};
    currentId=id;emptyState.style.display='none';chatTitleEl.textContent=title;
  }
  return convs[currentId];
}
 
// ── MARKDOWN ──
function fmtMd(text){
  text=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  text=text.replace(/```(\w*)\n?([\s\S]*?)```/g,(m,lang,code)=>{
    const highlighted=lang&&hljs.getLanguage(lang)?hljs.highlight(code.trim(),{language:lang}).value:hljs.highlightAuto(code.trim()).value;
    return `<pre style="position:relative"><button class="copy-code-btn" onclick="copyCode(this)">Copier</button><code class="hljs">${highlighted}</code></pre>`;
  });
  text=text.replace(/`([^`]+)`/g,'<code>$1</code>');
  text=text.replace(/^### (.+)$/gm,'<h3>$1</h3>');text=text.replace(/^## (.+)$/gm,'<h2>$1</h2>');text=text.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  text=text.replace(/\*\*\*([^*]+)\*\*\*/g,'<strong><em>$1</em></strong>');text=text.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');text=text.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  text=text.replace(/^\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/gm,(m,header,rows)=>{
    const th=header.split('|').filter(Boolean).map(c=>`<th>${c.trim()}</th>`).join('');
    const trs=rows.trim().split('\n').map(r=>'<tr>'+r.split('|').filter(Boolean).map(c=>`<td>${c.trim()}</td>`).join('')+'</tr>').join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  });
  text=text.replace(/^(\s*[-*+] .+(\n\s*[-*+] .+)*)/gm,block=>{const items=block.trim().split('\n').map(l=>'<li>'+l.replace(/^\s*[-*+] /,'')+'</li>').join('');return'<ul>'+items+'</ul>'});
  text=text.replace(/^(\s*\d+\. .+(\n\s*\d+\. .+)*)/gm,block=>{const items=block.trim().split('\n').map(l=>'<li>'+l.replace(/^\s*\d+\. /,'')+'</li>').join('');return'<ol>'+items+'</ol>'});
  text=text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  text=text.replace(/\n/g,'<br>');return text;
}
function copyCode(btn){
  const code=btn.nextElementSibling.textContent;
  navigator.clipboard.writeText(code).then(()=>{btn.textContent='✓ Copié';setTimeout(()=>btn.textContent='Copier',1500)});
}
function copyLastCode(){
  const blocks=[...msgEl.querySelectorAll('.bubble.ai pre code')];
  if(!blocks.length){toast('Aucun bloc de code trouvé');return}
  navigator.clipboard.writeText(blocks[blocks.length-1].textContent).then(()=>toast('Dernier code copié ✓'));
}
 
// ── TTS ──
function ttsMsg(btn){
  if(!window.speechSynthesis){toast('TTS non supporté dans ce navigateur');return}
  if(currentTTS){
    speechSynthesis.cancel();currentTTS=null;
    document.querySelectorAll('.tts-btn').forEach(b=>{b.textContent='🔊';b.dataset.playing='0'});
    if(btn.dataset.playing==='1')return;
  }
  const text=btn.closest('.row').querySelector('.bubble').innerText||'';
  const utt=new SpeechSynthesisUtterance(text);utt.lang='fr-FR';utt.rate=1;
  utt.onend=()=>{btn.textContent='🔊';btn.dataset.playing='0';currentTTS=null};
  btn.textContent='⏹';btn.dataset.playing='1';currentTTS=utt;speechSynthesis.speak(utt);
}
 
// ── DOM ──
function addMsgDOM(role,content,ts,chips,msgId){
  const now=ts||Date.now();
  const mid=msgId||('m'+now+Math.random().toString(36).slice(2,6));
  const row=document.createElement('div');row.className='row '+(role==='user'?'user':'assistant');row.dataset.mid=mid;
  if(role==='assistant'){
    const a=document.createElement('div');a.className='av ai';
    a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.8" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
    row.appendChild(a);
  }
  const wrap=document.createElement('div');wrap.style.cssText='display:flex;flex-direction:column;max-width:76%';
  const b=document.createElement('div');b.className='bubble '+(role==='user'?'usr':'ai');
  if(role==='assistant'){b.innerHTML=fmtMd(content||'')}
  else{
    if(content)b.appendChild(document.createTextNode(content));
    (chips||[]).forEach(chip=>{
      if(chip.isImage&&chip.dataUrl){
        const img=document.createElement('img');img.src=chip.dataUrl;img.className='msg-img-preview';img.alt=chip.name;b.appendChild(img);
      } else {
        const d=document.createElement('div');d.className='msg-file-chip';
        d.innerHTML=`${fileIcon(chip.name,chip.type)} ${esc(chip.name)} <span style="opacity:.6;font-size:9.5px;margin-left:3px">${fmtSize(chip.size)}</span>`;
        b.appendChild(d);
      }
    });
  }
  wrap.appendChild(b);
  const timeDiv=document.createElement('div');timeDiv.className='msg-time';timeDiv.textContent=fmtTime(now);wrap.appendChild(timeDiv);
  const actions=document.createElement('div');actions.className='msg-actions';
  if(role==='assistant'){
    actions.innerHTML=`<button class="msg-action" onclick="copyMsg(this)">📋 Copier</button><button class="msg-action" onclick="regenerate()">🔄 Régénérer</button><button class="msg-action tts-btn" onclick="ttsMsg(this)" data-playing="0">🔊</button>`;
  } else {
    actions.innerHTML=`<button class="msg-action" onclick="copyMsg(this)">📋 Copier</button><button class="msg-action" onclick="editMsg(this)">✏️ Modifier</button>`;
  }
  wrap.appendChild(actions);row.appendChild(wrap);
  if(role==='user'){const a=document.createElement('div');a.className='av usr';a.textContent='👤';row.appendChild(a)}
  msgEl.appendChild(row);msgEl.scrollTop=msgEl.scrollHeight;setTimeout(updateScrollBtn,50);
  return row;
}
 
function addMsgImageDOM(url,ts){
  const now=ts||Date.now();
  const row=document.createElement('div');row.className='row assistant';
  const a=document.createElement('div');a.className='av ai';
  a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.8" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  row.appendChild(a);
  const wrap=document.createElement('div');wrap.style.cssText='display:flex;flex-direction:column;max-width:76%';
  const b=document.createElement('div');b.className='bubble ai img-bubble';
  const loadDiv=document.createElement('div');loadDiv.className='img-loading';
  loadDiv.innerHTML='<div class="img-loading-spinner"></div><span>Génération en cours…</span>';
  b.appendChild(loadDiv);
  const img=document.createElement('img');img.style.display='none';img.alt='Image générée';
  img.onload=()=>{loadDiv.remove();img.style.display='block';msgEl.scrollTop=msgEl.scrollHeight};
  img.onerror=()=>{loadDiv.innerHTML='❌ Échec du chargement'};
  img.src=url;b.appendChild(img);wrap.appendChild(b);
  const t=document.createElement('div');t.className='msg-time';t.textContent=fmtTime(now);wrap.appendChild(t);
  row.appendChild(wrap);msgEl.appendChild(row);msgEl.scrollTop=msgEl.scrollHeight;return row;
}
 
function copyMsg(btn){
  const bubble=btn.closest('.row').querySelector('.bubble');
  const text=bubble.innerText||bubble.textContent;
  navigator.clipboard.writeText(text).then(()=>{btn.textContent='✓ Copié';setTimeout(()=>btn.textContent='📋 Copier',1500)});
}
 
function editMsg(btn){
  const row=btn.closest('.row');const mid=row.dataset.mid;const bubble=row.querySelector('.bubble');
  const original=bubble.textContent||'';
  bubble.innerHTML='';
  const editTA=document.createElement('textarea');editTA.className='edit-textarea';editTA.value=original;
  editTA.style.height='auto';bubble.appendChild(editTA);
  editTA.style.height=editTA.scrollHeight+'px';
  editTA.addEventListener('input',()=>{editTA.style.height='auto';editTA.style.height=editTA.scrollHeight+'px'});
  const editActions=document.createElement('div');editActions.className='edit-actions';
  const saveBtn=document.createElement('button');saveBtn.className='edit-save';saveBtn.textContent='↵ Renvoyer';
  const cancelBtn=document.createElement('button');cancelBtn.className='edit-cancel';cancelBtn.textContent='Annuler';
  editActions.appendChild(saveBtn);editActions.appendChild(cancelBtn);bubble.appendChild(editActions);
  cancelBtn.onclick=()=>{bubble.innerHTML=original};
  saveBtn.onclick=async()=>{
    const newText=editTA.value.trim();if(!newText||loading)return;
    bubble.innerHTML=newText;
    const c=convs[currentId];if(!c)return;
    const rows=[...msgEl.querySelectorAll('.row')];const rowIdx=rows.indexOf(row);
    rows.slice(rowIdx+1).forEach(r=>r.remove());
    let histIdx=c.messages.findIndex(m=>m.id===mid);
    if(histIdx<0)histIdx=c.messages.length-1;
    c.messages[histIdx].content=newText;c.messages[histIdx].displayContent=newText;
    c.messages.splice(histIdx+1);
    lastAssistantRow=null;save();
    loading=true;setStopVisible(true);sb.disabled=true;
    try{const api=buildApiMessages(c.messages.slice(-20));await streamReply(api)}
    finally{loading=false;setStopVisible(false);updateSendBtn()}
  };
  editTA.focus();
}
 
function addMsg(role,displayContent,apiContent,chips){
  const ts=Date.now();const mid='m'+ts+Math.random().toString(36).slice(2,6);
  const row=addMsgDOM(role,displayContent,ts,chips||[],mid);
  if(role==='assistant')lastAssistantRow=row;
  const c=convs[currentId];
  if(c){
    c.messages.push({
      id:mid,role,
      // Pour les messages avec images, on stocke le content multipart
      content: (chips||[]).some(ch=>ch.isImage)
        ? buildMultipartContent(displayContent, chips.filter(ch=>ch.isImage))
        : (typeof apiContent==='string'?apiContent:displayContent),
      displayContent,ts,
      chips:(chips||[]).map(ch=>({name:ch.name,size:ch.size,type:ch.type,isImage:ch.isImage,dataUrl:ch.isImage?ch.dataUrl:null}))
    });
    c.date=ts;save();renderSidebar();updateTokenDisplay();updateCtxBar();
  }
}
 
function addMsgImage(url){
  const ts=Date.now();addMsgImageDOM(url,ts);
  const c=convs[currentId];
  if(c){c.messages.push({type:'image',role:'assistant',url,content:'[Image générée]',displayContent:'[Image générée]',ts});c.date=ts;save();renderSidebar()}
}
 
function addTyping(){
  const row=document.createElement('div');row.className='row assistant';row.id='typing';
  const a=document.createElement('div');a.className='av ai pulse';
  a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.8" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  row.appendChild(a);
  const b=document.createElement('div');b.className='bubble ai';
  b.innerHTML='<div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
  row.appendChild(b);msgEl.appendChild(row);msgEl.scrollTop=msgEl.scrollHeight;
}
function rmTyping(){const e=document.getElementById('typing');if(e)e.remove()}
 
// ── VISION : construction du contenu multipart ──
// Transforme un message texte + images en format OpenAI vision
function buildMultipartContent(text, imageChips){
  const parts=[];
  // Ajoute le texte en premier s'il y en a
  if(text&&text.trim()){
    parts.push({type:'text',text:text.trim()});
  }
  // Ajoute chaque image en base64
  imageChips.forEach(chip=>{
    if(chip.dataUrl){
      // dataUrl = "data:image/jpeg;base64,XXXX"
      const [header,b64]=chip.dataUrl.split(',');
      const mimeMatch=header.match(/data:([^;]+);/);
      const mime=mimeMatch?mimeMatch[1]:'image/jpeg';
      parts.push({
        type:'image_url',
        image_url:{
          url:`data:${mime};base64,${b64}`,
          detail:'auto'
        }
      });
    }
  });
  return parts;
}
 
// ── CONSTRUCTION DES MESSAGES API ──
// Gère le format texte simple ET le format vision multipart
function buildApiMessages(storedMessages){
  return storedMessages.map(m=>{
    // Si le contenu est déjà un tableau (multipart vision), on le passe directement
    if(Array.isArray(m.content)){
      return {role:m.role, content:m.content};
    }
    // Sinon contenu texte simple
    return {role:m.role, content:String(m.content||'')};
  });
}
 
// ── STREAMING ──
async function streamReply(apiMessages, forcedModel){
  addTyping();
  const temp=parseFloat(document.getElementById('temp-slider').value)||0.7;
  // Choisit le bon modèle : forcé > modèle courant > fallback vision si image détectée
  const modelToUse = forcedModel || (hasImageInMessages(apiMessages) && !VISION_MODELS.includes(currentModel)
    ? DEFAULT_VISION_MODEL
    : currentModel);
 
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:apiMessages,model:modelToUse,temperature:temp,systemPrompt:settings.systemPrompt||undefined,stream:true})});
    if(!r.ok){const err=await r.json().catch(()=>({error:{message:'Erreur '+r.status}}));throw new Error(err?.error?.message||'Erreur '+r.status)}
    rmTyping();
    const row=document.createElement('div');row.className='row assistant';
    const a=document.createElement('div');a.className='av ai';
    a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.8" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
    row.appendChild(a);
    const wrap=document.createElement('div');wrap.style.cssText='display:flex;flex-direction:column;max-width:76%';
    const b=document.createElement('div');b.className='bubble ai';b.innerHTML='';
    wrap.appendChild(b);
    const t=document.createElement('div');t.className='msg-time';t.textContent=fmtTime(Date.now());wrap.appendChild(t);
    row.appendChild(wrap);msgEl.appendChild(row);
    const reader=r.body.getReader();currentReader=reader;
    const decoder=new TextDecoder();let fullText='',buffer='';
    while(true){
      const{done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split('\n');buffer=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')break;
        try{const parsed=JSON.parse(data);const delta=parsed.choices?.[0]?.delta?.content||'';if(delta){fullText+=delta;b.innerHTML=fmtMd(fullText);msgEl.scrollTop=msgEl.scrollHeight}}catch(e){}
      }
    }
    currentReader=null;
    const actions=document.createElement('div');actions.className='msg-actions';
    actions.innerHTML=`<button class="msg-action" onclick="copyMsg(this)">📋 Copier</button><button class="msg-action" onclick="regenerate()">🔄 Régénérer</button><button class="msg-action tts-btn" onclick="ttsMsg(this)" data-playing="0">🔊</button>`;
    wrap.appendChild(actions);lastAssistantRow=row;
    const mid='m'+Date.now()+Math.random().toString(36).slice(2,6);row.dataset.mid=mid;
    const c=convs[currentId];
    if(c){c.messages.push({id:mid,role:'assistant',content:fullText,displayContent:fullText,ts:Date.now(),chips:[]});c.date=Date.now();save();renderSidebar();updateTokenDisplay();updateCtxBar()}
    return fullText;
  }catch(e){
    rmTyping();currentReader=null;
    if(e.name!=='AbortError')addMsg('assistant','❌ '+e.message,'❌ '+e.message,[]);
    throw e;
  }
}
 
// ── REGENERATE ──
async function regenerate(){
  if(!currentId||loading)return;
  const c=convs[currentId];if(!c)return;
  const msgs=c.messages;
  if(msgs[msgs.length-1]?.role==='assistant'){msgs.pop();c.date=Date.now();save()}
  if(lastAssistantRow&&lastAssistantRow.parentNode)lastAssistantRow.remove();
  lastAssistantRow=null;loading=true;sb.disabled=true;setStopVisible(true);
  try{const apiMessages=buildApiMessages(c.messages.slice(-20));await streamReply(apiMessages)}
  finally{loading=false;setStopVisible(false);updateSendBtn()}
}
 
// ── INPUT ──
ta.addEventListener('input',()=>{
  ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,120)+'px';
  updateSendBtn();document.getElementById('char-count').textContent=ta.value.length>0?ta.value.length+' car.':'';
});
ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!sb.disabled)send()}});
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();newChat()}
  if((e.ctrlKey||e.metaKey)&&e.key==='r'){e.preventDefault();regenerate()}
  if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();openMsgSearch()}
  if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key==='C'){e.preventDefault();copyLastCode()}
  if(e.key==='Escape'){
    stopGeneration();
    if(document.getElementById('msg-search-bar').classList.contains('open'))closeMsgSearch();
  }
});
function fill(t){ta.value=t;ta.dispatchEvent(new Event('input'));ta.focus()}
 
// ── IMAGE GENERATION ──
function isImageRequest(text){return /génèr|créer?\s+une\s+image|dessine?|imagine?\s+une|fais\s+(moi\s+)?une\s+(image|photo|illustration)|image\s+de\s+/i.test(text)}
function buildImagePrompt(text){return text.replace(/génère(r)?\s+(une\s+)?(image|photo|illustration)\s*(de|d'|du|des)?/i,'').replace(/crée(r)?\s+(une\s+)?(image|photo|illustration)\s*(de|d'|du|des)?/i,'').replace(/dessine(r)?\s+(un[e]?\s+)?/i,'').replace(/fais\s+(moi\s+)?(une\s+)?(image|photo|illustration)\s*(de|d'|du|des)?/i,'').trim()||text}
 
// ── SEND ──
async function send(){
  const text=ta.value.trim();const files=[...pendingFiles];
  if(!text&&!files.length)return;
  if(files.some(f=>f.loading)){toast('Lecture des fichiers en cours…');return}
  if(loading){stopGeneration();await new Promise(r=>setTimeout(r,80))}
 
  const firstMsg=text||(files[0]?.name||'Fichier');
  getOrCreate(firstMsg);
 
  ta.value='';ta.style.height='auto';pendingFiles=[];renderFilePreview();
  loading=true;setStopVisible(true);sb.disabled=true;document.getElementById('char-count').textContent='';
 
  const chips=files.map(f=>({name:f.name,size:f.size,type:f.type,isImage:f.isImage,dataUrl:f.dataUrl}));
  const imageChips=chips.filter(c=>c.isImage&&c.dataUrl);
  const textChips=chips.filter(c=>!c.isImage);
 
  // Parties texte des fichiers non-image
  const fileParts=textChips.map(f=>{
    const t=files.find(ff=>ff.name===f.name);
    const txt=t&&t.text?t.text.slice(0,5000):'';
    return`=== Fichier: ${f.name} ===\n${txt}\n=== Fin ===`;
  });
 
  // ── Si images présentes → format vision multipart ──
  let apiContent;
  if(imageChips.length>0){
    apiContent=buildMultipartContent([...fileParts,text].filter(Boolean).join('\n\n'), imageChips);
  } else {
    // Pas d'image → texte simple
    apiContent=[...fileParts,text].filter(Boolean).join('\n\n');
    // Génération d'image Pollinations
    if(!files.length&&isImageRequest(text)){
      addMsg('user',text,text,[]);addTyping();await new Promise(r=>setTimeout(r,200));rmTyping();
      const prompt=encodeURIComponent(buildImagePrompt(text));const seed=Math.floor(Math.random()*99999);
      addMsgImage(`https://image.pollinations.ai/prompt/${prompt}?width=512&height=512&nologo=true&seed=${seed}`);
      loading=false;setStopVisible(false);updateSendBtn();return;
    }
  }
 
  addMsg('user',text,apiContent,chips);
 
  try{
    const apiMessages=buildApiMessages(convs[currentId].messages.slice(-20));
    // Si images dans ce tour → forcer un modèle vision
    const forcedModel=imageChips.length>0&&!VISION_MODELS.includes(currentModel)?DEFAULT_VISION_MODEL:null;
    await streamReply(apiMessages, forcedModel);
  }finally{loading=false;setStopVisible(false);updateSendBtn()}
}
 
// ── SIDEBAR MOBILE ──
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('overlay').classList.toggle('open')}
function closeSidebar(){document.getElementById('sidebar').classList.remove('open');document.getElementById('overlay').classList.remove('open')}
 
// ── TOAST ──
function toast(msg,duration=2500){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(t._to);t._to=setTimeout(()=>t.classList.remove('show'),duration);
}
 
load();
