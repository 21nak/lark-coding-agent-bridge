import { describe, expect, it } from 'vitest';
import { buildLarkChannelEnv } from '../../../src/agent/lark-channel-env';

describe('buildLarkChannelEnv', () => {
  it('keeps profile mode bound to the bridge workspace', () => {
    expect(buildLarkChannelEnv({
      profile: 'codex',
      rootDir: '/tmp/bridge',
      larkCliConfigSource: 'profile',
      larkCliConfigDir: '/tmp/bridge/profiles/codex/lark-cli',
    })).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex',
      LARK_CHANNEL_HOME: '/tmp/bridge',
      LARKSUITE_CLI_CONFIG_DIR: '/tmp/bridge/profiles/codex/lark-cli',
    });
  });

  it('removes bridge workspace markers in local mode', () => {
    expect(buildLarkChannelEnv({
      profile: 'codex',
      rootDir: '/tmp/bridge',
      configPath: '/tmp/bridge/config.json',
      larkCliConfigSource: 'local',
      larkCliConfigDir: '/home/user/.lark-cli',
    })).toEqual({
      LARK_CHANNEL: undefined,
      LARK_CHANNEL_HOME: undefined,
      LARK_CHANNEL_PROFILE: undefined,
      LARK_CHANNEL_CONFIG: undefined,
      LARKSUITE_CLI_CONFIG_DIR: '/home/user/.lark-cli',
    });
  });
});
