PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO partners (id, name, partner_type, status)
VALUES ('PARTNER-0001', 'Builtegrity Direct', 'HOUSE', 'ACTIVE');

INSERT OR IGNORE INTO merchants (
  id, partner_id, name, email, processor, processor_account_id,
  integration_mode, automatic_payouts_required, status
) VALUES (
  'MER-0001', 'PARTNER-0001', 'ABC Cabinetry', 'merchant@example.com',
  'STRIPE', NULL, 'STRIPE_CONNECT', 1, 'TEST'
);

INSERT OR IGNORE INTO customers (
  id, merchant_id, name, email, merchant_customer_reference
) VALUES (
  'CUST-0001', 'MER-0001', 'John Smith', 'john@example.com', 'CUST-0001'
);

INSERT OR IGNORE INTO purchases (
  id, merchant_id, customer_id, merchant_reference, purchase_type,
  description, total_value_cents, currency, status
) VALUES (
  'PUR-0001', 'MER-0001', 'CUST-0001', 'JOB-1048', 'CUSTOM_PROJECT',
  'Custom kitchen cabinetry', 400000, 'USD', 'OPEN'
);

INSERT OR IGNORE INTO transactions (
  id, purchase_id, merchant_id, customer_id,
  transaction_type, description, amount_cents, currency,
  terms_version, terms_snapshot, refund_policy_snapshot, cancellation_policy_snapshot,
  consent_accepted, lifecycle_status, integrity_status, exception_status,
  processor, customer_paid_cents,
  integrity_fee_earned_cents, fee_collection_method, integrity_fee_collected_cents,
  payment_access_token
) VALUES (
  'TX-0001', 'PUR-0001', 'MER-0001', 'CUST-0001',
  'DEPOSIT', 'Custom kitchen cabinetry deposit', 120000, 'USD',
  'TERMS-001',
  'Deposit becomes non-refundable once custom materials are ordered.',
  'Deposit becomes non-refundable once custom materials are ordered.',
  'Customer may cancel before materials are ordered.',
  0, 'CREATED', 'INCOMPLETE', 'NONE',
  'STRIPE', NULL,
  25, 'STRIPE_APPLICATION_FEE', 0,
  'test-tx-0001-token'
);

INSERT OR IGNORE INTO transaction_events (
  id, transaction_id, event_type, source, event_data_json
) VALUES (
  'EVT-000001', 'TX-0001', 'TX_CREATED', 'BUILTEGRITY',
  '{"seed":true,"note":"Initial fake V1 transaction"}'
);
