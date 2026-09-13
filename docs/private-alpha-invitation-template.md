# Private-Alpha Invitation Template

Status: Approved no-send template for manual private delivery

This is the approved message for inviting one person to create an alice. account during the private alpha. It is a manual template, not an email-delivery implementation. Do not create an invitation token, add an email address, or send this message until the product owner separately approves a specific recipient.

The account invitation operator returns a one-time registration URL for one exact email address. It stores only the token hash. The link expires after seven days. Send the resulting URL only through a private channel such as the operator's own email, WhatsApp, or iMessage. Do not put a real link, recipient email, or invitation token in Git, issue trackers, logs, screenshots, or shared chat.

## Send-ready message

**Subject:** You’re invited to alice.

```text
alice.
PRIVATE WORKSPACE

Switch AI tools. Keep the plot.

Keep the decisions, context, and files that matter in one private workspace.

Hi [FIRST NAME],

I’d love to invite you to a small private alpha of alice.

alice. gives you a private place to keep the parts of a project you choose to save, so you can pick up where you left off when you use different AI tools.

You stay in control. Nothing becomes trusted project context just because an AI suggests it. Important changes are shown for your review first.

Create your private workspace:
[ONE-TIME REGISTRATION LINK]

This invitation works only for [RECIPIENT EMAIL] and expires in seven days.

This is an early private alpha. Please do not add sensitive, regulated, or client-confidential information.

If you were not expecting this invitation, you can ignore it.

[YOUR NAME]
```

## Before sending

1. Confirm the exact recipient email and whether the invitation is for a controlled test or an approved alpha participant.
2. Obtain the separate approval required to temporarily create and invoke the private invitation operator.
3. Generate one link, verify that its response is no-store, and remove the temporary operator immediately.
4. Replace only `[FIRST NAME]`, `[RECIPIENT EMAIL]`, `[ONE-TIME REGISTRATION LINK]`, and `[YOUR NAME]` in a private copy of this message.
5. Send it privately. Do not forward or reuse the link.

The recipient first sees registration. The existing sign-in page is used only after they have registered with the exact invited email.

## Copy boundaries

The template avoids em dashes. It does not promise permanent deletion, provider training behavior, data residency, exact ChatGPT or Claude surface support, performance, or automatic email delivery. The current private-alpha disclosure remains authoritative.

