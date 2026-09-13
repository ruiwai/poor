import * as fs from "node:fs/promises";
import type { Dir } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ARTIFACT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const owner = process.getuid?.() ?? "local";
const prefix = `poor-bash-exec-${owner}-`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Private per-command directories; completed captures have best-effort retention.
 * Cleanup never recurses and only unlinks the three files this store owns.
 */
export class CommandArtifacts {
  private cursor?: Dir;
  private cleaning?: Promise<void>;
  readonly base: string;
  constructor(base = tmpdir()) { this.base = base; }

  async cleanup(now = Date.now()): Promise<void> {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.sweep(now).catch(() => {}).finally(() => { this.cleaning = undefined; });
    return this.cleaning;
  }

  private async sweep(now: number): Promise<void> {
    this.cursor ??= await fs.opendir(this.base);
    for (let count = 0; count < 128; count++) {
      const entry = await this.cursor.read();
      if (!entry) { await this.cursor.close(); this.cursor = undefined; return; }
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const id = entry.name.slice(prefix.length);
      if (!uuidPattern.test(id)) continue;
      const directory = join(this.base, entry.name);
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
        const marker = await fs.lstat(join(directory, ".completed"));
        if (!marker.isFile() || marker.isSymbolicLink() || now - marker.mtimeMs < ARTIFACT_RETENTION_SECONDS * 1000) continue;
        for (const name of [`${id}.stdout`, `${id}.stderr`, ".completed"]) {
          await fs.unlink(join(directory, name)).catch(() => {});
        }
        await fs.rmdir(directory).catch(() => {});
      } catch { /* Missing, active, replaced, or inaccessible: leave it alone. */ }
    }
  }

  async close(): Promise<void> {
    await this.cleaning;
    await this.cursor?.close();
    this.cursor = undefined;
  }

  async begin() {
    await this.cleanup();
    const commandId = randomUUID();
    const directory = join(this.base, prefix + commandId);
    await fs.mkdir(directory, { mode: 0o700 });
    const stdoutPath = join(directory, `${commandId}.stdout`);
    const stderrPath = join(directory, `${commandId}.stderr`);
    const stdout = await fs.open(stdoutPath, "wx", 0o600).catch(async (error) => {
      await fs.rmdir(directory).catch(() => {}); throw error;
    });
    const stderr = await fs.open(stderrPath, "wx", 0o600).catch(async (error) => {
      await stdout.close(); await fs.unlink(stdoutPath).catch(() => {});
      await fs.rmdir(directory).catch(() => {}); throw error;
    });
    return {
      commandId, directory, stdoutPath, stderrPath, stdout, stderr,
      complete: async () => { await fs.writeFile(join(directory, ".completed"), "poor bash_exec capture\n", { flag: "wx", mode: 0o600 }); },
    };
  }
}
