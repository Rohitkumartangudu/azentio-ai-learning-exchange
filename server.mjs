import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const DATA_DIR = path.join(HERE, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const PORT = Number(process.env.PORT || 4173);
const requestedThemeThreshold = Number(process.env.MIN_THEME_ORGS || 3);
const MIN_THEME_ORGS = Number.isFinite(requestedThemeThreshold) ? Math.max(3, requestedThemeThreshold) : 3;
const COOKIE = 'az_session';
const sessions = new Map();
const sessionKey = randomBytes(32);

const demoUsers = [
  { id: 'user-a', login: 'client-a', name: 'Asha Rao', role: 'client', orgId: 'org-a', orgName: 'Northstar Finance', isOrgAdmin: true },
  { id: 'user-a-team', login: 'client-a-teammate', name: 'Mira Patel', role: 'client', orgId: 'org-a', orgName: 'Northstar Finance', isOrgAdmin: false },
  { id: 'user-b', login: 'client-b', name: 'Ben Carter', role: 'client', orgId: 'org-b', orgName: 'BlueRiver Bank' },
  { id: 'user-c', login: 'client-c', name: 'Chloe Singh', role: 'client', orgId: 'org-c', orgName: 'Cedar Trust' },
  { id: 'moderator-1', login: 'moderator', name: 'Learning Moderator', role: 'moderator', orgId: null, orgName: 'Platform moderation' },
  { id: 'owner-1', login: 'owner', name: 'Product Owner', role: 'owner', orgId: null, orgName: 'Financial Analysis Intelligence' },
];
const passwordSalt = 'azentio-demo-only-salt';
const demoPasswordHash = scryptSync('demo123', passwordSalt, 32);

function initialStore() {
  return {
    users: demoUsers,
    observations: [],
    sharedCopies: [],
    ideas: [],
    notifications: [],
    reports: [],
    feedback: [],
    clientInvitations: [],
    audit: [],
    nextObservation: 1,
    nextShared: 1,
    nextIdea: 1,
  };
}

await mkdir(DATA_DIR, { recursive: true });
if (!existsSync(STORE_PATH)) await writeFile(STORE_PATH, JSON.stringify(initialStore(), null, 2));
let store = JSON.parse(await readFile(STORE_PATH, 'utf8'));
if (!Array.isArray(store.feedback)) store.feedback = [];
if (!Array.isArray(store.clientInvitations)) store.clientInvitations = [];
for (const seed of demoUsers) {
  let existing = store.users.find(u => u.id === seed.id);
  if (!existing) { existing = { ...seed, active: true }; store.users.push(existing); }
  if (existing.active === undefined) existing.active = true;
  if (existing.isOrgAdmin === undefined) existing.isOrgAdmin = Boolean(seed.isOrgAdmin);
  if (!existing.login) existing.login = seed.login;
}

async function persist() {
  const temp = `${STORE_PATH}.tmp`;
  await writeFile(temp, JSON.stringify(store, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(temp, STORE_PATH);
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
function safeUser(user) {
  return { id: user.id, name: user.name, role: user.role, orgId: user.orgId, orgName: user.orgName, clientAdmin: user.role === 'client' && user.isOrgAdmin === true };
}
function currentUser(req) {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) { sessions.delete(token); return null; }
  return store.users.find(u => u.id === session.userId && u.active !== false) || null;
}
function requireRole(user, roles) { return Boolean(user && roles.includes(user.role)); }
function audit(actor, action, resourceType, resourceId, detail = '') {
  store.audit.push({ id: randomBytes(8).toString('hex'), actorId: actor?.id || 'system', action, resourceType, resourceId, detail, at: new Date().toISOString() });
}
function notify(userId, message) {
  store.notifications.push({ id: randomBytes(8).toString('hex'), userId, message, read: false, at: new Date().toISOString() });
}
function cleanShared(copy) {
  return {
    id: copy.id,
    title: copy.title,
    summary: copy.summary,
    offering: copy.offering,
    industry: copy.industry,
    region: copy.region,
    period: copy.period,
    topic: copy.topic,
    evidenceType: copy.evidenceType,
    confidence: copy.confidence,
    evidenceQuality: copy.evidenceQuality || null,
    evidenceQualityNote: copy.evidenceQualityNote || '',
    publishedAt: copy.publishedAt,
    status: copy.status,
  };
}
async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 128_000) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}
function validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
function sensitiveIndicators(title, summary) {
  const text = `${title || ''}\n${summary || ''}`;
  const flags = new Set();
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) flags.add('email address');
  if ((text.match(/\+?\d[\d\s().-]{7,}\d/g) || []).some(value => { const digits = value.replace(/\D/g, '').length; return digits >= 10 && digits <= 15; })) flags.add('phone-like number');
  if (/\b\d{8,19}\b/.test(text)) flags.add('long numeric identifier');
  return [...flags];
}
for (const observation of store.observations) {
  if (observation.status === 'pending_review' && !Array.isArray(observation.privacyFlags)) {
    observation.privacyFlags = sensitiveIndicators(observation.title, observation.summary);
    observation.privacyReviewStatus = observation.privacyFlags.length ? 'flagged' : 'clear';
  }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function visibleToClient(user, record) {
  if (user.role !== 'client') return false;
  if (record.authorId === user.id) return true;
  return record.orgId === user.orgId && record.sharing === 'organisation';
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  if (req.method === 'GET' && pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

  if (pathname.startsWith('/api/') && req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request denied.' });

  if (req.method === 'POST' && pathname === '/api/login') {
    let body;
    try { body = await bodyJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const seed = demoUsers.find(u => u.login === body.login);
    const user = seed && store.users.find(u => u.id === seed.id && u.active !== false);
    const candidate = scryptSync(String(body.password || ''), passwordSalt, 32);
    if (!seed || !user || !timingSafeEqual(candidate, demoPasswordHash)) return send(res, 401, { error: 'Login or password is incorrect.' });
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { userId: user.id, expires: Date.now() + 8 * 60 * 60 * 1000 });
    audit(user, 'demo_login', 'session', user.id);
    await persist();
    return send(res, 200, { user: safeUser(user) }, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = cookieValue(req, COOKIE); if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (req.method === 'GET' && pathname === '/api/session') {
    const user = currentUser(req); return send(res, 200, { user: user ? safeUser(user) : null });
  }

  const user = currentUser(req);
  if (pathname.startsWith('/api/') && !user) return send(res, 401, { error: 'Sign in to continue.' });

  if (pathname.startsWith('/api/client-admin/')) {
    if (user.role !== 'client' || user.isOrgAdmin !== true) return send(res, 403, { error: 'Client organisation administrator permission required.' });
    if (req.method === 'GET' && pathname === '/api/client-admin/members') {
      const members = store.users.filter(m => m.role === 'client' && m.orgId === user.orgId).map(m => ({ id: m.id, name: m.name, login: m.login, role: m.isOrgAdmin ? 'client_admin' : 'client_member', self: m.id === user.id, active: m.active !== false }));
      return send(res, 200, { members });
    }
    if (req.method === 'GET' && pathname === '/api/client-admin/invitations') {
      const invitations = store.clientInvitations.filter(i => i.orgId === user.orgId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(({id,email,role,status,createdAt}) => ({id,email,role,status,createdAt}));
      return send(res, 200, { invitations });
    }
    if (req.method === 'POST' && pathname === '/api/client-admin/invitations') {
      let b; try { b = await bodyJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      const email = String(b.email || '').trim().toLowerCase(), role = b.role;
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Enter a valid invitation email address.' });
      if (!['client_member','client_admin'].includes(role)) return send(res, 400, { error: 'Choose an approved client role.' });
      if (store.clientInvitations.some(i => i.orgId === user.orgId && i.email === email && i.status === 'pending')) return send(res, 409, { error: 'A pending invitation already exists for this email in your organisation.' });
      const invitation = { id: randomBytes(8).toString('hex'), orgId: user.orgId, email, role, status: 'pending', createdBy: user.id, createdAt: new Date().toISOString() };
      store.clientInvitations.push(invitation); audit(user, 'create_client_invitation', 'client_invitation', invitation.id, `Synthetic invitation created for role ${role}; no email sent.`); await persist();
      return send(res, 201, { invitation: { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, createdAt: invitation.createdAt } });
    }
    const revokeInvite = pathname.match(/^\/api\/client-admin\/invitations\/([a-f0-9]{16})\/revoke$/);
    if (req.method === 'POST' && revokeInvite) {
      const invitation = store.clientInvitations.find(i => i.id === revokeInvite[1] && i.orgId === user.orgId && i.status === 'pending');
      if (!invitation) return send(res, 404, { error: 'Pending invitation not found in your organisation.' });
      invitation.status = 'revoked'; invitation.revokedAt = new Date().toISOString(); audit(user, 'revoke_client_invitation', 'client_invitation', invitation.id, 'Invitation revoked by its organisation.'); await persist();
      return send(res, 200, { ok: true, status: invitation.status });
    }
    const memberRole = pathname.match(/^\/api\/client-admin\/members\/([a-z0-9-]+)\/role$/);
    if (req.method === 'POST' && memberRole) {
      let b; try { b = await bodyJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      if (!['client_member','client_admin'].includes(b.role)) return send(res, 400, { error: 'Choose an approved client role.' });
      const member = store.users.find(m => m.id === memberRole[1] && m.orgId === user.orgId && m.role === 'client' && m.active !== false);
      if (!member || member.id === user.id) return send(res, 404, { error: 'Another active member in your organisation was not found.' });
      if (member.isOrgAdmin && b.role === 'client_member' && !store.users.some(m => m.id !== member.id && m.orgId === user.orgId && m.role === 'client' && m.active !== false && m.isOrgAdmin)) return send(res, 409, { error: 'The organisation must retain at least one active administrator.' });
      member.isOrgAdmin = b.role === 'client_admin'; audit(user, 'change_client_member_role', 'client_member', member.id, b.role); await persist();
      return send(res, 200, { ok: true, role: b.role });
    }
    const restoreMember = pathname.match(/^\/api\/client-admin\/members\/([a-z0-9-]+)\/restore$/);
    if (req.method === 'POST' && restoreMember) {
      const member = store.users.find(m => m.id === restoreMember[1] && m.orgId === user.orgId && m.role === 'client' && m.active === false);
      if (!member || member.id === user.id) return send(res, 404, { error: 'Inactive member not found in your organisation.' });
      member.active = true; delete member.revokedAt; audit(user, 'restore_client_membership', 'client_member', member.id, 'Membership restored by its organisation.'); await persist();
      return send(res, 200, { ok: true });
    }
    const revokeMember = pathname.match(/^\/api\/client-admin\/members\/([a-z0-9-]+)\/revoke$/);
    if (req.method === 'POST' && revokeMember) {
      const member = store.users.find(m => m.id === revokeMember[1] && m.orgId === user.orgId && m.role === 'client' && m.active !== false);
      if (!member || member.id === user.id) return send(res, 404, { error: 'Another active member in your organisation was not found.' });
      if (member.isOrgAdmin && !store.users.some(m => m.id !== member.id && m.orgId === user.orgId && m.role === 'client' && m.active !== false && m.isOrgAdmin)) return send(res, 409, { error: 'The organisation must retain at least one active administrator.' });
      member.active = false; member.revokedAt = new Date().toISOString(); audit(user, 'revoke_client_membership', 'client_member', member.id, 'Membership disabled within the administrator organisation.'); await persist();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Client administration route not found.' });
  }

  if (req.method === 'GET' && pathname === '/api/observations') {
    if (user.role === 'moderator') {
      const queue = store.observations.filter(o => o.status === 'pending_review');
      return send(res, 200, { observations: queue.map(o => ({ ...o })) });
    }
    if (user.role !== 'client') return send(res, 403, { error: 'This workspace cannot access observations.' });
    return send(res, 200, { observations: store.observations.filter(o => visibleToClient(user, o)).map(o => ({ ...o, orgId: o.orgId === user.orgId ? o.orgId : undefined })) });
  }
  if (req.method === 'GET' && pathname === '/api/shared') {
    if (user.role !== 'client' && user.role !== 'owner' && user.role !== 'moderator') return send(res, 403, { error: 'Not authorised.' });
    const active = store.sharedCopies.filter(c => c.status === 'published' && c.withdrawnAt === null);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const filters = ['offering','industry','region','period','topic'].map(key => [key,(url.searchParams.get(key)||'').trim().toLowerCase()]).filter(([,value])=>value);
    const items = active.filter(c => {
      const clean = cleanShared(c);
      if (q && ![clean.title,clean.summary,clean.offering,clean.industry,clean.region,clean.period,clean.topic].join(' ').toLowerCase().includes(q)) return false;
      return filters.every(([key,value]) => String(clean[key]||'').toLowerCase() === value);
    }).map(c => ({ ...cleanShared(c), ...(user.role === 'client' ? { myFeedback: store.feedback.find(f => f.sharedId === c.id && f.orgId === user.orgId)?.value || null } : {}) }));
    return send(res, 200, { items });
  }
  if (req.method === 'GET' && pathname === '/api/themes') {
    if (user.role !== 'client' && user.role !== 'owner' && user.role !== 'moderator') return send(res, 403, { error: 'Not authorised.' });
    const groups = new Map();
    for (const copy of store.sharedCopies.filter(c => c.status === 'published' && c.withdrawnAt === null)) {
      const source = store.observations.find(o => o.id === copy.sourceId);
      if (!source) continue;
      const key = `${copy.offering.toLowerCase()}\u0000${copy.topic.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { offering: copy.offering, topic: copy.topic, orgs: new Set(), periods: new Set(), contributions: [], latestUpdate: copy.publishedAt });
      const g = groups.get(key);
      g.orgs.add(source.orgId);
      g.periods.add(copy.period);
      g.contributions.push({ id: copy.id, title: copy.title, evidenceQuality: copy.evidenceQuality || null, evidenceQualityNote: copy.evidenceQualityNote || '' });
      if (copy.publishedAt > g.latestUpdate) g.latestUpdate = copy.publishedAt;
    }
    const themes = [...groups.entries()].filter(([,g])=>g.orgs.size>=MIN_THEME_ORGS).map(([key,g])=>({
      offering: g.offering,
      topic: g.topic,
      observationPeriod: [...g.periods].sort().join(', '),
      distinctOrganisations: g.orgs.size,
      confidenceAndLimitations: `Exploratory evidence from ${g.orgs.size} distinct synthetic organisations; this is not proof of market prevalence or causation.`,
      latestUpdate: g.latestUpdate,
      supportingContributions: g.contributions,
    }));
    return send(res, 200, { minimumOrganisations: MIN_THEME_ORGS, themes });
  }
  if (req.method === 'GET' && pathname === '/api/notifications') {
    return send(res, 200, { items: store.notifications.filter(n => n.userId === user.id).sort((a,b) => b.at.localeCompare(a.at)) });
  }
  if (req.method === 'GET' && pathname === '/api/audit') {
    if (user.role !== 'moderator' && user.role !== 'owner') return send(res, 403, { error: 'Not authorised.' });
    const events = store.audit.slice(-200).reverse().map(event => ({
      action: event.action,
      actor: store.users.find(person => person.id === event.actorId)?.name || (event.actorId === 'system' ? 'System' : 'Unknown user'),
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      detail: event.detail,
      at: event.at,
    }));
    return send(res, 200, { events });
  }
  if (req.method === 'GET' && pathname === '/api/ideas') {
    if (user.role === 'client') return send(res, 200, { items: store.ideas.filter(i => i.audience === 'clients' && store.sharedCopies.some(c => c.id === i.evidenceId && c.status === 'published' && !c.withdrawnAt)).map(i => ({ ...i })) });
    if (user.role === 'owner' || user.role === 'moderator') return send(res, 200, { items: store.ideas.map(i => ({ ...i })) });
    return send(res, 403, { error: 'Not authorised.' });
  }

  if (req.method === 'POST' && pathname === '/api/observations') {
    if (user.role !== 'client') return send(res, 403, { error: 'Only client members can add observations.' });
    let b; try { b = await bodyJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const fields = ['title','summary','offering','industry','region','period','topic','evidenceType','confidence'];
    const limits = { title: 120, summary: 1200, offering: 100, industry: 100, region: 100, period: 80, topic: 100, evidenceType: 100, confidence: 50 };
    for (const f of fields) if (!validText(b[f], limits[f])) return send(res, 400, { error: `Enter ${f} (maximum ${limits[f]} characters).` });
    if(b.consentProcessing!==true) return send(res,400,{error:'Explicit permission to store and process this observation is required.'});
    const sharing = ['private','organisation','community'].includes(b.sharing) ? b.sharing : 'private';
    const consentPublish = b.consentPublish === true && sharing === 'community';
    const submit = b.submit === true;
    if (submit && sharing === 'community' && !consentPublish) return send(res, 400, { error: 'Explicit permission to propose community sharing is required.' });
    const id = `obs-${store.nextObservation++}`;
    const now=new Date().toISOString();
    const record = { id, rootContributionId:id, version:1, versionOf:null, ...Object.fromEntries(fields.map(f => [f, b[f].trim()])), authorId: user.id, authorName: user.name, orgId: user.orgId, orgName: user.orgName, sharing, consentProcessing: true, consentPublish, consentAttribution:false, consentTraining:false, consentHistory:[{purpose:'storage_processing',granted:true,at:now},{purpose:'community_publication',granted:consentPublish,at:now}], status: submit && sharing === 'community' ? 'pending_review' : 'draft', createdAt: now, updatedAt: now, sharedId: null };
    record.privacyFlags=sensitiveIndicators(record.title,record.summary);record.privacyReviewStatus=record.privacyFlags.length?'flagged':'clear';
    store.observations.push(record); audit(user, submit ? 'submit_observation' : 'save_draft', 'observation', id, sharing); await persist();
    if (record.status === 'pending_review') { for (const m of demoUsers.filter(x => x.role === 'moderator')) notify(m.id, record.privacyFlags.length?'A proposed shared observation needs review; a possible sensitive pattern was flagged.':`A proposed shared observation needs review: ${record.title}`); await persist(); }
    return send(res, 201, { observation: record });
  }
  const amendMatch = pathname.match(/^\/api\/observations\/(obs-\d+)\/amend$/);
  if(req.method==='POST'&&amendMatch){
    if(user.role!=='client') return send(res,403,{error:'Only client members can amend observations.'});
    let b;try{b=await bodyJson(req);}catch{return send(res,400,{error:'Invalid request.'});}
    const o=store.observations.find(x=>x.id===amendMatch[1]&&x.authorId===user.id&&x.orgId===user.orgId);
    if(!o) return send(res,404,{error:'Observation not found.'});
    if(!['draft','clarification_requested'].includes(o.status)) return send(res,409,{error:'Only private drafts and returned observations can be amended.'});
    if(b.consentProcessing!==true) return send(res,400,{error:'Explicit permission to store and process this amended observation is required.'});
    const fields=['title','summary','offering','industry','region','period','topic','evidenceType','confidence'];
    const limits={title:120,summary:1200,offering:100,industry:100,region:100,period:80,topic:100,evidenceType:100,confidence:50};
    for(const field of fields) if(!validText(b[field],limits[field])) return send(res,400,{error:`Enter ${field} (maximum ${limits[field]} characters).`});
    const sharing=['private','organisation','community'].includes(b.sharing)?b.sharing:'private';
    const submit=b.submit===true, consentPublish=b.consentPublish===true&&sharing==='community';
    if(submit&&(sharing!=='community'||!consentPublish)) return send(res,400,{error:'Select community sharing and confirm explicit publishing permission before resubmission.'});
    for(const field of fields)o[field]=b[field].trim();
    o.privacyFlags=sensitiveIndicators(o.title,o.summary);o.privacyReviewStatus=o.privacyFlags.length?'flagged':'clear';
    const now=new Date().toISOString();o.sharing=sharing;o.consentProcessing=true;o.consentPublish=consentPublish;o.consentAttribution=false;o.consentTraining=false;o.status=submit?'pending_review':'draft';o.updatedAt=now;
    o.consentHistory ||= [];o.consentHistory.push({purpose:'storage_processing',granted:true,at:now},{purpose:'community_publication',granted:consentPublish,at:now});
    audit(user,submit?'amend_and_resubmit_observation':'amend_observation','observation',o.id,sharing);
    if(submit) for(const moderator of demoUsers.filter(x=>x.role==='moderator')) notify(moderator.id,o.privacyFlags.length?'An amended observation needs review; a possible sensitive pattern was flagged.':`An amended observation needs review: ${o.title}`);
    await persist();return send(res,200,{observation:o});
  }
  const versionMatch=pathname.match(/^\/api\/observations\/(obs-\d+)\/version$/);
  if(req.method==='POST'&&versionMatch){
    if(user.role!=='client') return send(res,403,{error:'Only client members can propose a new version.'});
    let b;try{b=await bodyJson(req);}catch{return send(res,400,{error:'Invalid request.'});}
    const source=store.observations.find(x=>x.id===versionMatch[1]&&x.authorId===user.id&&x.orgId===user.orgId);
    if(!source) return send(res,404,{error:'Contribution not found.'});
    const currentCopy=store.sharedCopies.find(c=>c.id===source.sharedId&&c.status==='published'&&!c.withdrawnAt);
    if(source.status!=='published'||!currentCopy) return send(res,409,{error:'Only an active published contribution can be revised.'});
    const root=source.rootContributionId||source.id;
    if(store.observations.some(x=>(x.rootContributionId||x.id)===root&&x.status==='pending_review')) return send(res,409,{error:'A version of this contribution is already awaiting review.'});
    const fields=['title','summary','offering','industry','region','period','topic','evidenceType','confidence'];
    const limits={title:120,summary:1200,offering:100,industry:100,region:100,period:80,topic:100,evidenceType:100,confidence:50};
    for(const field of fields) if(!validText(b[field],limits[field])) return send(res,400,{error:`Enter ${field} (maximum ${limits[field]} characters).`});
    if(b.submit!==true||b.sharing!=='community'||b.consentProcessing!==true||b.consentPublish!==true) return send(res,400,{error:'Submit the proposed version with separate explicit permission for storage/processing and community publishing.'});
    const now=new Date().toISOString(),id=`obs-${store.nextObservation++}`;
    const version={id,rootContributionId:root,version:(source.version||1)+1,versionOf:source.id,...Object.fromEntries(fields.map(f=>[f,b[f].trim()])),authorId:user.id,authorName:user.name,orgId:user.orgId,orgName:user.orgName,sharing:'community',consentProcessing:true,consentPublish:true,consentAttribution:false,consentTraining:false,consentHistory:[{purpose:'storage_processing',granted:true,at:now},{purpose:'community_publication',granted:true,at:now}],status:'pending_review',createdAt:now,updatedAt:now,sharedId:null,moderatorReason:''};
    version.privacyFlags=sensitiveIndicators(version.title,version.summary);version.privacyReviewStatus=version.privacyFlags.length?'flagged':'clear';
    store.observations.push(version);audit(user,'submit_contribution_version','observation',id,`Version ${version.version} of ${root}`);
    for(const moderator of demoUsers.filter(x=>x.role==='moderator'))notify(moderator.id,version.privacyFlags.length?'A new contribution version needs review; a possible sensitive pattern was flagged.':`A new version of a published contribution needs review: ${version.title}`);
    await persist();return send(res,201,{observation:version});
  }
  const submitMatch = pathname.match(/^\/api\/observations\/(obs-\d+)\/submit$/);
  if (req.method === 'POST' && submitMatch) {
    if (user.role !== 'client') return send(res, 403, { error: 'Not authorised.' });
    const o = store.observations.find(x => x.id === submitMatch[1] && x.authorId === user.id && x.orgId === user.orgId);
    if (!o) return send(res, 404, { error: 'Observation not found.' });
    if (o.status !== 'draft') return send(res, 409, { error: 'Returned observations must be amended before they can be resubmitted.' });
    if(!o.consentProcessing) return send(res,400,{error:'Explicit permission to store and process this observation is required.'});
    if (o.sharing !== 'community' || !o.consentPublish) return send(res, 400, { error: 'Choose proposed community sharing and grant explicit publishing permission before review.' });
    o.privacyFlags=sensitiveIndicators(o.title,o.summary);o.privacyReviewStatus=o.privacyFlags.length?'flagged':'clear';o.status='pending_review'; o.updatedAt=new Date().toISOString(); audit(user,'submit_observation','observation',o.id); for (const m of demoUsers.filter(x=>x.role==='moderator')) notify(m.id,o.privacyFlags.length?'A proposed shared observation needs review; a possible sensitive pattern was flagged.':`A proposed shared observation needs review: ${o.title}`); await persist(); return send(res,200,{observation:o});
  }
  const withdrawMatch = pathname.match(/^\/api\/observations\/(obs-\d+)\/withdraw$/);
  if (req.method === 'POST' && withdrawMatch) {
    if (user.role !== 'client') return send(res,403,{error:'Not authorised.'});
    const o=store.observations.find(x=>x.id===withdrawMatch[1] && x.authorId===user.id && x.orgId===user.orgId);
    if(!o) return send(res,404,{error:'Observation not found.'});
    const root=o.rootContributionId||o.id, lineage=store.observations.filter(x=>(x.rootContributionId||x.id)===root), withdrawnAt=new Date().toISOString();
    const lineageIds=new Set(lineage.map(x=>x.id));
    for(const item of lineage){item.status='withdrawn';item.updatedAt=withdrawnAt;}
    for(const copy of store.sharedCopies.filter(x=>lineageIds.has(x.sourceId))){copy.status='withdrawn';copy.withdrawnAt=withdrawnAt;}
    audit(user,'withdraw_observation','observation',o.id,'Search and future retrieval are filtered synchronously.'); await persist(); return send(res,200,{ok:true});
  }
  const moderateMatch = pathname.match(/^\/api\/moderation\/(obs-\d+)$/);
  if (req.method === 'POST' && moderateMatch) {
    if (user.role !== 'moderator') return send(res,403,{error:'Moderator permission required.'});
    let b; try{b=await bodyJson(req);}catch{return send(res,400,{error:'Invalid request.'});}
    const o=store.observations.find(x=>x.id===moderateMatch[1]);
    if(!o || o.status!=='pending_review') return send(res,404,{error:'Review item not found.'});
    if(b.action==='approve'){
      if(!validText(b.sharedTitle,120)||!validText(b.sharedSummary,1200)) return send(res,400,{error:'Provide reviewed title and summary.'});
      const sourceFlags=Array.isArray(o.privacyFlags)?o.privacyFlags:sensitiveIndicators(o.title,o.summary), sharedFlags=sensitiveIndicators(b.sharedTitle,b.sharedSummary);
      if(sharedFlags.length) return send(res,400,{error:`Possible sensitive pattern remains in the reviewed copy (${sharedFlags.join(', ')}). Remove it before approval.`});
      if(sourceFlags.length&&b.privacyReviewed!==true) return send(res,400,{error:'Confirm that you reviewed the flagged source and removed likely sensitive details from the shared copy.'});
      if(!['Strong','Moderate','Limited'].includes(b.evidenceQuality)||!validText(b.evidenceQualityNote,300)) return send(res,400,{error:'Choose an evidence assessment and explain it in 1–300 characters.'});
      if(o.version>1){
        const root=o.rootContributionId||o.id;
        for(const previousCopy of store.sharedCopies.filter(c=>c.status==='published')){
          const previousSource=store.observations.find(item=>item.id===previousCopy.sourceId);
          if(previousSource&&(previousSource.rootContributionId||previousSource.id)===root){previousCopy.status='superseded';previousSource.status='superseded';previousSource.updatedAt=new Date().toISOString();}
        }
      }
      const copy={id:`shared-${store.nextShared++}`,sourceId:o.id,title:b.sharedTitle.trim(),summary:b.sharedSummary.trim(),offering:o.offering,industry:o.industry,region:o.region,period:o.period,topic:o.topic,evidenceType:o.evidenceType,confidence:o.confidence,evidenceQuality:b.evidenceQuality,evidenceQualityNote:b.evidenceQualityNote.trim(),evidenceAssessedAt:new Date().toISOString(),publishedAt:new Date().toISOString(),status:'published',withdrawnAt:null};
      store.sharedCopies.push(copy); o.sharedId=copy.id; o.status='published'; o.privacyReviewStatus=sourceFlags.length?'reviewed':'clear';o.updatedAt=new Date().toISOString(); notify(o.authorId,o.version>1?`Your updated contribution “${o.title}” was approved. The previous shared version was replaced.`:`Your observation “${o.title}” was approved for the learning community.`); audit(user,o.version>1?'publish_contribution_version':'publish_shared_copy','observation',o.id,`Evidence assessment: ${copy.evidenceQuality}. ${copy.evidenceQualityNote}${sourceFlags.length?` Privacy review completed for: ${sourceFlags.join(', ')}.`:''}`); await persist(); return send(res,200,{observation:o,shared:cleanShared(copy)});
    }
    if(b.action==='clarify') { o.status='clarification_requested'; o.moderatorReason=String(b.reason||'Please clarify the evidence.').slice(0,300); o.updatedAt=new Date().toISOString(); notify(o.authorId,`Clarification requested for “${o.title}”.`); audit(user,'request_clarification','observation',o.id,o.moderatorReason); await persist(); return send(res,200,{observation:o}); }
    if(b.action==='reject') { o.status='rejected'; o.moderatorReason=String(b.reason||'Not suitable for shared learning.').slice(0,300); o.updatedAt=new Date().toISOString(); notify(o.authorId,`Your observation “${o.title}” was not approved for community sharing.`); audit(user,'reject_observation','observation',o.id,o.moderatorReason); await persist(); return send(res,200,{observation:o}); }
    return send(res,400,{error:'Unknown moderation action.'});
  }
  if (req.method === 'POST' && pathname === '/api/reports') {
    if(user.role!=='client') return send(res,403,{error:'Only clients can report shared content.'});
    let b; try{b=await bodyJson(req);}catch{return send(res,400,{error:'Invalid request.'});}
    const copy=store.sharedCopies.find(c=>c.id===b.sharedId&&c.status==='published'&&!c.withdrawnAt);
    if(!copy||!validText(b.reason,300)) return send(res,400,{error:'Choose a published item and provide a short reason.'});
    const report={id:randomBytes(8).toString('hex'),sharedId:copy.id,reporterOrgId:user.orgId,reason:b.reason.trim(),status:'open',createdAt:new Date().toISOString()}; store.reports.push(report); audit(user,'report_shared_copy','shared_copy',copy.id); await persist(); return send(res,201,{ok:true});
  }
  const feedbackMatch = pathname.match(/^\/api\/shared\/([^/]+)\/feedback$/);
  if (feedbackMatch && req.method === 'POST') {
    if (user.role !== 'client') return send(res, 403, { error: 'Only clients can provide quality feedback.' });
    let b; try { b = await bodyJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    if (!['useful', 'needs_evidence'].includes(b.value)) return send(res, 400, { error: 'Choose Useful or Needs more evidence.' });
    const copy = store.sharedCopies.find(c => c.id === feedbackMatch[1] && c.status === 'published' && c.withdrawnAt === null);
    if (!copy) return send(res, 404, { error: 'Published contribution not found.' });
    const prior = store.feedback.find(f => f.sharedId === copy.id && f.orgId === user.orgId);
    if (prior) return send(res, 409, { error: 'Your organisation has already provided feedback for this contribution.' });
    store.feedback.push({ sharedId: copy.id, orgId: user.orgId, value: b.value, createdAt: new Date().toISOString() });
    audit(user, 'submit_quality_feedback', 'shared_copy', copy.id, b.value);
    await persist();
    return send(res, 201, { ok: true, myFeedback: b.value });
  }
  if (req.method === 'GET' && pathname === '/api/reports') {
    if(user.role!=='moderator') return send(res,403,{error:'Moderator permission required.'});
    return send(res,200,{items:store.reports.filter(r=>(r.status==='open'||r.status==='under_review')&&store.sharedCopies.some(c=>c.id===r.sharedId&&!c.withdrawnAt&&(c.status==='published'||c.status==='under_review'))).map(r=>({id:r.id,sharedId:r.sharedId,title:store.sharedCopies.find(c=>c.id===r.sharedId)?.title||'Unavailable contribution',reason:r.reason,status:r.status,decisionNote:r.decisionNote||'',createdAt:r.createdAt}))});
  }
  const reportReviewMatch = pathname.match(/^\/api\/reports\/([a-f0-9]{16})\/review$/);
  if(req.method==='POST'&&reportReviewMatch){
    if(user.role!=='moderator') return send(res,403,{error:'Moderator permission required.'});
    let b;try{b=await bodyJson(req);}catch{return send(res,400,{error:'Invalid request.'});}
    if(!validText(b.reason,300)) return send(res,400,{error:'Enter a decision note (maximum 300 characters).'});
    const report=store.reports.find(r=>r.id===reportReviewMatch[1]);
    if(!report||!['open','under_review'].includes(report.status)) return send(res,404,{error:'Active report not found.'});
    const copy=store.sharedCopies.find(c=>c.id===report.sharedId);
    const source=copy&&store.observations.find(o=>o.id===copy.sourceId);
    if(!copy||!source) return send(res,404,{error:'Reported contribution not found.'});
    if(!['published','under_review'].includes(copy.status)) return send(res,409,{error:'This contribution is no longer active; the report cannot change its publication state.'});
    if(copy.withdrawnAt||copy.status==='withdrawn') return send(res,409,{error:'The contributor has withdrawn this item; it cannot be restored through report review.'});
    const reason=b.reason.trim();
    if(b.action==='dismiss'&&report.status==='open'){
      report.status='resolved';report.decision='dismissed';report.decisionNote=reason;report.resolvedAt=new Date().toISOString();report.moderatorId=user.id;
      notify(source.authorId,`A report about your shared contribution was reviewed. It remains published. Moderator note: ${reason}`);
      audit(user,'dismiss_report_keep_published','report',report.id,reason);
    }else if(b.action==='unpublish'&&report.status==='open'){
      copy.status='under_review';report.status='under_review';report.decision='temporarily_unpublished';report.decisionNote=reason;report.moderatorId=user.id;
      notify(source.authorId,`Your shared contribution was temporarily unpublished while a report is reviewed. Moderator note: ${reason}`);
      audit(user,'temporarily_unpublish_reported_content','shared_copy',copy.id,reason);
    }else if((b.action==='restore'||b.action==='remove')&&report.status==='under_review'){
      const restored=b.action==='restore';
      copy.status=restored?'published':'removed';
      report.status='resolved';report.decision=restored?'restored':'removed';report.decisionNote=reason;report.resolvedAt=new Date().toISOString();report.moderatorId=user.id;
      if(!restored){source.status='removed_by_moderator';source.moderatorReason=reason;source.updatedAt=new Date().toISOString();}
      notify(source.authorId,`Review of the report about your shared contribution is complete. ${restored?'The contribution has been restored to the learning community.':'The contribution will remain unpublished.'} Moderator note: ${reason}`);
      audit(user,restored?'restore_reported_content':'remove_reported_content','shared_copy',copy.id,reason);
    }else return send(res,400,{error:'That report action is not available in its current state.'});
    await persist();return send(res,200,{ok:true,status:report.status});
  }
  if (req.method === 'POST' && pathname === '/api/ideas') {
    if(user.role!=='owner') return send(res,403,{error:'Product owner permission required.'});
    let b;try{b=await bodyJson(req);}catch{return send(res,400,{error:'Invalid request.'});}
    if(!validText(b.title,120)||!validText(b.problem,1000)||!validText(b.offering,100)||!validText(b.outcome,500)) return send(res,400,{error:'Complete the required idea fields.'});
    const evidenceId=String(b.evidenceId||''); const copy=store.sharedCopies.find(c=>c.id===evidenceId&&c.status==='published'&&!c.withdrawnAt);
    if(!copy) return send(res,400,{error:'Link an active approved shared contribution.'});
    const idea={id:`idea-${store.nextIdea++}`,title:b.title.trim(),problem:b.problem.trim(),offering:b.offering.trim(),outcome:b.outcome.trim(),owner:user.name,priority:['Low','Normal','High'].includes(b.priority)?b.priority:'Normal',status:'Proposed',evidenceId:copy.id,audience:b.audience==='clients'?'clients':'internal',updatedAt:new Date().toISOString()};
    store.ideas.push(idea); audit(user,'create_improvement_idea','idea',idea.id); await persist(); return send(res,201,{idea});
  }
  const ideaMatch=pathname.match(/^\/api\/ideas\/(idea-\d+)$/);
  if(req.method==='POST'&&ideaMatch){
    if(user.role!=='owner') return send(res,403,{error:'Product owner permission required.'});
    let b;try{b=await bodyJson(req);}catch{return send(res,400,{error:'Invalid request.'});}
    const i=store.ideas.find(x=>x.id===ideaMatch[1]); const statuses=['Proposed','Under review','Planned','In progress','Released','Not proceeding'];
    if(!i||!statuses.includes(b.status)) return send(res,400,{error:'Choose a valid status.'});
    i.status=b.status;i.updatedAt=new Date().toISOString();audit(user,'update_idea_status','idea',i.id,b.status);await persist();return send(res,200,{idea:i});
  }

  if (pathname.startsWith('/api/')) return send(res,404,{error:'API route not found.'});
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.resolve(PUBLIC, relative);
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== path.join(PUBLIC,'index.html')) return send(res,404,{error:'Not found.'});
  try {
    const data=await readFile(filePath);
    const ext=path.extname(filePath);
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
  } catch { send(res,404,{error:'Not found.'}); }
}

http.createServer((req,res)=>{handle(req,res).catch(err=>{console.error(err);if(!res.headersSent)send(res,500,{error:'Unexpected server error.'});else res.end();});}).listen(PORT,'127.0.0.1',()=>console.log(`azentio.ai pipeline demo listening at http://localhost:${PORT}`));
