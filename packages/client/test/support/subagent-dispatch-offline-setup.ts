import { vi } from 'vitest';

vi.mock('../../src/client/avatar.js', () => ({
  PERSONA_BOT_ACTIVITY_STATES: ['idle', 'thinking', 'working', 'waiting', 'blocked'],
}));
vi.mock('../../../core/src/bots/avatar-appearance.js', () => ({
  isAvatarAppearance: () => false,
  isRetainedAvatarAppearance: () => false,
}));
