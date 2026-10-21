import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMerchantDeliveryPreferences, resolveDocumentBranding,
  buildCustomerDeliveryDecision, renderTransactionEmail
} from "./merchant-themed-delivery.mjs";

const merchant = { displayName: "Example Plumbing" };
const transaction = { id:"tx-1", status:"succeeded", reference:"TX-0001", formattedAmount:"$200.00", formattedDate:"2026-10-20" };
const customer = { email:"customer@example.com" };
test("opt-in defaults are OFF and PDF is neutral", () => {
  assert.equal(validateMerchantDeliveryPreferences({}).customerTransactionEmailEnabled,false);
  assert.equal(resolveDocumentBranding({theme:"forest"},merchant).theme,"builtegrity");
  assert.equal(buildCustomerDeliveryDecision({preferences:{},transaction,customer}).send,false);
});
test("merchant may choose independent PDF and email branding", () => {
  assert.equal(resolveDocumentBranding({theme:"ocean",themePdfEnabled:true},merchant).theme,"ocean");
  assert.equal(buildCustomerDeliveryDecision({preferences:{theme:"ocean", customerTransactionEmailEnabled:true},transaction,customer}).theme,"builtegrity");
  assert.equal(buildCustomerDeliveryDecision({preferences:{theme:"ocean",customerTransactionEmailEnabled:true,themeEmailEnabled:true},transaction,customer}).theme,"ocean");
});
test("no send for missing recipient or incomplete payment", () => {
  const preferences={customerTransactionEmailEnabled:true};
  assert.equal(buildCustomerDeliveryDecision({preferences,transaction,customer:{email:""}}).send,false);
  assert.equal(buildCustomerDeliveryDecision({preferences,transaction:{id:"tx",status:"pending"},customer}).send,false);
});
test("refund creates a distinct idempotent update", () => {
  const preferences={customerTransactionEmailEnabled:true};
  const original=buildCustomerDeliveryDecision({preferences,transaction,customer});
  const refunded=buildCustomerDeliveryDecision({preferences,transaction:{...transaction,status:"refunded"},customer});
  assert.notEqual(original.idempotencyKey,refunded.idempotencyKey);
  assert.match(renderTransactionEmail({preferences,merchant,transaction:{...transaction,status:"refunded"},customer}).subject,/refund/);
});
test("escape untrusted merchant text; no PDF links in email", () => {
  const email=renderTransactionEmail({preferences:{customerTransactionEmailEnabled:true,themeEmailEnabled:true,theme:"plum"},merchant:{displayName:'<script>alert("x")</script>'},transaction,customer});
  assert.ok(email);
  assert.doesNotMatch(email.html,/<script>/);
  assert.doesNotMatch(email.html,/download.*pdf/i);
});
test("untrusted theme and non-boolean opt-in rejected", () => {
  assert.throws(()=>validateMerchantDeliveryPreferences({theme:"javascript:alert(1)"}),RangeError);
  assert.throws(()=>validateMerchantDeliveryPreferences({themeEmailEnabled:"true"}),TypeError);
});
