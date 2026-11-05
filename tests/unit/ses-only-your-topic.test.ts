/**
 * Newsletter SES/SNS webhook: only notices from YOUR topic are accepted
 * ============================================================================
 *
 * Audit 2026-10-25: the SNS signature only proves that AWS sent the message,
 * not that the topic is yours. Anyone with an AWS account published to their
 * own "complaints" topic with addresses from your list and unsubscribed them. Now without
 * `SES_TOPIC_ARN` the adapter is not configured, and a message from another topic
 * is rejected (even before looking at the signature, nothing is followed).
 */

import { describe, expect, it } from "vitest";

import { sesFeedback } from "../../kons/kon-newsletter/feedback/ses";

describe("sesFeedback", () => {
  it("without SES_TOPIC_ARN it is not configured", () => {
    expect(sesFeedback({ SES_FEEDBACK_ENABLED: "true" }).isConfigured()).toBe(false);
    expect(
      sesFeedback({ SES_FEEDBACK_ENABLED: "true", SES_TOPIC_ARN: "arn:aws:sns:eu-west-1:1:mine" }).isConfigured()
    ).toBe(true);
  });

  it("an envelope without a valid signature or from another topic is rejected", async () => {
    const ses = sesFeedback({ SES_FEEDBACK_ENABLED: "true", SES_TOPIC_ARN: "arn:aws:sns:eu-west-1:1:mine" });
    const about = {
      Type: "Notification",
      TopicArn: "arn:aws:sns:eu-west-1:666:del-atacante",
      Message: JSON.stringify({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "v@x.com" }] } }),
      Signature: "AAAA",
      SigningCertURL: "https://example.com/cert.pem",
    };
    expect(await ses.parse(JSON.stringify(about), {})).toBeNull();
  });
});
