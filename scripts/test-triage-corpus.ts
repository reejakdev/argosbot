/**
 * Synthetic 50-message triage corpus.
 * Each entry: text + expected route + reason.
 * No real partner data — generic test fixtures only.
 */

export type ExpectedRoute = 'urgent_notif' | 'task' | 'skip';

export interface CorpusEntry {
  text: string;
  expectedRoute: ExpectedRoute;
  reason: string;
  /** Optional: simulate sender being a partner (default true) */
  fromPartner?: boolean;
  /** Optional: explicit @reejak mention helper */
  mentionsOwner?: boolean;
}

export const CORPUS: CorpusEntry[] = [
  // ─── 5 genuinely urgent → urgent_notif ─────────────────────────────────────
  {
    text: '@reejak production is DOWN, payments failing right now, need you ASAP',
    expectedRoute: 'urgent_notif',
    reason: 'production down + asap + mention',
    mentionsOwner: true,
  },
  {
    text: '@reejak our hot wallet is compromised, please rotate keys immediately',
    expectedRoute: 'urgent_notif',
    reason: 'wallet compromise = critical',
    mentionsOwner: true,
  },
  {
    text: 'URGENT @reejak the deadline is tomorrow EOD and we still need your sign-off',
    expectedRoute: 'urgent_notif',
    reason: 'urgent + tomorrow deadline',
    mentionsOwner: true,
  },
  {
    text: '@reejak can you process the refund NOW, customer is escalating to legal',
    expectedRoute: 'urgent_notif',
    reason: 'act now + legal threat',
    mentionsOwner: true,
  },
  {
    text: 'If we do not get a reply in the next hour we will have to terminate the contract — @reejak',
    expectedRoute: 'urgent_notif',
    reason: 'partner threatening to pull contract',
    mentionsOwner: true,
  },

  // ─── 10 actionable but not urgent → task ───────────────────────────────────
  {
    text: 'Hi, can you send the receiving address by Friday so we can prepare the transfer?',
    expectedRoute: 'task',
    reason: 'concrete request with soft deadline',
  },
  {
    text: 'Please review the attached contract and let us know if the terms work for you.',
    expectedRoute: 'task',
    reason: 'review request',
  },
  {
    text: 'We need an invoice for last month — could you send it over when you have a moment?',
    expectedRoute: 'task',
    reason: 'invoice request',
  },
  {
    text: 'Could we schedule a call next week to align on the integration timeline?',
    expectedRoute: 'task',
    reason: 'scheduling request',
  },
  {
    text: 'Can you whitelist 0x1234567890abcdef1234567890abcdef12345678 on your side?',
    expectedRoute: 'task',
    reason: 'whitelist request (tx_whitelist counts as task surface)',
  },
  {
    text: 'Please add the new beneficiary to your ops list when you can.',
    expectedRoute: 'task',
    reason: 'add request',
  },
  {
    text: 'When you get a chance, could you confirm the wire details for next week?',
    expectedRoute: 'task',
    reason: 'confirmation request',
  },
  {
    text: 'Can you double-check the latest KYC docs we sent yesterday?',
    expectedRoute: 'task',
    reason: 'review request',
  },
  {
    text: 'We would like to onboard a new entity — can you share the form to fill?',
    expectedRoute: 'task',
    reason: 'document request',
  },
  {
    text: 'Could you forward the compliance memo from Q1 to our auditor?',
    expectedRoute: 'task',
    reason: 'forwarding request',
  },

  // ─── 10 informational status updates → skip ────────────────────────────────
  { text: 'Deploy completed successfully on staging.', expectedRoute: 'skip', reason: 'status' },
  { text: "I'll be offline tomorrow, back Monday.", expectedRoute: 'skip', reason: 'OOO notice' },
  { text: 'FYI new docs published at our portal.', expectedRoute: 'skip', reason: 'FYI' },
  { text: 'Update: the migration finished without issues.', expectedRoute: 'skip', reason: 'status' },
  { text: 'Just so you know, we rotated our API keys this morning.', expectedRoute: 'skip', reason: 'info' },
  { text: 'The audit report has been uploaded to the shared drive.', expectedRoute: 'skip', reason: 'info' },
  { text: 'Reminder: maintenance window scheduled for Sunday 2-4am UTC.', expectedRoute: 'skip', reason: 'info reminder' },
  { text: 'Heads up — we changed our office address last week.', expectedRoute: 'skip', reason: 'info' },
  { text: 'New release notes are out, no action needed from your side.', expectedRoute: 'skip', reason: 'info' },
  { text: 'Quarterly numbers are in, attaching the deck for visibility.', expectedRoute: 'skip', reason: 'info' },

  // ─── 10 social/casual → skip ───────────────────────────────────────────────
  { text: 'thanks!', expectedRoute: 'skip', reason: 'social' },
  { text: 'ok cool', expectedRoute: 'skip', reason: 'social' },
  { text: 'have a good weekend!', expectedRoute: 'skip', reason: 'social' },
  { text: '👍', expectedRoute: 'skip', reason: 'emoji only' },
  { text: '🎉🎉', expectedRoute: 'skip', reason: 'emoji only' },
  { text: 'lol', expectedRoute: 'skip', reason: 'social' },
  { text: 'great, appreciate it', expectedRoute: 'skip', reason: 'social' },
  { text: 'good morning team', expectedRoute: 'skip', reason: 'greeting' },
  { text: 'happy birthday!', expectedRoute: 'skip', reason: 'social' },
  { text: 'congrats on the launch', expectedRoute: 'skip', reason: 'social' },

  // ─── 10 ambiguous → skip (low signal, no action) ───────────────────────────
  { text: 'did you see my last message?', expectedRoute: 'skip', reason: 'vague nudge' },
  { text: 'any update?', expectedRoute: 'skip', reason: 'vague nudge' },
  { text: 'ping', expectedRoute: 'skip', reason: 'vague' },
  { text: '?', expectedRoute: 'skip', reason: 'vague' },
  { text: 'hey', expectedRoute: 'skip', reason: 'vague' },
  { text: 'still waiting', expectedRoute: 'skip', reason: 'vague nudge' },
  { text: 'so?', expectedRoute: 'skip', reason: 'vague' },
  { text: 'anyone there', expectedRoute: 'skip', reason: 'vague' },
  { text: 'hm', expectedRoute: 'skip', reason: 'vague' },
  { text: 'thoughts?', expectedRoute: 'skip', reason: 'vague' },

  // ─── 5 noise / spam-ish → skip ─────────────────────────────────────────────
  { text: 'Forwarded: 10 things every CTO should know in 2026', expectedRoute: 'skip', reason: 'forwarded news' },
  { text: 'Check out our new newsletter, sign up here for updates!', expectedRoute: 'skip', reason: 'marketing' },
  { text: 'Off-topic: anyone tried the new sushi place downtown?', expectedRoute: 'skip', reason: 'off-topic' },
  { text: 'Webinar invite: AI in finance — register now', expectedRoute: 'skip', reason: 'marketing' },
  { text: 'Job opening at our company, share with your network', expectedRoute: 'skip', reason: 'spam-ish' },
];
