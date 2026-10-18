// Fail closed when runtime stage and Stripe credentials disagree.
// Preview/test must never send money-moving requests using live credentials.
export function assertStripeStageCredential(env) {
  const stage=String(env?.WATCHDOG_STAGE||'PREVIEW').trim().toUpperCase();
  const key=String(env?.STRIPE_SECRET_KEY||'');
  if(!['PREVIEW','TEST','PILOT','LIVE'].includes(stage)
     || !/^(sk|rk)_(test|live)_\S+$/.test(key)
     || (['PREVIEW','TEST'].includes(stage)&&!/^(sk|rk)_test_/.test(key))) {
    const error=new Error('Stripe key type is incompatible with runtime stage');
    error.status=503;
    throw error;
  }
}
