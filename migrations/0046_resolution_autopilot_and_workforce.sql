PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Pricing compatibility / exact snapshot completion.
-- The application only needs to supply the historical snapshot columns; the DB derives
-- the new exact-micros fields for BG_STANDARD_V1 so old HTTP callers cannot bypass them.
-- -----------------------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN pricing_amount_band_id TEXT;

DROP TRIGGER IF EXISTS transactions_validate_bg_standard_v1_insert;
CREATE TRIGGER transactions_validate_bg_standard_v1_insert
BEFORE INSERT ON transactions
WHEN NEW.pricing_version_id='BG_STANDARD_V1'
BEGIN
  SELECT CASE WHEN NEW.pricing_percentage_bps <> 10
    THEN RAISE(ABORT, 'BG_STANDARD_V1 must use 10 basis points') END;
  SELECT CASE WHEN NEW.pricing_calculated_cents <> CAST((
    (SELECT base_fee_cents * 10000 FROM pricing_amount_bands b
      WHERE b.pricing_version_id='BG_STANDARD_V1'
        AND NEW.amount_cents >= b.min_amount_cents
        AND (b.max_amount_cents IS NULL OR NEW.amount_cents <= b.max_amount_cents)
      LIMIT 1)
    + (NEW.amount_cents * 10)
  ) / 10000 AS INTEGER)
    THEN RAISE(ABORT, 'BG_STANDARD_V1 whole-cent calculation is invalid') END;
  SELECT CASE WHEN NEW.integrity_fee_earned_cents <> NEW.pricing_calculated_cents
    THEN RAISE(ABORT, 'BG_STANDARD_V1 earned whole-cent fee must equal server price') END;
END;

CREATE TRIGGER IF NOT EXISTS transactions_complete_bg_standard_v1_snapshot
AFTER INSERT ON transactions
WHEN NEW.pricing_version_id='BG_STANDARD_V1'
BEGIN
  UPDATE transactions
     SET pricing_amount_band_id = (
           SELECT id FROM pricing_amount_bands b
            WHERE b.pricing_version_id='BG_STANDARD_V1'
              AND NEW.amount_cents >= b.min_amount_cents
              AND (b.max_amount_cents IS NULL OR NEW.amount_cents <= b.max_amount_cents)
            ORDER BY b.min_amount_cents DESC LIMIT 1
         ),
         pricing_base_cents = (
           SELECT base_fee_cents FROM pricing_amount_bands b
            WHERE b.pricing_version_id='BG_STANDARD_V1'
              AND NEW.amount_cents >= b.min_amount_cents
              AND (b.max_amount_cents IS NULL OR NEW.amount_cents <= b.max_amount_cents)
            ORDER BY b.min_amount_cents DESC LIMIT 1
         ),
         pricing_fee_micros = (
           (SELECT base_fee_cents * 10000 FROM pricing_amount_bands b
             WHERE b.pricing_version_id='BG_STANDARD_V1'
               AND NEW.amount_cents >= b.min_amount_cents
               AND (b.max_amount_cents IS NULL OR NEW.amount_cents <= b.max_amount_cents)
             ORDER BY b.min_amount_cents DESC LIMIT 1)
           + (NEW.amount_cents * 10)
         ),
         integrity_fee_earned_micros = (
           (SELECT base_fee_cents * 10000 FROM pricing_amount_bands b
             WHERE b.pricing_version_id='BG_STANDARD_V1'
               AND NEW.amount_cents >= b.min_amount_cents
               AND (b.max_amount_cents IS NULL OR NEW.amount_cents <= b.max_amount_cents)
             ORDER BY b.min_amount_cents DESC LIMIT 1)
           + (NEW.amount_cents * 10)
         ),
         pricing_fee_residual_micros = (
           ((SELECT base_fee_cents * 10000 FROM pricing_amount_bands b
              WHERE b.pricing_version_id='BG_STANDARD_V1'
                AND NEW.amount_cents >= b.min_amount_cents
                AND (b.max_amount_cents IS NULL OR NEW.amount_cents <= b.max_amount_cents)
              ORDER BY b.min_amount_cents DESC LIMIT 1)
            + (NEW.amount_cents * 10)) % 10000
         ),
         pricing_uncapped = 1
   WHERE id=NEW.id;
END;

DROP TRIGGER IF EXISTS transactions_bg_standard_v1_pricing_no_mutation;
CREATE TRIGGER transactions_bg_standard_v1_pricing_no_mutation
BEFORE UPDATE OF pricing_amount_band_id, pricing_base_cents, pricing_fee_micros,
                 integrity_fee_earned_micros, pricing_fee_residual_micros, pricing_uncapped
