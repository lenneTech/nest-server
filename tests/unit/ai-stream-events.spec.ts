import { describe, expect, it } from 'vitest';

import { CoreAiAction } from '../../src/core/modules/ai/models/core-ai-action.model';
import { CoreAiResponse } from '../../src/core/modules/ai/models/core-ai-response.model';
import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';

/**
 * `promptStream` event ordering.
 *
 * The agent loop cannot token-stream the answer (emulated tool calling needs the
 * full model output, and the final answer arrives wrapped in JSON), so `action`
 * events are the ONLY real-time signal a streaming client gets. Before this they
 * were collected from the finished response and emitted in one burst — on a
 * multi-step turn that meant a silent minute followed by everything at once.
 *
 * The bridging between the callback hook and the async generator is the delicate
 * part (a tool can complete while the generator is suspended, and the run can
 * settle between two yields), so it is pinned here rather than left to an e2e run
 * that would need a live LLM.
 */
describe('CoreAiService.promptStream', () => {
  const action = (name: string): CoreAiAction => Object.assign(new CoreAiAction(), { name, success: true });

  /**
   * A service whose `prompt()` is replaced by a scripted run: it invokes the
   * `onAction` hook for each name, awaiting a tick between them, then resolves.
   * Everything else about the class is untouched.
   */
  const scripted = (names: string[], text = 'done', fail?: Error) => {
    const service = Object.create(CoreAiService.prototype) as CoreAiService;
    (service as unknown as { prompt: unknown }).prompt = async (
      _input: unknown,
      _options: unknown,
      hooks?: { onAction?: (a: CoreAiAction) => void },
    ) => {
      for (const name of names) {
        await new Promise((r) => setTimeout(r, 1));
        hooks?.onAction?.(action(name));
      }
      await new Promise((r) => setTimeout(r, 1));
      if (fail) {
        throw fail;
      }
      return Object.assign(new CoreAiResponse(), { actions: names.map(action), text });
    };
    return service;
  };

  const collect = async (service: CoreAiService) => {
    const events: { name?: string; type: string }[] = [];
    for await (const ev of service.promptStream({ prompt: 'x' } as never, {} as never)) {
      events.push(ev.type === 'action' ? { name: ev.action.name, type: ev.type } : { type: ev.type });
    }
    return events;
  };

  it('emits every action, then the answer chunks, then the final event', async () => {
    const events = await collect(scripted(['find_records', 'get_record']));

    expect(events.filter((e) => e.type === 'action').map((e) => e.name)).toEqual(['find_records', 'get_record']);
    expect(events.at(-1)?.type).toBe('final');
    // Ordering contract: no action may follow the first token.
    const firstToken = events.findIndex((e) => e.type === 'token');
    expect(events.slice(firstToken).some((e) => e.type === 'action')).toBe(false);
  });

  it('does not lose an action that completes while the generator is suspended', async () => {
    // The consumer here is slower than the producer, so actions queue up between
    // yields — the case a naive `await` bridge drops.
    const service = scripted(['a', 'b', 'c', 'd']);
    const seen: string[] = [];
    for await (const ev of service.promptStream({ prompt: 'x' } as never, {} as never)) {
      if (ev.type === 'action') {
        seen.push(ev.action.name);
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });

  it('terminates cleanly for a run that executes no tools at all', async () => {
    const events = await collect(scripted([]));
    expect(events.some((e) => e.type === 'action')).toBe(false);
    expect(events.at(-1)?.type).toBe('final');
  });

  it('propagates a failing run instead of hanging the stream', async () => {
    // A generator that awaits a promise nobody settles would hang the SSE
    // connection until the client gives up — worse than an error frame.
    const service = scripted(['a'], 'done', new Error('provider exploded'));
    await expect(collect(service)).rejects.toThrow('provider exploded');
  });
});
