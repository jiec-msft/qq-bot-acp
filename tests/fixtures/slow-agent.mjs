import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-sol",
      options: [{ value: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "medium", name: "Medium" },
        { value: "max", name: "Max" },
      ],
    },
  ];
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        agentCapabilities: { mcpCapabilities: { http: true } },
      },
    });
    return;
  }
  if (request.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: `slow-${Math.random()}`,
        configOptions: configOptions(),
      },
    });
    return;
  }
  if (request.method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { configOptions: configOptions() },
    });
    return;
  }
  if (request.method === "session/prompt") {
    const delay = request.params.prompt.some(
      (block) => block.type === "text" && block.text === "slow",
    )
      ? 1_000
      : 0;
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { stopReason: "end_turn" },
      });
    }, delay);
  }
});