ON transactions
WHEN OLD.pricing_version_id='BG_STANDARD_V1'
 AND OLD.pricing_fee_micros IS NOT NULL
 AND (
   COALESCE(NEW.pricing_amount_band_id,'') <> COALESCE(OLD.pricing_amount_band_id,'') OR
   NEW.pricing_base_cents <> OLD.pricing_base_cents OR
   NEW.pricing_fee_micros <> OLD.pricing_fee_micros OR
   NEW.integrity_fee_earned_micros <> OLD.integrity_fee_earned_micros OR
   NEW.pricing_fee_residual_micros <> OLD.pricing_fee_residual_micros OR
   NEW.pricing_uncapped <> OLD.pricing_uncapped
 )
BEGIN SELECT RAISE(ABORT, 'BG_STANDARD_V1 exact pricing is immutable once snapshotted'); END;

-- -----------------------------------------------------------------------------
-- Resolution routing catalog.
-- A person is never told merely to "contact support". Every problem maps to a playbook,
-- numbered actions, authoritative links, a verification rule and a fallback owner.
-- -----------------------------------------------------------------------------
ALTER TABLE system_alerts ADD COLUMN resolution_party_type TEXT;
ALTER TABLE system_alerts ADD COLUMN resolution_playbook_code TEXT;
ALTER TABLE system_alerts ADD COLUMN resolution_instance_id TEXT;
ALTER TABLE internal_cases ADD COLUMN resolution_instance_id TEXT;

CREATE TABLE IF NOT EXISTS resolution_providers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('PROCESSOR','HOSTING','AUTH','EMAIL','PLATFORM','WORKFORCE')),
  dashboard_url TEXT,
  status_url TEXT,
  support_url TEXT,
  docs_url TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR REPLACE INTO resolution_providers
(code,name,provider_type,dashboard_url,status_url,support_url,docs_url,active) VALUES
('STRIPE','Stripe','PROCESSOR','https://dashboard.stripe.com/','https://status.stripe.com/','https://support.stripe.com/','https://docs.stripe.com/connect',1),
('CLOUDFLARE','Cloudflare','HOSTING','https://dash.cloudflare.com/','https://www.cloudflarestatus.com/','https://developers.cloudflare.com/support/','https://developers.cloudflare.com/',1),
('CLERK','Clerk','AUTH','https://dashboard.clerk.com/','https://status.clerk.com/','https://clerk.com/contact/support','https://clerk.com/docs',1),
('RESEND','Resend','EMAIL','https://resend.com/','https://resend.com/','https://resend.com/support','https://resend.com/docs',1),
('BUILTEGRITY','Builtegrity','PLATFORM',NULL,NULL,NULL,NULL,1),
('SUPPORTYOURAPP','SupportYourApp','WORKFORCE',NULL,NULL,'https://supportyourapp.com/contacts/','https://supportyourapp.com/pricing/',1),
('PARTNERHERO','PartnerHero','WORKFORCE',NULL,NULL,'https://www.partnerhero.com/','https://www.partnerhero.com/',1),
('INFLUX','Influx','WORKFORCE',NULL,NULL,'https://influx.com/','https://influx.com/pricing',1);

CREATE TABLE IF NOT EXISTS resolution_playbooks (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  party_type TEXT NOT NULL CHECK (party_type IN ('SYSTEM','MERCHANT','CUSTOMER','PLATFORM_VENDOR','INTERNAL')),
  provider_code TEXT,
  verification_handler TEXT NOT NULL,
  default_sla_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (default_sla_minutes > 0),
  notify_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (notify_after_minutes >= 0),
  repeat_notice_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (repeat_notice_minutes >= 60),
  outsource_category TEXT,
  outsource_after_minutes INTEGER CHECK (outsource_after_minutes IS NULL OR outsource_after_minutes >= 0),
  default_work_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_work_budget_cents >= 0),
  privileged_access_required INTEGER NOT NULL DEFAULT 0 CHECK (privileged_access_required IN (0,1)),
  outsourcing_allowed INTEGER NOT NULL DEFAULT 0 CHECK (outsourcing_allowed IN (0,1)),
  customer_safe INTEGER NOT NULL DEFAULT 0 CHECK (customer_safe IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  FOREIGN KEY (provider_code) REFERENCES resolution_providers(code)
);

