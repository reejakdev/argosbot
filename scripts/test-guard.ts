import { guardMessage } from '../src/privacy/chat-guard.js';

const tests = [
  'sk-ant-api03-FAKEKEYFAKEKEY123456789',
  'voici ma clé 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890 merci',
  'mon wallet est 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
  'envoie 50000 USDC à cette adresse',
  'salut comment ça va',
];

for (const t of tests) {
  console.log(`\n--- Input: "${t.slice(0, 50)}…"`);
  const r = guardMessage(t);
  console.log('  redacted:', r.redacted, r.redactedItems);
  console.log('  confirm:', r.needsConfirmation, r.warnings);
  console.log('  output:', r.sanitized.slice(0, 80));
}
