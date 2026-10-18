# Merchant refund PDFs, private email links and dashboard adoption

## Security contract

- A merchant account is **optional for transaction monitoring**. Stripe/Square webhooks and the integrity engine do not require a merchant profile.
- A merchant **must create/sign into a verified Clerk account and hold active merchant_access membership** to view, print, download or send/share a transaction or refund PDF through the merchant portal.
- Onboarding emails, if explicitly opted in, include a **single-transaction** link under `/merchant/record/#<token>`. The stored SHA-256 token hash and 14-day expiry still apply. This URL displays **status only**: no PDF, amount, customer name, invoice reference, internal notes, attached images, fees, bank facts or other transactions. The old accountless PDF route returns 403.
- The merchant's other URL, `/dashboard/<business-name>-<merchant-id-suffix>/`, points at their authenticated profile. It is an address, not a capability or password. The server verifies Clerk identity **and** the D1 merchant membership before serving the dashboard. The general entry `/merchant/` remains valid.
- A merchant may claim an unowned profile from the onboarding link only with the matching verified Clerk business email and no preexisting owner; full profile privileges never come from a naked token alone.
- Existing separate **customer-shareable receipts** under `/api/records/<customer-token>` remain governed by their customer privacy rules; they never grant merchant PDF access. Review these customer receipts separately during privacy testing.

## Refund PDF workflow

Signed-in merchant visits Transaction Integrity → Refunds → View Refund PDF / Download Refund PDF / Share PDF. Each link identifies the exact refund ID, **not the original transaction's PDF**. Server searches Stripe's append-only successful refund adjustments and Square's provider-confirmed refund facts and checks the refund's original merchant_id against the Clerk principal's active tenant membership. A verified match produces a current PDF with refund reference, processor, status, amount and currency, original transaction and merchant invoice references, customer name, event time, application-fee refund details when supported, and explicit refund/bank finality limitations.

Square pending refunds are labeled **NOT A COMPLETED REFUND** and must not be represented as completed. Stripe financial refund adjustments are stored as successful refund deltas; this should be validated against actual provider sandbox refund event semantics. PDF delivery records a minimal merchant access audit, uses `Cache-Control: private, no-store`, and does not make the PDF publicly accessible. On supporting phones, Web Share can hand the downloaded file to a user-selected email/messaging app; otherwise the user downloads and attaches it themselves. Builtegrity does not automatically email sensitive refund PDFs to an arbitrary recipient.

## Profile adoption analytics

Operator-only endpoint: `GET /api/operations/merchant-profile-adoption` on the authorized admin host. Dashboard: `/console/merchant-adoption/`.

The eligible denominator includes merchant records that have **at least one transaction or a processor connection**, not empty shells. Numerators are merchants with active merchant_access and (separately) active OWNER membership. Report both with-profile and without-profile counts and their percentages; show emailed-link openings, repeat page opens, profile claims and refund-PDF downloads as auxiliary usage metrics. None of those numbers alone proves customer satisfaction or business value. No customer names, emails, business secrets, token hashes or PDFs are included in aggregate reports.

## Deployment and testing

Apply migration 0072 on production D1 **after all earlier migrations**; deploy Worker and UI assets; verify both logged-out and logged-in flows. Confirm a link-only viewer receives 403 for all PDF APIs, while an authorized merchant with a profile can download their own refunds but not another tenant's. Test partial refunds and Square pending/completed changes with real sandbox processor events before claiming provider readiness.

Keep optional email delivery and customer media gates off until external provider credentials, consent and privacy reviews are finished. A merged GitHub PR is not proof of a Cloudflare deployment.