CREATE TABLE IF NOT EXISTS resolution_steps (
  playbook_code TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','MERCHANT','CUSTOMER','VENDOR','PROVIDER')),
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  link_kind TEXT CHECK (link_kind IS NULL OR link_kind IN ('DASHBOARD','STATUS','SUPPORT','DOCS','PAYMENT','NONE')),
  explicit_url TEXT,
  automatic_verification_note TEXT,
  PRIMARY KEY (playbook_code, sequence),
  FOREIGN KEY (playbook_code) REFERENCES resolution_playbooks(code)
);

INSERT OR REPLACE INTO resolution_playbooks
(code,title,party_type,provider_code,verification_handler,default_sla_minutes,notify_after_minutes,repeat_notice_minutes,outsource_category,outsource_after_minutes,default_work_budget_cents,privileged_access_required,outsourcing_allowed,customer_safe) VALUES
('STRIPE_PAYOUT_FAILED','Stripe payout needs merchant action','MERCHANT','STRIPE','WATCHDOG_ALERT_CLEARED',1440,0,1440,NULL,NULL,0,0,0,1),
('STRIPE_PAYOUT_DELAYED','Stripe payout is overdue','MERCHANT','STRIPE','WATCHDOG_ALERT_CLEARED',1440,0,1440,NULL,NULL,0,0,0,1),
('STRIPE_ACCOUNT_REQUIREMENTS','Stripe account has an action required','MERCHANT','STRIPE','WATCHDOG_ALERT_CLEARED',1440,0,720,NULL,NULL,0,0,0,1),
('CUSTOMER_PAYMENT_INCOMPLETE','Payment needs customer action','CUSTOMER','BUILTEGRITY','WATCHDOG_ALERT_CLEARED',1440,60,1440,NULL,NULL,0,0,0,1),
('WEBHOOK_RECOVERY','Processor event could not self-recover','INTERNAL','STRIPE','WATCHDOG_ALERT_CLEARED',60,0,60,'TECHNICAL_L1',15,1500,0,1,0),
('PROCESSOR_RECORD_RECONCILIATION','Processor records do not reconcile','INTERNAL','STRIPE','WATCHDOG_ALERT_CLEARED',120,0,120,'BACK_OFFICE_RECONCILIATION',30,1500,0,1,0),
('FEE_RECONCILIATION','Builtegrity fee record needs reconciliation','INTERNAL','STRIPE','WATCHDOG_ALERT_CLEARED',120,0,120,'BACK_OFFICE_RECONCILIATION',30,1500,0,1,0),
('CLERK_DEPENDENCY','Authentication provider dependency problem','PLATFORM_VENDOR','CLERK','WATCHDOG_ALERT_CLEARED',120,0,120,'TECHNICAL_L1',30,1500,0,1,0),
('PUBLIC_RUNTIME_DEPENDENCY','Builtegrity public runtime problem','INTERNAL','CLOUDFLARE','WATCHDOG_ALERT_CLEARED',30,0,60,'TECHNICAL_L1',10,2500,1,1,0),
('PLATFORM_CONFIGURATION','Platform configuration is incomplete','INTERNAL','BUILTEGRITY','WATCHDOG_ALERT_CLEARED',240,0,240,'TECHNICAL_L1',30,2500,1,1,0),
('DATA_INTEGRITY','Transaction data integrity needs repair','INTERNAL','BUILTEGRITY','WATCHDOG_ALERT_CLEARED',120,0,120,'BACK_OFFICE_RECONCILIATION',30,2000,0,1,0),
('UNKNOWN_TECHNICAL','Unclassified technical exception','INTERNAL','BUILTEGRITY','WATCHDOG_ALERT_CLEARED',60,0,60,'TECHNICAL_L1',15,2500,0,1,0),
('FINANCIAL_SAFETY','Financial safety brake requires verified inputs','INTERNAL','BUILTEGRITY','WATCHDOG_ALERT_CLEARED',60,0,60,NULL,NULL,0,0,0,0),
('SECURITY_HOLD','Security condition requires authorized review','INTERNAL','BUILTEGRITY','AUTHORIZED_SECURITY_CLEARANCE',15,0,60,NULL,NULL,0,1,0,0),
('LEGAL_HOLD','Legal/regulatory condition requires authorized review','INTERNAL','BUILTEGRITY','AUTHORIZED_LEGAL_CLEARANCE',60,0,60,NULL,NULL,0,1,0,0);

