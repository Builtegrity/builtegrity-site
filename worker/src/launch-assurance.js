// Owner policy controls are voluntary release requirements, not assurances of legal immunity.
export const LAUNCH_ASSURANCE_IDS=Object.freeze([
 'POLICY-LIMITED-LIABILITY-ENTITY',
 'POLICY-TECH-EO-CYBER-COVERAGE',
 'POLICY-PROCESSOR-LOSS-ALLOCATION'
]);
export async function launchAssuranceBlockers(env){
 let rows;
 try{
  const result=await env.DB.prepare(`SELECT id,status,evidence_ref,verified_at,next_review_due_at
   FROM compliance_obligations WHERE id IN (?,?,?)`).bind(...LAUNCH_ASSURANCE_IDS).all();
  rows=result.results||[];
 }catch{return ['LAUNCH_ASSURANCE_UNAVAILABLE'];}
 const now=Date.now();
 return LAUNCH_ASSURANCE_IDS.filter(id=>{
  const r=rows.find(v=>v.id===id);
  const checked=Date.parse(r?.verified_at||'');
  const review=Date.parse(r?.next_review_due_at||'');
  return !r||r.status!=='SATISFIED'||!String(r.evidence_ref||'').trim()
   ||!Number.isFinite(checked)||checked>now||!Number.isFinite(review)||review<=now||review<=checked;
 }).map(id=>'LAUNCH_ASSURANCE_NOT_CURRENT:'+id);
}
