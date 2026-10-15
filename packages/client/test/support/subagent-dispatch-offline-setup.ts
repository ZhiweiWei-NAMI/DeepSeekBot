import { vi } from 'vitest';

// Transport-only tests do not exercise avatars. Keep those unrelated UI imports
// out of this bounded offline run; no dispatch parser, store or transport is mocked.
vi.mock('../../src/client/avatar.js', () => ({
  PERSONA_BOT_ACTIVITY_STATES: ['idle', 'thinking', 'working', 'waiting', 'blocked'],
}));
vi.mock('../../../core/src/bots/avatar-appearance.js', () => ({
  isAvatarAppearance: () => false,
  isRetainedAvatarAppearance: () => false,
}));