INSERT OR REPLACE INTO resolution_steps
(playbook_code,sequence,actor_type,title,instruction,link_kind,explicit_url,automatic_verification_note) VALUES
('STRIPE_PAYOUT_FAILED',1,'MERCHANT','Open your Stripe payout','Open Stripe Dashboard and review the failed payout. Read the failure reason and the bank account or verification action Stripe identifies.','DASHBOARD','https://dashboard.stripe.com/','Builtegrity keeps checking Stripe automatically.'),
('STRIPE_PAYOUT_FAILED',2,'MERCHANT','Complete the Stripe action','Correct the bank details or complete any verification Stripe requests. If Stripe does not provide a self-service action, open Stripe Support from the official support link.','SUPPORT','https://support.stripe.com/','Do not send bank credentials to Builtegrity.'),
('STRIPE_PAYOUT_FAILED',3,'SYSTEM','Automatic recheck','No confirmation button is required. Builtegrity rechecks the connected account and payout state until Stripe reports the issue cleared.','NONE',NULL,'The case closes only from processor evidence.'),

('STRIPE_PAYOUT_DELAYED',1,'MERCHANT','Check the payout in Stripe','Open Stripe Dashboard and locate the payout. Confirm the expected arrival date and whether Stripe shows an action required.','DASHBOARD','https://dashboard.stripe.com/','Builtegrity continues reconciling automatically.'),
('STRIPE_PAYOUT_DELAYED',2,'MERCHANT','Resolve any action required','Complete any Stripe-requested bank or verification action. If the payout remains overdue with no action shown, contact Stripe Support.','SUPPORT','https://support.stripe.com/','Builtegrity never asks you to send banking credentials by email.'),
('STRIPE_PAYOUT_DELAYED',3,'SYSTEM','Automatic recheck','Builtegrity closes the case when the processor payout reconciles successfully.','NONE',NULL,'Machine verified.'),

('STRIPE_ACCOUNT_REQUIREMENTS',1,'MERCHANT','Open Stripe actions required','Open your Stripe Dashboard and complete every item shown under actions or verification requirements.','DASHBOARD','https://dashboard.stripe.com/','Stripe is the source of truth for KYC/account requirements.'),
('STRIPE_ACCOUNT_REQUIREMENTS',2,'MERCHANT','Submit missing information to Stripe','Provide the requested information directly inside Stripe. If Stripe does not expose the needed action, use Stripe Support.','SUPPORT','https://support.stripe.com/','Never send identity documents or credentials to Builtegrity by ordinary email.'),
('STRIPE_ACCOUNT_REQUIREMENTS',3,'SYSTEM','Automatic capability recheck','Builtegrity polls charges, payouts and account requirements. Processing restores only after the required capabilities are actually enabled.','NONE',NULL,'No human can mark this fixed without Stripe evidence.'),

('CUSTOMER_PAYMENT_INCOMPLETE',1,'CUSTOMER','Return to the secure payment page','Use the Builtegrity payment link in this message to review the purchase and continue the payment.','PAYMENT',NULL,'The link is transaction-specific and expires according to the transaction record.'),
('CUSTOMER_PAYMENT_INCOMPLETE',2,'CUSTOMER','Complete required consent and payment','Review the merchant terms, provide the required billing jurisdiction attestation, and complete payment through Stripe.','NONE',NULL,'Builtegrity never asks for card details by email.'),
('CUSTOMER_PAYMENT_INCOMPLETE',3,'SYSTEM','Automatic confirmation','Builtegrity verifies the payment directly from Stripe and closes the reminder automatically.','NONE',NULL,'Machine verified.'),

('CLERK_DEPENDENCY',1,'SYSTEM','Check Clerk service status','Builtegrity retries authentication probes. During a provider incident no payment record is rewritten and no unsafe bypass is enabled.','STATUS','https://status.clerk.com/','Automatic retries continue.'),
('CLERK_DEPENDENCY',2,'VENDOR','Escalate persistent provider issue','If Clerk is operational but the probe still fails, review the Clerk configuration and use Clerk support with the captured error evidence.','SUPPORT','https://clerk.com/contact/support','Only an approved technical vendor may receive this work order.'),
('CLERK_DEPENDENCY',3,'SYSTEM','Verify recovery','Builtegrity resolves the incident only after its live JWKS probe succeeds.','NONE',NULL,'Machine verified.'),

