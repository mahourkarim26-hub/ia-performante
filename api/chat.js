async function send(){
  const text=ta.value.trim();
  const files=[...pendingFiles];
  if(!text&&!files.length||loading) return;

  const firstMsg=text||(files[0]?.name||'Fichier');
  const conv=getOrCreate(firstMsg);

  ta.value='';ta.style.height='auto';
  pendingFiles=[];renderFilePreview();
  sb.disabled=true;loading=true;charCount.textContent='';

  // Affiche le message utilisateur avec pièces jointes
  const displayAtts=files.map(f=>({name:f.name,size:f.size,type:f.type,isImage:f.isImage,dataUrl:f.isImage?f.content:null}));
  addMsg('user', text, displayAtts);

  // Génération d'image ?
  if(!files.length && isImageRequest(text)){
    addTyping();
    await new Promise(r=>setTimeout(r,300));
    rmTyping();
    const prompt=encodeURIComponent(buildImagePrompt(text));
    const seed=Math.floor(Math.random()*99999);
    const url=`https://image.pollinations.ai/prompt/${prompt}?width=512&height=512&nologo=true&seed=${seed}`;
    addMsgImage(url);
    loading=false;updateSendBtn();
    return;
  }

  addTyping();
  try{
    // Historique des messages précédents (sans le dernier qu'on vient d'ajouter)
    const history=conv.messages.slice(0,-1).slice(-18).map(m=>({
      role:m.role,
      content:m.content||''
    }));

    // Message actuel avec le vrai contenu des fichiers injecté
    const fileContents=files.map(f=>{
      if(f.isImage){
        return `[Image jointe : ${f.name} - l'utilisateur a joint une image, décris ce que tu ferais avec si tu pouvais la voir]`;
      } else {
        const c=f.content.length>4000?f.content.slice(0,4000)+'…[tronqué]':f.content;
        return `[Fichier joint : ${f.name}]\n\`\`\`\n${c}\n\`\`\``;
      }
    }).join('\n\n');

    const fullContent=[fileContents, text].filter(Boolean).join('\n\n');

    const apiMessages=[
      ...history,
      {role:'user', content:fullContent}
    ];

    const r=await fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:apiMessages})
    });
    const d=await r.json();
    if(!r.ok) throw new Error(d?.error?.message||'Erreur '+r.status);
    const reply=d.choices?.[0]?.message?.content||'Aucune réponse.';
    rmTyping();addMsg('assistant',reply);
  }catch(e){
    rmTyping();addMsg('assistant','❌ '+e.message);
  }finally{
    loading=false;updateSendBtn();
  }
}
