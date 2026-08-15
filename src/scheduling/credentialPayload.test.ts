import assert from "node:assert/strict";

import { carriesCredentialPayload } from "./proactive";

/**
 * The 2026-08-08 defect: a SIRVA password-reset email was classified NOTIFY by stage 1,
 * then killed by stage 2's context gate ("email: suppressed by context") because fig had
 * been helping the owner hunt for that exact portal a minute earlier. The owner never got
 * the link, and the only trace was a Pending line he couldn't see. The suppression rule
 * literally named "a password reset YOU triggered" as a skip case — right instinct for a
 * receipt, backwards for a payload.
 *
 * `carriesCredentialPayload` is the deterministic backstop: a model may not decide to
 * suppress its own delivery. Two things ride on it, which sets the bar from both sides:
 *   - a FALSE NEGATIVE re-opens the original bug (the ping gets eaten), so the common
 *     phrasings all have to hit;
 *   - a FALSE POSITIVE bypasses quiet hours, i.e. wakes him at 3am for a promo code, so
 *     "code" in the ordinary retail sense must NOT match.
 */

let failures = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

const CARRIES = [
  "what: SIRVA Relocation sent a password reset link for the relocation portal.",
  "what: Your verification code is 481920.",
  "what: GitHub sent a one-time code to sign in.",
  "what: Okta 2FA code: 553201",
  "what: Click below to reset your password.",
  "what: Notion sent a magic link to sign in.",
  "what: Please verify your email address to finish signing up.",
  "what: Confirm your account to activate it.",
  "what: Your login code is 8823 and expires in 10 minutes.",
  "what: Amazon sent a security code for a new sign-in attempt.",
  "what: Enter this passcode: 902213",
  "what: An MFA challenge was sent to your device.",
];

// Everything here is either a normal notify or pure noise. None may bypass quiet hours.
const DOES_NOT_CARRY = [
  "what: Use promo code SAVE20 for 20% off your next order.",
  "what: Your discount code expires Sunday.",
  "what: Southwest confirmation CMAPJ5 for SAN to DEN on Aug 9.",
  "what: Your package was delivered to the front desk.",
  "what: Chris Myers replied about the lab meeting on Thursday.",
  "what: Your Amex statement is ready, $1,722.92 due Aug 11.",
  "what: A new sign-in to your Google account from San Diego.",
  "what: Your area code is changing for the support line.",
  "what: The building access hours are 6am to 9pm.",
  "what: Your coupon code did not apply at checkout.",
];

function main(): void {
  for (const brief of CARRIES) {
    check(`carries: ${brief.slice(6, 52)}`, () => {
      assert.equal(carriesCredentialPayload(brief), true, "should be treated as a payload — missing it eats the ping");
    });
  }

  for (const brief of DOES_NOT_CARRY) {
    check(`plain:   ${brief.slice(6, 52)}`, () => {
      assert.equal(carriesCredentialPayload(brief), false, "false positive here means a quiet-hours bypass at 3am");
    });
  }

  check("matching is case-insensitive — briefs are not normalized upstream", () => {
    assert.equal(carriesCredentialPayload("what: PASSWORD RESET requested"), true);
    assert.equal(carriesCredentialPayload("what: Your One-Time Code is 1234"), true);
  });

  check("an empty brief is not a payload", () => {
    assert.equal(carriesCredentialPayload(""), false);
  });

  console.log(`\n${ran - failures}/${ran} passed`);
  if (failures) process.exit(1);
}

main();
