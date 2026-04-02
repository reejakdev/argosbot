import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import { ChevronDown } from 'lucide-react'

const faqs = [
  {
    q: 'Does any of my data leave my machine?',
    a: 'Only anonymized data ever leaves your machine — and only to the LLM you explicitly configure. Raw messages, exact addresses, amounts, and PII are never sent anywhere. The anonymization step runs locally using a local model (Ollama or LM Studio). Cloud providers only receive content with placeholders like [PERSON_1], [ADDR_1], and [AMT_10K-100K_USDC]. The lookup table that maps placeholders back to real values lives exclusively in local memory.',
  },
  {
    q: 'Do I need to run a local model? Is Ollama required?',
    a: 'Ollama (or a compatible local model server like LM Studio) is required for the LLM anonymizer step — the one that strips your PII before any cloud model sees your data. If you skip the local model, the LLM anonymizer step is disabled. You can still use Argos with regex-only anonymization, but you\'ll get less comprehensive de-identification. For production use in fintech/crypto, running a local model for the anonymizer step is strongly recommended.',
  },
  {
    q: 'Will Argos ever send a message or take an action on its own?',
    a: 'No. Every action — whether it\'s a reply, a calendar event, a Notion page, or a transaction review pack — is presented as a proposal in your approval queue. Nothing executes until you explicitly approve it. The only exceptions are low-risk owner workspace operations (like creating a task in your own Notion workspace) which auto-execute without approval. All other actions are gated behind your WebAuthn dashboard with proposal expiry.',
  },
  {
    q: 'Which LLM providers are supported?',
    a: 'Argos supports 15+ providers via a unified multi-provider abstraction: Anthropic Claude, OpenAI GPT-4o, Groq (Llama/Mixtral), Google Gemini, DeepSeek, Mistral, xAI Grok, Together AI, Perplexity, Cohere, Ollama (local), LM Studio (local), and any OpenAI-compatible endpoint. You configure a primary provider, a local model for anonymization, and an optional fallback. The fallback activates automatically on 5xx errors, 429 rate limits, or timeouts.',
  },
  {
    q: 'Do I need Telegram? Can I use Argos without it?',
    a: 'Telegram is not required. Each channel is independently opt-in. You can run Argos with just email, just WhatsApp, or any combination. The pipeline works with however many channels you configure. If no channels are enabled, you can still use Argos\'s planning and approval features by manually injecting messages via the plugin API or the raw-forwarder example.',
  },
  {
    q: 'How does the approval dashboard work?',
    a: 'Argos runs a local web server (default: localhost:3000) secured by WebAuthn/FIDO2. You register your YubiKey, Apple Passkey, or Windows Hello device during setup. The dashboard shows pending proposals with full context: what will happen, which tool will execute it, and why the classifier flagged it. For high-risk proposals (transactions, external API calls), the approval requires a fresh cryptographic assertion bound to the specific proposal ID. TOTP is available as a backup authentication method.',
  },
  {
    q: 'Is Argos free? What does it cost to run?',
    a: 'Argos itself is MIT licensed and completely free. The running cost depends on your LLM provider. With a cloud provider like Claude or GPT-4o, costs are purely API usage — typically a few dollars per month for personal use. With a local model for everything, the cost is just electricity. You can mix: use a cost-efficient cloud model for classification and a local model for anonymization. The setup wizard helps you estimate costs based on your expected message volume.',
  },
  {
    q: 'Can I write my own plugins and integrations?',
    a: 'Yes. The plugin API is in TypeScript and ships with full lifecycle hooks: onBoot (called at startup), onMessage (called for every ingested message), and onShutdown. Plugins can register custom tools that the planner can use, inject synthetic messages into the pipeline, or add background cron jobs. There\'s a raw-forwarder example plugin in the repository that shows the full pattern. The knowledge base connector system follows the same registry pattern for adding new data sources.',
  },
  {
    q: 'What are the system requirements?',
    a: 'Argos requires Node.js 22 or later on macOS, Linux, or Windows (WSL). For local model support, you\'ll need Ollama or LM Studio installed. RAM requirements depend on your local model — a 7B parameter model typically needs 8GB RAM, a 13B model needs 16GB. The SQLite database and configuration live in ~/.argos/. For the vector store (LanceDB), plan for a few hundred MB per thousand indexed documents.',
  },
  {
    q: 'How is memory handled? What does Argos remember?',
    a: 'Argos stores anonymized summaries — never raw messages — in a SQLite database with FTS5 full-text search and LanceDB vector embeddings for semantic search. Memory has a configurable TTL (default 30 days). Memories with an importance score of 8 or above are automatically archived for 1 year instead of expiring. A daily cleanup cron job at 03:00 purges expired memories. You can browse, search, and delete memories at any time through the web dashboard.',
  },
]

function FAQItem({ item, index }: { item: typeof faqs[0]; index: number }) {
  const [open, setOpen] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.05 }}
      className="rounded-lg overflow-hidden"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      }}
    >
      <button
        className="w-full flex items-center justify-between px-6 py-4 text-left transition-colors group"
        style={{ borderRadius: 'inherit' }}
        onClick={() => setOpen(!open)}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#f9fafb'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
      >
        <div className="flex items-center gap-3 flex-1">
          <span className="font-mono text-xs text-text2/40 flex-shrink-0">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="font-medium text-text group-hover:text-text transition-colors">
            {item.q}
          </span>
        </div>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0 ml-4"
        >
          <ChevronDown size={16} style={{ color: 'rgba(79,110,255,0.5)' }} />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div
              className="px-6 pb-5 pt-0"
              style={{ borderTop: '1px solid #f3f4f6' }}
            >
              <p className="text-text2 text-sm leading-relaxed pt-4">{item.a}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default function FAQ() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="faq"
      className="py-24"
      style={{ borderTop: '1px solid #f3f4f6' }}
    >
      <div className="max-w-4xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14 text-center"
        >
          <div className="section-label mb-3 text-center">FAQ</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-text mb-4">
            Frequently asked{' '}
            <span className="gradient-text">questions</span>
          </h2>
          <p className="text-text2 max-w-xl mx-auto leading-relaxed">
            Everything you need to know before running Argos on your machine.
          </p>
        </motion.div>

        <div className="space-y-3">
          {faqs.map((item, i) => (
            <FAQItem key={item.q} item={item} index={i} />
          ))}
        </div>
      </div>
    </section>
  )
}
