import {authenticateClerkSession} from './clerk-auth.js';
import {requireMerchantMembership} from './authorization.js';
const types=new Set(['CUSTOMER','TRANSACTION','GROUP']);
const validMime={
 'image/jpeg':['ffd8ff'],
 'image/png':['89504e470d0a1a0a'],
 'image/webp':['52494646'],
 'application/pdf':['255044462d']
};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{
 'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
function bad(s,status=400){const e=new Error(s);e.status=status;return e;}
const hex=bytes=>[...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
function validateMagic(mime,buffer){
 const b=new Uint8Array(buffer);
 if(!validMime[mime]?.some(prefix=>hex(b.slice(0,prefix.length/2))===prefix))return false;
 if(mime==='image/webp'&&hex(b.slice(8,12))!=='57454250')return false;
 return true;
}
function sameOrigin(request){
 const origin=request.headers.get('origin');
 if(origin&&origin!==new URL(request.url).origin)throw bad('Cross-origin upload blocked',403);
 if(['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')))
  throw bad('Cross-site upload blocked',403);
}
async function targetCheck(env,merchantId,type,id){
 if(!types.has(type)||!id||String(id).length>180)throw bad('Unknown record type or ID');
 const q={
  CUSTOMER:`SELECT id FROM customers WHERE id=? AND merchant_id=?`,
  TRANSACTION:`SELECT id FROM transactions WHERE id=? AND merchant_id=?`,
  GROUP:`SELECT id FROM merchant_record_groups WHERE id=? AND merchant_id=?`
 }[type];
 const result=await env.DB.prepare(q).bind(id,merchantId).first();
 if(!result)throw bad('Record does not belong to this merchant',404);
 return result;
}
export async function createMerchantGroup(env,merchantId,userId,values){
 const field=String(values.field_key||'').trim(),group_value=String(values.group_value||'').trim();
 const title=String(values.title||'').trim(),description=String(values.description||'').trim();
 if(!field||field.length>40||!group_value||group_value.length>256||
  !title||title.length>100||description.length>800)throw bad('Group title, field and value are required');
 const def=await env.DB.prepare(`SELECT field_key FROM merchant_custom_field_definitions
  WHERE merchant_id=? AND field_key=? AND record_scope='CUSTOMER' AND active=1`)
  .bind(merchantId,field).first();
 if(!def)throw bad('Customer group field is not active',409);
 const group=await env.DB.prepare(`SELECT id FROM merchant_record_groups
  WHERE merchant_id=? AND field_key=? AND group_value=?`)
  .bind(merchantId,field,group_value).first();
 if(group)return {group_id:group.id,created:false};
 const id='GRP-'+crypto.randomUUID();
 await env.DB.prepare(`INSERT INTO merchant_record_groups
 (id,merchant_id,field_key,group_value,title,description,created_by)
 VALUES(?,?,?,?,?,?,?)`).bind(id,merchantId,field,group_value,title,description||null,userId).run();
 return {group_id:id,created:true};
}
export async function listMerchantGroups(env,merchantId){
 const x=await env.DB.prepare(`SELECT id,field_key,group_value,title,description,created_at
 FROM merchant_record_groups WHERE merchant_id=? ORDER BY title LIMIT 100`).bind(merchantId).all();
 return x.results||[];
}
export async function listMedia(env,merchantId,type,id){
 await targetCheck(env,merchantId,type,id);
 const [medias,display]=await Promise.all([
  env.DB.prepare(`SELECT id,filename,mime_type,role,caption,byte_count,created_at
    FROM merchant_record_media WHERE merchant_id=? AND target_type=? AND target_id=?
    AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`).bind(merchantId,type,id).all(),
  env.DB.prepare(`SELECT display_title,display_note,updated_at
    FROM merchant_record_display WHERE merchant_id=? AND target_type=? AND target_id=?`)
   .bind(merchantId,type,id).first()
 ]);
 return {media:medias.results||[],display:display||null};
}
export async function updateDisplay(env,merchantId,userId,type,id,raw){
 await targetCheck(env,merchantId,type,id);
 const title=String(raw.display_title||'').trim(),note=String(raw.display_note||'').trim();
 if(title.length>100||note.length>800)throw bad('Display title or note too long');
 await env.DB.prepare(`INSERT INTO merchant_record_display
  (merchant_id,target_type,target_id,display_title,display_note,updated_by)
  VALUES(?,?,?,?,?,?)
  ON CONFLICT(merchant_id,target_type,target_id) DO UPDATE SET
  display_title=excluded.display_title,display_note=excluded.display_note,
  updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
  .bind(merchantId,type,id,title||null,note||null,userId).run();
 return {saved:true};
}
export async function uploadMerchantMedia(env,merchantId,userId,type,id,file,role,caption){
 if(!env.MERCHANT_MEDIA)throw bad('Private attachment storage not configured',503);
 await targetCheck(env,merchantId,type,id);
 if(!file||typeof file.arrayBuffer!=='function')throw bad('Choose a file',400);
 if(file.size<1||file.size>5*1024*1024)throw bad('Files must be 5 MB or smaller',413);
 if(!validMime[file.type])throw bad('Choose a JPEG, PNG, WEBP image or PDF file');
 role=String(role||'ATTACHMENT').toUpperCase();
 if(!['COVER','ATTACHMENT'].includes(role))throw bad('Invalid attachment type');
 if(role==='COVER'&&!file.type.startsWith('image/'))throw bad('A cover/profile picture must be an image');
 const fileName=String(file.name||'attachment').replace(/[\x00-\x1f\\/<>:"|?*]/g,'_').slice(0,120)||'attachment';
 caption=String(caption||'').trim();
 if(caption.length>400)throw bad('Caption must be under 400 characters');
 const count=await env.DB.prepare(`SELECT COUNT(*) AS count FROM merchant_record_media
  WHERE merchant_id=? AND deleted_at IS NULL`).bind(merchantId).first();
 if(Number(count?.count)>999)throw bad('Merchant storage limit reached (1,000 attachments)',409);
 const targetCount=await env.DB.prepare(`SELECT COUNT(*) AS count FROM merchant_record_media
  WHERE merchant_id=? AND target_type=? AND target_id=? AND deleted_at IS NULL`)
  .bind(merchantId,type,id).first();
 if(Number(targetCount?.count)>=50)throw bad('50 attachment limit per record',409);
 const buffer=await file.arrayBuffer();
 if(!validateMagic(file.type,buffer))throw bad('File contents do not match its declared type');
 const digest=hex(await crypto.subtle.digest('SHA-256',buffer));
 const fileId='MEDIA-'+crypto.randomUUID();
 const key='merchants/'+merchantId+'/'+type.toLowerCase()+'/'+encodeURIComponent(id)+'/'+fileId;
 await env.MERCHANT_MEDIA.put(key,buffer,{httpMetadata:{contentType:file.type},
  customMetadata:{merchantId,mediaId:fileId}});
 try{
  await env.DB.prepare(`INSERT INTO merchant_record_media
   (id,merchant_id,target_type,target_id,filename,mime_type,role,object_key,
    byte_count,sha256,caption,uploaded_by)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(fileId,merchantId,type,id,fileName,file.type,role,key,file.size,digest,
    caption||null,userId).run();
 }catch(e){await env.MERCHANT_MEDIA.delete(key).catch(()=>{});throw e;}
 return {id:fileId,filename:fileName,role,attachment_url:'/api/merchant/media/file/'+fileId};
}
async function jsonBody(request){
 const text=await request.text();if(text.length>9000)throw bad('Request too large',413);
 try{return JSON.parse(text);}catch{throw bad('Invalid JSON');}
}
export async function handleMerchantMediaRoute(request,env){
 const url=new URL(request.url),path=url.pathname;
 if(!path.startsWith('/api/merchant/media/'))return null;
 if(env.MERCHANT_MEDIA_ENABLED!=='true')return json({error:'Private attachment feature is not enabled'},503);
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub||principal.claims?.act)return json({error:'Sign-in required'},401);
 if(request.method==='POST')sameOrigin(request);
 const fileMatch=path.match(/^\/api\/merchant\/media\/file\/(MEDIA-[a-f0-9-]+)$/);
 if(fileMatch&&request.method==='GET'){
  const row=await env.DB.prepare(`SELECT * FROM merchant_record_media
    WHERE id=? AND deleted_at IS NULL`).bind(fileMatch[1]).first();
  if(!row)return json({error:'Attachment not found'},404);
  await requireMerchantMembership(env,principal,row.merchant_id,'VIEWER');
  if(!env.MERCHANT_MEDIA)return json({error:'Private storage unavailable'},503);
  const item=await env.MERCHANT_MEDIA.get(row.object_key);
  if(!item)return json({error:'Attachment not available in private storage'},404);
  const headers=new Headers({'content-type':row.mime_type,'cache-control':'private, no-store',
   'x-content-type-options':'nosniff','x-frame-options':'DENY',
   'cross-origin-resource-policy':'same-origin','referrer-policy':'no-referrer',
   'content-security-policy':"sandbox; default-src 'none'"});
  headers.set('content-disposition',row.mime_type==='application/pdf'?
   "attachment; filename=\"merchant-attachment.pdf\"":'inline');
  return new Response(item.body,{headers});
 }
 let data={},isUpload=path==='/api/merchant/media/upload'&&request.method==='POST';
 if(isUpload){
  const len=Number(request.headers.get('content-length')||0);
  if(len>6*1024*1024)return json({error:'Upload exceeds 5 MB file limit'},413);
  const form=await request.formData();
  data={merchant_id:form.get('merchant_id'),target_type:form.get('target_type'),
   target_id:form.get('target_id'),role:form.get('role'),caption:form.get('caption'),
   file:form.get('file')};
 }else if(request.method==='GET')data=Object.fromEntries(url.searchParams);
 else if(request.method==='POST')data=await jsonBody(request);
 else return json({error:'Method not allowed'},405);
 const merchantId=String(data.merchant_id||''),type=String(data.target_type||'').toUpperCase(),id=String(data.target_id||'');
 if(!/^MER-[A-Za-z0-9-]+$/.test(merchantId))return json({error:'Merchant ID required'},400);
 await requireMerchantMembership(env,principal,merchantId,request.method==='GET'?'VIEWER':'OWNER');
 if(path==='/api/merchant/media/groups'&&request.method==='GET')
   return json({groups:await listMerchantGroups(env,merchantId)});
 if(path==='/api/merchant/media/group'&&request.method==='POST')
   return json(await createMerchantGroup(env,merchantId,principal.sub,data));
 if(path==='/api/merchant/media/list'&&request.method==='GET')
   return json(await listMedia(env,merchantId,type,id));
 if(path==='/api/merchant/media/display'&&request.method==='POST')
   return json(await updateDisplay(env,merchantId,principal.sub,type,id,data));
 if(isUpload)return json(await uploadMerchantMedia(env,merchantId,principal.sub,type,id,
   data.file,data.role,data.caption),201);
 if(path==='/api/merchant/media/delete'&&request.method==='POST'){
  const row=await env.DB.prepare(`SELECT id FROM merchant_record_media
   WHERE id=? AND merchant_id=? AND deleted_at IS NULL`)
    .bind(String(data.media_id||''),merchantId).first();
  if(!row)return json({error:'Attachment not found'},404);
  // Retain audit metadata until retention policy deletes physical R2 data.
  await env.DB.prepare(`UPDATE merchant_record_media SET deleted_at=CURRENT_TIMESTAMP
   WHERE id=? AND merchant_id=?`).bind(row.id,merchantId).run();
  return json({hidden:true});
 }
 return json({error:'Action not found'},404);
}