('PUBLIC_RUNTIME_DEPENDENCY',1,'SYSTEM','Check Cloudflare status','Builtegrity distinguishes a provider outage from an application defect before any human work is purchased.','STATUS','https://www.cloudflarestatus.com/','Provider outage waits and retries; application defects can be outsourced.'),
('PUBLIC_RUNTIME_DEPENDENCY',2,'VENDOR','Diagnose the runtime if Cloudflare is healthy','Use the Builtegrity runbook and Cloudflare dashboard/support to restore the public health endpoint. Do not bypass financial or security gates.','SUPPORT','https://developers.cloudflare.com/support/','Requires an approved vendor with privileged technical access.'),
('PUBLIC_RUNTIME_DEPENDENCY',3,'SYSTEM','Verify the public endpoint','The work order is considered successful only when Builtegrity can reach its own production health endpoint again.','NONE',NULL,'Machine verified.'),

('WEBHOOK_RECOVERY',1,'SYSTEM','Retry deterministic recovery','Builtegrity retries only idempotent processor-event handling and preserves the original Stripe event ID.','NONE',NULL,'Retry storms are prohibited.'),
('WEBHOOK_RECOVERY',2,'VENDOR','Reconcile from processor evidence','If automatic recovery fails, use the captured event/transaction IDs and official Stripe tools to reconcile the record without editing history.','SUPPORT','https://support.stripe.com/','Vendor output is not trusted until the alert clears.'),
('WEBHOOK_RECOVERY',3,'SYSTEM','Verify reconciliation','Builtegrity reruns invariants and closes the case only when processor and local state agree.','NONE',NULL,'Machine verified.'),

('PROCESSOR_RECORD_RECONCILIATION',1,'SYSTEM','Refresh processor state','Builtegrity first attempts a fresh processor read and deterministic derived-state rebuild.','NONE',NULL,'No manual database edits.'),
('PROCESSOR_RECORD_RECONCILIATION',2,'VENDOR','Reconcile missing records','An approved back-office/technical vendor may investigate processor references using the case runbook and official Stripe support.','SUPPORT','https://support.stripe.com/','No card data or secrets are included in the work order.'),
('PROCESSOR_RECORD_RECONCILIATION',3,'SYSTEM','Verify processor agreement','The case closes only when required processor IDs and integrity invariants reconcile.','NONE',NULL,'Machine verified.'),

('FEE_RECONCILIATION',1,'SYSTEM','Refresh application-fee evidence','Builtegrity refreshes processor evidence before purchasing human work.','NONE',NULL,'Merchant refunds do not erase an already-earned Builtegrity fee.'),
('FEE_RECONCILIATION',2,'VENDOR','Investigate fee mismatch','An approved reconciliation vendor may trace the processor application-fee record and documented platform-error credits.','SUPPORT','https://support.stripe.com/','The vendor cannot authorize a revenue write-off.'),
('FEE_RECONCILIATION',3,'SYSTEM','Verify fee state','Builtegrity closes only when the processor fee evidence reconciles or an authorized platform-fault credit is recorded.','NONE',NULL,'Machine verified.'),

('PLATFORM_CONFIGURATION',1,'SYSTEM','Identify the exact missing setting','The alert names the missing configuration key. Builtegrity never invents or substitutes a secret.','NONE',NULL,'Missing secrets fail closed.'),
('PLATFORM_CONFIGURATION',2,'VENDOR','Complete approved configuration work','An approved privileged technical vendor may configure the named provider setting using delegated access. Secrets must stay in the provider/secret store, not tickets or email.','NONE',NULL,'Auto-outsourcing is blocked until a vendor is contractually approved for privileged access.'),
('PLATFORM_CONFIGURATION',3,'SYSTEM','Verify configuration','The watchdog re-runs and resolves the case only when the required configuration is observable.','NONE',NULL,'Machine verified.'),

('DATA_INTEGRITY',1,'SYSTEM','Attempt deterministic repair','Builtegrity rebuilds derived state from append-only transaction and processor evidence.','NONE',NULL,'Source history is never rewritten.'),
('DATA_INTEGRITY',2,'VENDOR','Investigate unresolved integrity mismatch','An approved reconciliation vendor may follow the case runbook. Manual data changes are prohibited; any code/data repair must create auditable events.','NONE',NULL,'Machine verification remains authoritative.'),
('DATA_INTEGRITY',3,'SYSTEM','Run invariants again','The alert closes only when all integrity checks pass.','NONE',NULL,'Machine verified.'),

