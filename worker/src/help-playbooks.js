// Audited help routes are safe explanatory workflows. They never make a payment,
// edit processor truth, reveal account data, or outsource privileged work.
export const helpPlaybooks=[
 {code:'BANK_RECONNECT',audience:['MERCHANT'],title:'Bank permission needs renewing',
  symptom:'I cannot see a bank-posted deposit or my bank is asking for permission again.',
  steps:['Open My connections.','Select the bank that receives Stripe or Square payouts.',
   'If your bank asks, approve its read-only access using the bank provider screen.',
   'Return to your payment journey; bank updates may take days to appear.'],
  action_url:'/merchant/bank/',self_service:true,requires_provider_consent:true},
 {code:'CUSTOM_SOURCE',audience:['MERCHANT'],title:'My custom fields are not updating',
  symptom:'A customer property, cart count, service route or other custom label is not current.',
  steps:['Open Customer fields and find the source that supplies this field.',
   'Check whether the last accepted update is recorded.',
   'Ensure your software sends the same existing customer/invoice reference and registered field key.',
   'If the API key was rotated or revoked, replace it in your private sending system.',
   'If the software has no outgoing integration, upload CSV/JSON or update the field manually.'],
  action_url:'/merchant/integrations/',self_service:true,requires_provider_consent:false},
 {code:'RECORD_PHOTOS',audience:['MERCHANT'],title:'Attach a customer or HOA group photo',
  symptom:'I want to add or change a picture or supporting PDF.',
  steps:['Open Photos & record customization.','Choose an existing customer, transaction or saved customer group.',
   'Use a JPEG, PNG, WEBP or PDF no larger than 5 MB.',
   'Choose Cover for a profile picture or Supporting File for receipts and documents.',
   'Only merchant-authorized users can view these private files.'],
  action_url:'/merchant/media/',self_service:true,requires_provider_consent:false},
 {code:'EMAIL_LINK',audience:['MERCHANT'],title:'View a transaction without creating an account',
  symptom:'I received an email with a Builtegrity private transaction link.',
  steps:['Open the unique link in your email before it expires.',
   'Review that individual transaction or download its limited shareable PDF.',
   'For full history and photos, create a profile with your verified business email and return to your original private link to connect the business.',
   'For an expired invitation, use an authorized onboarding contact to issue a new link.'],
  action_url:'/signup/',self_service:true,requires_provider_consent:false},
 {code:'INTEGRITY_EXCEPTION',audience:['MERCHANT'],title:'The integrity status needs attention',
  symptom:'A payment status says Needs Attention or does not match my processor.',
  steps:['Open Transaction integrity and expand that payment.',
   'Read which processor fact or payout event is missing.',
   'Allow time for the provider to deliver a delayed signed event.',
   'Do not change the amount manually; processor evidence controls financial truth.',
   'If the issue persists, submit a request with the transaction ID only—not bank credentials.'],
  action_url:'/merchant/transactions/',self_service:false,requires_provider_consent:false},
 {code:'PARTNER_REFERRAL',audience:['PARTNER'],title:'Check a merchant referral or onboarding handoff',
  symptom:'A referred merchant has not completed onboarding.',
  steps:['Confirm the merchant has received their onboarding invitation.',
   'Ask the merchant to authorize their own payment processor connection.',
   'Avoid requesting processor or banking passwords.',
   'If the system does not support the referral scenario, submit a limited request to the partner support route when enabled.'],
  action_url:'/partner/help/',self_service:false,requires_provider_consent:false}
];
export function findHelpSolutions(query='',audience='MERCHANT'){
 const role=String(audience||'MERCHANT').toUpperCase();
 if(!['MERCHANT','PARTNER'].includes(role))return [];
 const term=String(query||'').toLowerCase().trim().slice(0,100);
 return helpPlaybooks.filter(x=>x.audience.includes(role)&&
  (!term||[x.code,x.title,x.symptom,...x.steps].join(' ').toLowerCase().includes(term)));
}
export async function handleHelpSolutionRoute(request){
 const url=new URL(request.url);
 if(url.pathname!=='/api/help/solutions')return null;
 if(request.method!=='GET')return new Response('Method not allowed',{status:405});
 const audience=url.searchParams.get('audience')||'MERCHANT';
 return new Response(JSON.stringify({
  solutions:findHelpSolutions(url.searchParams.get('q')||'',audience),
  limitations:'These are preapproved self-service instructions, not evidence of external service repair or payment settlement. Escalations and future vendor work require explicit approval.'
 }),{headers:{'content-type':'application/json','cache-control':'no-store',
  'x-content-type-options':'nosniff'}});
}
