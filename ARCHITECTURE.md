# Argos — Architecture

> **Omniscient. Privacy-first. Human-approved.**

Argos est un assistant IA pour les opérations fintech/crypto.
Il observe tous les canaux de communication, extrait le signal actionnable, et propose des actions — mais **n'agit jamais de manière autonome**.

---

## Table des matières

1. [Principes de design](#1-principes-de-design)
2. [Vue d'ensemble](#2-vue-densemble)
3. [Canal : Listener vs Personal](#3-canal--listener-vs-personal)
4. [Couche Channels](#4-couche-channels)
5. [Couche Privacy (transversale)](#5-couche-privacy-transversale)
6. [Couche Knowledge](#6-couche-knowledge)
7. [Couche Core](#7-couche-core)
8. [Couche Plugins](#8-couche-plugins)
9. [Approval Gateway & Workers](#9-approval-gateway--workers)
10. [Config système](#10-config-système)
11. [v1 — Solo worker](#11-v1--solo-worker)
12. [v2 — Entreprise](#12-v2--entreprise)
13. [Considérations multi-tenant](#13-considérations-multi-tenant)
14. [Modèle de sécurité](#14-modèle-de-sécurité)
15. [Structure des fichiers](#15-structure-des-fichiers)

---

## 1. Principes de design

| Principe | Signification |
|----------|---------------|
| **Read by default** | Observe tout, ne stocke rien sans anonymisation |
| **Sanitize before memory** | Le contenu brut ne touche jamais Claude, ne persiste jamais |
| **Approve before execute** | Chaque action a un checkpoint humain avec expiry |
| **Local first** | Données, index, modèles restent sur la machine par défaut |
| **Privacy by routing** | Chaque étape du pipeline choisit indépendamment local vs cloud |
| **One instance, N channels** | Un seul process Argos, autant d'adapters que nécessaire |
| **Distributable** | Argos = package npm. Config uniquement. Zéro code à écrire |

---

## 2. Vue d'ensemble

```
┌──────────────────────────────────────────────────────────────────┐
│                     CHANNELS (adapters)                          │
│                                                                  │
│  ┌─────────────────────────┐   ┌────────────────────────────┐   │
│  │      LISTENER           │   │        PERSONAL            │   │
│  │  (sources non fiables)  │   │    (owner-only, trusted)   │   │
│  │                         │   │                            │   │
│  │  Telegram MTProto (v1)  │   │  Telegram Bot              │   │
│  │  Telegram Bot     (v2)  │   │  Discord Bot               │   │
│  │  Slack Bot              │   │  Slack DM                  │   │
│  │  Discord Bot            │   │  ...                       │   │
│  │  Gmail IMAP             │   │                            │   │
│  └───────────┬─────────────┘   └───────────┬────────────────┘   │
└──────────────┼──────────────────────────────┼────────────────────┘
               │ RawMessage                   │ OwnerCommand
               ▼                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                          CORE                                    │
│                                                                  │
│   Sanitize → Anonymize → Triage → ContextWindow                  │
│        → Classify → Plan → Approve → Execute                     │
│                                                                  │
│   Privacy layer (transversale) :                                 │
│     local LLM  → sanitize / classify / triage                    │
│     cloud LLM  → plan / approbation                             │
└──────────────────────────────────────────────────────────────────┘
               │                              │
               ▼                              ▼
┌─────────────────────┐          ┌────────────────────────────────┐
│     KNOWLEDGE       │          │           PLUGINS              │
│                     │          │         (optionnel)            │
│  Notion / GitHub    │          │                                │
│  Drive / Linear     │◀────────▶│  Workflows custom entreprise   │
│  Index LanceDB      │          │  Intégrations propriétaires    │
│  (local, jamais     │          │                                │
│   cloud)            │          │                                │
└─────────────────────┘          └────────────────────────────────┘
```

---

## 3. Canal : Listener vs Personal

C'est la séparation de sécurité fondamentale d'Argos.

### Listener — sources non fiables

Le listener écoute les conversations partenaires. Il ingère des messages de sources **non fiables**. Il ne répond jamais, ne prend aucune commande, n'exécute rien.

**Modes selon la version :**

| Version | Mode listener | Description |
|---------|--------------|-------------|
| v1 solo | MTProto user token | Ton propre compte Telegram — accès complet à tes conversations |
| v2 entreprise | Company bot token | Bot invité dans les channels partenaires par l'entreprise |

**Surface d'attaque injection : zéro.** Tout ce qui entre passe par `sanitize → anonymize → pipeline`. Le listener ne peut jamais déclencher une action.

### Personal — owner-only, trusted

Le personal bot est celui avec lequel **le owner parle directement, et uniquement lui**. C'est le canal de confiance.

- Reçoit les notifications, proposals, alerts du pipeline
- Accepte les commandes (`/approve`, `/todos`, `/done`, `/status`)
- Permet de dialoguer avec Argos
- Source 100% fiable → sanitization minimale

**Toujours un bot** (token bot dédié, `allowedUsers` configuré).

### La coupure de confiance

```
Partenaire crafts injection parfaite
    │
    ▼ Listener ingère (RawMessage)
    │
    ▼ sanitize (fail-closed)
    │
    ▼ anonymize (PII/addresses → placeholders)
    │
    ▼ pipeline (triage → classify → plan)
    │
    ▼ Proposal créée (texte anonymisé)
    │
    ▼ Personal bot notifie le owner
    │
    ▼ Owner approuve manuellement

→ L'injection n'a jamais atteint le personal bot directement.
→ Elle n'a jamais déclenché d'action automatique.
→ La chaîne de confiance est coupée par le pipeline.
```

### Config

```json
{
  "channels": {
    "telegram": {
      "listener": {
        "mode": "mtproto",
        "monitoredChats": [...]
      },
      "personal": {
        "botToken": "xoxb-...",
        "allowedUsers": ["123456789"]
      }
    },
    "slack": {
      "listener": {
        "botToken": "xoxb-...",
        "enabled": true
      },
      "personal": {
        "botToken": "xoxb-...",
        "allowedUsers": ["U012AB3CD"]
      }
    }
  }
}
```

---

## 4. Couche Channels

**Location :** `src/channels/`

Chaque adapter implémente l'interface `Channel` et s'enregistre via `channelRegistry`.

```typescript
interface Channel {
  name:    string;
  role:    'listener' | 'personal';
  start(config: Config, onMessage: (msg: RawMessage) => void): Promise<void>;
  stop():  Promise<void>;
  send?(chatId: string, text: string): Promise<void>;
}
```

**Adapters built-in :**

| Channel | Listener mode | Personal mode |
|---------|--------------|---------------|
| Telegram | MTProto (user token) ou Bot | Bot (owner-only) |
| Slack | Bot (workspace) | Bot DM (owner-only) |
| Discord | Bot (server) | Bot DM (owner-only) |
| WhatsApp | Baileys (user token) | — |
| Gmail | IMAP OAuth | — |

**Output :** `RawMessage` — contenu non modifié + métadonnées. Jamais persisté, vit uniquement en mémoire.

Chaque adapter est responsable de remplir **tous** les champs standard. C'est ce qui permet au core d'être channel-agnostic.

```typescript
interface RawMessage {
  id:           string;   // ULID — généré par l'adapter

  // ── Channel identity ───────────────────────────────────────────────
  channel:      string;   // 'telegram' | 'slack' | 'discord' | 'gmail' | ...
  source:       string;   // @deprecated — alias de channel pour compat

  // ── Chat ───────────────────────────────────────────────────────────
  chatId:       string;   // ID natif de la conv (ex: "-1001234567890")
  chatName?:    string;   // nom human (ex: "Ops Team") — depuis config ou résolu par l'adapter
  chatType?:    'dm' | 'group' | 'channel' | 'thread';

  // ── Sender ─────────────────────────────────────────────────────────
  senderId?:    string;   // ID natif de l'expéditeur
  senderName?:  string;   // nom affiché
  partnerName?: string;   // résolu depuis monitoredChats config

  // ── Content ────────────────────────────────────────────────────────
  content:      string;   // texte brut — NE JAMAIS logger/stocker/envoyer au LLM sans anonymisation
  anonText?:    string;   // set par la privacy layer après anonymisation — safe

  // ── Links & media ──────────────────────────────────────────────────
  messageUrl?:  string;   // permalink web (ex: "https://t.me/c/123456/42")
  links:        string[]; // URLs extraites du contenu
  isForward?:   boolean;
  forwardFrom?: string;
  mediaType?:   'photo' | 'video' | 'document' | 'audio' | 'sticker' | 'voice';

  // ── Threading ──────────────────────────────────────────────────────
  replyToId?:   string;
  threadId?:    string;

  // ── Timestamps ─────────────────────────────────────────────────────
  receivedAt:   number;   // unix ms — quand Argos a reçu le message
  timestamp?:   number;   // unix ms — timestamp original du channel (peut différer)

  // ── Channel-specific extras ────────────────────────────────────────
  meta?:        Record<string, unknown>; // extras adapter-specific (ex: telegram_message_id)
}
```

**Règle pour les adapters :** remplir `channel`, `chatId`, `chatName`, `chatType`, `senderName`, `partnerName`, `messageUrl` et `timestamp` à chaque message. Le core ne devine rien.

**Exemple — adapter Telegram (groupe partenaire) :**

```typescript
const msg: RawMessage = {
  id:          ulid(),
  channel:     'telegram',
  source:      'telegram',
  chatId:      String(chat.id),
  chatName:    monitoredChat?.name ?? chat.title,
  chatType:    chat.isGroup ? 'group' : chat.isBroadcast ? 'channel' : 'dm',
  senderId:    String(sender.id),
  senderName:  sender.firstName + ' ' + (sender.lastName ?? ''),
  partnerName: monitoredChat?.name,
  content:     message.text ?? '',
  messageUrl:  `https://t.me/c/${Math.abs(chat.id)}/${message.id}`,
  links:       extractLinks(message.text ?? ''),
  receivedAt:  Date.now(),
  timestamp:   message.date * 1000,
  meta: { telegram_message_id: message.id, telegram_chat_id: chat.id },
};
```

**Plugin exemple** : `src/plugins/examples/raw-forwarder.ts` — montre le pattern complet pour un adapter custom (webhook, fichier, bridge).

---

## 5. Couche Privacy (transversale)

La privacy n'est pas un plugin. C'est une **promesse fondamentale du core**.

Chaque étape du pipeline est assignée à un rôle LLM. Le rôle détermine si le contenu part en cloud ou reste local.

### Config

```json
{
  "privacy": {
    "provider": "ollama/llama3",
    "roles": {
      "sanitize":  "primary",   // sécurité critique → cloud (fail-closed)
      "classify":  "privacy",   // contenu partenaire → local
      "triage":    "privacy",   // idem, local
      "plan":      "primary"    // raisonnement complexe → cloud (contenu anonymisé)
    }
  }
}
```

### Routing par rôle

```
RawMessage (contenu brut)
    │
    ▼ sanitize   → [primary|privacy] LLM — contenu brut, fail-closed
    │
    ▼ anonymize  → regex local (jamais LLM)
    │
    ▼ triage     → [privacy] LLM par défaut — contenu brut, local only
    │
    ▼ classify   → [privacy] LLM par défaut — contenu anonymisé
    │
    ▼ plan       → [primary] LLM — contenu anonymisé uniquement
```

### Classification des données

| Classe | Description | Destinations autorisées |
|--------|-------------|------------------------|
| **Raw** | Message partenaire non modifié | Mémoire uniquement (jamais persisté, jamais loggé) |
| **Sanitized** | Injection-checked, contient encore des vraies données | Mémoire uniquement |
| **Anonymized** | PII/adresses remplacés par des placeholders | LLM, DB, logs |
| **Metadata** | IDs, timestamps, chat IDs | DB, logs |

### Invariant critique

`msg.content` = brut, ne quitte jamais la privacy layer.
`msg.anonText` = safe, peut aller au LLM et en DB.

---

## 6. Couche Knowledge

**Location :** `src/knowledge/`

La knowledge layer donne à Argos un accès structuré aux **documents internes de l'entreprise**. C'est la mémoire long-terme de ce que fait l'entreprise — séparée de la mémoire opérationnelle des conversations partenaires.

### Config

```json
{
  "knowledge": {
    "sources": [
      { "type": "notion",       "name": "Company Wiki",    "scope": "read" },
      { "type": "github",       "name": "Smart contracts", "paths": ["README.md"] },
      { "type": "google-drive", "name": "Legal docs",      "scope": "read" },
      { "type": "linear",       "name": "Engineering",     "scope": "read" }
    ],
    "indexLocally": true,
    "refreshHours": 6
  }
}
```

### Privacy model

| `indexLocally` | Embeddings | Contenu |
|----------------|-----------|---------|
| `true` (défaut) | Ollama nomic-embed-text — local | Ne part jamais dans le cloud |
| `false` | OpenAI/Anthropic (opt-in explicite) | User assume la responsabilité |

### Pipeline knowledge

```
Source externe (Notion / GitHub / Drive / Linear)
    │
    ▼ Connector → texte brut du document
    │
    ▼ Chunker → chunks ~500 tokens avec métadonnées
    │
    ▼ Embedder → modèle local (nomic-embed-text via Ollama)
    │
    ▼ LanceDB → index vectoriel stocké dans ~/.argos/knowledge/
    │
    ▼ (au moment de la requête)
    Semantic search → top-K chunks → injectés dans le contexte du planner
```

### Ce qui a accès au knowledge dans le core

- **Planner** — pour répondre à "est-ce que ce contrat est déjà signé ?"
- **Triage** — pour cross-checker une demande whitelist contre les adresses connues
- **Heartbeat** — pour faire un digest "voici ce qui a changé dans la doc"

### Generic fields dans les chunks

Le vector store est agnostique à l'architecture channel. Les `VectorChunk` ont 4 champs génériques indexés (`field1`–`field4`) dont la sémantique est définie par l'adapter qui indexe — pas par le store.

```typescript
interface VectorChunk {
  id:         string;
  sourceRef:  string;   // e.g. "telegram:channel_id:msg_id"
  sourceName: string;
  content:    string;
  tags:       string[];
  createdAt:  number;
  // Generic indexed fields — semantics defined by the adapter
  field1?: string;
  field2?: string;
  field3?: string;
  field4?: string;
}
```

**Convention par adapter (documentée dans l'adapter, pas dans le store) :**

| Adapter | field1 | field2 | field3 | field4 |
|---------|--------|--------|--------|--------|
| Telegram | chatId | chatName | senderName | messageUrl |
| Email | senderEmail | subject | senderName | — |
| GitHub | owner/repo | filePath | — | — |
| Webhook custom | défini par l'app | défini par l'app | — | — |

**Indexer un message Telegram :**

```typescript
chunkText(anonText, sourceRef, chatName, tags, {
  field1: msg.chatId,      // "-1001234567890"
  field2: msg.chatName,    // "ACME Corp Ops"
  field3: msg.senderName,  // "Alice Dupont"
  field4: msg.messageUrl,  // "https://t.me/c/123/42"
});
```

**Recherche filtrée :**

```typescript
// Tous les messages du channel "-1001234567890"
await semanticSearch('deposit limits', config, { field1: '-1001234567890' });

// Messages d'un webhook custom où field1 = userId
await semanticSearch('access request', config, { field1: 'user_42' });
```

### Structure

```
src/knowledge/
  types.ts              ← KnowledgeDocument, KnowledgeConnector interfaces
  index.ts              ← loadKnowledge(), refreshStaleKnowledge()
  indexer.ts            ← SQLite upsert + LanceDB vector indexing
  connectors/
    notion.ts
    github.ts
    google-drive.ts
    linear.ts
    url.ts
```

---

## 7. Couche Core

**Location :** `src/core/`

Le core traite les messages de bout en bout. Triage et heartbeat font partie du core — ils sont **channel-agnostic** (un message de Slack ou Telegram passe par le même triage).

```
src/core/
  pipeline.ts    ← ingestMessage() + processWindow()
  triage.ts      ← smart inbox routing (regex pre-screen → LLM → sink)
  heartbeat.ts   ← proactivité générique (schedule → état → proposal)
  privacy.ts     ← routing local/cloud par rôle
```

### Pipeline complet

```
channels (listener)
    │ RawMessage
    ▼
┌─────────────────────────────────────────────────────────────┐
│ ingestMessage()                                             │
│                                                             │
│  1. Persist metadata (hash, no content)                     │
│  2. Sanitize  → [primary|privacy] LLM — fail-closed         │
│  3. Anonymize → regex local                                 │
│  4. Triage    → [privacy] LLM — non-blocking, en parallèle │
│  5. Context window → batch (1-5 msgs, 30s timer)           │
└─────────────────────────────────────────────────────────────┘
    │ (quand window se ferme)
    ▼
┌─────────────────────────────────────────────────────────────┐
│ processWindow()                                             │
│                                                             │
│  1. Classify → [privacy] LLM (contenu anonymisé)           │
│  2. Store memory (FTS5, TTL 7j)                            │
│  3. Knowledge retrieval (semantic search)                   │
│  4. Plan → [primary] LLM + tool use (contenu anonymisé)    │
│  5. Auto-execute owner workspace actions                    │
│  6. Send remaining → Approval Gateway                       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Approval Gateway → Personal bot notifie le owner
    │ (human approves)
    ▼
Workers → exécution
```

### Triage (core/triage.ts)

Le triage tourne sur chaque `RawMessage` **avant** la context window. Il est non-bloquant.

```
RawMessage
    │
    ▼ Pre-screen regex (zéro LLM cost)
    │  - @me mentionné ?      → my_task / my_reply
    │  - @team mentionné ?    → team_task
    │  - whitelist keywords ? → tx_whitelist
    │  - rien                 → skip (100+ channels à l'échelle)
    │
    ▼ (si match) LLM extraction → [privacy] local
    │  route / title / body / urgency
    │
    ▼ Sink
       my_task / team_task → SQLite + Notion
       my_reply            → proposal draft
       tx_whitelist        → tx review pack
       skip                → nothing
```

### Heartbeat (core/heartbeat.ts)

Proactivité générique. S'exécute sur un schedule, sans message entrant.

```
Cron tick (every N minutes)
    │
    ▼ Snapshot état (open tasks, pending approvals, recent memories)
    │
    ▼ Plan → [primary] LLM (contenu anonymisé)
    │
    ▼ Si actions détectées → Proposal → Approval Gateway
    │
    ▼ Sinon → log "nothing to do" + audit
```

---

## 8. Couche Plugins

**Location :** `src/plugins/`

Le core est **complet sans aucun plugin**. Les plugins sont optionnels et vides par défaut.

Ils existent pour :
- Intégrations propriétaires d'une entreprise spécifique
- Workflows custom qui ne font pas partie du core
- Cas d'usage très verticaux (ex : intégration avec un système interne)

```typescript
interface ArgosPlugin {
  readonly name:         string;
  readonly description?: string;
  onBoot?(ctx: PluginContext): Promise<void>;
  onMessage?(msg: RawMessage, ctx: PluginContext): Promise<void>;
  onShutdown?(): Promise<void>;
}
```

**Ce qui N'EST PAS un plugin :**
- Triage → core
- Heartbeat → core
- Privacy → core
- Commandes du personal bot (`/approve`, `/todos`) → channel adapter

---

## 9. Approval Gateway & Workers

### Gateway

Chaque action proposée doit être approuvée par le owner avant exécution. Pas d'exception pour les actions externes.

```
Proposal créée
    │
    ▼ Risk classification
    │  standard  → 30min expiry, notification personal bot
    │  critical  → 10min expiry, assertion YubiKey requise
    │
    ▼ Personal bot notifie le owner
    │
    ▼ Owner approuve dans le web app (localhost:3000)
    │  approve → Workers exécutent
    │  reject  → archivé
    │  expire  → archivé
```

**Auto-execution exceptions** (workspace owner, zéro risque) :
- Écriture Notion workspace owner
- `create_task` en local
- `set_reminder` local

### Workers

| Worker | Écrit dans |
|--------|-----------|
| `calendar` | Google Calendar |
| `notion` | Notion workspace |
| `tx-prep` | Transaction review packs (local) |
| `reply` | Telegram/Slack/Discord (via personal bot) |
| `linear` | Linear issues _(planned)_ |
| `fordefi` | Fordefi whitelist + TX _(planned)_ |

---

## 10. Config système

Fichier unique `~/.argos/config.json` (chmod 600), validé par Zod.

```json
{
  "channels": {
    "telegram": {
      "listener": {
        "mode": "mtproto",
        "monitoredChats": [],
        "ignoredChats": []
      },
      "personal": {
        "botToken": "...",
        "allowedUsers": [],
        "approvalChatId": "me"
      }
    }
  },

  "privacy": {
    "provider": "ollama/llama3",
    "roles": {
      "sanitize":  "primary",
      "classify":  "privacy",
      "triage":    "privacy",
      "plan":      "primary"
    }
  },

  "triage": {
    "enabled":         true,
    "myHandles":       ["@emeric"],
    "watchedTeams":    [],
    "whitelistKeywords": ["whitelist", "add address"]
  },

  "heartbeat": {
    "enabled":         true,
    "intervalMinutes": 60,
    "prompt":          ""
  },

  "knowledge": {
    "sources": [],
    "indexLocally": true,
    "refreshHours": 6
  },

  "llm": {
    "activeProvider": "anthropic",
    "activeModel":    "claude-opus-4-6",
    "providers": {
      "anthropic": { "api": "anthropic", "models": ["claude-opus-4-6"] },
      "local":     { "api": "openai", "baseUrl": "http://localhost:11434" }
    }
  },

  "owner":    { "name": "Emeric", "telegramUserId": 123456789 },
  "readOnly": true,
  "dataDir":  "~/.argos"
}
```

---

## 11. v1 — Solo worker

Un seul utilisateur, une seule entreprise. Setup typique :

```
Machine locale (macOS / Linux)
  ~/.argos/config.json        ← secrets, channels, knowledge sources
  ~/.argos/argos.db           ← SQLite — données opérationnelles
  ~/.argos/knowledge/         ← LanceDB vector indexes
  ~/.argos/sessions/          ← sessions Telegram, etc.

Listener  : Telegram MTProto (user token — ton propre compte)
Personal  : Telegram Bot (owner-only, notifications + commandes)
Knowledge : Notion perso + GitHub perso
LLM cloud : Anthropic Claude
LLM local : Ollama (optionnel — privacy agent)
```

---

## 12. v2 — Entreprise

Plusieurs employés, une instance Argos partagée.

### Différences clés avec v1

| Aspect | v1 (solo) | v2 (enterprise) |
|--------|-----------|-----------------|
| Listener Telegram | MTProto user token | Company bot (invité dans les channels partenaires) |
| Personal bot | Bot owner-only | Bot par user (ou DM dans le bot company) |
| Knowledge | Workspace perso | Shared company layer + personal layer par user |
| Base de données | SQLite unique | Shared DB + per-user workspace DB |
| Auth | WebAuthn owner seul | SSO/SAML + WebAuthn par user |
| Config | `~/.argos/` perso | Centralisé + override per-user |

### Knowledge layers v2

```
~/.argos/
  shared/
    knowledge.db           ← index company (Notion, GitHub org, Linear)
    knowledge/             ← LanceDB shared
    config.json            ← config company-level
  users/
    emeric/
      workspace.db         ← tasks, memories, proposals perso
      knowledge/           ← LanceDB perso
      config.json          ← overrides perso
    alice/
      workspace.db
      knowledge/
      config.json
```

### Routing des messages en v2

```
[Partenaire écrit dans un channel → Company bot listener]
    │
    ▼ Message attribué à un user (par mention ou channel ownership)
    │
    ▼ Routé vers le workspace pipeline du user concerné
    │
    ├─ Privacy layer (shared)
    ├─ Knowledge layer (shared + personal)
    └─ Core pipeline (personal workspace)
```

---

## 13. Considérations multi-tenant

À anticiper dans l'archi v1 pour éviter un full rewrite en v2 :

### 1. DB isolation

`getDb(userId?)` — en v1 `userId` est toujours null. En v2, route vers la DB per-user.

### 2. Knowledge namespacing

Tables LanceDB préfixées dès v1 :
- `knowledge_shared_*` — company level
- `knowledge_user_{userId}_*` — personal

En v1, seulement `knowledge_user_default_*`.

### 3. Config layering

`merge(companyConfig, userConfig)` — en v1, une seule config. En v2, merge des deux.

### 4. Notification routing

`notify(text)` dans le PluginContext doit router vers le bon canal personal du user. En v1, toujours vers Saved Messages.

### 5. Channel attribution

En v2, chaque RawMessage reçu par le company bot doit être attribué à un user avant d'entrer dans le pipeline.

---

## 14. Modèle de sécurité

### Surface d'attaque

| Vecteur | Mitigation |
|---------|-----------|
| Prompt injection via messages partenaires | Listener read-only + sanitizer fail-closed |
| Coupure listener/personal | Pipeline entre les deux — injection ne peut jamais atteindre le personal bot directement |
| SSRF via `fetch_url` / `api_call` | Block cloud metadata, RFC-1918, loopback, link-local |
| LanceDB SQL injection | Strip `'`, `"`, `\`, `%` des tag values |
| Session hijacking | HttpOnly, SameSite=Strict, Secure cookies |
| Session volée bypass approval critique | Assertion FIDO2 fraîche liée au proposal ID |
| API key theft | `~/.argos/config.json` doit être chmod 600 |
| Race condition approval | `UPDATE WHERE status = 'proposed'` atomique |
| Key cloning (YubiKey) | Counter check à chaque assertion |
| Replay (challenge reuse) | Challenges single-use, marqués `used = 1` immédiatement |

### Non-négociables

1. Prepared statements uniquement — jamais de concat SQL avec user input
2. Contenu brut jamais envoyé au LLM sans anonymisation
3. Contenu brut jamais persisté — uniquement hashes et résumés anonymisés
4. Chaque action critique dans `audit_log` — immuable, append-only
5. `readOnly: true` par défaut — les écritures nécessitent un opt-in explicite
6. **Le listener ne répond jamais** — zéro surface d'exécution exposée aux sources non fiables

---

## 15. Structure des fichiers

```
argos/
├── ARCHITECTURE.md         ← ce fichier
├── CLAUDE.md               ← instructions pour les assistants IA
├── package.json
├── tsconfig.json
│
└── src/
    ├── index.ts            ← entry point: boot, channels, plugins, shutdown
    ├── types.ts            ← RawMessage, Proposal, Task, ...
    ├── logger.ts
    │
    ├── config/
    │   ├── schema.ts       ← Zod schema — source de vérité du config
    │   └── index.ts        ← loader: JSON + env merge + path resolution
    │
    ├── db/
    │   └── index.ts        ← SQLite init, migrations, getDb(), audit()
    │
    ├── channels/           ← adapters built-in (listener + personal)
    │   ├── registry.ts     ← registerChannel(), startAll(), stopAll()
    │   ├── telegram/
    │   │   ├── mtproto.ts  ← listener: user token (v1)
    │   │   └── bot.ts      ← listener (v2) ou personal (v1+v2)
    │   ├── slack/
    │   │   ├── listener.ts
    │   │   └── personal.ts
    │   ├── discord/
    │   ├── whatsapp/
    │   └── gmail/
    │
    ├── core/
    │   ├── pipeline.ts     ← ingestMessage() + processWindow()
    │   ├── triage.ts       ← smart inbox routing — channel-agnostic
    │   ├── heartbeat.ts    ← proactivité générique
    │   └── privacy.ts      ← routing local/cloud par rôle
    │
    ├── knowledge/
    │   ├── types.ts        ← KnowledgeDocument, KnowledgeConnector
    │   ├── index.ts        ← loadKnowledge(), refreshStaleKnowledge()
    │   ├── indexer.ts      ← SQLite upsert + LanceDB vector indexing
    │   └── connectors/
    │       ├── notion.ts
    │       ├── github.ts
    │       ├── google-drive.ts
    │       ├── linear.ts
    │       └── url.ts
    │
    ├── privacy/
    │   ├── sanitizer.ts    ← injection detection, fail-closed
    │   ├── anonymizer.ts   ← regex PII/crypto redaction, lookup table
    │   └── llm-anonymizer.ts ← second pass local LLM
    │
    ├── llm/
    │   ├── index.ts        ← multi-provider: llmCall(), withRetry()
    │   ├── tool-loop.ts    ← streaming tool use loop
    │   ├── builtin-tools.ts ← fetch_url, api_call (avec guards SSRF)
    │   └── compaction.ts
    │
    ├── memory/
    │   └── store.ts        ← FTS5, TTL, auto-archive
    │
    ├── vector/
    │   └── store.ts        ← LanceDB wrapper, tag-safe filter builder
    │
    ├── planner/
    │   └── index.ts        ← proposal generation avec tool use
    │
    ├── gateway/
    │   └── approval.ts     ← risk classification, expiry, notification
    │
    ├── workers/
    │   ├── index.ts        ← dispatcher, read-only enforcement
    │   ├── calendar.ts
    │   ├── notion.ts
    │   ├── tx-prep.ts
    │   └── proposal-executor.ts
    │
    ├── scheduler/
    │   └── index.ts        ← cron jobs, registerHandler(), upsertCronJob()
    │
    ├── skills/
    │   ├── registry.ts
    │   └── builtins/       ← memory-search, notion-search, web-search, ...
    │
    ├── mcp/
    │   ├── index.ts
    │   └── client.ts
    │
    ├── webapp/
    │   ├── server.ts       ← Express 5, API routes, WebSocket
    │   ├── webauthn.ts     ← FIDO2/YubiKey
    │   └── totp.ts
    │
    ├── auth/
    │   └── anthropic-oauth.ts
    │
    ├── plugins/            ← optionnel, vide par défaut
    │   ├── registry.ts     ← ArgosPlugin interface + PluginRegistry
    │   ├── README.md       ← guide authoring plugins
    │   └── examples/
    │       └── raw-forwarder.ts  ← démo pattern RawMessage complet + adapter custom
    │
    └── scripts/
        ├── setup.ts
        ├── doctor.ts
        └── anon-test.ts
```