('UNKNOWN_TECHNICAL',1,'SYSTEM','Contain the unknown state','Quarantine the affected subject where needed and preserve evidence.','NONE',NULL,'Unknown errors do not silently continue.'),
('UNKNOWN_TECHNICAL',2,'VENDOR','Diagnose and repair once','An approved technical vendor may diagnose the failure. The repair must produce a permanent deterministic rule or regression test before the case is considered complete.','NONE',NULL,'One-off manual fixes without a permanent rule are rejected.'),
('UNKNOWN_TECHNICAL',3,'SYSTEM','Verify the permanent rule','Builtegrity re-runs the originating watchdog and keeps the case open until the condition stays clear.','NONE',NULL,'Machine verified.');

CREATE TABLE IF NOT EXISTS resolution_instances (
  id TEXT PRIMARY KEY,
  source_alert_key TEXT NOT NULL,
  internal_case_id TEXT,
  playbook_code TEXT NOT NULL,
  party_type TEXT NOT NULL,
  provider_code TEXT,
  merchant_id TEXT,
  customer_id TEXT,
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','NOTIFIED','WAITING_EXTERNAL','WAITING_VENDOR','VERIFYING','RESOLVED','BLOCKED')),
  verification_handler TEXT NOT NULL,
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  last_verified_at TEXT,
  next_check_at TEXT,
  last_error TEXT,
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY (playbook_code) REFERENCES resolution_playbooks(code),
  FOREIGN KEY (provider_code) REFERENCES resolution_providers(code),
  FOREIGN KEY (internal_case_id) REFERENCES internal_cases(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resolution_instance_open_alert
  ON resolution_instances(source_alert_key)
  WHERE status <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS idx_resolution_instances_queue
  ON resolution_instances(status, next_check_at, opened_at);

CREATE TABLE IF NOT EXISTS resolution_notifications (
  id TEXT PRIMARY KEY,
  resolution_instance_id TEXT NOT NULL,
  audience_type TEXT NOT NULL CHECK (audience_type IN ('MERCHANT','CUSTOMER','VENDOR','INTERNAL')),
  recipient TEXT,
  delivery_provider TEXT NOT NULL DEFAULT 'RESEND',
  status TEXT NOT NULL CHECK (status IN ('SENT','SKIPPED','FAILED')),
  provider_message_id TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (resolution_instance_id) REFERENCES resolution_instances(id)
);
CREATE INDEX IF NOT EXISTS idx_resolution_notifications_instance
  ON resolution_notifications(resolution_instance_id, created_at);
CREATE TRIGGER IF NOT EXISTS resolution_notifications_no_update BEFORE UPDATE ON resolution_notifications
BEGIN SELECT RAISE(ABORT, 'resolution notifications are append-only'); END;
CREATE TRIGGER IF NOT EXISTS resolution_notifications_no_delete BEFORE DELETE ON resolution_notifications
BEGIN SELECT RAISE(ABORT, 'resolution notifications are append-only'); END;

-- -----------------------------------------------------------------------------
-- Outsourced workforce. No arbitrary contractor can receive work or money.
-- A vendor must be APPROVED, capability-approved, within per-work and monthly budgets,
-- and the task must be machine-verifiable. Security, legal and discretionary finance are
-- intentionally not seeded as outsourceable categories.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workforce_vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_code TEXT,
  status TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (status IN ('CANDIDATE','APPROVED','PAUSED','RETIRED')),
  dispatch_mode TEXT NOT NULL DEFAULT 'EMAIL' CHECK (dispatch_mode IN ('EMAIL','WEBHOOK')),
  dispatch_email TEXT,
  dispatch_endpoint TEXT,
  dispatch_secret_env_key TEXT,
  payment_mode TEXT NOT NULL DEFAULT 'EXTERNAL_AUTOPAY' CHECK (payment_mode IN ('EXTERNAL_AUTOPAY','WEBHOOK_AFTER_VERIFICATION')),
  payment_endpoint TEXT,
  payment_secret_env_key TEXT,
  contract_status TEXT NOT NULL DEFAULT 'NOT_SIGNED' CHECK (contract_status IN ('NOT_SIGNED','ACTIVE','EXPIRED')),
  dpa_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (dpa_status IN ('NOT_REQUIRED','PENDING','ACTIVE','EXPIRED')),
  tax_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (tax_status IN ('PENDING','CLEARED')),
  privileged_access_approved INTEGER NOT NULL DEFAULT 0 CHECK (privileged_access_approved IN (0,1)),
  auto_dispatch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_dispatch_enabled IN (0,1)),
  per_work_order_cap_cents INTEGER NOT NULL DEFAULT 0 CHECK (per_work_order_cap_cents >= 0),
  monthly_cap_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_cap_cents >= 0),
  default_sla_minutes INTEGER NOT NULL DEFAULT 240 CHECK (default_sla_minutes > 0),
  contact_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (provider_code) REFERENCES resolution_providers(code)
);

