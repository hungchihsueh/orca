// A send to a session whose provider child is gone, against the real host.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionRefusalOperationState } from '../../../shared/agent-session-refusal-retry'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { StructuredAgentSessionSendRecovery } from './structured-agent-session-send-recovery'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
// Long enough that no release fires mid-test; whether one is pending is asserted directly.
const GRACE_MS = 60_000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let hostErrors: unknown[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-send-recovery-'))
  resetHostTestOperationIds()
  hostErrors = []
  let generation = 0
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    acquisitionGeneration: `generation-${++generation}`,
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex' as const, threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    releaseGraceMs: GRACE_MS,
    now: () => NOW,
    onEventSinkError: ({ error }) => hostErrors.push(error)
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function sendParams(text: string, operationId = hostTestOperationId()) {
  const body = hostTestMessage(text)
  const envelope: AgentSessionMutationEnvelope = {
    sessionId: SESSION,
    clientOperationId: operationId,
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    })
  }
  return { envelope, body }
}

/** The child timed out or exited: its lease is handed back and the host holds no session. */
async function loseOwner(): Promise<void> {
  await host.close(SESSION)
  expect(store.getRecord(SESSION)?.lease).toMatchObject({
    claimStatus: 'released',
    ownerProcess: null
  })
  acquire.mockClear()
}

describe('a send with no live owner', () => {
  it('restarts the owner once and delivers against it', async () => {
    await loseOwner()

    const result = await host.send(CALLER, sendParams('after the child died'))

    expect(result).toMatchObject({ ok: true, replayed: false })
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('restarts the owner before the send is admitted, so the send runs once', async () => {
    await loseOwner()
    const order: string[] = []
    const recovery = new StructuredAgentSessionSendRecovery({
      getRecord: (sessionId) => store.getRecord(sessionId),
      resume: async () => {
        order.push('resume')
      }
    })

    await recovery.send(sendParams('ensure first'), async () => {
      order.push('run')
      return { ok: false, refusal: { code: 'agent_session_operation_invalid', message: 'stub' } }
    })

    expect(order).toEqual(['resume', 'run'])
  })

  it('leaves a live owner alone', async () => {
    acquire.mockClear()

    await expect(host.send(CALLER, sendParams('owner is live'))).resolves.toMatchObject({
      ok: true
    })

    expect(acquire).not.toHaveBeenCalled()
  })

  it('does not restart an owner for a send the session refuses anyway', async () => {
    await loseOwner()
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: 'session-after-clear',
        operationId: hostTestOperationId(),
        callerKey: CALLER.callerKey,
        phase: 'committed'
      }
    }))

    await host.send(CALLER, sendParams('into a cleared chat'))

    expect(acquire).not.toHaveBeenCalled()
  })

  it('renews the idle window on journal activity in an unheld session', async () => {
    await loseOwner()
    await expect(host.send(CALLER, sendParams('restart'))).resolves.toMatchObject({ ok: true })
    const arm = vi.spyOn(host['holds']['clock'], 'arm')

    await expect(host.send(CALLER, sendParams('more activity'))).resolves.toMatchObject({
      ok: true
    })

    expect(arm).toHaveBeenCalledWith(SESSION)
  })

  it('releases the restarted child on the usual clock only when no surface holds it', async () => {
    await loseOwner()
    await expect(host.send(CALLER, sendParams('nobody is watching'))).resolves.toMatchObject({
      ok: true
    })
    expect(host['holds'].isReleasePending(SESSION)).toBe(true)

    await host.close(SESSION)
    // A reading surface that does not itself restart the agent.
    await host.hold(SESSION, 'desktop-chat:1', { resume: false })
    await expect(host.send(CALLER, sendParams('the chat is open'))).resolves.toMatchObject({
      ok: true
    })
    expect(host['holds'].isReleasePending(SESSION)).toBe(false)
  })

  it('restarts an owner that exited while the session stayed readable', async () => {
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence,
      acquisitionGeneration: 'generation-1'
    })
    expect(host.hasSession(SESSION)).toBe(true)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    acquire.mockClear()

    await expect(host.send(CALLER, sendParams('after an exit'))).resolves.toMatchObject({
      ok: true
    })
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('shares one restart between concurrent sends', async () => {
    await loseOwner()

    const results = await Promise.all([
      host.send(CALLER, sendParams('first')),
      host.send(CALLER, sendParams('second')),
      host.send(CALLER, sendParams('third'))
    ])

    expect(results.map((result) => result.ok)).toEqual([true, true, true])
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledTimes(3)
  })

  it('replays a resent operation instead of running or restarting it again', async () => {
    const params = sendParams('sent once')
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })
    await loseOwner()

    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('refuses for good when the owner cannot be restarted', async () => {
    await loseOwner()
    acquire.mockRejectedValue(new Error('no provider thread to resume'))

    const result = await host.send(CALLER, sendParams('nothing to resume'))

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_owner_unrecoverable',
        message: expect.stringMatching(/new chat/)
      }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(hostErrors).not.toEqual([])
    expect(
      agentSessionRefusalOperationState('agentSession.send', 'agent_session_owner_unrecoverable')
    ).toBe('settled-rejected')
  })

  it('leaves a lease it cannot adjudicate alone', async () => {
    await loseOwner()
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, unreconciled: true }
    }))

    const result = await host.send(CALLER, sendParams('owner unverifiable'))

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    expect(acquire).not.toHaveBeenCalled()
  })
})
