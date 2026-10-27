/** Run isolated local development processes without touching the user's dev server. */
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, "package.json"));
const frontendPort = 3138;
const relayPort = 8011;
const providerPort = 8010;
const image = "paradays-paddle-ocr:verified-20261007";
const imageId =
  "sha256:5072c48cc13db068280f6e15124ee638d8c39191041ada261466122e3084be39";
const containerName = `paradays-local-ocr-${process.pid}`;
const allowedPublic = [
  "NEXT_PUBLIC_COGNITO_DOMAIN",
  "NEXT_PUBLIC_COGNITO_CLIENT_ID",
  "NEXT_PUBLIC_COGNITO_REDIRECT_URI",
  "NEXT_PUBLIC_COGNITO_LOGOUT_URI",
  "NEXT_PUBLIC_COGNITO_SCOPES",
  "NEXT_PUBLIC_COGNITO_ISSUER",
  "NEXT_PUBLIC_COMMERCE_API_URL",
  "NEXT_PUBLIC_COMMERCE_API_BASE_URL",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
];

/** Only an explicit desktop opt-in enables the fixed Firebase demo origin. */
export function resolveLocalOcrProfile(demoSetting) {
  if (demoSetting !== undefined && !["true", "false"].includes(demoSetting))
    throw new Error("LOCAL_OCR_DEMO_CONFIGURATION_INVALID");
  const demoEnabled = demoSetting === "true";
  return {
    demoEnabled,
    providerDeadlineSeconds: demoEnabled ? 110 : 120,
    relayTimeoutMs: demoEnabled ? 115000 : 130000,
  };
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`LOCAL_OCR_COMMAND_FAILED: ${executable}`);
  return result.stdout.trim();
}
async function portAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`LOCAL_OCR_PORT_IN_USE: ${port}`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
async function ready(url, child) {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error("LOCAL_OCR_PROCESS_EXITED");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("LOCAL_OCR_STARTUP_TIMEOUT");
}