-- Candidates are deliberately NOT approved by migration. Once a contract, DPA/tax posture,
-- intake destination and payment arrangement exist, one database configuration change makes
-- them eligible for automatic dispatch without owner-by-owner requests.
INSERT OR IGNORE INTO workforce_vendors
(id,name,provider_code,status,dispatch_mode,payment_mode,contract_status,dpa_status,tax_status,auto_dispatch_enabled,per_work_order_cap_cents,monthly_cap_cents,default_sla_minutes,contact_url,notes) VALUES
('WF-SUPPORTYOURAPP','SupportYourApp','SUPPORTYOURAPP','CANDIDATE','EMAIL','EXTERNAL_AUTOPAY','NOT_SIGNED','PENDING','PENDING',0,0,0,240,'https://supportyourapp.com/contacts/','Primary candidate for pay-as-you-go support/back-office work. Public pricing confirms pay-as-you-go models; configure the contracted intake destination before approval.'),
('WF-PARTNERHERO','PartnerHero Flex','PARTNERHERO','CANDIDATE','EMAIL','EXTERNAL_AUTOPAY','NOT_SIGNED','PENDING','PENDING',0,0,0,240,'https://www.partnerhero.com/','Fallback candidate for flexible support. Configure only after contracting.'),
('WF-INFLUX','Influx','INFLUX','CANDIDATE','EMAIL','EXTERNAL_AUTOPAY','NOT_SIGNED','PENDING','PENDING',0,0,0,240,'https://influx.com/','Fallback candidate for pay-per-response/support workloads. Configure only after contracting.');

CREATE TABLE IF NOT EXISTS workforce_vendor_capabilities (
  vendor_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('CUSTOMER_SUPPORT','MERCHANT_SUPPORT','TECHNICAL_L1','BACK_OFFICE_RECONCILIATION')),
  approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),
  unit_type TEXT NOT NULL DEFAULT 'CASE' CHECK (unit_type IN ('CASE','HOUR','RESPONSE')),
  unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  max_data_class TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (max_data_class IN ('PUBLIC','INTERNAL','CUSTOMER_CONTACT')),
  PRIMARY KEY (vendor_id, category),
  FOREIGN KEY (vendor_id) REFERENCES workforce_vendors(id)
);

INSERT OR IGNORE INTO workforce_vendor_capabilities (vendor_id,category,approved,unit_type,unit_cost_cents,max_data_class) VALUES
('WF-SUPPORTYOURAPP','CUSTOMER_SUPPORT',0,'CASE',0,'CUSTOMER_CONTACT'),
('WF-SUPPORTYOURAPP','MERCHANT_SUPPORT',0,'CASE',0,'CUSTOMER_CONTACT'),
('WF-SUPPORTYOURAPP','TECHNICAL_L1',0,'CASE',0,'INTERNAL'),
('WF-SUPPORTYOURAPP','BACK_OFFICE_RECONCILIATION',0,'CASE',0,'INTERNAL'),
('WF-PARTNERHERO','CUSTOMER_SUPPORT',0,'HOUR',0,'CUSTOMER_CONTACT'),
('WF-PARTNERHERO','MERCHANT_SUPPORT',0,'HOUR',0,'CUSTOMER_CONTACT'),
('WF-PARTNERHERO','TECHNICAL_L1',0,'HOUR',0,'INTERNAL'),
('WF-INFLUX','CUSTOMER_SUPPORT',0,'RESPONSE',0,'CUSTOMER_CONTACT'),
('WF-INFLUX','MERCHANT_SUPPORT',0,'RESPONSE',0,'CUSTOMER_CONTACT');

