/**
 * Privacy layer — transversale au core.
 *
 * Résout quel LLM utiliser pour chaque rôle du pipeline selon la config `privacy`.
 *   'privacy' → modèle local (Ollama/LM Studio) — contenu brut, zéro cloud egress
 *   'primary' → modèle cloud (Claude/OpenAI)    — contenu anonymisé uniquement
 *
 * Si `privacy.provider` n'est pas configuré, tous les rôles tombent sur le primary.
 */

import type { Config, PrivacyRole } from '../config/schema.js';
import type { LLMConfig } from '../llm/index.js';

export type PipelineRole = 'sanitize' | 'classify' | 'triage' | 'llmAnon' | 'plan';

/**
 * Retourne la LLMConfig à utiliser pour un rôle donné.
 *
 * @param role         - étape du pipeline
 * @param primaryLlm   - config du LLM primaire (cloud)
 * @param privacyLlm   - config du LLM privacy (local) — null si non configuré
 * @param config       - config Argos complète
 */
export function llmForRole(
  role: PipelineRole,
  primaryLlm:  LLMConfig,
  privacyLlm:  LLMConfig | null,
  config:      Config,
): LLMConfig {
  const assignedRole: PrivacyRole = config.privacy.roles[role] ?? 'primary';

  if (assignedRole === 'privacy' && privacyLlm !== null) {
    return privacyLlm;
  }

  return primaryLlm;
}

/**
 * Construit la LLMConfig pour le privacy provider à partir de la config.
 * Retourne null si `privacy.provider` n'est pas configuré.
 */
export function buildPrivacyLlmConfig(
  config: Config,
  opts?: { maxTokens?: number },
): LLMConfig | null {
  const privacyProvider = config.privacy.provider;
  if (!privacyProvider) return null;

  const provider = config.llm.providers[privacyProvider];
  if (!provider) {
    return null;
  }

  return {
    provider:   provider.api === 'anthropic' ? 'anthropic' : 'compatible',
    model:      config.privacy.model ?? provider.models[0] ?? 'llama3',
    apiKey:     provider.apiKey ?? '',
    baseUrl:    provider.baseUrl,
    maxTokens:  opts?.maxTokens ?? 2048,
  };
}
