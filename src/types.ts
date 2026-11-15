import type { DeliveryGateContext } from './delivery-gate.js';
export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
  /** Host-owned channel metadata required to deliver after a restart. */
  delivery_context?: unknown;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

import type { DeliveryProfile } from './delivery-gate.js';

export interface Channel {
  name: string;
  /**
   * G46: the delivery-integrity profile every outbound transmission on this
   * channel must pass (delivery-gate.ts). REQUIRED — a channel cannot be
   * registered without declaring one (compile-time), and startup asserts the
   * declared profile is a known one (assertGateProfile).
   */
  gateProfile: DeliveryProfile;
  connect(): Promise<void>;
  prepareDelivery(
    jid: string,
    text: string,
    deliveryId: string,
    gateContext?: DeliveryGateContext,
  ): Promise<PrepareDeliveryResult>;
  deliverPrepared(delivery: PreparedDelivery): Promise<DeliveryOutcome>;
  /** Serializable channel-owned metadata needed to prepare after a restart. */
  snapshotDeliveryContext?(jid: string): unknown;
  /** Restore only strictly validated channel metadata. */
  restoreDeliveryContext?(jid: string, context: unknown): boolean;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

export interface PreparedDelivery {
  channel: string;
  deliveryId: string;
  jid: string;
  payload: unknown;
}

export type PrepareDeliveryResult =
  | { status: 'prepared'; delivery: PreparedDelivery }
  | {
      status: 'suppressed';
      reason: string;
      outcomeId: string;
      suppressionKind?: 'cc-context';
    }
  | { status: 'failed'; reason: string; retryable: false };

export type DeliveryOutcome =
  | { status: 'sent'; providerId?: string }
  | {
      status: 'suppressed';
      reason: string;
      outcomeId: string;
    }
  | { status: 'failed'; reason: string; retryable: boolean };

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (
  chatJid: string,
  message: NewMessage,
  deliveryContext?: unknown,
) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
