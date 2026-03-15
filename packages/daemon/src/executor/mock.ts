import type { CommandExecutor, ExecResult } from './types.js'

/** A canned response for a specific command + args pattern. */
export interface MockFixture {
  /** Command to match (e.g. '/usr/sbin/zpool') */
  command: string
  /** Args pattern to match. If omitted, matches any args for this command. */
  args?: string[]
  /** The result to return. */
  result: ExecResult
}

/**
 * Mock executor — returns fixture data for development and testing.
 *
 * Register fixtures for specific command/args patterns. Unmatched
 * commands return a default "command not found" error.
 */
export class MockExecutor implements CommandExecutor {
  private fixtures: MockFixture[] = []

  /** Register a fixture. More specific matches (with args) take priority. */
  addFixture(fixture: MockFixture): this {
    this.fixtures.push(fixture)
    return this
  }

  /** Clear all fixtures. */
  clearFixtures(): void {
    this.fixtures = []
  }

  async exec(command: string, args: string[]): Promise<ExecResult> {
    // Try exact match (command + args) first, then command-only match
    const exactMatch = this.fixtures.find(
      (f) =>
        f.command === command &&
        f.args !== undefined &&
        f.args.length === args.length &&
        f.args.every((a, i) => a === args[i]),
    )
    if (exactMatch) return exactMatch.result

    const commandMatch = this.fixtures.find(
      (f) => f.command === command && f.args === undefined,
    )
    if (commandMatch) return commandMatch.result

    return {
      stdout: '',
      stderr: `mock: command not found: ${command}`,
      exitCode: 127,
    }
  }
}
