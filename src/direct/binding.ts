import fs from 'node:fs';
import path from 'node:path';

export type Binding = {
  threadId: string; channelId: string; ownerId: string;
  codexPath?: string;
  workspaceDomain?: string;
  collaboratorIds?: string[];
};

export function readBinding(file: string): Binding {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid agent binding');
  for (const key of Object.keys(value)) {
    if (!['threadId', 'channelId', 'ownerId', 'codexPath', 'workspaceDomain', 'collaboratorIds'].includes(key))
      throw new Error(`Unknown binding field: ${key}`);
  }
  if (typeof value.threadId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.threadId))
    throw new Error('Set threadId to the one Codex task to connect');
  if (!/^[CG][A-Z0-9]+$/.test(value.channelId || '')) throw new Error('Set a Slack channelId');
  if (!/^[UW][A-Z0-9]+$/.test(value.ownerId || '')) throw new Error('Set a Slack ownerId');
  if (value.collaboratorIds !== undefined && (!Array.isArray(value.collaboratorIds)
    || value.collaboratorIds.some((id: unknown) => typeof id !== 'string' || !/^[UW][A-Z0-9]+$/.test(id))))
    throw new Error('Invalid collaboratorIds');
  if (value.codexPath !== undefined && (typeof value.codexPath !== 'string' || !value.codexPath.trim()))
    throw new Error('Invalid codexPath');
  if (value.workspaceDomain !== undefined &&
    (typeof value.workspaceDomain !== 'string' || !/^[a-z0-9-]+\.slack\.com$/.test(value.workspaceDomain)))
    throw new Error('Invalid Slack workspaceDomain');
  return value;
}

export function verifyWorkspace(expected: string | undefined, actualUrl: string | undefined): void {
  if (!expected) return;
  let actual: URL;
  try { actual = new URL(actualUrl || ''); }
  catch { throw new Error('Slack did not identify the authenticated workspace'); }
  if (actual.protocol !== 'https:' || actual.hostname !== expected)
    throw new Error(`Slack credentials do not belong to ${expected}`);
}

/** Only delivery IDs are stored here. No messages, history, or credentials. */
export class Journal {
  private entries: Record<string, 'claimed' | 'done'>;
  constructor(private file: string) {
    this.entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (!this.entries || typeof this.entries !== 'object' || Array.isArray(this.entries)
      || Object.values(this.entries).some(v => v !== 'claimed' && v !== 'done'))
      throw new Error('Invalid delivery journal; refusing to replay events');
  }
  claim(key: string): boolean {
    if (Object.hasOwn(this.entries, key)) return false;
    this.entries[key] = 'claimed'; this.save(); return true;
  }
  done(key: string): void { this.entries[key] = 'done'; this.save(); }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
