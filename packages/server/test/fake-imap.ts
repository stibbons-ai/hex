// A fake IMAP server on loopback, plaintext (as `HEX_IMAP_SECURITY=plain` allows for a loopback
// host), that refuses every login with a reply echoing the command as sent, credentials and all,
// as a careless server might: hex must never show them.
import type { TCPSocketListener } from "bun";

export interface FakeImap {
  server: TCPSocketListener<{ buffer: string }>;
  port: number;
  /** Every LOGIN command line, as received. */
  logins: string[];
}

export function refusingImap(): FakeImap {
  const logins: string[] = [];
  const server = Bun.listen<{ buffer: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
        socket.write("* OK fake IMAP ready\r\n");
      },
      data(socket, chunk) {
        socket.data.buffer += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          const [tag = "*", command = ""] = line.split(" ");
          switch (command.toUpperCase()) {
            case "CAPABILITY":
              socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
              break;
            case "LOGIN":
              logins.push(line);
              socket.write(`${tag} NO [AUTHENTICATIONFAILED] refused: ${line}\r\n`);
              break;
            case "LOGOUT":
              socket.write(`* BYE\r\n${tag} OK bye\r\n`);
              socket.end();
              break;
            default:
              socket.write(`${tag} OK done\r\n`);
          }
        }
      },
    },
  });
  return { server, port: server.port, logins };
}