async function startLocalOcr() {
  const children = [];
  let containerStarted = false;
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    if (containerStarted)
      spawnSync("docker", ["stop", containerName], { stdio: "ignore", timeout: 20000 });
  }
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("exit", stop);

  try {
    if (process.env.NODE_ENV === "production")
      throw new Error("LOCAL_OCR_DEVELOPMENT_ONLY");
    const profile = resolveLocalOcrProfile(process.env.LOCAL_OCR_DEMO_ENABLED);
    await Promise.all([frontendPort, relayPort, providerPort].map(portAvailable));
    if (
      command("docker", ["image", "inspect", image, "--format", "{{.Id}}"]) !== imageId
    )
      throw new Error("LOCAL_OCR_VERIFIED_IMAGE_MISMATCH");
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(root, true, { info() {}, error() {} });
    const publicEnv = Object.fromEntries(
      allowedPublic.flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    if (
      !publicEnv.NEXT_PUBLIC_COGNITO_ISSUER ||
      !publicEnv.NEXT_PUBLIC_COGNITO_CLIENT_ID
    )
      throw new Error("LOCAL_OCR_COGNITO_PUBLIC_CONFIGURATION_MISSING");
    const runtime = await mkdtemp(path.join(os.tmpdir(), "paradays-local-ocr-"));
    const source = path.join(runtime, "frontend");
    await mkdir(source, { mode: 0o700 });
    // Copy application source only. Private env files, OCR fixtures and outputs are excluded.
    for (const directory of [
      "app",
      "components",
      "contexts",
      "data",
      "hooks",
      "lib",
      "public",
      "types",
    ])
      await cp(path.join(root, directory), path.join(source, directory), {
        recursive: true,
      });
    for (const filename of [
      "package.json",
      "next.config.ts",
      "tsconfig.json",
      "next-env.d.ts",
      "postcss.config.mjs",
    ]) {
      try {
        await cp(path.join(root, filename), path.join(source, filename));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await symlink(path.join(root, "node_modules"), path.join(source, "node_modules"));
    // 브라우저와 서버가 공유하는 순수 파서만 복사함. infra 설정·비밀은 제외함.
    await mkdir(path.join(source, "infra", "lambda"), { recursive: true });
    for (const filename of ["ocr-table-parser.js", "ocr-table-parser.d.ts"])
      await cp(
        path.join(root, "infra", "lambda", filename),
        path.join(source, "infra", "lambda", filename),
      );
    const secret = randomBytes(32).toString("hex");
    const configFile = path.join(runtime, "relay-config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        origin: `http://localhost:${frontendPort}`,
        port: relayPort,
        issuer: publicEnv.NEXT_PUBLIC_COGNITO_ISSUER,
        clientId: publicEnv.NEXT_PUBLIC_COGNITO_CLIENT_ID,
        providerUrl: `http://127.0.0.1:${providerPort}`,
        sharedSecret: secret,
        providerTimeoutMs: profile.relayTimeoutMs,
        demoEnabled: profile.demoEnabled,
      }),
      { mode: 0o600 },
    );
    const providerEnv = path.join(runtime, "provider.env");
    await writeFile(
      providerEnv,
      `PADDLE_OCR_SHARED_SECRET=${secret}\nPADDLE_OCR_LOG_LEVEL=error\nPADDLE_OCR_PRELOAD_MODEL=true\n`,
      { mode: 0o600 },
    );
    command("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--platform",
      "linux/amd64",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "--tmpfs",
      "/home/paddleocr/.paddlex/temp:rw,nosuid,uid=10001,gid=10001,size=64m",
      "--tmpfs",
      "/home/paddleocr/.paddlex/locks:rw,nosuid,uid=10001,gid=10001,size=16m",
      "--tmpfs",
      "/home/paddleocr/.paddlex/func_ret:rw,nosuid,uid=10001,gid=10001,size=64m",
      "--env-file",
      providerEnv,
      "-p",
      `127.0.0.1:${providerPort}:8000`,
      image,
      "python",
      "-c",
      `import app.main as local_service; local_service.OCR_RESPONSE_DEADLINE_SECONDS = ${profile.providerDeadlineSeconds}; local_service.main()`,
    ]);
    containerStarted = true;
    await ready(`http://127.0.0.1:${providerPort}/readyz`);
    const safeBaseEnv = { ...process.env, NODE_ENV: "development" };
    delete safeBaseEnv.PADDLE_OCR_SHARED_SECRET;
    const relay = spawn(
      process.execPath,
      [
        "--import",
        path.join(root, "infra/node_modules/tsx/dist/loader.mjs"),
        path.join(root, "scripts/local-ocr-relay.ts"),
        configFile,
      ],
      { cwd: root, env: safeBaseEnv, stdio: "inherit" },
    );
    children.push(relay);
    await ready(`http://127.0.0.1:${relayPort}/healthz`, relay);
    // Only public settings enter the frontend child; provider configuration never does.
    const frontendEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("NEXT_PUBLIC_") &&
          !key.startsWith("PADDLE_OCR_") &&
          !key.startsWith("AWS_") &&
          !key.startsWith("LOCAL_OCR_"),
      ),
    );
    const frontend = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/next/dist/bin/next"),
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(frontendPort),
      ],
      {
        cwd: source,
        env: {
          ...frontendEnv,
          ...publicEnv,
          NODE_ENV: "development",
          NEXT_PUBLIC_LOCAL_OCR_ENABLED: "true",
          NEXT_PUBLIC_LOCAL_OCR_API_URL: `http://127.0.0.1:${relayPort}`,
        },
        stdio: "inherit",
      },
    );
    children.push(frontend);
    await ready(`http://127.0.0.1:${frontendPort}/admin`, frontend);
    console.log(`Local admin: http://localhost:${frontendPort}/admin`);
    console.log(
      `Local desktop profile: inference deadline ${profile.providerDeadlineSeconds} seconds, relay deadline ${profile.relayTimeoutMs / 1000} seconds. Production provider limits are unchanged.`,
    );
    if (profile.demoEnabled)
      console.log(
        "Firebase OCR demo origin enabled: https://paradays.web.app. No tunnel is started by this launcher; reviews are private to each authenticated admin and lost on restart.",
      );
    console.log(
      `Supervisor PID ${process.pid}; stop with kill -TERM ${process.pid}. Container ${containerName}.`,
    );
    console.log(
      `Runtime directory ${runtime}; review jobs are memory-only and disappear when stopped.`,
    );
    for (const child of children)
      child.once("exit", () => {
        stop();
        process.exit(1);
      });
  } catch (error) {
    stop();
    console.error(error instanceof Error ? error.message : "LOCAL_OCR_START_FAILED");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await startLocalOcr();
