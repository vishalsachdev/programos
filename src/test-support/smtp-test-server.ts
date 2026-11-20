/**
 * A local SMTP server for tests, inside the test process. It listens on
 * 127.0.0.1 only, with a certificate made for the test run by the `openssl`
 * command (the key never enters the repo). No test contacts a real mail
 * server.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SMTPServer } from 'smtp-server';

export interface ReceivedMail {
  envelopeFrom: string;
  rcptTo: string[];
  raw: string;
  user: string;
  secure: boolean;
  /** Arrival time, ms since the epoch. */
  at: number;
}

type Reply = { code: number; message: string };

export interface TestSmtpBehaviour {
  /** Refuse the login with this reply. */
  auth?: Reply;
  /** Refuse MAIL FROM with this reply. */
  mailFrom?: Reply;
  /** Per-recipient refusal. Return nothing to accept. */
  rcpt?: (address: string) => Reply | undefined;
  /**
   * After the content: a refusal reply, `hang` (read it, never answer) or
   * `drop` (read it, then cut the connection without an answer).
   */
  data?: Reply | 'hang' | 'drop';
  /** Fail this many content attempts with `data`, then accept. */
  dataFailures?: number;
}

export interface TestSmtpServer {
  host: string;
  port: number;
  /** PEM of the test certificate; also the CA that signs it. */
  ca: string;
  caPath: string;
  username: string;
  password: string;
  received: ReceivedMail[];
  /** Every AUTH the server saw, and whether the session was encrypted. */
  logins: Array<{ user: string; pass: string; secure: boolean }>;
  /** Count of content attempts, accepted or not. */
  dataAttempts: number;
  connections: number;
  behaviour: TestSmtpBehaviour;
  close(): Promise<void>;
}

function replyError(reply: Reply): Error {
  return Object.assign(new Error(reply.message), { responseCode: reply.code });
}

export async function startTestSmtpServer(options: {
  /**
   * `tls`: TLS from the first byte. `starttls`: plain greeting, STARTTLS
   * offered. `plain`: STARTTLS not offered at all, and AUTH allowed in the
   * clear, so a client that would send credentials unencrypted is caught.
   */
  mode: 'tls' | 'starttls' | 'plain';
}): Promise<TestSmtpServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-test-'));
  const keyPath = path.join(dir, 'key.pem');
  const caPath = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      caPath,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const ca = fs.readFileSync(caPath, 'utf8');

  const state: TestSmtpServer = {
    host: '127.0.0.1',
    port: 0,
    ca,
    caPath,
    username: 'program-mailbox',
    password: 'test-only-not-a-real-password',
    received: [],
    logins: [],
    dataAttempts: 0,
    connections: 0,
    behaviour: {},
    close: async () => {},
  };

  const server = new SMTPServer({
    secure: options.mode === 'tls',
    key: fs.readFileSync(keyPath),
    cert: ca,
    hideSTARTTLS: options.mode === 'plain',
    allowInsecureAuth: options.mode === 'plain',
    authMethods: ['PLAIN', 'LOGIN'],
    disabledCommands: options.mode === 'plain' ? ['STARTTLS'] : [],
    logger: false,
    closeTimeout: 200,
    onConnect(_session, callback) {
      state.connections++;
      callback();
    },
    onAuth(auth, session, callback) {
      state.logins.push({
        user: String(auth.username ?? ''),
        pass: String(auth.password ?? ''),
        secure: Boolean(session.secure),
      });
      if (state.behaviour.auth) {
        return callback(replyError(state.behaviour.auth));
      }
      if (
        auth.username !== state.username ||
        auth.password !== state.password
      ) {
        return callback(
          replyError({ code: 535, message: '5.7.8 Authentication failed' }),
        );
      }
      callback(null, { user: auth.username });
    },
    onMailFrom(_address, _session, callback) {
      if (state.behaviour.mailFrom) {
        return callback(replyError(state.behaviour.mailFrom));
      }
      callback();
    },
    onRcptTo(address, _session, callback) {
      const refusal = state.behaviour.rcpt?.(address.address);
      if (refusal) return callback(replyError(refusal));
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        state.dataAttempts++;
        const mode = state.behaviour.data;
        const failing =
          mode !== undefined &&
          (state.behaviour.dataFailures === undefined ||
            state.dataAttempts <= state.behaviour.dataFailures);
        if (failing && mode === 'hang') return;
        if (failing && mode === 'drop') {
          for (const connection of server.connections) {
            (
              connection as unknown as { _socket?: { destroy(): void } }
            )._socket?.destroy();
          }
          return;
        }
        if (failing && typeof mode === 'object') {
          return callback(replyError(mode));
        }
        state.received.push({
          envelopeFrom: session.envelope.mailFrom
            ? session.envelope.mailFrom.address
            : '',
          rcptTo: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          user: String(session.user ?? ''),
          secure: Boolean(session.secure),
          at: Date.now(),
        });
        callback();
      });
    },
  });
  server.on('error', () => {
    // A client that gives up mid-handshake is part of several tests.
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.server.address();
  state.port = typeof address === 'object' && address ? address.port : 0;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const connection of server.connections) {
        (
          connection as unknown as { _socket?: { destroy(): void } }
        )._socket?.destroy();
      }
      server.close(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    });
  return state;
}

/** One header's value from raw message text, unfolded. */
export function rawHeader(raw: string, name: string): string | undefined {
  const head = raw.split(/\r?\n\r?\n/)[0];
  const match = head.match(
    new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, 'im'),
  );
  return match ? match[1].replace(/\r?\n[ \t]+/g, ' ').trim() : undefined;
}
