/**
 * Test helper: start a channel whose listener was configured with port 0
 * (WEBHOOK_PORT='0', so the operating system picks a free port) and return
 * the port it got. The channel does not expose its server, so the helper
 * watches net.Server.prototype.listen for the duration of connect() only.
 *
 * Fixed port numbers in the tests collided: two files shared one number, and
 * the numbers sat inside the system's range for outgoing connections.
 */
import net from 'net';

export async function connectOnFreePort(channel: {
  connect(): Promise<void>;
}): Promise<number> {
  const started: net.Server[] = [];
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function (
    this: net.Server,
    ...args: unknown[]
  ): net.Server {
    started.push(this);
    return (original as (...a: unknown[]) => net.Server).apply(this, args);
  } as typeof net.Server.prototype.listen;
  try {
    await channel.connect();
  } finally {
    net.Server.prototype.listen = original;
  }
  if (started.length !== 1) {
    throw new Error(
      `connectOnFreePort: expected one listener from connect(), saw ${started.length}`,
    );
  }
  const address = started[0].address();
  if (!address || typeof address === 'string' || !address.port) {
    throw new Error('connectOnFreePort: the listener has no assigned port');
  }
  return address.port;
}
