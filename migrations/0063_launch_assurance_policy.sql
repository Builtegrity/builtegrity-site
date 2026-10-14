-- Voluntary company risk controls required by the owner before a live pilot.
-- These are not statutory requirements and must not be auto-cleared by AI.
INSERT INTO compliance_obligations
 (id,jurisdiction,category,obligation_type,title,requirement_summary,source_name,source_url,status)
VALUES
 ('POLICY-LIMITED-LIABILITY-ENTITY','US-RI','LAUNCH_POLICY','REQUIRED',
  'Entity separation before live activity',
  'Verify an active LLC or corporation, company contracting and bank/processor identity, separate books, and review of personal guarantees. DBA or sole proprietor alone does not satisfy company launch policy.',
  'Builtegrity owner launch policy; entity background',
  'https://www.sos.ri.gov/divisions/business-services/business-basics/costs-and-fees','OPEN'),
 ('POLICY-TECH-EO-CYBER-COVERAGE','US','LAUNCH_POLICY','REQUIRED',
  'Bound technology E&O and cyber coverage',
  'Broker/counsel must verify bound coverage for actual payment initiation, platform fees and monitoring operations; insured entity/persons, defense, exclusions, limits, retention funding, retroactive date, and reporting route. A quote is not coverage. Review due no later than policy expiry; reopen immediately on cancellation or material change.',
  'Builtegrity owner launch policy; coverage background',
  'https://www.ftc.gov/business-guidance/small-businesses/cybersecurity/cyber-insurance','OPEN'),
 ('POLICY-PROCESSOR-LOSS-ALLOCATION','US','LAUNCH_POLICY','REQUIRED',
  'Verified direct-charge loss responsibility',
  'Verify actual Connect settings and applicable agreement assign connected-account payment losses to Stripe within documented exceptions, keep merchant seller of record, and review platform indemnities, guarantees and remaining liabilities. Direct charges alone are insufficient evidence. Reopen when account configuration or agreement changes.',
  'Builtegrity owner launch policy; Stripe responsibility documentation',
  'https://docs.stripe.com/connect/risk-management','OPEN');
