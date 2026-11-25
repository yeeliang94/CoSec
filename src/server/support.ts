import { z } from 'zod';
import { assertCapability, DomainError } from '../domain/access';
import type { Actor, Settings } from '../domain/model';
import {
  getSettings,
  listDocuments,
  mutateSettings,
  pruneRequests,
  saveActorPreferences,
} from './repository';

const base = { expectedRevision: z.number().int().positive(), requestId: z.string().uuid() };
const settingsAction = z.object({
  ...base,
  action: z.literal('defaults'),
  firmName: z.string().trim().min(1).max(120),
  // Lodger details. The firm form leaves out empty fields, so a missing one clears the value.
  firmRegistrationNumber: z.string().trim().max(60).default(''),
  firmAddress: z.string().trim().max(1000).default(''),
  firmPhone: z.string().trim().max(60).default(''),
  firmEmail: z.union([z.literal(''), z.email().max(255)]).default(''),
});
export const preferencesSchema = z
  .object({
    textSize: z.enum(['default', 'large', 'larger']),
    density: z.enum(['comfortable', 'compact']),
    reducedMotion: z.boolean(),
  })
  .strict();
export async function getWorkspaceSupport(actor: Actor) {
  const [documents, settings] = await Promise.all([listDocuments(actor), getSettings()]);
  return {
    documents: documents.map(({ storageKey, ...metadata }) => {
      void storageKey;
      return metadata;
    }),
    settings,
  };
}

const count = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const importSettingsAction = z.object({
  ...base,
  action: z.literal('import'),
  // Empty switches bulk import off. Only https, except a local test gateway on this computer.
  gatewayUrl: z
    .string()
    .trim()
    .max(500)
    .default('')
    .refine(
      (v) =>
        !v || /^https:\/\/[^\s]+$/.test(v) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(v),
      'Enter the gateway address starting with https://.',
    ),
  model: z.string().trim().max(200).default(''),
  providerHeader: z.string().trim().max(100).default(''),
  companiesAtOnce: count(1, 20),
  maxTurns: count(5, 200),
  maxMinutes: count(5, 240),
  maxTokensPerCompany: count(10_000, 50_000_000),
  dailyTokenLimit: count(100_000, 1_000_000_000),
});
export async function applySettingsAction(actor: Actor, input: unknown) {
  assertCapability(actor, 'manage_catalogue');
  if ((input as { action?: string } | null)?.action === 'import') {
    const { expectedRevision, requestId, action, ...values } = importSettingsAction.parse(input);
    void action;
    if (values.gatewayUrl && !values.model)
      throw new DomainError('Enter the model name the gateway uses.');
    return mutateSettings(actor, expectedRevision, requestId, (settings: Settings) => ({
      ...settings,
      importSettings: values,
    }));
  }
  const action = settingsAction.parse(input);
  return mutateSettings(actor, action.expectedRevision, action.requestId, (settings: Settings) => ({
    ...settings,
    firmName: action.firmName,
    firmRegistrationNumber: action.firmRegistrationNumber,
    firmAddress: action.firmAddress,
    firmPhone: action.firmPhone,
    firmEmail: action.firmEmail,
  }));
}

export async function savePreferences(actor: Actor, input: unknown) {
  const preferences = preferencesSchema.parse(input);
  await saveActorPreferences(actor, preferences);
  return preferences;
}

const REQUEST_RETENTION_DAYS = 30;
/** Duplicate-submission records only need to outlive client retries; audit events are kept separately. */
export function pruneRequestRecords() {
  return pruneRequests(REQUEST_RETENTION_DAYS);
}
