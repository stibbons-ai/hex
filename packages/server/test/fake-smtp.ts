// A fake SMTP server on loopback, plaintext (as `HEX_SMTP_SECURITY=plain` allows for a loopback
// host): it accepts every mail and keeps it, so a test reads back exactly what hex sent. It
// offers AUTH PLAIN and records the credentials it was given.
import type { Socket, TCPSocketListener } from "bun";

/** One mail as the fake received it: its envelope and its raw message. */
export interface ReceivedMail {
  from: string;
  to: string[];
  /** The message as sent after DATA, dot-unstuffed, CRLF line ends. */
  raw: string;
}

export interface FakeSmtp {
  server: TCPSocketListener<Session>;
  port: number;
  /** Every mail accepted, in order. */
  mails: ReceivedMail[];
  /** Every `AUTH PLAIN` login, decoded: `{ user, password }`. */
  logins: { user: string; password: string }[];
  /** Recipients refused at `RCPT TO` (550) while listed here. */
  rejecting: Set<string>;
  /**
   * While true, every login is refused with a reply that echoes the credentials as sent, as a
   * careless server might.
   */
  refuseLogins: boolean;
}

interface Session {
  buffer: string;
  /** Collecting the message after DATA. */
  data: string[] | undefined;
  /** Waiting for the credentials after a bare `AUTH PLAIN`. */
  awaitingAuth: boolean;
  from: string;
  to: string[];
}

/** The address in `MAIL FROM:<a@b>` or `RCPT TO:<a@b> …`. */
const pathOf = (line: string) => /<([^>]*)>/.exec(line)?.[1] ?? "";

/** A fake SMTP server on 127.0.0.1 and a free port. */
export function fakeSmtp(): FakeSmtp {
  const mails: ReceivedMail[] = [];
  const logins: { user: string; password: string }[] = [];
  const rejecting = new Set<string>();
  const reply = (socket: Socket<Session>, line: string) => socket.write(`${line}\r\n`);
  const login = (socket: Socket<Session>, encoded: string) => {
    const [, user = "", password = ""] = Buffer.from(encoded, "base64")
      .toString("utf8")
      .split("\0");
    logins.push({ user, password });
    if (fake.refuseLogins) {
      reply(socket, `535 5.7.8 authentication failed for ${encoded} (password ${password})`);
    } else {
      reply(socket, "235 2.7.0 Authentication successful");
    }
  };

  function handle(socket: Socket<Session>, line: string) {
    const session = socket.data;
    if (session.data) {
      if (line !== ".") {
        session.data.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      mails.push({ from: session.from, to: session.to, raw: session.data.join("\r\n") });
      session.data = undefined;
      session.to = [];
      reply(socket, "250 2.0.0 queued");
      return;
    }
    if (session.awaitingAuth) {
      session.awaitingAuth = false;
      login(socket, line);
      return;
    }
    const command = line.toUpperCase();
    if (command.startsWith("EHLO")) {
      reply(socket, "250-hex-fake-smtp");
      reply(socket, "250-AUTH PLAIN");
      reply(socket, "250 8BITMIME");
    } else if (command.startsWith("HELO")) reply(socket, "250 hex-fake-smtp");
    else if (command.startsWith("AUTH PLAIN")) {
      const initial = line.slice("AUTH PLAIN".length).trim();
      if (initial) login(socket, initial);
      else {
        session.awaitingAuth = true;
        reply(socket, "334 ");
      }
    } else if (command.startsWith("MAIL FROM:")) {
      session.from = pathOf(line);
      reply(socket, "250 2.1.0 ok");
    } else if (command.startsWith("RCPT TO:")) {
      const to = pathOf(line);
      if (rejecting.has(to)) {
        reply(socket, `550 5.1.1 <${to}>: mailbox unavailable`);
        return;
      }
      session.to.push(to);
      reply(socket, "250 2.1.5 ok");
    } else if (command === "DATA") {
      session.data = [];
      reply(socket, "354 end with <CRLF>.<CRLF>");
    } else if (command === "RSET") {
      session.from = "";
      session.to = [];
      reply(socket, "250 2.0.0 ok");
    } else if (command === "QUIT") {
      reply(socket, "221 2.0.0 bye");
      socket.end();
    } else reply(socket, "502 5.5.1 not implemented");
  }

  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", data: undefined, awaitingAuth: false, from: "", to: [] };
        reply(socket, "220 hex-fake-smtp ESMTP");
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString("utf8");
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          handle(socket, line);
        }
      },
    },
  });
  const fake = { server, port: server.port, mails, logins, rejecting, refuseLogins: false };
  return fake;
}
