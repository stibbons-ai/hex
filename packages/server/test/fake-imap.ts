// A fake IMAP server on loopback, plaintext (as `HEX_IMAP_SECURITY=plain` allows for a loopback
// host), just enough for hex's Mailbox: logging in (or refusing it with a reply echoing the
// command as sent, credentials and all, as a careless server might), selecting INBOX with one
// mail, searching and fetching it, and refusing to move it, saying why.
import type { TCPSocketListener } from "bun";

interface Session {
  buffer: string;
  /** The tag of the IDLE in progress, if any. */
  idling: string | undefined;
}

export interface FakeImap {
  server: TCPSocketListener<Session>;
  port: number;
  /** Every LOGIN command line, as received. */
  logins: string[];
  /** Every command line, as received (LOGIN lines included). */
  commands: string[];
}

export interface FakeImapOptions {
  /** Refuse every login, echoing the command. Default: accept it. */
  refuseLogin?: boolean;
  /** The capabilities announced. Default: IMAP4rev1, IDLE and MOVE. */
  capabilities?: string;
  /** The Message-ID of the one mail in INBOX. */
  messageId?: string;
}

export function fakeImap({
  refuseLogin = false,
  capabilities = "IMAP4rev1 IDLE MOVE",
  messageId = "quota@shop.example",
}: FakeImapOptions = {}): FakeImap {
  const logins: string[] = [];
  const commands: string[] = [];
  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", idling: undefined };
        socket.write("* OK fake IMAP ready\r\n");
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
                "* OK [UIDVALIDITY 7] ok",
                "* OK [UIDNEXT 2] ok",
                `${tag} OK [READ-WRITE] selected`,
              );
              break;
            case "UID SEARCH":
              reply("* SEARCH 1", `${tag} OK done`);
              break;
            case "UID FETCH":
              reply(
                `* 1 FETCH (UID 1 ENVELOPE ("Mon, 2 Nov 2026 08:15:00 +0100" "Rechnung" NIL NIL NIL NIL NIL NIL NIL "<${messageId}>"))`,
                `${tag} OK done`,
              );
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
  return { server, port: server.port, logins, commands };
}
