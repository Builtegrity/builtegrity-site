# Builtegrity Homeowner Comparison Model

Effective: September 20, 2026

## Purpose

Give homeowners a way to understand roofing options without turning Builtegrity into a broad lead marketplace.

## Non-negotiable rules

1. Never broadcast a homeowner request to a contractor list.
2. One selected roofing-company introduction at a time is the default release model.
3. A second introduction is considered only when the homeowner requests or consents to it and an eligible partner is actually available.
4. Do not promise multiple quotes, the lowest price, the best contractor or a guaranteed second option.
5. Quote comparison is organizational, not a technical certification or contractor ranking.
6. The homeowner remains the decision-maker.

## What Builtegrity may compare

- Contract price and pricing structure
- Stated roof size or quantities
- Scope of removal and installation
- Materials and manufacturers
- Underlayment and ice-and-water coverage
- Decking allowances and unit prices
- Flashing and ventilation
- Disposal and cleanup
- Warranty terms
- Payment structure
- Exclusions, allowances and unresolved questions

Builtegrity should identify differences and questions. It should not independently certify that a proposal is technically correct or select a winner.

## Request-flow choices

- Find me a roofing company
- Help me compare quotes I already have
- I’d like to discuss another roofing option
- I’m not sure yet

## Current backend compatibility

The live Google Form schema is not changed by this release. The selected homeowner goal is prefixed into the existing Roof / Problem Details field:

`Builtegrity help requested: <choice>`

The Lead Dashboard extracts that prefix into the Help Requested column.

This preserves the established Google Form and Apps Script automation while adding the new capability safely.

## Dashboard controls

- Help Requested — automatic extraction
- Comparison Status — manual workflow status
- Additional Option Status — manual workflow status
- Quote Documents Received — manual workflow status

## Comparison workflow

1. Confirm the homeowner’s goal.
2. If comparison is requested, collect or review the proposals the homeowner chooses to provide.
3. Organize differences into neutral categories.
4. Flag missing or unclear items as questions for the contractor.
5. If another option is requested, check actual eligible-partner availability.
6. Obtain or confirm homeowner consent before any additional release.
7. Record the result.

## Conflict / compensation transparency

Builtegrity, its operator or representatives may have compensation relationships with roofing companies involved in introductions. Comparison assistance must therefore be presented as organizational and informational, not as an independent ranking or endorsement.

## Phase 1 limitation

Prime State Roofing may be the only active fulfillment option for some Rhode Island and Massachusetts requests. If no second eligible partner exists, say so plainly and continue offering comparison help on estimates the homeowner obtains independently.
