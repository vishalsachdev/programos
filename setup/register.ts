/**
 * Step: register — Write channel registration config, create group folders.
 *
 * Accepts --channel to specify the messaging platform (whatsapp, telegram, slack, discord).
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../src/config.ts';
import { initDatabase, setRegisteredGroup } from '../src/db.ts';
import { isValidGroupFolder, seedGroupFolder } from '../src/group-folder.ts';
import { readFileInTree, writeFileInTree } from '../src/host-fs-safety.ts';
import { logger } from '../src/logger.ts';
import { emitStatus } from './status.ts';

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // backward-compat: pre-refactor installs omit --channel
    requiresTrigger: true,
    isMain: false,
    assistantName: 'Andy',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.jid || !parsed.name || !parsed.trigger || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidGroupFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  logger.info(parsed, 'Registering channel');

  // Ensure data and store directories exist (store/ may not exist on
  // fresh installs that skip WhatsApp auth, which normally creates it)
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Initialize database (creates schema + runs migrations)
  initDatabase();

  setRegisteredGroup(parsed.jid, {
    name: parsed.name,
    folder: parsed.folder,
    trigger: parsed.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    isMain: parsed.isMain,
  });

  logger.info('Wrote registration to SQLite');

  // groups/ is agent-writable (each group's own folder; groups/global for
  // main) and setup runs as root: every read and write below goes through
  // host-fs-safety so a planted link is refused or replaced, never followed.
  const groupsDir = path.join(projectRoot, 'groups');

  // Create CLAUDE.md in the new group folder from template if it doesn't exist.
  // The agent runs with CWD=/workspace/group and loads CLAUDE.md from there.
  // Never overwrite an existing CLAUDE.md — users customize these extensively
  // (persona, workspace structure, communication rules, family context, etc.)
  // and a stock template replacement would destroy that work.
  const groupClaudeMdPath = path.join(groupsDir, parsed.folder, 'CLAUDE.md');
  const templateDir = path.join(groupsDir, parsed.isMain ? 'main' : 'global');
  let template: string | null = null;
  try {
    template = readFileInTree(templateDir, 'CLAUDE.md');
  } catch (err) {
    logger.warn({ templateDir, err }, 'Refused CLAUDE.md template');
  }
  if (seedGroupFolder(path.join(groupsDir, parsed.folder), template)) {
    logger.info(
      { file: groupClaudeMdPath, template: templateDir },
      'Created CLAUDE.md from template',
    );
  }

  // Update assistant name in CLAUDE.md files if different from default
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    logger.info(
      { from: 'Andy', to: parsed.assistantName },
      'Updating assistant name',
    );

    for (const d of fs.readdirSync(groupsDir)) {
      const dir = path.join(groupsDir, d);
      let content: string | null = null;
      let owner: { uid: number; gid: number } | undefined;
      try {
        if (!fs.lstatSync(dir).isDirectory()) continue;
        content = readFileInTree(dir, 'CLAUDE.md');
        if (content !== null) {
          // The rewrite is a new file: keep the old one's owner.
          const st = fs.lstatSync(path.join(dir, 'CLAUDE.md'));
          owner = { uid: st.uid, gid: st.gid };
        }
      } catch (err) {
        logger.warn({ dir, err }, 'Refused CLAUDE.md; not renamed');
        continue;
      }
      if (content === null) continue;
      content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
      content = content.replace(
        /You are Andy/g,
        `You are ${parsed.assistantName}`,
      );
      writeFileInTree(dir, 'CLAUDE.md', content, owner);
      logger.info({ file: path.join(dir, 'CLAUDE.md') }, 'Updated CLAUDE.md');
    }

    // Update .env
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(
          /^ASSISTANT_NAME=.*$/m,
          `ASSISTANT_NAME="${parsed.assistantName}"`,
        );
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    logger.info('Set ASSISTANT_NAME in .env');
    nameUpdated = true;
  }

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
