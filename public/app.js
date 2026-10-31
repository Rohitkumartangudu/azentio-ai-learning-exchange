const $ = (s) => document.querySelector(s);
const views = ['clientView','moderatorView','ownerView'];
let currentUser = null;
let sharedItems = [];
let observationCache = new Map();

function esc(value='') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function scanPrivacy(title='',summary=''){
  const text=`${title}\n${summary}`,flags=[];
  if(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text))flags.push('email address');
  if((text.match(/\+?\d[\d\s().-]{7,}\d/g)||[]).some(value=>{const digits=value.replace(/\D/g,'').length;return digits>=10&&digits<=15;}))flags.push('phone-like number');
  if(/\b\d{8,19}\b/.test(text))flags.push('long numeric identifier');
  return flags;
}
function dateLabel(value) { try { return new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(value)); } catch { return ''; } }
function dateTimeLabel(value) { try { return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)); } catch { return ''; } }
function visibilityLabel(o){
  if(o.status==='published')return 'Approved shared copy: visible to authorised learning-community clients. Your source record remains private.';
  if(o.status==='superseded')return 'Archived version: replaced in the shared feed by a newer approved version.';
  if(o.status==='withdrawn')return 'Withdrawn: removed from the shared feed and future retrieval.';
  if(o.status==='removed_by_moderator')return 'Removed from the shared learning feed by moderation.';
  if(o.status==='pending_review')return o.version>1?'Proposed version: visible to you and authorised moderators; the current approved version remains shared.':'Pending review: visible to you and authorised moderators, not to the community.';
  if(o.status==='clarification_requested')return 'Returned to you for changes; it is not in the community feed.';
  if(o.sharing==='organisation')return 'Organisation-only: visible to members of your organisation under their workspace permissions.';
  return 'Private draft: visible only to you.';
}
function consentSummary(o){
  const history=Array.isArray(o.consentHistory)?o.consentHistory:[];
  const processing=history.filter(x=>x.purpose==='storage_processing').at(-1);
  const publishing=history.filter(x=>x.purpose==='community_publication').at(-1);
  const processText=processing?`permitted ${dateTimeLabel(processing.at)}`:o.consentProcessing?'recorded in legacy demo data':'not recorded';
  const publishText=publishing?`${publishing.granted?'permitted':'not permitted'} ${dateTimeLabel(publishing.at)}`:o.consentPublish?'recorded in legacy demo data':'not permitted';
  return `Storage/processing: ${processText}. Community publication: ${publishText}. Attribution and model training: not permitted.`;
}
function showNotice(message, kind='success') { const n=$('#notice'); n.textContent=message; n.className=`notice ${kind}`; window.scrollTo({top:0,behavior:'smooth'}); setTimeout(()=>n.classList.add('hidden'),5000); }
async function api(url, options={}) {
  const response=await fetch(url,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({error:'Unexpected server response.'}));
  if(!response.ok) throw new Error(data.error||`Request failed (${response.status})`);
  return data;
}
function setPage(user) {
  currentUser=user;
  $('#loginView').classList.toggle('hidden',Boolean(user));
  $('#workspace').classList.toggle('hidden',!user);
  $('#userBadge').classList.toggle('hidden',!user);
  if(!user){views.forEach(id=>$('#'+id).classList.add('hidden'));return;}
  $('#userBadge').textContent=`${user.name} · ${user.orgName}`;
  $('#welcomeTitle').textContent=user.role==='client'?`Welcome, ${user.name.split(' ')[0]}`:user.role==='moderator'?'Moderation workspace':'Product improvement';
  $('#welcomeSub').textContent=user.role==='client'?`${user.orgName} · Client workspace`:user.orgName;
  views.forEach(id=>$('#'+id).classList.toggle('hidden',id!==`${user.role}View`));
  $('#clientAdminPanel').classList.toggle('hidden',user.role!=='client'||!user.clientAdmin);
  loadNotifications();
  if(user.role==='client'){loadMyObservations();loadShared('sharedFeed');loadThemes('themeDashboard');loadIdeas('clientIdeas');if(user.clientAdmin)loadClientAdmin();}
  if(user.role==='moderator'){loadQueue();loadReports();loadShared('modFeed');loadAudit('modAudit');}
  if(user.role==='owner'){loadShared('ownerFeed');loadIdeas('ownerIdeas');loadThemes('ownerThemeDashboard');loadAudit('ownerAudit');}
}
function statusPill(status) {
  const cls=status==='published'?'good':status==='pending_review'||status==='clarification_requested'||status==='under_review'?'pending':status==='withdrawn'||status==='rejected'||status==='removed_by_moderator'?'bad':status==='superseded'?'':'private';
  return `<span class="pill ${cls}">${esc(status.replaceAll('_',' '))}</span>`;
}
async function loadNotifications(){
  try{const {items}=await api('/api/notifications');const box=$('#notifications');box.innerHTML=items.length?`<b>Recent updates:</b> ${items.slice(0,3).map(n=>esc(n.message)).join(' · ')}`:'';box.classList.toggle('hidden',!items.length);}catch{}
}
async function loadMyObservations(){
  const box=$('#myObservations');
  try{
    const {observations}=await api('/api/observations');
    observationCache=new Map(observations.map(o=>[o.id,o]));
    box.innerHTML=observations.length?observations.slice().reverse().map(o=>`<article class="list-item"><h3>${esc(o.title)}</h3><p>${esc(o.summary)}</p><div class="meta-row">${statusPill(o.status)}<span class="pill">${esc(o.sharing)}</span>${o.version?`<span class="pill">Version ${o.version}</span>`:''}<span class="pill">${dateLabel(o.updatedAt)}</span></div><p class="small muted">${esc(visibilityLabel(o))}</p><p class="small muted">${esc(consentSummary(o))}</p>${o.moderatorReason?`<p><b>Moderator note:</b> ${esc(o.moderatorReason)}</p>`:''}<div class="item-actions">${o.status==='draft'||o.status==='clarification_requested'?`<button class="button button-outline edit-observation" data-id="${esc(o.id)}">Edit and resubmit</button>`:''}${o.status==='published'?`<button class="button button-outline version-observation" data-id="${esc(o.id)}">Propose updated version</button>`:''}${!['withdrawn','removed_by_moderator','superseded'].includes(o.status)?`<button class="button button-outline withdraw" data-id="${esc(o.id)}">Withdraw</button>`:''}</div></article>`).join(''):'<div class="empty">No observations yet. Saved drafts remain private.</div>';
    box.querySelectorAll('.withdraw').forEach(b=>b.addEventListener('click',()=>withdraw(b.dataset.id)));
    box.querySelectorAll('.edit-observation').forEach(b=>b.addEventListener('click',()=>editObservation(b.dataset.id)));
    box.querySelectorAll('.version-observation').forEach(b=>b.addEventListener('click',()=>proposeVersion(b.dataset.id)));
  }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
function editObservation(id){
  const observation=observationCache.get(id);if(!observation)return;
  const form=$('#observationForm');
  for(const [key,value] of Object.entries(observation)){const field=form.elements.namedItem(key);if(field&&key!=='consentPublish')field.value=value??'';}
  $('#editId').value=id;
  $('#versionOf').value='';$('#saveDraft').classList.remove('hidden');
  $('#consentProcessing').checked=false;
  $('#editModeHint').textContent=observation.status==='clarification_requested'?`Amending the submission returned by the moderator. Note: ${observation.moderatorReason||'Review the moderator feedback below.'} Confirm community publishing consent again before resubmitting.`:'Editing your private draft. It remains private until you explicitly submit it for review.';
  $('#editModeHint').classList.remove('hidden');$('#cancelEdit').classList.remove('hidden');
  $('#submitReview').textContent=observation.status==='clarification_requested'?'Resubmit amended observation':'Submit for review';
  updatePrivacyWarning();
  $('#consentPublish').checked=false;
  $('#sharing').dispatchEvent(new Event('change'));
  form.scrollIntoView({behavior:'smooth',block:'center'});
}
function proposeVersion(id){
  const observation=observationCache.get(id);if(!observation)return;
  const form=$('#observationForm');
  for(const [key,value] of Object.entries(observation)){const field=form.elements.namedItem(key);if(field&&key!=='consentPublish')field.value=value??'';}
  $('#editId').value='';$('#versionOf').value=id;$('#editModeHint').textContent=`Proposing version ${(observation.version||1)+1}. The currently approved copy stays available until a moderator approves this version. Confirm community publishing consent again.`;
  $('#editModeHint').classList.remove('hidden');$('#cancelEdit').classList.remove('hidden');$('#saveDraft').classList.add('hidden');
  $('#consentProcessing').checked=false;$('#consentPublish').checked=false;$('#sharing').value='community';$('#sharing').dispatchEvent(new Event('change'));
  updatePrivacyWarning();
  $('#submitReview').textContent=`Submit version ${(observation.version||1)+1} for review`;
  form.scrollIntoView({behavior:'smooth',block:'center'});
}
function clearObservationEdit(){
  $('#observationForm').reset();$('#editId').value='';$('#versionOf').value='';$('#editModeHint').classList.add('hidden');$('#cancelEdit').classList.add('hidden');$('#saveDraft').classList.remove('hidden');$('#submitReview').textContent='Submit for review';
  updatePrivacyWarning();
  $('#sharing').dispatchEvent(new Event('change'));
}
function updatePrivacyWarning(){
  const warning=$('#privacyWarning'),flags=scanPrivacy($('#observationForm').elements.namedItem('title').value,$('#observationForm').elements.namedItem('summary').value);
  warning.textContent=flags.length?`Possible sensitive pattern detected: ${flags.join(', ')}. Review and remove it before submission. If you continue, moderators will be asked to review this item. The scan can miss other sensitive information.`:'';
  warning.classList.toggle('hidden',!flags.length);
}
async function loadShared(target){
  const box=$('#'+target); if(!box)return;
  try{
    const params=new URLSearchParams();
    if(target==='sharedFeed'){
      const q=$('#feedSearch').value.trim();if(q)params.set('q',q);
      for(const key of ['offering','industry','region','period','topic']){const value=$('#filter'+key[0].toUpperCase()+key.slice(1)).value;if(value)params.set(key,value);}
    }
    const {items}=await api('/api/shared'+(params.size?'?'+params.toString():'')); sharedItems=items;
    if(target==='sharedFeed'){
      const all=await api('/api/shared');
      for(const key of ['offering','industry','region','period','topic']){
        const sel=$('#filter'+key[0].toUpperCase()+key.slice(1)), selected=sel.value;
        const values=[...new Set(all.items.map(x=>x[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
        sel.innerHTML=`<option value="">All ${key==='period'?'periods':key==='topic'?'topics':key==='offering'?'offerings':key==='industry'?'industries':'regions'}</option>`+values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
        sel.value=selected;
      }
    }
    box.innerHTML=items.length?items.map(x=>`<article class="feed-card"><div class="tagline">${esc(x.offering)} · ${esc(x.industry)} · ${esc(x.period)}</div><h3>${esc(x.title)}</h3><p>${esc(x.summary)}</p><div class="meta-row"><span class="pill">${esc(x.region)}</span><span class="pill">${esc(x.topic)}</span><span class="pill">${esc(x.evidenceType)}</span><span class="pill">Contributor confidence: ${esc(x.confidence)}</span></div><p class="small muted">Reviewed shared copy · ${dateLabel(x.publishedAt)}</p><div class="quality-assessment"><b>Reviewer evidence assessment: ${esc(x.evidenceQuality||'Not assessed')}</b><p>${esc(x.evidenceQualityNote||'This existing demo copy has no recorded reviewer assessment.')}</p><p class="small muted">Human assessment of the supporting material; it does not establish that the claim is true.</p></div>${currentUser?.role==='client'?`<div class="small muted">${x.myFeedback?`Your organisation marked this: ${x.myFeedback==='useful'?'Useful':'Needs more evidence'}.`:'Quality feedback (one response per organisation):'}</div><div class="item-actions">${x.myFeedback?'':`<button class="button button-outline feedback" data-id="${esc(x.id)}" data-value="useful">Useful</button><button class="button button-outline feedback" data-id="${esc(x.id)}" data-value="needs_evidence">Needs more evidence</button>`}<button class="button button-outline report" data-id="${esc(x.id)}">Report content</button></div>`:''}</article>`).join(''):'<div class="empty">No approved observations match this view yet.</div>';
    box.querySelectorAll('.report').forEach(b=>b.addEventListener('click',()=>report(b.dataset.id)));
    box.querySelectorAll('.feedback').forEach(b=>b.addEventListener('click',()=>submitFeedback(b.dataset.id,b.dataset.value)));
    if(target==='evidenceSelect') return;
    const sel=$('#evidenceSelect'); if(sel) sel.innerHTML=items.length?items.map(x=>`<option value="${esc(x.id)}">${esc(x.title)}</option>`).join(''):'<option value="">No approved contributions available</option>';
  }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function loadThemes(target){
  const box=$('#'+target);if(!box)return;
  try{
    const [{minimumOrganisations,themes},{items:ideas}]=await Promise.all([api('/api/themes'),api('/api/ideas')]);
    box.innerHTML=themes.length?themes.map(t=>{
      const evidence=t.supportingContributions||[], evidenceIds=new Set(evidence.map(c=>c.id));
      const linked=ideas.filter(i=>evidenceIds.has(i.evidenceId));
      return `<article class="feed-card"><div class="tagline">${esc(t.offering)} · ${esc(t.observationPeriod)}</div><h3>${esc(t.topic)}</h3><p>Supported by ${t.distinctOrganisations} distinct organisations across ${evidence.length} approved contributions.</p><p class="small muted">${esc(t.confidenceAndLimitations)}</p><div class="theme-evidence"><b>Approved evidence and reviewer assessment</b><ul>${evidence.map(c=>`<li>${esc(c.title)}<div class="small muted">${c.evidenceQuality?`Reviewer assessment: ${esc(c.evidenceQuality)}. ${esc(c.evidenceQualityNote||'')}`:'Reviewer assessment: not recorded for this existing demo copy.'}</div></li>`).join('')}</ul></div><div class="theme-action"><b>Linked improvement action${linked.length===1?'':'s'}</b>${linked.length?linked.map(i=>`<div class="theme-idea"><span>${esc(i.title)}</span><span class="pill ${i.status==='Released'?'good':'pending'}">${esc(i.status)}</span><span class="small muted">Owner: ${esc(i.owner)} · Updated ${dateLabel(i.updatedAt)}</span></div>`).join(''):'<p class="small muted">No audience-visible improvement idea is linked to this evidence yet.</p>'}</div></article>`;
    }).join(''):`<div class="empty">No theme currently meets the minimum of ${minimumOrganisations} distinct organisations.</div>`;
  }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function loadQueue(){
  const box=$('#reviewQueue');
  try{
    const {observations}=await api('/api/observations');
    box.innerHTML=observations.length?observations.map(o=>`<article class="list-item"><div class="section-label">${esc(o.orgName)} · ${esc(o.authorName)} · ${esc(o.offering)}${o.version>1?` · Version ${o.version}`:''}</div><h3>${esc(o.title)}</h3><p>${esc(o.summary)}</p><div class="meta-row"><span class="pill">${esc(o.industry)}</span><span class="pill">${esc(o.region)}</span><span class="pill">${esc(o.period)}</span><span class="pill">${esc(o.topic)}</span>${statusPill(o.status)}</div>${o.privacyReviewStatus==='flagged'?`<div class="notice error"><b>Possible sensitive pattern flagged:</b> ${esc((o.privacyFlags||[]).join(', '))}. The basic scan checked the source title and summary. Review the final shared copy and remove any sensitive details.</div><label class="consent-row"><input class="privacy-reviewed" type="checkbox"><span>I reviewed the flagged source and checked the final shared title and wording for sensitive details.</span></label>`:''}${o.version>1?'<p class="small muted">The currently approved version remains available until this version is approved.</p>':''}<label>Reviewer evidence assessment<select class="review-quality"><option value="">Choose an assessment</option><option>Strong</option><option>Moderate</option><option>Limited</option></select></label><p class="small muted quality-guidance">Suggested guide: Strong = direct, relevant support; Moderate = relevant support with material gaps; Limited = narrow, anecdotal or unverified support. This assesses the evidence provided, not whether the claim is true.</p><label>Assessment rationale (published with the shared copy)<textarea class="review-quality-note review-text" maxlength="300" placeholder="Explain the evidence limits or support in up to 300 characters"></textarea></label><label>Reviewed shared title<input class="review-title" value="${esc(o.title)}" maxlength="120"></label><label>Reviewed shared wording<textarea class="review-summary review-text" maxlength="1200">${esc(o.summary)}</textarea></label><label>Decision note (for clarification/rejection)<input class="review-reason" maxlength="300" placeholder="Explain what needs attention"></label><div class="item-actions"><button class="button button-primary approve" data-id="${esc(o.id)}">Approve reviewed copy</button><button class="button button-outline clarify" data-id="${esc(o.id)}">Request clarification</button><button class="button button-outline reject" data-id="${esc(o.id)}">Reject</button></div></article>`).join(''):'<div class="empty">Review queue is clear.</div>';
    box.querySelectorAll('.approve').forEach(b=>b.addEventListener('click',()=>moderate(b,'approve')));
    box.querySelectorAll('.clarify').forEach(b=>b.addEventListener('click',()=>moderate(b,'clarify')));
    box.querySelectorAll('.reject').forEach(b=>b.addEventListener('click',()=>moderate(b,'reject')));
  }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function loadReports(){
  const box=$('#reportsList');
  try{
    const {items}=await api('/api/reports');
    box.innerHTML=items.length?items.map(r=>`<article class="list-item report-card"><h3>${esc(r.title)}</h3><p><b>Report:</b> ${esc(r.reason)}</p><div class="meta-row"><span class="pill ${r.status==='under_review'?'pending':'bad'}">${esc(r.status.replaceAll('_',' '))}</span><span class="pill">${esc(r.sharedId)}</span><span class="pill">${dateLabel(r.createdAt)}</span></div>${r.decisionNote?`<p><b>Review note:</b> ${esc(r.decisionNote)}</p>`:''}<label>Decision note<input class="report-decision-note" maxlength="300" placeholder="Record the moderation decision" required></label><div class="item-actions">${r.status==='open'?`<button class="button button-outline report-dismiss" data-id="${esc(r.id)}" data-action="dismiss">Dismiss and keep published</button><button class="button button-primary report-unpublish" data-id="${esc(r.id)}" data-action="unpublish">Temporarily unpublish</button>`:`<button class="button button-outline report-restore" data-id="${esc(r.id)}" data-action="restore">Restore publication</button><button class="button button-primary report-remove" data-id="${esc(r.id)}" data-action="remove">Keep unpublished</button>`}</div></article>`).join(''):'<div class="empty">No reports need moderator review.</div>';
    box.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>resolveReport(button)));
  }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function resolveReport(button){
  const card=button.closest('.list-item'),reason=card.querySelector('.report-decision-note').value.trim();
  if(!reason){showNotice('Add a brief decision note before recording the report outcome.','error');card.querySelector('.report-decision-note').focus();return;}
  try{await api(`/api/reports/${button.dataset.id}/review`,{method:'POST',body:JSON.stringify({action:button.dataset.action,reason})});showNotice('Report decision recorded and contributor notified.');await Promise.all([loadReports(),loadShared('modFeed'),loadAudit('modAudit')]);}catch(e){showNotice(e.message,'error');}
}
async function loadAudit(target){
  const box=$('#'+target);if(!box)return;
  try{
    const {events}=await api('/api/audit');
    box.innerHTML=events.length?events.map(event=>`<article class="list-item"><div class="meta-row"><span class="pill good">${esc(event.action.replaceAll('_',' '))}</span><span class="pill">${esc(event.actor)}</span><span class="pill">${esc(event.resourceType)} · ${esc(event.resourceId)}</span><span class="pill">${new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(event.at))}</span></div>${event.detail?`<p>${esc(event.detail)}</p>`:''}</article>`).join(''):'<div class="empty">No audit events recorded yet.</div>';
  }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function loadIdeas(target){
  const box=$('#'+target);if(!box)return;
  try{const {items}=await api('/api/ideas');const statuses=['Proposed','Under review','Planned','In progress','Released','Not proceeding'];box.innerHTML=items.length?items.map(i=>`<article class="list-item"><h3>${esc(i.title)}</h3><p>${esc(i.problem)}</p><div class="meta-row"><span class="pill good">${esc(i.status)}</span><span class="pill">${esc(i.offering)}</span><span class="pill">Owner: ${esc(i.owner)}</span><span class="pill">${esc(i.priority)} priority</span><span class="pill">Updated ${dateLabel(i.updatedAt)}</span></div>${currentUser?.role==='owner'?`<div class="item-actions status-actions">${statuses.map(s=>`<button class="button ${s===i.status?'button-primary':'button-outline'} status-action" data-id="${esc(i.id)}" data-status="${esc(s)}" ${s===i.status?'disabled':''}>${esc(s)}</button>`).join('')}</div>`:''}</article>`).join(''):'<div class="empty">No improvement ideas have been shared with this audience.</div>';
    box.querySelectorAll('.status-action').forEach(b=>b.addEventListener('click',()=>updateIdea(b.dataset.id,b.dataset.status)));
  }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function loadClientAdmin(){
  try{
    const [{members},{invitations}]=await Promise.all([api('/api/client-admin/members'),api('/api/client-admin/invitations')]);
    const memberBox=$('#clientMembers');
    memberBox.innerHTML=members.length?members.map(m=>`<article class="list-item"><h3>${esc(m.name)}${m.self?' · You':''}</h3><p class="small muted">Demo login: ${esc(m.login)} · ${m.active?'Active membership':'Revoked membership'}</p>${m.self?`<span class="pill good">${m.role==='client_admin'?'Client administrator':'Client member'}</span>`:m.active?`<label>Client role<select class="member-role" data-id="${esc(m.id)}"><option value="client_member" ${m.role==='client_member'?'selected':''}>Client member</option><option value="client_admin" ${m.role==='client_admin'?'selected':''}>Client administrator</option></select></label><div class="item-actions"><button class="button button-outline save-member-role" data-id="${esc(m.id)}">Save role</button><button class="button button-outline revoke-member" data-id="${esc(m.id)}">Revoke membership</button></div>`:`<button class="button button-outline restore-member" data-id="${esc(m.id)}">Restore membership</button>`}</article>`).join(''):'<div class="empty">No client members are registered.</div>';
    memberBox.querySelectorAll('.save-member-role').forEach(b=>b.addEventListener('click',()=>saveClientRole(b.dataset.id,memberBox.querySelector(`.member-role[data-id="${CSS.escape(b.dataset.id)}"]`).value)));
    memberBox.querySelectorAll('.revoke-member').forEach(b=>b.addEventListener('click',()=>revokeClientMember(b.dataset.id)));
    memberBox.querySelectorAll('.restore-member').forEach(b=>b.addEventListener('click',()=>restoreClientMember(b.dataset.id)));
    const inviteBox=$('#clientInvitations');
    inviteBox.innerHTML=invitations.length?invitations.map(i=>`<article class="list-item"><h3>${esc(i.email)}</h3><div class="meta-row"><span class="pill">${i.role==='client_admin'?'Client administrator':'Client member'}</span><span class="pill ${i.status==='pending'?'pending':i.status==='revoked'?'bad':'good'}">${esc(i.status)}</span><span class="pill">${dateLabel(i.createdAt)}</span></div>${i.status==='pending'?`<div class="item-actions"><button class="button button-outline revoke-invitation" data-id="${esc(i.id)}">Revoke invitation</button></div>`:''}</article>`).join(''):'<div class="empty">No demo invitations yet.</div>';
    inviteBox.querySelectorAll('.revoke-invitation').forEach(b=>b.addEventListener('click',()=>revokeClientInvitation(b.dataset.id)));
  }catch(e){$('#clientMembers').innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function saveClientRole(memberId,role){try{await api(`/api/client-admin/members/${encodeURIComponent(memberId)}/role`,{method:'POST',body:JSON.stringify({role})});showNotice('Organisation role updated and audited.');await loadClientAdmin();}catch(e){showNotice(e.message,'error');}}
async function revokeClientMember(memberId){if(!confirm('Revoke this member’s access to the organisation workspace? They will no longer be able to sign in.'))return;try{await api(`/api/client-admin/members/${encodeURIComponent(memberId)}/revoke`,{method:'POST',body:'{}'});showNotice('Membership revoked. The member can be restored by this organisation administrator.');await loadClientAdmin();}catch(e){showNotice(e.message,'error');}}
async function restoreClientMember(memberId){try{await api(`/api/client-admin/members/${encodeURIComponent(memberId)}/restore`,{method:'POST',body:'{}'});showNotice('Membership restored.');await loadClientAdmin();}catch(e){showNotice(e.message,'error');}}
async function revokeClientInvitation(invitationId){if(!confirm('Revoke this pending demo invitation?'))return;try{await api(`/api/client-admin/invitations/${encodeURIComponent(invitationId)}/revoke`,{method:'POST',body:'{}'});showNotice('Demo invitation revoked and audited.');await loadClientAdmin();}catch(e){showNotice(e.message,'error');}}
async function withdraw(id){try{await api(`/api/observations/${id}/withdraw`,{method:'POST',body:'{}'});showNotice('Withdrawn. It no longer appears in the shared feed or future retrieval.');await Promise.all([loadMyObservations(),loadShared('sharedFeed'),loadNotifications()]);}catch(e){showNotice(e.message,'error');}}
async function resubmit(id){try{await api(`/api/observations/${id}/submit`,{method:'POST',body:'{}'});showNotice('Submitted for moderator review.');await Promise.all([loadMyObservations(),loadNotifications()]);}catch(e){showNotice(e.message,'error');}}
async function moderate(button,action){
  const card=button.closest('.list-item');const data={action};
  if(action==='approve'){data.sharedTitle=card.querySelector('.review-title').value;data.sharedSummary=card.querySelector('.review-summary').value;data.evidenceQuality=card.querySelector('.review-quality').value;data.evidenceQualityNote=card.querySelector('.review-quality-note').value;data.privacyReviewed=Boolean(card.querySelector('.privacy-reviewed')?.checked);}
  else data.reason=card.querySelector('.review-reason').value;
  try{await api(`/api/moderation/${button.dataset.id}`,{method:'POST',body:JSON.stringify(data)});showNotice(action==='approve'?'Approved shared copy published.':'Moderation decision recorded.');await Promise.all([loadQueue(),loadShared('modFeed'),loadNotifications()]);}catch(e){showNotice(e.message,'error');}
}
async function report(sharedId){const reason=prompt('Briefly describe the concern. Do not include another client’s identity.');if(!reason)return;try{await api('/api/reports',{method:'POST',body:JSON.stringify({sharedId,reason})});showNotice('Report recorded for moderation.');}catch(e){showNotice(e.message,'error');}}
async function submitFeedback(sharedId,value){try{await api(`/api/shared/${encodeURIComponent(sharedId)}/feedback`,{method:'POST',body:JSON.stringify({value})});showNotice('Quality feedback recorded for your organisation.');await loadShared('sharedFeed');}catch(e){showNotice(e.message,'error');}}
async function updateIdea(id,status){try{await api(`/api/ideas/${id}`,{method:'POST',body:JSON.stringify({status})});showNotice('Improvement status updated and audited.');await Promise.all([loadIdeas('ownerIdeas'),loadThemes('ownerThemeDashboard')]);}catch(e){showNotice(e.message,'error');}}

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';try{const data=await api('/api/login',{method:'POST',body:JSON.stringify({login:$('#login').value,password:$('#password').value})});setPage(data.user);}catch(err){$('#loginError').textContent=err.message;}});
$('#logoutButton').addEventListener('click',async()=>{await api('/api/logout',{method:'POST',body:'{}'});setPage(null);});
$('#sharing').addEventListener('change',()=>{const community=$('#sharing').value==='community';$('#consentRow').classList.toggle('hidden',!community);$('#submitReview').classList.toggle('hidden',!community);});
$('#observationForm').addEventListener('submit',async e=>{
  e.preventDefault();const fd=new FormData(e.target);const intent=e.submitter?.value||'draft';
  const data=Object.fromEntries(fd.entries());data.submit=intent==='submit';data.consentProcessing=fd.get('consentProcessing')==='on';data.consentPublish=fd.get('consentPublish')==='on';
  const privacyFlags=scanPrivacy(data.title,data.summary);
  if(data.submit&&privacyFlags.length&&!confirm(`The basic scan found a possible ${privacyFlags.join(', ')} in the title or summary. Remove it before submitting. If you continue, moderators will see a review flag and must check the edited shared copy. Continue to moderator review?`))return;
  try{
    const editId=data.editId,versionOf=data.versionOf;delete data.editId;delete data.versionOf;
    await api(versionOf?`/api/observations/${versionOf}/version`:editId?`/api/observations/${editId}/amend`:'/api/observations',{method:'POST',body:JSON.stringify(data)});
    clearObservationEdit();showNotice(versionOf?'New version submitted. The approved copy remains shared until moderator review.':editId?(data.submit?'Amended observation resubmitted for moderator review.':'Draft changes saved privately.'):(data.submit?'Observation submitted for review. Your source remains private.':'Private draft saved. It has not been shared.'));
    await Promise.all([loadMyObservations(),loadNotifications()]);
  }catch(err){showNotice(err.message,'error');}
});
$('#observationForm').querySelectorAll('[name="title"],[name="summary"]').forEach(field=>field.addEventListener('input',updatePrivacyWarning));
$('#cancelEdit').addEventListener('click',clearObservationEdit);
$('#ideaForm').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target).entries());try{await api('/api/ideas',{method:'POST',body:JSON.stringify(data)});e.target.reset();showNotice('Improvement idea created with permitted evidence.');await Promise.all([loadIdeas('ownerIdeas'),loadIdeas('clientIdeas'),loadThemes('ownerThemeDashboard')]);}catch(err){showNotice(err.message,'error');}});
$('#clientInviteForm').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target).entries());try{await api('/api/client-admin/invitations',{method:'POST',body:JSON.stringify(data)});e.target.reset();showNotice('Synthetic invitation recorded. No email was sent and no account was created.');await loadClientAdmin();}catch(err){showNotice(err.message,'error');}});
$('#refreshClient').addEventListener('click',loadMyObservations);$('#refreshFeed').addEventListener('click',()=>loadShared('sharedFeed'));$('#refreshThemes').addEventListener('click',()=>loadThemes('themeDashboard'));$('#refreshOwnerThemes')?.addEventListener('click',()=>loadThemes('ownerThemeDashboard'));$('#feedSearch').addEventListener('input',()=>loadShared('sharedFeed'));
$('#refreshClientAdmin').addEventListener('click',loadClientAdmin);
for(const key of ['offering','industry','region','period','topic'])$('#filter'+key[0].toUpperCase()+key.slice(1)).addEventListener('change',()=>loadShared('sharedFeed'));
$('#refreshQueue').addEventListener('click',loadQueue);$('#refreshReports').addEventListener('click',loadReports);$('#refreshIdeas').addEventListener('click',()=>loadIdeas('ownerIdeas'));
$('#refreshModAudit').addEventListener('click',()=>loadAudit('modAudit'));$('#refreshOwnerAudit').addEventListener('click',()=>loadAudit('ownerAudit'));
$('#sharing').dispatchEvent(new Event('change'));
api('/api/session').then(({user})=>setPage(user)).catch(()=>setPage(null));
