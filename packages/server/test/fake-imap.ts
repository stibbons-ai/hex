// A fake IMAP server on loopback, plaintext (as `HEX_IMAP_SECURITY=plain` allows for a loopback
// host), just enough for hex's Mailbox: logging in (or refusing it with a reply echoing the
// command as sent, credentials and all, as a careless server might), selecting INBOX with one
// mail, listing, searching and fetching it, and refusing to move it, saying why; or dropping the
// connection at a command, or never answering one.
import type { TCPSocketListener } from "bun";

interface Session {
  buffer: string;
  /** The tag of the IDLE in progress, if any. */
  idling: string | undefined;
  /** What this connection's SELECT answers. */
  uidValidity: number;
}

export interface FakeImap {
  server: TCPSocketListener<Session>;
  port: number;
  /** Every LOGIN command line, as received. */
  logins: string[];
  /** Every command line, as received (LOGIN lines included). */
  commands: string[];
  /** Resolves once a client's connection closed (either side closing it). */
  closed: Promise<void>;
}

export interface FakeImapOptions {
  /** Refuse every login, echoing the command. Default: accept it. */
  refuseLogin?: boolean;
  /** The capabilities announced. Default: IMAP4rev1, IDLE and MOVE. */
  capabilities?: string;
  /** The Message-ID of the one mail in INBOX. */
  messageId?: string;
  /** Refuse SEARCH, saying why. */
  refuseSearch?: boolean;
  /**
   * Drop the connection without a word at this command: when the client enters IDLE, on a UID
   * MOVE, or right after answering the listing's FETCH.
   */
  dropOn?: "IDLE" | "UID MOVE" | "FETCH";
  /** Never answer this command. */
  silentOn?: "LOGIN" | "SELECT";
  /** The UIDVALIDITY each connection's SELECT answers, in order; the last one repeats. */
  uidValidities?: readonly number[];
}

export function fakeImap({
  refuseLogin = false,
  capabilities = "IMAP4rev1 IDLE MOVE",
  messageId = "quota@shop.example",
  refuseSearch = false,
  dropOn,
  silentOn,
  uidValidities = [7],
}: FakeImapOptions = {}): FakeImap {
  const logins: string[] = [];
  const commands: string[] = [];
  const closed = Promise.withResolvers<void>();
  let connections = 0;
  const envelope = `ENVELOPE ("Mon, 2 Nov 2026 08:15:00 +0100" "Rechnung" NIL NIL NIL NIL NIL NIL NIL "<${messageId}>")`;
  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const validity = uidValidities[Math.min(connections++, uidValidities.length - 1)];
        socket.data = { buffer: "", idling: undefined, uidValidity: validity ?? 7 };
        socket.write("* OK fake IMAP ready\r\n");
      },
      close() {
        closed.resolve();
      },
      data(socket, chunk) {
        socket.data.buffer += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          commands.push(line);
          if (socket.data.idling && line.toUpperCase() === "DONE") {
            socket.write(`${socket.data.idling} OK idle done\r\n`);
            socket.data.idling = undefined;
            continue;
          }
          const [tag = "*", first = "", second = ""] = line.split(" ");
          const command = (first.toUpperCase() === "UID" ? `UID ${second}` : first).toUpperCase();
          const reply = (...lines: string[]) => socket.write(`${lines.join("\r\n")}\r\n`);
          if (command === silentOn || (silentOn === "SELECT" && command === "EXAMINE")) continue;
          if (command === dropOn && dropOn !== "FETCH") {
            socket.terminate();
            return;
          }
          switch (command) {
            case "CAPABILITY":
              reply(`* CAPABILITY ${capabilities}`, `${tag} OK done`);
              break;
            case "LOGIN":
              logins.push(line);
              reply(
                refuseLogin
                  ? `${tag} NO [AUTHENTICATIONFAILED] refused: ${line}`
                  : `${tag} OK [CAPABILITY ${capabilities}] logged in`,
              );
              break;
            case "LIST":
              reply(`* LIST () "/" "INBOX"`, `${tag} OK done`);
              break;
            case "SELECT":
            case "EXAMINE":
              reply(
                "* FLAGS (\\Seen)",
                "* 1 EXISTS",
                `* OK [UIDVALIDITY ${socket.data.uidValidity}] ok`,
                "* OK [UIDNEXT 2] ok",
                `${tag} OK [READ-WRITE] selected`,
              );
              break;
            case "UID SEARCH":
              reply(
                refuseSearch
                  ? `${tag} NO [CANNOT] Search is not available right now`
                  : `* SEARCH 1\r\n${tag} OK done`,
              );
              break;
            case "FETCH":
              reply(`* 1 FETCH (UID 1 ${envelope})`, `${tag} OK done`);
              if (dropOn === "FETCH") {
                socket.terminate();
                return;
              }
              break;
            case "UID FETCH":
              reply(`* 1 FETCH (UID 1 ${envelope})`, `${tag} OK done`);
              break;
            case "UID MOVE":
              reply(`${tag} NO [OVERQUOTA] Quota exceeded (mailbox full)`);
              break;
            case "IDLE":
              socket.data.idling = tag;
              reply("+ idling");
              break;
            case "LOGOUT":
              reply("* BYE", `${tag} OK bye`);
              socket.end();
              break;
            default:
              reply(`${tag} OK done`);
          }
        }
      },
    },
  });
  return { server, port: server.port, logins, commands, closed: closed.promise };
}
