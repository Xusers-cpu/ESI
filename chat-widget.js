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
  if(darkMode) root.classList.add('esi-dark');
  const panel = root.querySelector('#esi-panel'), launcher = root.querySelector('#esi-launcher'), body = root.querySelector('#esi-body');
  const introHTML = body.innerHTML;
  let authArea = root.querySelector('#esi-auth-area');

  // Update launcher label based on unlock
  function updateLauncherLabel(){
    const span = launcher.querySelector('span:last-child');
    if(span) span.textContent = unlocked ? 'Study Circle' : 'Science Helper';
  }
  updateLauncherLabel();

  // ---------- State ----------
  let supabase = null, currentUser = null, myName = 'Someone', loading = false;
  // currentChat: { kind:'dm', id:<peer user id>, peer, title, sub } | { kind:'group', id:<group id>, group, title, sub, lastRead }
  let currentChat = null, tab = 'members';
  let inbox = null, ginbox = null, tick = null, tickN = 0;                         // realtime inbox channel + polling fallback
  let typingCh = null, typingReady = false, lastTypingSent = 0; const typers = new Map();
  let lastSig = null, divider = null, initialScroll = false, forceBottom = false, hasReadAt = true, groupsOk = null;
  let unread = {}, gunread = {}, unreadSig = '';                    // unread counts: by sender (DMs) and by group
  let directoryCache = [], groupsCache = [];
  let unlocked = localStorage.getItem('esi_unlocked') === 'true';
  let darkMode = localStorage.getItem('esi_dark') === 'true';
  let olderMessagesLoading = false;
  let hasMoreMessages = false;

  // ---------- Helpers ----------
  const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status = (msg, cls='esi-error') => { const el = body.querySelector('#esi-status'); if(el) el.innerHTML = `<div class="${cls}" role="status">${esc(msg)}</div>`; };
  const atBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const viewingChat = () => !!currentChat && panel.classList.contains('esi-open') && !document.hidden;
  const peerName = p => p.display_name || p.username;
  const ini = s => String(s||'?').slice(0,1).toUpperCase();
  const hue = id => { let h=0; for(const c of String(id)) h=(h*31+c.charCodeAt(0))%360; return h; };
  const sum = o => Object.values(o).reduce((a,b)=>a+b,0);
  const plural = (n,w) => `${n} ${w}${n===1?'':'s'}`;
  const errText = e => (e && e.message) ? e.message : 'Something went wrong. Please try again.';
  const dmChat = peer => ({kind:'dm', id:peer.user_id, peer, title:peerName(peer), sub:'Study Circle member'});
  const freshGroup = g => groupsCache.find(x=>x.id===g.id) || g;
  const groupChat = g => ({kind:'group', id:g.id, group:g, title:g.name, sub:plural(g.count||0,'member'), lastRead:g.last_read_at||''});

  const toggle = (open) => {
    panel.classList.toggle('esi-open',open); launcher.setAttribute('aria-expanded',String(open));
    if(open){
      setTimeout(()=>{const f=panel.querySelector('input'); if(f) f.focus();},50);
      if(currentUser){ if(currentChat) loadMessages(); else loadUnread(); }
    }
  };
  launcher.addEventListener('click',()=>toggle(!panel.classList.contains('esi-open')));
  root.querySelector('#esi-close').addEventListener('click',()=>toggle(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')toggle(false)});
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&currentUser){ loadUnread(); if(currentChat) loadMessages(); } });

  // ---------- Unread counters ----------
  function setCount(el,n){ if(!el) return; el.hidden=!n; el.textContent=n>99?'99+':String(n); }
  function renderBadges(){
    const dm=sum(unread), g=sum(gunread), t=dm+g;
    let b=launcher.querySelector('.esi-launch-badge');
    if(t>0){
      if(!b){ b=document.createElement('span'); b.className='esi-launch-badge'; launcher.appendChild(b); }
      b.textContent=t>99?'99+':String(t); b.setAttribute('aria-label',`${plural(t,'unread message')}`);
    } else if(b){ b.remove(); }
    renderTabCounts();
    if(body.querySelector('#esi-directory')) renderList();
  }
  function renderTabCounts(){
    setCount(body.querySelector('[data-tab="members"] .esi-tabcount'),sum(unread));
    setCount(body.querySelector('[data-tab="groups"] .esi-tabcount'),sum(gunread));
  }
  function commitUnread(){ unreadSig=JSON.stringify([unread,gunread]); renderBadges(); }
  async function loadUnread(){
    if(!currentUser) return;
    let dm=null, g=null;
    if(hasReadAt){
      try{
        const {data,error}=await supabase.from('direct_messages').select('sender_id').eq('recipient_id',currentUser.id).is('read_at',null).limit(1000);
        if(error) throw error;
        dm={}; (data||[]).forEach(r=>{ dm[r.sender_id]=(dm[r.sender_id]||0)+1; });
      }catch(e){ if(e&&(e.code==='42703'||/read_at/.test(e.message||''))) hasReadAt=false; }
    }
    if(groupsOk!==false){
      try{
        const {data,error}=await supabase.rpc('group_unread_counts');
        if(error) throw error;
        g={}; (data||[]).forEach(r=>{ g[r.group_id]=Number(r.unread); });
      }catch(e){ /* groups SQL not installed yet */ }
    }
    if(dm===null) dm=unread; if(g===null) g=gunread;
    if(viewingChat()){ if(currentChat.kind==='dm') delete dm[currentChat.id]; else delete g[currentChat.id]; }   // the open chat is being read right now
    const sig=JSON.stringify([dm,g]); if(sig===unreadSig) return;
    unread=dm; gunread=g; commitUnread();
  }
  const isUnread = (chat,m) => chat.kind==='dm'
    ? (hasReadAt && m.sender_id===chat.id && !m.read_at)
    : (m.sender_id!==currentUser.id && m.created_at>(chat.lastRead||''));
  async function markRead(chat,data){
    if(!currentUser) return;
    try{
      if(chat.kind==='dm'){
        if(!hasReadAt) return;
        const {error}=await supabase.from('direct_messages').update({read_at:new Date().toISOString()}).eq('recipient_id',currentUser.id).eq('sender_id',chat.id).is('read_at',null);
        if(error) throw error;
        if(unread[chat.id]){ delete unread[chat.id]; commitUnread(); }
      } else {
        const latest=data.reduce((a,m)=>m.created_at>a?m.created_at:a,'');   // server timestamps, so no clock-skew
        if(!latest||latest<=(chat.lastRead||'')) return;
        const {error}=await supabase.from('group_members').update({last_read_at:latest}).eq('group_id',chat.id).eq('user_id',currentUser.id);
        if(error) throw error;
        chat.lastRead=latest; const gi=groupsCache.find(x=>x.id===chat.id); if(gi) gi.last_read_at=latest;
        if(gunread[chat.id]){ delete gunread[chat.id]; commitUnread(); }
      }
    }catch(e){ /* non-fatal: counters just stay until the next refresh */ }
  }

  // ---------- Realtime: inbox + typing ----------
  function startRealtime(){
    if(!currentUser||inbox) return;
    inbox = supabase.channel('esi-inbox-'+currentUser.id)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'direct_messages',filter:'recipient_id=eq.'+currentUser.id},payload=>{
        const m=payload.new||{};
        if(currentChat&&currentChat.kind==='dm'&&m.sender_id===currentChat.id){ removeTyper(m.sender_id); loadMessages(); }
        loadUnread();
      })
      .subscribe();
    startGroupRealtime();
    // Polling fallback: keeps badges and the open chat fresh even if Realtime isn't enabled on a table.
    if(!tick) tick = setInterval(()=>{
      if(!currentUser||document.hidden) return;
      tickN++;
      loadUnread(); if(currentChat) loadMessages();
      if(groupsOk!==false&&(tab==='groups'||(currentChat&&currentChat.kind==='group')||tickN%5===0)) loadGroups();
    },4000);
  }
  // Group events live on their own channel so a missing groups table can never break direct-message delivery.
  function startGroupRealtime(){
    if(!currentUser||ginbox||groupsOk!==true) return;
    ginbox = supabase.channel('esi-groups-'+currentUser.id)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'group_messages'},payload=>{   // RLS only delivers groups you belong to
        const m=payload.new||{};
        if(currentChat&&currentChat.kind==='group'&&currentChat.id===m.group_id){ if(m.sender_id!==currentUser.id) removeTyper(m.sender_id); loadMessages(); }
        loadUnread();
      })
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'group_members',filter:'user_id=eq.'+currentUser.id},()=>{ loadGroups(); loadUnread(); })   // you were added to a group
      .subscribe();
  }
  function stopRealtime(){
    closeTyping();
    if(inbox){ const c=inbox; inbox=null; supabase.removeChannel(c); }
    if(ginbox){ const c=ginbox; ginbox=null; supabase.removeChannel(c); }
    if(tick){ clearInterval(tick); tick=null; }
  }
  function openTyping(chat){
    closeTyping();
    const name = chat.kind==='dm' ? 'esi-typing-'+[currentUser.id,chat.id].sort().join('-') : 'esi-gtyping-'+chat.id;
    typingCh = supabase.channel(name,{config:{private:true,broadcast:{self:false}}})
      .on('broadcast',{event:'typing'},({payload})=>{
        if(!payload||payload.from===currentUser.id) return;
        if(chat.kind==='dm'&&payload.from!==chat.id) return;
        if(payload.typing===false) removeTyper(payload.from); else addTyper(payload.from, chat.kind==='dm'?chat.title:(payload.name||'Someone'));
      })
      .subscribe(st=>{ typingReady = st==='SUBSCRIBED'; });         // if the typing policies aren't installed, this just stays off
  }
  function closeTyping(){
    clearTypers(); lastTypingSent=0; typingReady=false;
    if(typingCh){ const c=typingCh; typingCh=null; supabase.removeChannel(c); }
  }
  function sendTyping(on){
    if(!typingCh||!typingReady) return;
    const now=Date.now();
    if(on){ if(now-lastTypingSent<2000) return; lastTypingSent=now; }
    else { if(!lastTypingSent) return; lastTypingSent=0; }
    typingCh.send({type:'broadcast',event:'typing',payload:{from:currentUser.id,name:myName,typing:on}});
  }
  function showTypers(){
    const el=body.querySelector('#esi-typing'); if(!el) return;
    const names=[...typers.values()].map(t=>t.name);
    el.textContent = !names.length ? '' : names.length===1 ? `${names[0]} is typing…` : names.length===2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }
  function addTyper(id,name){
    const t=typers.get(id); if(t) clearTimeout(t.timer);
    typers.set(id,{name,timer:setTimeout(()=>{typers.delete(id);showTypers();},3500)}); showTypers();
  }
  function removeTyper(id){ const t=typers.get(id); if(t){ clearTimeout(t.timer); typers.delete(id); } showTypers(); }
  function clearTypers(){ typers.forEach(t=>clearTimeout(t.timer)); typers.clear(); showTypers(); }

  // ---------- Auth ----------
  function ensureAuthArea(){
    if(authArea.isConnected) return;
    body.classList.remove('esi-chat'); body.innerHTML=introHTML; authArea=body.querySelector('#esi-auth-area');
  }
  function setupMessage() {
    authArea.innerHTML = `<p class="esi-error">Study Circle isn't connected yet.</p><p class="esi-muted">To enable the member directory and messaging, add your Supabase project URL and public anon key in <code>supabase-config.js</code>, then run the included SQL setup script. Do not add a service-role key to a public website.</p><a href="SUPABASE_SETUP.md" target="_blank" rel="noopener" class="esi-muted">Open setup guide ↗</a>`;
  }
  function showAuth() {
    ensureAuthArea();
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
    myName=username;
    const {error}=await supabase.from('profiles').upsert({user_id:currentUser.id,username,display_name:username,is_listed:listed},{onConflict:'user_id'}); if(error) throw error;
  }
  async function initSession(){
    const {data:{user},error}=await supabase.auth.getUser(); if(error) throw error; currentUser=user;
    if(!user){currentChat=null;showAuth();return;}
    const {data:profile,error:pe}=await supabase.from('profiles').select('username,display_name,is_listed').eq('user_id',user.id).maybeSingle();
    if(pe) throw pe;
    if(profile) myName=profile.display_name||profile.username;
    if(!profile){
      const username=(user.user_metadata?.username||'').toString();
      if(username){await ensureProfile(username,false);} else {showProfileSetup();return;}
    }
    showDirectoryShell(); await loadDirectory();
  }
  function showProfileSetup(){
    ensureAuthArea();
    authArea.innerHTML=`<p><strong>Finish your community profile</strong></p><input class="esi-field" id="esi-profile-name" maxlength="24" placeholder="Username (3–24 characters)"><label class="esi-optin"><input type="checkbox" id="esi-profile-optin"><span>List me in the Study Circle directory. Other opted-in members can message me.</span></label><button class="esi-btn" id="esi-profile-save">Save profile</button><div id="esi-status"></div>`;
    authArea.querySelector('#esi-profile-save').onclick=async()=>{try{const n=authArea.querySelector('#esi-profile-name').value.trim();if(!/^[a-zA-Z0-9_]{3,24}$/.test(n))throw Error('Use 3–24 letters, numbers or _.');await ensureProfile(n,authArea.querySelector('#esi-profile-optin').checked);await showDirectoryShell();await loadDirectory();}catch(e){status(e.message)}};
  }

  // ---------- Directory (Members | Groups) ----------
  function showDirectoryShell(){
    closeTyping(); currentChat=null; body.classList.remove('esi-chat');
    body.innerHTML=`<div class="esi-tabs" role="tablist"><button class="esi-tab" role="tab" data-tab="members">Members<span class="esi-badge esi-tabcount" hidden></span></button><button class="esi-tab" role="tab" data-tab="groups">Groups<span class="esi-badge esi-tabcount" hidden></span></button></div><div class="esi-toolbar"><input class="esi-field" id="esi-search" aria-label="Search"><button class="esi-btn esi-light" id="esi-refresh" title="Refresh">↻</button></div><div class="esi-muted" id="esi-caption" style="margin-bottom:8px"></div><div id="esi-directory"><p class="esi-muted">Loading…</p></div><div id="esi-status"></div><div class="esi-actions"><button class="esi-btn esi-light" id="esi-profile-toggle">Directory settings</button><button class="esi-btn esi-light" id="esi-signout">Sign out</button></div>`;
    body.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
    body.querySelector('#esi-refresh').onclick=loadDirectory;
    body.querySelector('#esi-search').oninput=renderList;
    body.querySelector('#esi-signout').onclick=async()=>{stopRealtime();await supabase.auth.signOut();currentUser=null;currentChat=null;unread={};gunread={};unreadSig='';groupsCache=[];directoryCache=[];groupsOk=null;renderBadges();showAuth();};
    body.querySelector('#esi-profile-toggle').onclick=showDirectorySettings;
    applyTabUI(); renderTabCounts(); startRealtime();
  }
  function applyTabUI(){
    body.querySelectorAll('[data-tab]').forEach(b=>{ const on=b.dataset.tab===tab; b.classList.toggle('esi-active',on); b.setAttribute('aria-selected',String(on)); });
    const s=body.querySelector('#esi-search'); if(s) s.placeholder = tab==='groups' ? 'Find a group…' : 'Find a study member…';
    const c=body.querySelector('#esi-caption'); if(c) c.textContent = tab==='groups' ? 'Your study groups' : 'Members who opted in to the Study Circle';
  }
  function setTab(t){ tab=t; applyTabUI(); const s=body.querySelector('#esi-search'); if(s) s.value=''; renderList(); if(t==='groups') loadGroups(); }
  const renderList = () => tab==='groups' ? renderGroups() : filterDirectory();

  async function loadDirectory(){
    if(!currentUser)return;
    const dest=body.querySelector('#esi-directory'); if(!dest)return; dest.innerHTML='<p class="esi-muted">Loading…</p>';
    await loadGroups(true);
    await loadUnread();
    try{const {data,error}=await supabase.from('profiles').select('user_id,username,display_name').eq('is_listed',true).neq('user_id',currentUser.id).order('username').limit(100);if(error)throw error;directoryCache=data||[];renderList();}
    catch(e){dest.innerHTML=`<p class="esi-error">Could not load the directory. Check the Supabase tables and access policies.</p>`;}
  }
  function filterDirectory(){
    const dest=body.querySelector('#esi-directory');if(!dest)return;
    const q=(body.querySelector('#esi-search')?.value||'').toLowerCase();
    // Members who wrote to you first, then everyone else alphabetically.
    const list=directoryCache.filter(u=>(u.username+' '+(u.display_name||'')).toLowerCase().includes(q))
      .sort((a,b)=>((unread[b.user_id]||0)-(unread[a.user_id]||0))||a.username.localeCompare(b.username));
    dest.innerHTML=list.length?list.map(u=>{
      const n=unread[u.user_id]||0;
      return `<button class="esi-user${n?' esi-has-unread':''}" data-peer="${esc(u.user_id)}"><span class="esi-avatar">${esc(ini(u.display_name||u.username))}</span><span><span class="esi-user-name">${esc(u.display_name||u.username)}${n?`<span class="esi-badge" aria-label="${plural(n,'unread message')}">${n>99?'99+':n}</span>`:''}</span><span class="esi-user-sub">${n?plural(n,'new message'):'Study Circle member'}</span></span><span style="margin-left:auto"><button class="esi-request-btn" data-req="${esc(u.user_id)}">Request</button></span></button>`;
    }).join(''):'<p class="esi-muted">No opted-in members found yet. Try again later.</p>';
    dest.querySelectorAll('[data-peer]').forEach(btn=>btn.onclick=()=>openChat(dmChat(list.find(u=>u.user_id===btn.dataset.peer))));
    dest.querySelectorAll('[data-req]').forEach(btn=>btn.onclick=async (e)=>{
      e.stopPropagation();
      try{
        const {error} = await supabase.from('chat_requests').insert({sender_id: currentUser.id, recipient_id: btn.dataset.req, status: 'pending'});
        if(error) throw error;
        status('Request sent!','esi-success');
      }catch(err){ status(err.message); }
    });
  }
  async function showDirectorySettings(){
    const {data:p,error}=await supabase.from('profiles').select('username,display_name,is_listed').eq('user_id',currentUser.id).single();if(error){status(error.message);return;}
    body.innerHTML=`<div class="esi-topline"><button class="esi-back" id="esi-back">← Members</button><strong>Directory settings</strong></div><p class="esi-muted">Choose whether other members can find and message you.</p><label class="esi-optin"><input id="esi-list-toggle" type="checkbox" ${p.is_listed?'checked':''}><span>Show my username in the Study Circle directory</span></label><button class="esi-btn" id="esi-save-list">Save preference</button><div id="esi-status"></div>`;
    body.querySelector('#esi-back').onclick=()=>{showDirectoryShell();loadDirectory()};body.querySelector('#esi-save-list').onclick=async()=>{try{const {error}=await supabase.from('profiles').update({is_listed:body.querySelector('#esi-list-toggle').checked}).eq('user_id',currentUser.id);if(error)throw error;showDirectoryShell();await loadDirectory();}catch(e){status(e.message)}};
  }

  // ---------- Groups: list, create, info ----------
  async function loadGroups(quiet){
    if(!currentUser) return;
    try{
      const [g,m]=await Promise.all([
        supabase.from('groups').select('id,name,created_by,group_members(count)'),
        supabase.from('group_members').select('group_id,role,last_read_at').eq('user_id',currentUser.id)
      ]);
      if(g.error) throw g.error; if(m.error) throw m.error;
      const mine=new Map((m.data||[]).map(r=>[r.group_id,r]));
      groupsCache=(g.data||[]).filter(x=>mine.has(x.id)).map(x=>({id:x.id,name:x.name,created_by:x.created_by,count:x.group_members?.[0]?.count||0,role:mine.get(x.id).role,last_read_at:mine.get(x.id).last_read_at}));
      groupsOk=true; startGroupRealtime();
      if(currentChat&&currentChat.kind==='group'){
        const still=groupsCache.find(x=>x.id===currentChat.id);
        if(!still){ tab='groups'; showDirectoryShell(); await loadDirectory(); status('You are no longer a member of that group.'); return; }
        currentChat.group=still; currentChat.title=still.name; currentChat.sub=plural(still.count,'member');
      }
    }catch(e){ groupsOk=false; groupsCache=[]; }
    if(!quiet && body.querySelector('#esi-directory')) renderList();
  }
  function renderGroups(){
    const dest=body.querySelector('#esi-directory'); if(!dest) return;
    if(groupsOk===false){ dest.innerHTML='<p class="esi-muted">Groups need the latest database setup. Run the updated <code>supabase-schema.sql</code> in the Supabase SQL Editor, then press ↻.</p>'; return; }
    const q=(body.querySelector('#esi-search')?.value||'').toLowerCase();
    const list=groupsCache.filter(g=>g.name.toLowerCase().includes(q)).sort((a,b)=>((gunread[b.id]||0)-(gunread[a.id]||0))||a.name.localeCompare(b.name));
    dest.innerHTML=`<button class="esi-btn esi-light" id="esi-new-group" style="width:100%;margin-bottom:8px">＋ New group</button>`+(list.length?list.map(g=>{
      const n=gunread[g.id]||0;
      return `<button class="esi-user${n?' esi-has-unread':''}" data-gid="${esc(g.id)}"><span class="esi-avatar esi-gavatar" style="background:hsl(${hue(g.id)} 70% 90%);color:hsl(${hue(g.id)} 45% 28%)">${esc(ini(g.name))}</span><span><span class="esi-user-name">${esc(g.name)}${n?`<span class="esi-badge" aria-label="${plural(n,'unread message')}">${n>99?'99+':n}</span>`:''}</span><span class="esi-user-sub">${n?plural(n,'new message'):plural(g.count,'member')+(g.role==='admin'?' · you are admin':'')}</span></span><span style="margin-left:auto;color:#8291a3">›</span></button>`;
    }).join(''):(groupsCache.length?'<p class="esi-muted">No groups match your search.</p>':'<p class="esi-muted">You are not in any groups yet. Create one to chat with several members at once.</p>'));
    dest.querySelector('#esi-new-group').onclick=showNewGroup;
    dest.querySelectorAll('[data-gid]').forEach(btn=>btn.onclick=()=>{ const g=groupsCache.find(x=>String(x.id)===btn.dataset.gid); if(g) openChat(groupChat(g)); });
  }
  function renderPicker(box,candidates,picked,q,onChange){
    const list=candidates.filter(u=>(u.username+' '+(u.display_name||'')).toLowerCase().includes(q.toLowerCase()));
    box.innerHTML=list.length?list.map(u=>`<label class="esi-pick"><input type="checkbox" value="${esc(u.user_id)}" ${picked.has(u.user_id)?'checked':''}><span class="esi-avatar esi-sm">${esc(ini(u.display_name||u.username))}</span><span>${esc(u.display_name||u.username)}</span></label>`).join(''):'<p class="esi-muted">No members to show.</p>';
    box.querySelectorAll('input').forEach(cb=>cb.onchange=()=>{ if(cb.checked) picked.add(cb.value); else picked.delete(cb.value); onChange(); });
  }
  function backToGroups(){ tab='groups'; showDirectoryShell(); loadDirectory(); }
  function showNewGroup(){
    closeTyping(); currentChat=null; body.classList.remove('esi-chat');
    const picked=new Set();
    body.innerHTML=`<div class="esi-topline"><button class="esi-back" id="esi-back">← Groups</button><strong>New group</strong></div><input class="esi-field" id="esi-group-name" maxlength="40" placeholder="Group name (e.g. Class 9 Physics)" aria-label="Group name"><div class="esi-muted" style="margin:6px 0 2px">Add members <span id="esi-picked-count"></span></div><input class="esi-field" id="esi-pick-search" placeholder="Search members…" aria-label="Search members"><div class="esi-picklist" id="esi-pick-list"></div><div id="esi-status"></div><button class="esi-btn" id="esi-group-create" style="width:100%" disabled>Create group</button>`;
    const nameEl=body.querySelector('#esi-group-name'), searchEl=body.querySelector('#esi-pick-search'), listEl=body.querySelector('#esi-pick-list'), createEl=body.querySelector('#esi-group-create'), countEl=body.querySelector('#esi-picked-count');
    const refresh=()=>{ countEl.textContent=picked.size?`· ${picked.size} selected`:''; createEl.disabled=!(nameEl.value.trim()&&picked.size>=1); };
    const draw=()=>renderPicker(listEl,directoryCache,picked,searchEl.value,refresh);
    nameEl.oninput=refresh; searchEl.oninput=draw; draw(); refresh();
    body.querySelector('#esi-back').onclick=backToGroups;
    createEl.onclick=async()=>{
      createEl.disabled=true; createEl.textContent='Creating…';
      try{
        const {data,error}=await supabase.rpc('create_group',{p_name:nameEl.value.trim(),p_members:[...picked]}); if(error) throw error;
        await loadGroups(true);
        const g=groupsCache.find(x=>x.id===data); tab='groups';
        if(g) openChat(groupChat(g)); else backToGroups();
      }catch(e){ status(errText(e)); createEl.textContent='Create group'; refresh(); }
    };
  }
  async function showGroupInfo(g){
    closeTyping(); currentChat=null; body.classList.remove('esi-chat');
    body.innerHTML=`<div class="esi-topline"><button class="esi-back" id="esi-back">← Chat</button><strong>Group info</strong></div><p class="esi-muted">Loading…</p><div id="esi-status"></div>`;
    body.querySelector('#esi-back').onclick=()=>openChat(groupChat(freshGroup(g)));
    try{
      const {data,error}=await supabase.rpc('get_group_members',{p_group:g.id}); if(error) throw error;
      const roster=data||[], me=roster.find(r=>r.user_id===currentUser.id), isAdmin=me?.role==='admin';
      g.count=roster.length; if(me) g.role=me.role;
      const inGroup=new Set(roster.map(r=>r.user_id)), candidates=directoryCache.filter(u=>!inGroup.has(u.user_id));
      body.innerHTML=`<div class="esi-topline"><button class="esi-back" id="esi-back">← Chat</button><strong>Group info</strong></div>
        <div class="esi-ginfo-head"><span class="esi-avatar esi-gavatar esi-lg" style="background:hsl(${hue(g.id)} 70% 90%);color:hsl(${hue(g.id)} 45% 28%)">${esc(ini(g.name))}</span><div><strong>${esc(g.name)}</strong><div class="esi-muted">${plural(roster.length,'member')}</div></div></div>
        ${isAdmin?`<div class="esi-section-title">Rename group</div><div class="esi-toolbar"><input class="esi-field" id="esi-rename" maxlength="40" value="${esc(g.name)}" aria-label="Group name"><button class="esi-btn esi-light" id="esi-rename-save">Save</button></div>`:''}
        <div class="esi-section-title">Members</div>
        <div id="esi-roster">${roster.map(r=>`<div class="esi-roster-row"><span class="esi-avatar esi-sm">${esc(ini(r.display_name||r.username))}</span><span class="esi-roster-name">${esc(r.display_name||r.username)}${r.user_id===currentUser.id?' <span class="esi-muted">(you)</span>':''}</span>${r.role==='admin'?'<span class="esi-tag">Admin</span>':''}${isAdmin&&r.user_id!==currentUser.id&&r.role!=='admin'?`<button class="esi-x" data-remove="${esc(r.user_id)}" aria-label="Remove ${esc(r.display_name||r.username)}">✕</button>`:''}</div>`).join('')}</div>
        ${isAdmin?`<div class="esi-section-title">Add members</div><input class="esi-field" id="esi-add-search" placeholder="Search members…" aria-label="Search members to add"><div class="esi-picklist" id="esi-add-list"></div><button class="esi-btn" id="esi-add-go" style="width:100%" disabled>Add selected</button>`:''}
        <div id="esi-status"></div>
        <div class="esi-actions"><button class="esi-btn esi-danger" id="esi-leave">Leave group</button></div>`;
      body.querySelector('#esi-back').onclick=()=>openChat(groupChat(freshGroup(g)));
      const reload=async()=>{ await loadGroups(true); showGroupInfo(groupsCache.find(x=>x.id===g.id)||g); };
      body.querySelectorAll('[data-remove]').forEach(b=>b.onclick=async()=>{ if(!confirm('Remove this member from the group?')) return; try{ const {error}=await supabase.rpc('remove_group_member',{p_group:g.id,p_user:b.dataset.remove}); if(error) throw error; await reload(); }catch(e){ status(errText(e)); } });
      if(isAdmin){
        body.querySelector('#esi-rename-save').onclick=async()=>{ try{ const name=body.querySelector('#esi-rename').value.trim(); if(!name) throw new Error('Enter a group name.'); const {data:rows,error}=await supabase.from('groups').update({name}).eq('id',g.id).select('id'); if(error) throw error; if(!rows||!rows.length) throw new Error('Only admins can rename this group.'); await reload(); }catch(e){ status(errText(e)); } };
        const picked=new Set(), addGo=body.querySelector('#esi-add-go'), addSearch=body.querySelector('#esi-add-search'), addList=body.querySelector('#esi-add-list');
        const refresh=()=>{ addGo.disabled=!picked.size; addGo.textContent=picked.size?`Add ${picked.size} selected`:'Add selected'; };
        const draw=()=>renderPicker(addList,candidates,picked,addSearch.value,refresh);
        addSearch.oninput=draw; draw();
        addGo.onclick=async()=>{ addGo.disabled=true; try{ const {error}=await supabase.rpc('add_group_members',{p_group:g.id,p_members:[...picked]}); if(error) throw error; await reload(); }catch(e){ status(errText(e)); refresh(); } };
      }
      body.querySelector('#esi-leave').onclick=async()=>{ if(!confirm('Leave this group? You will stop receiving its messages.')) return; try{ const {error}=await supabase.rpc('leave_group',{p_group:g.id}); if(error) throw error; backToGroups(); }catch(e){ status(errText(e)); } };
    }catch(e){ status(errText(e)); }
  }

  // ---------- Conversation (direct or group) ----------
  async function openChat(chat){
    if(!chat||(chat.kind==='dm'&&!chat.peer)) return;
    currentChat=chat; lastSig=null; initialScroll=false; divider=null; forceBottom=false;
    body.classList.add('esi-chat');
    const isGroup=chat.kind==='group';
    const avatar=isGroup?`<span class="esi-avatar esi-gavatar" style="background:hsl(${hue(chat.id)} 70% 90%);color:hsl(${hue(chat.id)} 45% 28%)">${esc(ini(chat.title))}</span>`:`<span class="esi-avatar">${esc(ini(chat.title))}</span>`;
    body.innerHTML=`<div class="esi-topline"><button class="esi-back" id="esi-back">← ${isGroup?'Groups':'Members'}</button>${avatar}<div><strong style="font-size:13px">${esc(chat.title)}</strong><div class="esi-muted">${esc(chat.sub)}</div></div>${isGroup?'<button class="esi-back esi-info" id="esi-info" aria-label="Group info" title="Group info">ⓘ</button>':''}</div><div class="esi-note esi-muted">Keep the conversation respectful. Avoid sharing personal contact details or sensitive information.</div><div class="esi-listwrap"><div class="esi-message-list" id="esi-messages" aria-live="polite"><p class="esi-muted">Loading conversation…</p></div><button type="button" class="esi-jump" id="esi-jump" hidden>↓ New messages</button></div><div class="esi-typing" id="esi-typing" role="status" aria-live="polite"></div><div id="esi-status"></div><form class="esi-compose" id="esi-compose"><input class="esi-field" id="esi-message-input" maxlength="2000" autocomplete="off" placeholder="Write a study-related message…" aria-label="Message"><button class="esi-btn" type="submit" aria-label="Send message">Send</button></form>`;
    const list=body.querySelector('#esi-messages'), jump=body.querySelector('#esi-jump'), input=body.querySelector('#esi-message-input');
    body.querySelector('#esi-back').onclick=()=>{ tab=isGroup?'groups':'members'; showDirectoryShell(); loadDirectory(); };
    if(isGroup) body.querySelector('#esi-info').onclick=()=>showGroupInfo(chat.group);
    list.addEventListener('scroll',()=>{ if(atBottom(list)) jump.hidden=true; });
    jump.onclick=()=>{ list.scrollTo({top:list.scrollHeight,behavior:reducedMotion()?'auto':'smooth'}); jump.hidden=true; };
    input.addEventListener('input',()=>sendTyping(input.value.trim().length>0));
    body.querySelector('#esi-compose').onsubmit=async e=>{
      e.preventDefault(); const message=input.value.trim(); if(!message||loading) return;
      loading=true; sendTyping(false);
      try{
        const row = isGroup ? {group_id:chat.id,sender_id:currentUser.id,body:message} : {sender_id:currentUser.id,recipient_id:chat.id,body:message};
        const {error}=await supabase.from(isGroup?'group_messages':'direct_messages').insert(row); if(error) throw error;
        input.value=''; forceBottom=true; await loadMessages();
      }catch(err){ status(err.message||'Message could not be sent.'); }
      finally{ loading=false; }
    };
    openTyping(chat);
    await loadMessages();
  }
  async function fetchMessages(chat, before=null){
    let run;
    if(chat.kind==='group'){
      run=()=>supabase.from('group_messages').select('id,sender_id,sender_name,body,created_at,edited_at').eq('group_id',chat.id).order('created_at',{ascending:false}).limit(150);
    } else {
      run=()=>supabase.from('direct_messages').select(hasReadAt?'id,sender_id,recipient_id,body,created_at,read_at,edited_at':'id,sender_id,recipient_id,body,created_at,edited_at')
        .or(`and(sender_id.eq.${currentUser.id},recipient_id.eq.${chat.id}),and(sender_id.eq.${chat.id},recipient_id.eq.${currentUser.id})`)
        .order('created_at',{ascending:false}).limit(150);
    }
    if(before){
      // for older: need to adjust the query, but for simplicity, re-fetch and slice or use .lt
      // Note: full implementation would use .lt('created_at', before)
    }
    let {data,error}=await run();
    if(error&&chat.kind==='dm'&&hasReadAt&&(error.code==='42703'||/read_at/.test(error.message||''))){ hasReadAt=false; ({data,error}=await run()); }
    if(error) throw error;
    return (data||[]).slice().reverse();
  }
  async function loadMessages(){
    const chat=currentChat; if(!chat) return;
    const box=body.querySelector('#esi-messages'); if(!box) return;
    try{
      const data=await fetchMessages(chat);
      if(currentChat!==chat||!box.isConnected) return;               // user left this chat while loading
      const first=!initialScroll, jump=body.querySelector('#esi-jump');
      if(first){                                                     // remember where the unread block starts
        const fu=data.find(m=>isUnread(chat,m));
        divider=fu?{id:fu.id,count:data.filter(m=>isUnread(chat,m)).length}:null;
      }
      const sig=data.map(m=>m.id).join(',');
      if(sig!==lastSig){
        const wasAtBottom=atBottom(box), prevTop=box.scrollTop, stick=wasAtBottom||forceBottom; forceBottom=false;
        lastSig=sig;
        box.innerHTML=data.length? (hasMoreMessages ? '<button class="esi-load-earlier" id="esi-load-earlier">Load earlier messages</button>' : '') + data.map(m=>{
          const mine=m.sender_id===currentUser.id;
          const who=(chat.kind==='group'&&!mine)?`<span class="esi-sender" style="color:hsl(${hue(m.sender_id)} 45% 32%)">${esc(m.sender_name||'Former member')}</span>`:'';
          const edited = m.edited_at ? ' <small>(edited)</small>' : '';
          const actions = mine ? `<div class="esi-bubble-actions"><button data-edit="${m.id}">✎</button><button data-del="${m.id}">✕</button></div>` : '';
          return (divider&&m.id===divider.id?`<div class="esi-unread-divider" id="esi-unread-divider" role="separator"><span>${plural(divider.count,'new message')}</span></div>`:'')+
            `<div class="esi-bubble ${mine?'esi-mine':'esi-theirs'}">${who}${esc(m.body).replace(/\n/g,'<br>')}${edited}<span class="esi-time">${new Date(m.created_at).toLocaleString([], {hour:'2-digit',minute:'2-digit',month:'short',day:'numeric'})}</span>${actions}</div>`;
        }).join(''):'<p class="esi-muted">Start with a question about a science topic or homework.</p>';
        // Bind load earlier and actions
        const loadBtn = box.querySelector('#esi-load-earlier');
        if(loadBtn) loadBtn.onclick = () => loadOlderMessages(chat);
        box.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => editMessage(btn.dataset.edit, chat));
        box.querySelectorAll('[data-del]').forEach(btn => btn.onclick = () => deleteMessage(btn.dataset.del, chat));
        if(first){
          const d=box.querySelector('#esi-unread-divider');
          if(d) box.scrollTop+=d.getBoundingClientRect().top-box.getBoundingClientRect().top-8;   // land on the first unread message
          else box.scrollTop=box.scrollHeight;
          if(jump&&!atBottom(box)) jump.hidden=false;
        } else if(stick){ box.scrollTop=box.scrollHeight; }
        else {                                                       // reading older messages: don't yank the view
          box.scrollTop=prevTop;
          const last=data[data.length-1];
          if(jump&&last&&last.sender_id!==currentUser.id) jump.hidden=false;
        }
      }
      initialScroll=true;
      if(viewingChat()&&data.some(m=>isUnread(chat,m))) markRead(chat,data);   // auto-mark as read
    }catch(e){box.innerHTML='<p class="esi-error">Messages could not load. Check your Supabase policies and Realtime setup.</p>';}
  }

  async function loadOlderMessages(chat){
    if(olderMessagesLoading) return;
    olderMessagesLoading = true;
    // Simple implementation: for full pagination, query with .lt('created_at', oldest.created_at).limit(50)
    // Then prepend to the list. For this demo, we note the feature is supported in schema.
    status('Loading earlier messages…','esi-success');
    olderMessagesLoading = false;
    hasMoreMessages = false; // after one load, or check count
  }

  async function editMessage(id, chat){
    const newBody = prompt('Edit message:');
    if(!newBody || !newBody.trim()) return;
    const table = chat.kind==='group' ? 'group_messages' : 'direct_messages';
    const {error} = await supabase.from(table).update({body: newBody.trim(), edited_at: new Date().toISOString()}).eq('id', id);
    if(error) status(error.message); else loadMessages();
  }

  async function deleteMessage(id, chat){
    if(!confirm('Delete this message?')) return;
    const table = chat.kind==='group' ? 'group_messages' : 'direct_messages';
    const {error} = await supabase.from(table).delete().eq('id', id);
    if(error) status(error.message); else loadMessages();
  }

  async function start(){
    const url=window.ESI_SUPABASE_URL,key=window.ESI_SUPABASE_ANON_KEY;
    if(!url||!key||url.includes('YOUR_SUPABASE')||key.includes('YOUR_SUPABASE')||!window.supabase?.createClient){setupMessage();return;}
    supabase=window.supabase.createClient(url,key);
    if(!unlocked){ showCoverChatbot(); return; }
    showAuth();
    try{const {data:{session}}=await supabase.auth.getSession();if(session)await initSession();}catch(e){status('Could not connect to Study Circle. Check your Supabase configuration.');}
    supabase.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_IN'&&session){ if(currentUser&&currentUser.id===session.user.id) return; setTimeout(()=>initSession().catch(e=>status(e.message)),0); }
      if(event==='SIGNED_OUT'){ stopRealtime(); }
    });
  }

  // ---------- Cover Chatbot & Secret Unlock ----------
  function showCoverChatbot(){
    body.innerHTML = `<div class="esi-note esi-muted">Hi! I'm your science helper for CBSE Classes 9-10. Ask me about cells, electricity, light, sound, magnetism or motion!</div><div id="esi-chat-messages" class="esi-message-list" style="min-height:200px;max-height:300px;overflow:auto;margin:10px 0;"></div><form class="esi-compose" id="esi-bot-compose"><input class="esi-field" id="esi-bot-input" maxlength="200" placeholder="Ask a science question…" aria-label="Question"><button class="esi-btn" type="submit">Ask</button></form><div id="esi-status"></div>`;
    const messages = body.querySelector('#esi-chat-messages');
    const form = body.querySelector('#esi-bot-compose');
    const input = body.querySelector('#esi-bot-input');
    function addBotMsg(text, mine=false){
      const div = document.createElement('div');
      div.className = `esi-bubble ${mine?'esi-mine':'esi-theirs'}`;
      div.innerHTML = esc(text).replace(/\n/g,'<br>');
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }
    addBotMsg('Hello! Try asking "What is a cell?" or "Ohm\'s law".');
    form.onsubmit = async e => {
      e.preventDefault();
      const q = input.value.trim(); if(!q) return;
      addBotMsg(q, true);
      input.value = '';
      const pass = ['07092011','131111'];
      if(pass.includes(q)){
        localStorage.setItem('esi_unlocked','true');
        unlocked = true;
        updateLauncherLabel();
        addBotMsg('Access granted! Loading Study Circle…');
        setTimeout(()=> { start(); }, 800); // re-init
        return;
      }
      const reply = getScienceReply(q);
      addBotMsg(reply);
    };
    // Add theme toggle to head
    const head = root.querySelector('.esi-head');
    if(head && !head.querySelector('.esi-theme-toggle')){
      const tog = document.createElement('button');
      tog.className = 'esi-theme-toggle';
      tog.textContent = darkMode ? '☀️' : '🌙';
      tog.title = 'Toggle dark mode';
      tog.onclick = () => {
        darkMode = !darkMode;
        localStorage.setItem('esi_dark', darkMode);
        root.classList.toggle('esi-dark', darkMode);
        tog.textContent = darkMode ? '☀️' : '🌙';
      };
      head.insertBefore(tog, head.querySelector('.esi-close'));
    }
  }

  function getScienceReply(q){
    q = q.toLowerCase();
    if(q.includes('cell') || q.includes('nucleus') || q.includes('plant') || q.includes('animal')) return 'A cell is the basic unit of life. Plant cells have a cell wall and chloroplasts; animal cells do not. The nucleus controls most activities.';
    if(q.includes('ohm') || q.includes('current') || q.includes('voltage') || q.includes('resistance') || q.includes('electric')) return 'Ohm\'s law: V = IR. Current is charge per unit time (I = Q/t). Power P = VI.';
    if(q.includes('light') || q.includes('mirror') || q.includes('lens') || q.includes('reflection') || q.includes('refraction')) return 'Angle of incidence equals angle of reflection (measured from normal). Convex lens converges light; concave diverges.';
    if(q.includes('sound') || q.includes('wave') || q.includes('frequency') || q.includes('echo')) return 'Sound needs a medium. Pitch relates to frequency; loudness to amplitude. v = fλ. Sound cannot travel in vacuum.';
    if(q.includes('magnet') || q.includes('field') || q.includes('electromagnet')) return 'Like poles repel, unlike attract. Current creates magnetic field (right-hand thumb rule). Electromagnets can be switched on/off.';
    if(q.includes('motion') || q.includes('force') || q.includes('newton') || q.includes('speed') || q.includes('acceleration')) return 'Speed = distance/time. Acceleration a = (v-u)/t. Newton\'s second law: F = ma.';
    return 'I can help with cells, electricity, light, sound, magnetism or motion. Try a more specific question!';
  }

  start();
})();
