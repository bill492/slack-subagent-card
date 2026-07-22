import { spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && (result.status !== 0 || result.signal)) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    const outcome = result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} ${outcome}${detail ? `\n${detail}` : ""}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function output(command, args, options = {}) {
  return run(command, args, { ...options, capture: true }).stdout.trim();
}
