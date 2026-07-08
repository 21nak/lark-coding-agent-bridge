import type { CardActionEvent } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const cleanups: Array<() => Promise<void>> = [];

describe('recharge.resume card command', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('resumes the payload Claude session and passes form_value to the prompt', async () => {
    const h = await createHarness({
      events: [
        { type: 'system', sessionId: SESSION_ID, cwd: undefined },
        { type: 'text', delta: 'done' },
        { type: 'done', sessionId: SESSION_ID, terminationReason: 'normal' },
      ],
    });
    h.channel.rawMessages.set('om_card', [
      {
        body: {
          content: JSON.stringify(originalRechargeCard()),
        },
      },
    ]);

    await h.dispatch(rechargePayload(h.tmp.workspace), { note: 'confirmed' });
    await tick();

    expect(markdowns(h.channel)).toHaveLength(0);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]).toMatchObject({
      sessionId: SESSION_ID,
      cwd: h.workspaceRealpath,
    });
    expect(h.agent.runOptions[0]?.prompt).toContain('[recharge-card-click]');
    expect(h.agent.runOptions[0]?.prompt).toContain('draftId: draft-1');
    expect(h.agent.runOptions[0]?.prompt).toContain('action: confirm');
    expect(h.agent.runOptions[0]?.prompt).toContain('operatorOpenId: ou_operator');
    expect(h.agent.runOptions[0]?.prompt).toContain('cardMessageId: om_card');
    expect(h.agent.runOptions[0]?.prompt).toContain('cardUpdateToken: c-recharge-token');
    expect(h.agent.runOptions[0]?.prompt).toContain(
      'cardUpdateApi: /open-apis/interactive/v1/card/update',
    );
    expect(h.agent.runOptions[0]?.prompt).toContain('form_value: {"note":"confirmed"}');
    expect(h.sessions.resumeFor('oc_group', h.workspaceRealpath)).toBe(SESSION_ID);
    expect(h.channel.streams).toHaveLength(0);
    const cardUpdate = h.channel.rawClient.requests.find(
      (request) =>
        request.method === 'POST' &&
        (request.params as { url?: unknown }).url === '/open-apis/interactive/v1/card/update',
    );
    const updatedCard = extractUpdatedCard(cardUpdate?.params);
    expect(updatedCard).toMatchObject({
      schema: '2.0',
      header: {
        template: 'yellow',
        title: { tag: 'plain_text', content: '腾讯云充值审批 · Agent 处理中' },
      },
    });
    expect(JSON.stringify(updatedCard)).toContain('原始样式保留');
    expect(JSON.stringify(updatedCard)).toContain('已收到确认，正在恢复原 Claude session 处理。');
    expect(JSON.stringify(updatedCard)).not.toContain('待确认');
    expect(JSON.stringify(updatedCard)).not.toContain('确认按钮区域');
  });

  it('rejects invalid session ids without starting a run', async () => {
    const h = await createHarness();

    await h.dispatch({ ...rechargePayload(h.tmp.workspace), sessionId: 'not-a-uuid' });

    expect(h.agent.runOptions).toHaveLength(0);
    expect(markdowns(h.channel).at(-1)).toContain('sessionId must be a UUID');
  });

  it('rejects operators outside owner/admin/confirmers', async () => {
    const h = await createHarness({ confirmers: [] });

    await h.dispatch(rechargePayload(h.tmp.workspace));

    expect(h.agent.runOptions).toHaveLength(0);
    expect(markdowns(h.channel).at(-1)).toBe('无权执行充值确认。');
  });

  it('does not interrupt an active run in the same scope', async () => {
    const h = await createHarness();
    const active = h.agent.run({ runId: 'run-active', prompt: 'active' });
    h.activeRuns.register('oc_group', active);

    await h.dispatch(rechargePayload(h.tmp.workspace));

    expect(h.agent.runOptions).toHaveLength(1);
    expect(markdowns(h.channel).at(-1)).toBe('当前会话已有任务运行中');
  });
});

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  workspaceRealpath: string;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  dispatch(value: Record<string, unknown>, formValue?: Record<string, unknown>): Promise<unknown>;
}

async function createHarness(opts: {
  confirmers?: string[];
  events?: FakeAgentEvents;
} = {}): Promise<Harness> {
  const tmp = await createTmpProfile('recharge-resume-test-');
  const workspaceRealpath = await realpath(tmp.workspace);
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const catalog = new SessionCatalog(`${tmp.profile}/session-catalog.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter({ id: 'claude', events: opts.events });
  const profileConfig = profile(opts.confirmers ?? ['ou_operator']);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const pending = new PendingQueue(60_000, () => {});
  const chatModeCache = {
    resolve: async () => 'group',
  } as unknown as ChatModeCache;
  const pool = new ProcessPool(() => 2);
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'run-recharge',
  });

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    workspaceRealpath,
    activeRuns,
    agent,
    controls,
    dispatch: (value, formValue) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: cardEvent(value, formValue),
        sessions,
        sessionCatalog: catalog,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        runExecutor: executor,
        processPool: pool,
      }),
  };
}

function profile(confirmers: string[]): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'], confirmers },
  });
}

function rechargePayload(cwd: string): Record<string, unknown> {
  return {
    cmd: 'recharge.resume',
    workflow: 'invoice',
    agent: 'claude',
    sessionId: SESSION_ID,
    draftId: 'draft-1',
    cwd,
    action: 'confirm',
    cardPatch: {
      header: {
        template: 'yellow',
        title: { tag: 'plain_text', content: '腾讯云充值审批 · Agent 处理中' },
      },
      replace: [
        {
          element_id: 'recharge_status',
          with: {
            tag: 'markdown',
            element_id: 'recharge_status',
            content: '**状态**：处理中\n已收到确认，正在恢复原 Claude session 处理。',
          },
        },
      ],
      remove: [{ element_id: 'recharge_action_area' }],
    },
  };
}

function originalRechargeCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { summary: { content: '腾讯云充值审批' } },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '腾讯云充值审批 · 待确认' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: 'style_marker',
          content: '原始样式保留',
        },
        {
          tag: 'markdown',
          element_id: 'recharge_status',
          content: '**状态**：待确认',
        },
        {
          tag: 'markdown',
          element_id: 'recharge_action_area',
          content: '确认按钮区域',
        },
      ],
    },
  };
}

function extractUpdatedCard(params: unknown): Record<string, unknown> | undefined {
  const card = (params as { data?: { card?: unknown } } | undefined)?.data?.card;
  return card && typeof card === 'object' && !Array.isArray(card)
    ? (card as Record<string, unknown>)
    : undefined;
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
    raw: {
      token: 'c-recharge-token',
      ...(formValue ? { action: { form_value: formValue } } : {}),
    },
  } as unknown as CardActionEvent;
}

function markdowns(channel: FakeChannel): string[] {
  return channel.sent
    .map((message) => (message.content as { markdown?: unknown }).markdown)
    .filter((markdown): markdown is string => typeof markdown === 'string');
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}
