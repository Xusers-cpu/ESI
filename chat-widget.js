(() => {
  const root = document.createElement('div'); root.id = 'esi-chat-root';
  root.innerHTML = `
    <section class="esi-panel" id="esi-panel" role="dialog" aria-label="Study Circle community" aria-modal="false">
      <header class="esi-head"><div class="esi-brand"><div class="esi-brand-mark">✦</div><div><strong>Study Circle</strong><small>Community conversations</small></div></div><button class="esi-close" id="esi-close" aria-label="Close panel">×</button></header>
      <div class="esi-body" id="esi-body"><p class="esi-muted">Connect with learners who have chosen to join the study community.</p><div class="esi-note esi-muted">Sign in to see opted-in members and exchange study-related messages. Keep personal information private and report anything uncomfortable to a trusted adult.</div><div id="esi-auth-area"></div></div>
      <div class="esi-foot">Be respectful · Never share passwords or private details</div>
    </section>
    <button class="esi-launcher" id="esi-launcher" aria-expanded="false" aria-controls="esi-panel"><span class="esi-launch-icon">✦</span><span>Study Circle</span></button>`;
  document.body.appendChild(root);
  const panel = root.querySelector('#esi-panel'), launcher = root.querySelector('#esi-launcher'), body = root.querySelector('#esi-body');
  const authArea = root.querySelector('#esi-auth-area');
  let supabase = null, currentUser = null, currentPeer = null, realtime = null, loading = false, poll = null, lastSig = null;
  const stopPoll = () => { if(poll){clearInterval(poll);poll=null;} };
  const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status = (msg, cls='esi-error') => { const el = body.querySelector('#esi-status'); if(el) el.innerHTML = `<div class="${cls}" role="status">${esc(msg)}</div>`; };
  const toggle = (open) => { panel.classList.toggle('esi-open',open); launcher.setAttribute('aria-expanded',String(open)); if(open) setTimeout(()=>{const f=panel.querySelector('input'); if(f) f.focus();},50); };
  launcher.addEventListener('click',()=>toggle(!panel.classList.contains('esi-open')));
  root.querySelector('#esi-close').addEventListener('click',()=>toggle(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')toggle(false)});

  function setupMessage() {
    authArea.innerHTML = `<p class="esi-error">Study Circle isn't connected yet.</p><p class="esi-muted">To enable the member directory and messaging, add your Supabase project URL and public anon key in <code>assets/supabase-config.js</code>, then run the included SQL setup script. Do not add a service-role key to a public website.</p><a href="SUPABASE_SETUP.md" target="_blank" rel="noopener" class="esi-muted">Open setup guide ↗</a>`;
  }
  function showAuth() {
    authArea.innerHTML = `<div class="esi-toolbar"><button class="esi-btn" id="esi-signin-tab">Sign in</button><button class="esi-btn esi-light" id="esi-signup-tab">Create account</button></div><div id="esi-auth-form"></div><div id="esi-status"></div>`;
    const form = authArea.querySelector('#esi-auth-form');
    const draw = (signup) => {
      form.innerHTML = `${signup?'<input class="esi-field" id="esi-username" maxlength="24" autocomplete="nickname" placeholder="Username (letters, numbers, _)">':''}<input class="esi-field" id="esi-email" type="email" autocomplete="email" placeholder="Email address"><input class="esi-field" id="esi-password" type="password" autocomplete="${signup?'new-password':'current-password'}" minlength="8" placeholder="Password (at least 8 characters)">${signup?'<label class="esi-optin"><input id="esi-optin" type="checkbox"><span>I choose to appear in the Study Circle member directory so other opted-in members can message me.</span></label>':''}<button class="esi-btn" id="esi-submit" style="width:100%">${signup?'Create account':'Sign in'}</button><div id="esi-status"></div>`;
      form.querySelector('#esi-submit').addEventListener('click',async()=>{
        const email=form.querySelector('#esi-email').value.trim(), password=form.querySelector('#esi-password').value;
        const btn=form.querySelector('#esi-submit'); btn.disabled=true; btn.textContent='Please wait…';
        try {
          if(signup){
            const username=form.querySelector('#esi-username').value.trim();
            if(!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error('Username must be 3–24 characters using letters, numbers or _.');
            if(!form.querySelector('#esi-optin').checked) throw new Error('Please choose whether to join the member directory.');
            const {data,error}=await supabase.auth.signUp({email,password,options:{data:{username}}}); if(error) throw error;
            currentUser=data.user;
            if(!data.session){ status('Check your email to confirm your account, then return here to sign in.','esi-success'); }
            else { await ensureProfile(username,true); await loadDirectory(); }
          } else { const {error}=await supabase.auth.signInWithPassword({email,password}); if(error) throw error; await initSession(); }
        } catch(e){ status(e.message || 'Could not complete this action.'); }
        finally {btn.disabled=false;btn.textContent=signup?'Create account':'Sign in';}
      });
    };
    authArea.querySelector('#esi-signin-tab').onclick=()=>draw(false); authArea.querySelector('#esi-signup-tab').onclick=()=>draw(true); draw(false);
  }
  async function ensureProfile(username, listed) {
    const {error}=await supabase.from('profiles').upsert({user_id:currentUser.id,username,display_name:username,is_listed:listed},{onConflict:'user_id'}); if(error) throw error;
  }
  async function initSession(){
    const {data:{user},error}=await supabase.auth.getUser(); if(error) throw error; currentUser=user;
    if(!user){currentPeer=null;showAuth();return;}
    const {data:profile,error:pe}=await supabase.from('profiles').select('username,is_listed').eq('user_id',user.id).maybeSingle();
    if(pe) throw pe;
    if(!profile){
      const username=(user.user_metadata?.username||'').toString();
      if(username){await ensureProfile(username,false);} else {showProfileSetup();return;}
    }
    showDirectoryShell(); await loadDirectory();
  }
  function showProfileSetup(){
    authArea.innerHTML=`<p><strong>Finish your community profile</strong></p><input class="esi-field" id="esi-profile-name" maxlength="24" placeholder="Username (3–24 characters)"><label class="esi-optin"><input type="checkbox" id="esi-profile-optin"><span>List me in the Study Circle directory. Other opted-in members can message me.</span></label><button class="esi-btn" id="esi-profile-save">Save profile</button><div id="esi-status"></div>`;
    authArea.querySelector('#esi-profile-save').onclick=async()=>{try{const n=authArea.querySelector('#esi-profile-name').value.trim();if(!/^[a-zA-Z0-9_]{3,24}$/.test(n))throw Error('Use 3–24 letters, numbers or _.');await ensureProfile(n,authArea.querySelector('#esi-profile-optin').checked);await showDirectoryShell();await loadDirectory();}catch(e){status(e.message)}};
  }
  function showDirectoryShell(){
    currentPeer=null;
    body.innerHTML=`<div class="esi-toolbar"><input class="esi-field" id="esi-search" placeholder="Find a study member…" aria-label="Search members"><button class="esi-btn esi-light" id="esi-refresh" title="Refresh directory">↻</button></div><div class="esi-muted" style="margin-bottom:8px">Members who opted in to the Study Circle</div><div id="esi-directory"><p class="esi-muted">Loading members…</p></div><div id="esi-status"></div><div class="esi-actions"><button class="esi-btn esi-light" id="esi-profile-toggle">Directory settings</button><button class="esi-btn esi-light" id="esi-signout">Sign out</button></div>`;
    body.querySelector('#esi-refresh').onclick=loadDirectory;
    body.querySelector('#esi-search').oninput=filterDirectory;
    body.querySelector('#esi-signout').onclick=async()=>{stopPoll();if(realtime){await supabase.removeChannel(realtime);realtime=null;}await supabase.auth.signOut();currentUser=null;currentPeer=null;showAuth();};
    body.querySelector('#esi-profile-toggle').onclick=showDirectorySettings;
  }
  let directoryCache=[];
  async function loadDirectory(){
    if(!currentUser)return;
    const dest=body.querySelector('#esi-directory'); if(!dest)return; dest.innerHTML='<p class="esi-muted">Loading members…</p>';
    try{const {data,error}=await supabase.from('profiles').select('user_id,username,display_name').eq('is_listed',true).neq('user_id',currentUser.id).order('username').limit(100);if(error)throw error;directoryCache=data||[];filterDirectory();}
    catch(e){dest.innerHTML=`<p class="esi-error">Could not load the directory. Check the Supabase tables and access policies.</p>`;}
  }
  function filterDirectory(){const dest=body.querySelector('#esi-directory');if(!dest)return;const q=(body.querySelector('#esi-search')?.value||'').toLowerCase();const list=directoryCache.filter(u=>(u.username+' '+(u.display_name||'')).toLowerCase().includes(q));dest.innerHTML=list.length?list.map(u=>`<button class="esi-user" data-peer="${esc(u.user_id)}"><span class="esi-avatar">${esc((u.display_name||u.username||'?').slice(0,1).toUpperCase())}</span><span><span class="esi-user-name">${esc(u.display_name||u.username)}</span><span class="esi-user-sub">Study Circle member</span></span><span style="margin-left:auto;color:#8291a3">›</span></button>`).join(''):'<p class="esi-muted">No opted-in members found yet. Try again later.</p>';dest.querySelectorAll('[data-peer]').forEach(btn=>btn.onclick=()=>openConversation(list.find(u=>u.user_id===btn.dataset.peer)));}
  async function showDirectorySettings(){
    const {data:p,error}=await supabase.from('profiles').select('username,display_name,is_listed').eq('user_id',currentUser.id).single();if(error){status(error.message);return;}
    body.innerHTML=`<div class="esi-topline"><button class="esi-back" id="esi-back">← Members</button><strong>Directory settings</strong></div><p class="esi-muted">Choose whether other members can find and message you.</p><label class="esi-optin"><input id="esi-list-toggle" type="checkbox" ${p.is_listed?'checked':''}><span>Show my username in the Study Circle directory</span></label><button class="esi-btn" id="esi-save-list">Save preference</button><div id="esi-status"></div>`;
    body.querySelector('#esi-back').onclick=()=>{showDirectoryShell();loadDirectory()};body.querySelector('#esi-save-list').onclick=async()=>{try{const {error}=await supabase.from('profiles').update({is_listed:body.querySelector('#esi-list-toggle').checked}).eq('user_id',currentUser.id);if(error)throw error;showDirectoryShell();await loadDirectory();}catch(e){status(e.message)}};
  }
  async function openConversation(peer){
    if(!peer)return;currentPeer=peer;
    body.innerHTML=`<div class="esi-topline"><button class="esi-back" id="esi-back">← Members</button><span class="esi-avatar">${esc((peer.display_name||peer.username||'?').slice(0,1).toUpperCase())}</span><div><strong style="font-size:13px">${esc(peer.display_name||peer.username)}</strong><div class="esi-muted">Study Circle member</div></div></div><div class="esi-note esi-muted">Keep the conversation respectful. Avoid sharing personal contact details or sensitive information.</div><div class="esi-message-list" id="esi-messages"><p class="esi-muted">Loading conversation…</p></div><div id="esi-status"></div><form class="esi-compose" id="esi-compose"><input class="esi-field" id="esi-message-input" maxlength="2000" autocomplete="off" placeholder="Write a study-related message…" aria-label="Message"><button class="esi-btn" type="submit" aria-label="Send message">Send</button></form>`;
    body.querySelector('#esi-back').onclick=async()=>{stopPoll();if(realtime){await supabase.removeChannel(realtime);realtime=null;}showDirectoryShell();await loadDirectory();};
    body.querySelector('#esi-compose').onsubmit=async e=>{e.preventDefault();const input=body.querySelector('#esi-message-input'),message=input.value.trim();if(!message||loading)return;loading=true;try{const {error}=await supabase.from('direct_messages').insert({sender_id:currentUser.id,recipient_id:peer.user_id,body:message});if(error)throw error;input.value='';await loadMessages();}catch(err){status(err.message||'Message could not be sent.');}finally{loading=false;}};
    lastSig=null;stopPoll();
    await loadMessages();
    // Fallback: if Realtime isn't enabled for direct_messages, new incoming messages
    // would only appear after the user sends one. Poll so they always show up.
    poll=setInterval(()=>{if(!document.hidden)loadMessages();},3000);
    if(realtime)await supabase.removeChannel(realtime);
    realtime=supabase.channel('esi-dm-'+[currentUser.id,peer.user_id].sort().join('-')).on('postgres_changes',{event:'INSERT',schema:'public',table:'direct_messages'},payload=>{const m=payload.new;if((m.sender_id===currentUser.id&&m.recipient_id===peer.user_id)||(m.sender_id===peer.user_id&&m.recipient_id===currentUser.id))loadMessages();}).subscribe();
  }
  async function loadMessages(){
    if(!currentPeer)return;const box=body.querySelector('#esi-messages');if(!box)return;
    try{const {data,error}=await supabase.from('direct_messages').select('id,sender_id,recipient_id,body,created_at').or(`and(sender_id.eq.${currentUser.id},recipient_id.eq.${currentPeer.user_id}),and(sender_id.eq.${currentPeer.user_id},recipient_id.eq.${currentUser.id})`).order('created_at',{ascending:true}).limit(150);if(error)throw error;
      const sig=(data||[]).map(m=>m.id).join(',');if(sig===lastSig)return;lastSig=sig;
      box.innerHTML=(data||[]).map(m=>`<div class="esi-bubble ${m.sender_id===currentUser.id?'esi-mine':'esi-theirs'}">${esc(m.body).replace(/\n/g,'<br>')}<span class="esi-time">${new Date(m.created_at).toLocaleString([], {hour:'2-digit',minute:'2-digit',month:'short',day:'numeric'})}</span></div>`).join('')||'<p class="esi-muted">Start with a question about a science topic or homework.</p>';box.scrollTop=box.scrollHeight;
    }catch(e){box.innerHTML='<p class="esi-error">Messages could not load. Check your Supabase policies and Realtime setup.</p>';}
  }
  async function start(){
    const url=window.ESI_SUPABASE_URL,key=window.ESI_SUPABASE_ANON_KEY;
    if(!url||!key||url.includes('YOUR_SUPABASE')||key.includes('YOUR_SUPABASE')||!window.supabase?.createClient){setupMessage();return;}
    supabase=window.supabase.createClient(url,key);
    showAuth();
    try{const {data:{session}}=await supabase.auth.getSession();if(session)await initSession();}catch(e){status('Could not connect to Study Circle. Check your Supabase configuration.');}
    supabase.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'&&session){setTimeout(()=>initSession().catch(e=>status(e.message)),0)}});
  }
  start();
})();
