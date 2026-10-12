const ROLE_RANK = {
  VIEWER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export async function getMerchantMembership(env, principal, merchantId) {
  const externalUserId = String(principal?.sub || '');
  if (!externalUserId || !merchantId) return null;

  return env.DB.prepare(`
    SELECT id, merchant_id, external_user_id, role, status, created_at
    FROM merchant_access
    WHERE merchant_id = ?
      AND external_user_id = ?
      AND status = 'ACTIVE'
    LIMIT 1
  `).bind(merchantId, externalUserId).first();
}

export async function requireMerchantMembership(env, principal, merchantId, minimumRole = 'VIEWER') {
  const membership = await getMerchantMembership(env, principal, merchantId);
  if (!membership) throw forbidden('No active Builtegrity merchant membership exists for this identity');
  if (!hasRole(membership.role, minimumRole)) {
    throw forbidden(`Merchant role ${membership.role} does not satisfy required role ${minimumRole}`);
  }
  return membership;
}

export async function getPartnerMembership(env, principal, partnerId) {
  const externalUserId = String(principal?.sub || '');
  if (!externalUserId || !partnerId) return null;

  return env.DB.prepare(`
    SELECT id, partner_id, external_user_id, role, status, created_at
    FROM partner_access
    WHERE partner_id = ?
      AND external_user_id = ?
      AND status = 'ACTIVE'
    LIMIT 1
  `).bind(partnerId, externalUserId).first();
}

export async function requirePartnerMembership(env, principal, partnerId, minimumRole = 'VIEWER') {
  const membership = await getPartnerMembership(env, principal, partnerId);
  if (!membership) throw forbidden('No active Builtegrity partner membership exists for this identity');
  if (!hasRole(membership.role, minimumRole)) {
    throw forbidden(`Partner role ${membership.role} does not satisfy required role ${minimumRole}`);
  }
  return membership;
}

export function hasRole(actualRole, minimumRole) {
  return Number(ROLE_RANK[String(actualRole || '').toUpperCase()] || 0) >=
    Number(ROLE_RANK[String(minimumRole || '').toUpperCase()] || Number.POSITIVE_INFINITY);
}

function forbidden(message) {
  const error = new Error(message || 'Forbidden');
  error.status = 403;
  return error;
}
