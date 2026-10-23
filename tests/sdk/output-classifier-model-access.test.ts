import { describe, it, expect } from 'bun:test';
import {
  isAuthFailureObserverOutput,
  isModelAccessDeniedObserverOutput,
  isOrgDisabledSubscriptionObserverOutput,
} from '../../src/sdk/output-classifier.js';

// A gateway that refuses the observer's model answers 403, which the auth
// detector books as "signed out, run /login". Logging in again cannot fix
// it: the model has to change. So it is told apart, like the org-policy
// refusal (#4677). The text is what Claude Code printed for a LiteLLM-style
// gateway on 2026-10-23, verbatim.
const TEAM_MODEL_REFUSAL = 'Failed to authenticate. API Error: 403 {"error":{"message":"team not allowed to access model. '
  + 'This team can only access models=[\'claude-haiku-4-5-20251001\', \'claude-sonnet-5-5\']. Tried to access claude-sonnet-4-6",'
  + '"type":"team_model_access_denied","param":"model","code":"401"}}';

describe('isModelAccessDeniedObserverOutput', () => {
  it('matches a gateway refusing the model, which the auth detector also catches', () => {
    expect(isAuthFailureObserverOutput(TEAM_MODEL_REFUSAL)).toBe(true);
    expect(isModelAccessDeniedObserverOutput(TEAM_MODEL_REFUSAL)).toBe(true);
  });

  it('matches Anthropic-style model access wording', () => {
    expect(isModelAccessDeniedObserverOutput('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your organization does not have access to model claude-x"}}')).toBe(true);
    expect(isModelAccessDeniedObserverOutput('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-6"}}')).toBe(true);
  });

  it('does not match a signed-out observer or the org-policy notice', () => {
    expect(isModelAccessDeniedObserverOutput('Not logged in · Please run /login')).toBe(false);
    expect(isModelAccessDeniedObserverOutput('Failed to authenticate. API Error: 401 {"error":{"message":"invalid x-api-key"}}')).toBe(false);
    const orgPolicy = 'Your organization has disabled Claude subscription access for Claude Code';
    expect(isOrgDisabledSubscriptionObserverOutput(orgPolicy)).toBe(true);
    expect(isModelAccessDeniedObserverOutput(orgPolicy)).toBe(false);
  });

  it('does not match an observation that only talks about model access', () => {
    expect(isModelAccessDeniedObserverOutput('<observation><title>Team not allowed to access model fixed</title></observation>')).toBe(false);
    expect(isModelAccessDeniedObserverOutput('')).toBe(false);
    expect(isModelAccessDeniedObserverOutput(undefined)).toBe(false);
  });
});
