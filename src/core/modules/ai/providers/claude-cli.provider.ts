import { BadGatewayException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { ConfigService } from '../../../common/services/config.service';
import { ErrorCode } from '../../error-code';
import {
  ILlmProvider,
  LlmCapabilities,
  LlmCompletionOptions,
  LlmMessage,
  LlmResponse,
  LlmToolSchema,
} from '../interfaces/llm-provider.interface';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';

/**
 * Provider that drives the local Claude Code CLI (`claude`) as an LLM backend.
 *
 * Claude Code is an agentic CLI, not an HTTP completion endpoint, so this provider
 * shells out to it in non-interactive print mode and parses the single JSON result.
 * It is **opt-in**: register it on the {@link LlmProviderFactory} from a consumer
 * module, then create a connection with `providerType: 'claude-cli'`.
 *
 * ```typescript
 * factory.registerBuilder('claude-cli', (conn) => new ClaudeCliProvider(conn));
 * ```
 *
 * ## Security model
 *
 * The CLI is invoked with **all of its own tools disabled** (`--tools ""`), so
 * Claude Code cannot read files, run shell commands, or reach the network on its
 * own. Tool calling for the orchestrator is therefore **emulated** (capabilities
 * `nativeTools: false`) — exactly like any other emulated backend, the orchestrator
 * injects the tool catalog into the system prompt and executes tools itself through
 * `CrudService` with the caller's permissions. Additional hardening:
 *
 * - `spawn` is called with an **argument array (never a shell string)**, so prompt
 *   content can never be interpreted as a shell command (no command injection).
 * - The conversation is written to **stdin**, not passed as an argv element.
 * - The child runs in a neutral working directory ({@link tmpdir}) so no project
 *   `CLAUDE.md`/settings are auto-discovered into the context.
 * - `--system-prompt` **replaces** Claude Code's default agent prompt with the
 *   orchestrator's prompt, and `--no-session-persistence` avoids writing session files.
 * - The call is bounded by a timeout; the child is killed if it overruns.
 *
 * The connection's `model` is passed to `--model` (e.g. `opus`, `sonnet`, `haiku`,
 * or a full model id). `baseUrl` is unused (auth is the CLI's own login / API key);
 * if `apiKey` is set it is forwarded to the child as `ANTHROPIC_API_KEY`.
 *
 * Optional config (`ai.claudeCli`): `{ bin?: string; extraArgs?: string[]; maxBudgetUsd?: number }`.
 */
export class ClaudeCliProvider implements ILlmProvider {
  readonly capabilities: LlmCapabilities = { jsonResponse: false, nativeTools: false, systemPrompt: true };
  readonly name = 'claude-cli';

  protected readonly defaultTimeoutMs: number;
  private readonly logger = new Logger(ClaudeCliProvider.name);

  constructor(protected readonly connection: ResolvedAiConnection) {
    this.defaultTimeoutMs = connection.timeoutMs ?? 120_000;
  }

  /**
   * Run a completion via `claude -p --output-format json`. `tools` is intentionally
   * ignored — the CLI runs tool-free and the orchestrator emulates tool calling via
   * the (replaced) system prompt. Maps spawn/exit/parse failures to a gateway error.
   */
  async chat(messages: LlmMessage[], _tools: LlmToolSchema[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    // Flatten the remaining turns into a single labelled transcript for stdin. The
    // emulated 'tool' role is rendered as tool results the model can read.
    const transcript = messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${this.labelFor(m.role)}:\n${m.content}`)
      .join('\n\n');

    const args = this.buildArgs(system, options);
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    let stdout: string;
    try {
      stdout = await this.run(args, transcript, timeoutMs);
    } catch (err) {
      this.logger.warn(`Claude CLI invocation for "${this.connection.name}" failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(ErrorCode.AI_PROVIDER_ERROR);
    }

    let parsed: {
      is_error?: boolean;
      result?: string;
      subtype?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      this.logger.warn(`Claude CLI returned non-JSON output for "${this.connection.name}": ${stdout.slice(0, 300)}`);
      throw new BadGatewayException(ErrorCode.AI_PROVIDER_ERROR);
    }

    if (parsed.is_error || parsed.subtype !== 'success' || typeof parsed.result !== 'string') {
      this.logger.warn(`Claude CLI reported an error for "${this.connection.name}": ${stdout.slice(0, 300)}`);
      throw new BadGatewayException(ErrorCode.AI_PROVIDER_ERROR);
    }

    const promptTokens = parsed.usage?.input_tokens;
    const completionTokens = parsed.usage?.output_tokens;
    return {
      raw: parsed,
      text: parsed.result,
      usage: {
        completionTokens,
        promptTokens,
        totalTokens:
          promptTokens !== undefined || completionTokens !== undefined
            ? (promptTokens ?? 0) + (completionTokens ?? 0)
            : undefined,
      },
    };
  }

  /**
   * Build the argv for the CLI. Override to customize flags. Tools are always
   * disabled (`--tools ""`) — do not re-enable them unless you fully trust the model
   * with local file/shell access.
   */
  protected buildArgs(system: string, options?: LlmCompletionOptions): string[] {
    const args = [
      '-p',
      '--output-format',
      'json',
      // Disable ALL of Claude Code's own tools — it must be a pure text generator.
      '--tools',
      '',
      '--no-session-persistence',
      '--model',
      options?.model ?? this.connection.model,
    ];
    if (system) {
      // Replace (not append) Claude Code's default agent prompt with ours.
      args.push('--system-prompt', system);
    }
    const maxBudgetUsd = ConfigService.get<number>('ai.claudeCli.maxBudgetUsd');
    if (typeof maxBudgetUsd === 'number' && maxBudgetUsd > 0) {
      args.push('--max-budget-usd', String(maxBudgetUsd));
    }
    const extraArgs = ConfigService.get<string[]>('ai.claudeCli.extraArgs');
    if (Array.isArray(extraArgs)) {
      args.push(...extraArgs);
    }
    return args;
  }

  /** Resolve the CLI binary (override or `ai.claudeCli.bin`, default `claude`). */
  protected getBinary(): string {
    return ConfigService.get<string>('ai.claudeCli.bin') || 'claude';
  }

  /** Render a transcript label for a non-system message role. */
  protected labelFor(role: LlmMessage['role']): string {
    if (role === 'assistant') {
      return 'Assistant';
    }
    if (role === 'tool') {
      return 'Tool results';
    }
    return 'User';
  }

  /**
   * Spawn the CLI with an argument array (never a shell), feed the transcript via
   * stdin, and resolve with stdout. Rejects on non-zero exit, spawn error, or timeout
   * (the child is killed). Runs in {@link tmpdir} so no project files are discovered.
   */
  protected run(args: string[], input: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      if (this.connection.apiKey) {
        env.ANTHROPIC_API_KEY = this.connection.apiKey;
      }

      const child = spawn(this.getBinary(), args, { cwd: tmpdir(), env, shell: false });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`));
        }
      });

      child.stdin.on('error', () => {
        // Ignore EPIPE if the child closed stdin early; close handler reports the failure.
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }
}
