PRAGMA foreign_keys = ON;

-- Email delivery is part of the resolution transport, not the payment truth path. Route failures
-- to Resend specifically, keep payment state untouched, retry automatically, and permit an
-- approved privileged technical vendor to act only when standing access and dispatch controls exist.
INSERT OR REPLACE INTO resolution_playbooks
(code,title,party_type,provider_code,verification_handler,default_sla_minutes,notify_after_minutes,repeat_notice_minutes,outsource_category,outsource_after_minutes,default_work_budget_cents,privileged_access_required,outsourcing_allowed,customer_safe) VALUES
('RESEND_DEPENDENCY','Resolution email delivery is unavailable','PLATFORM_VENDOR','RESEND','WATCHDOG_ALERT_CLEARED',120,0,120,'TECHNICAL_L1',15,1500,1,1,0);

DELETE FROM resolution_steps WHERE playbook_code='RESEND_DEPENDENCY';
INSERT INTO resolution_steps
(playbook_code,sequence,actor_type,title,instruction,link_kind,explicit_url,automatic_verification_note) VALUES
('RESEND_DEPENDENCY',1,'SYSTEM','Retry delivery without changing transaction state','Keep the originating merchant/customer case open and retry its required notice on subsequent autopilot cycles. Do not bypass the notice, alter payment truth, or mark the case fixed merely because email is unavailable.','NONE',NULL,'A later successful Resend delivery automatically clears the dependency alert.'),
('RESEND_DEPENDENCY',2,'VENDOR','Check Resend service health','Open the official Resend service surface and determine whether delivery is failing because of a provider incident, sender/domain state, API credentials, or Builtegrity configuration.','STATUS','https://resend.com/','Provider incidents should be allowed to recover while automatic retries continue.'),
('RESEND_DEPENDENCY',3,'VENDOR','Use official Resend support for provider-side blockers','If Resend is operational but the failure persists, use the official Resend support channel with the captured error and message reference. Never place API keys or unrelated customer data into the support request.','SUPPORT','https://resend.com/support','Privileged configuration work is allowed only for a pre-approved workforce vendor.'),
('RESEND_DEPENDENCY',4,'SYSTEM','Machine-verify actual delivery','The dependency is resolved only when Builtegrity successfully sends the previously blocked guidance through Resend.','NONE',NULL,'Successful delivery resolves both resend-config and resend-api dependency alerts for that resolution instance.');