CREATE TABLE IF NOT EXISTS workforce_policy (
  id TEXT PRIMARY KEY CHECK (id='GLOBAL'),
  auto_dispatch_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_dispatch_enabled IN (0,1)),
  max_single_work_order_cents INTEGER NOT NULL DEFAULT 5000 CHECK (max_single_work_order_cents >= 0),
  monthly_budget_cents INTEGER NOT NULL DEFAULT 50000 CHECK (monthly_budget_cents >= 0),
  max_vendor_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_vendor_attempts BETWEEN 1 AND 10),
  require_machine_verification INTEGER NOT NULL DEFAULT 1 CHECK (require_machine_verification IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO workforce_policy (id) VALUES ('GLOBAL');

CREATE TABLE IF NOT EXISTS workforce_work_orders (
  id TEXT PRIMARY KEY,
  resolution_instance_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','DISPATCHED','WAITING_VERIFICATION','VERIFIED','FAILED','TIMED_OUT','CANCELLED')),
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  scope_text TEXT NOT NULL,
  verification_handler TEXT NOT NULL,
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_cents >= 0),
  approved_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (approved_budget_cents >= 0),
  payment_status TEXT NOT NULL DEFAULT 'NOT_DUE'
    CHECK (payment_status IN ('NOT_DUE','EXTERNAL_AUTOPAY','PAYMENT_PENDING','PAID','HELD')),
  external_reference TEXT,
  dispatched_at TEXT,
  verify_by TEXT,
  verified_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (resolution_instance_id) REFERENCES resolution_instances(id),
  FOREIGN KEY (vendor_id) REFERENCES workforce_vendors(id)
);
CREATE INDEX IF NOT EXISTS idx_work_orders_queue ON workforce_work_orders(status, verify_by, created_at);
CREATE INDEX IF NOT EXISTS idx_work_orders_vendor_month ON workforce_work_orders(vendor_id, created_at);

CREATE TABLE IF NOT EXISTS workforce_work_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (work_order_id) REFERENCES workforce_work_orders(id)
);
CREATE TRIGGER IF NOT EXISTS workforce_work_order_events_no_update BEFORE UPDATE ON workforce_work_order_events
BEGIN SELECT RAISE(ABORT, 'work order events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS workforce_work_order_events_no_delete BEFORE DELETE ON workforce_work_order_events
BEGIN SELECT RAISE(ABORT, 'work order events are append-only'); END;

CREATE VIEW IF NOT EXISTS workforce_monthly_spend AS
SELECT
  strftime('%Y-%m', created_at) AS month,
  SUM(estimated_cost_cents) AS committed_cost_cents,
  COUNT(*) AS work_orders,
  SUM(CASE WHEN status='VERIFIED' THEN 1 ELSE 0 END) AS verified_work_orders,
  SUM(CASE WHEN status IN ('FAILED','TIMED_OUT') THEN 1 ELSE 0 END) AS failed_work_orders
FROM workforce_work_orders
WHERE status <> 'CANCELLED'
GROUP BY strftime('%Y-%m', created_at);

-- Vendor cannot declare its own work successful. Verification comes from the originating
-- machine-observable condition. Payment therefore cannot be marked PAID on unverified work.
CREATE TRIGGER IF NOT EXISTS work_order_no_unverified_paid_insert
BEFORE INSERT ON workforce_work_orders
WHEN NEW.payment_status='PAID' AND NEW.status<>'VERIFIED'
BEGIN SELECT RAISE(ABORT, 'unverified outsourced work cannot be paid'); END;
CREATE TRIGGER IF NOT EXISTS work_order_no_unverified_paid_update
BEFORE UPDATE OF payment_status,status ON workforce_work_orders
WHEN NEW.payment_status='PAID' AND NEW.status<>'VERIFIED'
BEGIN SELECT RAISE(ABORT, 'unverified outsourced work cannot be paid'); END;

-- Candidates cannot accidentally be activated without the minimum contractual controls.
CREATE TRIGGER IF NOT EXISTS workforce_vendor_approval_guard
BEFORE UPDATE OF status,auto_dispatch_enabled,contract_status,tax_status,dispatch_email,dispatch_endpoint ON workforce_vendors
WHEN NEW.status='APPROVED' AND NEW.auto_dispatch_enabled=1 AND (
  NEW.contract_status<>'ACTIVE' OR NEW.tax_status<>'CLEARED' OR
  (NEW.dispatch_mode='EMAIL' AND (NEW.dispatch_email IS NULL OR NEW.dispatch_email='')) OR
  (NEW.dispatch_mode='WEBHOOK' AND (NEW.dispatch_endpoint IS NULL OR NEW.dispatch_endpoint='')) OR
  NEW.per_work_order_cap_cents<=0 OR NEW.monthly_cap_cents<=0
)
BEGIN SELECT RAISE(ABORT, 'automatic workforce vendor requires active contract, tax clearance, dispatch destination and budget caps'); END;
