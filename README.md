# Builtegrity site

Static GitHub Pages site for Builtegrity's Rhode Island and Massachusetts Phase 1 roofing-request launch.

## Routes

- `/` homeowner trust and explanation page
- `/request/` five-step roofing request with homeowner goal selection for contractor introduction, quote comparison or another option
- `/request/complete/` request confirmation
- `/contact/`
- `/privacy/`
- `/terms/`

The request currently posts to the established Google Form endpoint. The homeowner help preference is preserved inside the existing project-description field so the live Google Form and downstream automation remain compatible while the backend schema is unchanged. The generated Builtegrity request reference, related exterior needs and campaign
attribution are posted to their established Google Form fields. The request flow
requires Rhode Island or Massachusetts and appends the selected state to the stored
property address without changing the working form-entry mapping.

## Publication gates

- Confirm written permission for the Prime State launch disclosure
- Confirm current partner credentials and insurance documentation
- Obtain legal review of Privacy Notice, Terms and request consent
- Maintain the validated Rhode Island/Massachusetts submission-and-reconciliation controls; the September 20 controlled E2E test passed all four homeowner-goal paths


## Comparison model

- Homeowners may ask Builtegrity to organize roofing quotes they already have.
- Comparison is limited to documented differences such as scope, materials, allowances, exclusions, warranties and pricing structure.
- Builtegrity does not select a winning contractor or guarantee the lowest price, technical accuracy or outcome.
- Contractor introductions remain controlled: one selected roofing company at a time.
- An additional contractor introduction is considered only when the homeowner requests or consents to it and an eligible partner is available.
- The request must never be broadcast to a contractor list.


## Operating safeguards

- `System Reconciliation` identifies raw Form Responses that have not yet reached Lead Dashboard and alerts after five minutes.
- Lead Dashboard records comparison status, additional-option status, quote-document state, named-partner consent, consent timestamp and release timestamp.
- An introduced additional option must pass the Handoff Gate; incomplete consent/release records produce BLOCK.
- Quote documents are kept in the restricted Builtegrity Quote Comparison Documents Drive workflow, not in public or contractor-shared folders.
