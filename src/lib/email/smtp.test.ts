import net from "node:net";
import { describe, expect, it } from "vitest";
import { explainSmtpError, sendEmail } from "./smtp";

/** A minimal SMTP server on localhost (no TLS, no auth) that records the messages it accepts. */
async function fakeSmtpServer() {
  const messages: Array<{ from: string; to: string[]; data: string }> = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { from: "", to: [] as string[], data: "" };
    socket.write("220 localhost ESMTP test\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            current = { from: "", to: [], data: "" };
            socket.write("250 OK queued\r\n");
          } else {
            current.data += `${line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") {
          socket.write("250-localhost\r\n250 8BITMIME\r\n");
        } else if (verb === "MAIL") {
          current.from = line;
          socket.write("250 OK\r\n");
        } else if (verb === "RCPT") {
          current.to.push(line);
          socket.write("250 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 Go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 Bye\r\n");
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, messages, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("sendEmail over SMTP", () => {
  it("delivers the message (sender, recipient, subject, both bodies) to the mail server", async () => {
    const smtp = await fakeSmtpServer();
    try {
      await sendEmail(
        { host: "127.0.0.1", port: smtp.port, security: "none", user: null, password: null, from: "DragonGrader <grader@example.com>" },
        { to: "prof@example.edu", subject: "Graded: Unit 4 Quiz", text: "2 papers were graded.", html: "<p>2 papers were graded.</p>" },
      );
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0].from).toContain("grader@example.com");
      expect(smtp.messages[0].to.join()).toContain("prof@example.edu");
      expect(smtp.messages[0].data).toContain("Subject: Graded: Unit 4 Quiz");
      expect(smtp.messages[0].data).toContain("2 papers were graded.");
      expect(smtp.messages[0].data).toContain("text/html");
    } finally {
      await smtp.close();
    }
  });

  it("says when the mail server can't be reached", async () => {
    const closed = await fakeSmtpServer();
    await closed.close();
    await expect(sendEmail(
      { host: "127.0.0.1", port: closed.port, security: "none", user: null, password: null, from: "g@example.com" },
      { to: "p@example.edu", subject: "s", text: "t", html: "<p>t</p>" },
    )).rejects.toThrow(/Couldn't reach the mail server/);
  });

  it("explains a refused password in plain words", () => {
    expect(explainSmtpError({ code: "EAUTH", responseCode: 535 })).toMatch(/app password/);
  });
});
