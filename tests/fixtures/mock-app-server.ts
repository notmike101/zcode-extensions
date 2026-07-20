import readline from "node:readline";

const reader = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
const pending = new Map<string, string | number>();

reader.on("line", (line) => {
  const message = JSON.parse(line) as {id?: string | number; method?: string; result?: unknown};
  if (message.method === "ping") {
    send({id: message.id, result: {pong: true}});
  } else if (message.method === "interaction-test") {
    pending.set("server-request", message.id!);
    send({id: "server-request", method: "interaction/requestUserInput", params: {sessionId: "sess_test"}});
  } else if (message.id === "server-request" && "result" in message) {
    send({id: pending.get("server-request"), result: {interaction: message.result}});
    pending.delete("server-request");
  } else if (message.method === "notify") {
    send({method: "session/event", params: {sessionId: "sess_test", events: [{type: "turn.completed", sessionId: "sess_test"}]}});
    send({id: message.id, result: {ok: true}});
  }
});

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
