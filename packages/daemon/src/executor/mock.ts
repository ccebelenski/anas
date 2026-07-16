import type { CommandExecutor, ExecOptions, ExecResult, PipelineResult } from './types.js'

/** A canned response for a specific command + args pattern. */
export interface MockFixture {
  /** Command to match (e.g. '/usr/sbin/zpool') */
  command: string
  /** Args pattern to match. If omitted, matches any args for this command. */
  args?: string[]
  /** The result to return. */
  result: ExecResult
}

/** A canned response for a specific pipeline (cmd1 | cmd2) pattern. */
export interface MockPipelineFixture {
  cmd1: string
  /** cmd1 args to match. If omitted, matches any args for cmd1. */
  args1?: string[]
  cmd2: string
  /** cmd2 args to match. If omitted, matches any args for cmd2. */
  args2?: string[]
  result: PipelineResult
}

/** A recorded pipeline invocation, for test assertions on the exact argv. */
export interface MockPipelineCall {
  cmd1: string
  args1: string[]
  cmd2: string
  args2: string[]
}

/**
 * Mock executor — returns fixture data for development and testing.
 *
 * Register fixtures for specific command/args patterns. Unmatched
 * commands return a default "command not found" error.
 */
export class MockExecutor implements CommandExecutor {
  private fixtures: MockFixture[] = []
  private pipelineFixtures: MockPipelineFixture[] = []

  /** Every exec() call made, in order — tests assert the exact argv here. */
  readonly calls: { command: string, args: string[] }[] = []

  /** Every pipeline() call made, in order — tests assert the exact argv here. */
  readonly pipelineCalls: MockPipelineCall[] = []

  /** Register a fixture. More specific matches (with args) take priority. */
  addFixture(fixture: MockFixture): this {
    this.fixtures.push(fixture)
    return this
  }

  /** Register a pipeline fixture. Unmatched pipelines default to success. */
  addPipelineFixture(fixture: MockPipelineFixture): this {
    this.pipelineFixtures.push(fixture)
    return this
  }

  /** Clear all fixtures (including pipeline fixtures and recorded calls). */
  clearFixtures(): void {
    this.fixtures = []
    this.pipelineFixtures = []
    this.calls.length = 0
    this.pipelineCalls.length = 0
  }

  async exec(command: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> {
    // Record for test assertions on the exact argv (e.g. the zfs hold calls).
    this.calls.push({ command, args })
    // stdin (_opts.stdin) is accepted for interface parity but ignored — mock
    // matching is by command + args only, and secrets must never be matched on.
    // Try exact match (command + args) first, then command-only match
    const exactMatch = this.fixtures.find(
      f =>
        f.command === command
        && f.args !== undefined
        && f.args.length === args.length
        && f.args.every((a, i) => a === args[i]),
    )
    if (exactMatch)
      return exactMatch.result

    const commandMatch = this.fixtures.find(
      f => f.command === command && f.args === undefined,
    )
    if (commandMatch)
      return commandMatch.result

    return {
      stdout: '',
      stderr: `mock: command not found: ${command}`,
      exitCode: 127,
    }
  }

  async pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[]): Promise<PipelineResult> {
    // Record the call so route tests can assert the exact send/recv argv.
    this.pipelineCalls.push({ cmd1, args1, cmd2, args2 })

    const sameArgs = (pattern: string[] | undefined, actual: string[]): boolean =>
      pattern === undefined || (pattern.length === actual.length && pattern.every((a, i) => a === actual[i]))

    const match = this.pipelineFixtures.find(
      f => f.cmd1 === cmd1 && f.cmd2 === cmd2 && sameArgs(f.args1, args1) && sameArgs(f.args2, args2),
    )
    if (match)
      return match.result

    // Default: both sides succeed (like the command-only exec fallbacks).
    return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: '' }
  }
}
